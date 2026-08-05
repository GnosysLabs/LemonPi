import assert from "node:assert/strict";
import {
  buildPartialWorkerHandoff,
  continuationIssue,
  hardLimitBoundaryDecision,
  immutableResumeBinding,
  launchOverridePath,
  ownershipExpansionIssue,
  preferredTerminalStatus,
  renderContinuationPrompt,
  resolveAgentLaunchBinding,
  terminalOutcome,
  typedTargetStatusFromRunStatus,
  validateSubagentRpcHandshake,
  workerBudgetPhase,
  workerExecutionBudget,
  workerStatusMetrics,
} from "../src-tauri/resources/lemonpi-narration/extensions/orchestration-runtime.ts";

const availableModels = ["openai-codex/gpt-5.6-luna", "openai-codex/gpt-5.6-terra"];
const routedSettings = (model = availableModels[0], thinking = "xhigh") => ({
  subagents: { agentOverrides: { worker: { model, thinking } } },
});
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("default limits are disabled and spawn contains no package budgets", () => {
  const policy = workerExecutionBudget("worker", "implementation", {});
  assert.equal(policy.enabled, false);
  assert.equal(policy.source, "disabled-default");
  assert.deepEqual(policy.warning, {});
  assert.deepEqual(policy.hard, {});
  assert.deepEqual(policy.spawn, {});
  assert.deepEqual(workerBudgetPhase({ tokens: 130_730, turns: 44, toolCalls: 46, elapsedMs: 60 * 60_000 }, policy), { phase: "work" });
});

test("only exact all-project per-agent settings enable limits", () => {
  const user = { subagents: { agentLimits: { worker: {
    enabled: true,
    hardStopBehavior: "checkpoint-and-stop",
    tokenWarning: 100,
    tokenHardStop: 120,
    turnWarning: 10,
    turnHardStop: 12,
    toolWarning: 40,
    toolHardStop: 45,
    runtimeWarningMs: 1_000,
    runtimeHardStopMs: 2_000,
  } } } };
  const policy = workerExecutionBudget("worker", "implementation", user);
  assert.deepEqual(policy.warning, { tokens: 100, turns: 10, toolCalls: 40, runtimeMs: 1_000 });
  assert.deepEqual(policy.hard, { tokens: 120, turns: 12, toolCalls: 45, runtimeMs: 2_000 });
  assert.equal(policy.behavior, "checkpoint-and-stop");
  assert.deepEqual(policy.spawn, {});
  assert.equal(workerExecutionBudget("other", "implementation", user).enabled, false);
});

test("task and Main Pi launch fields cannot override user limits", () => {
  for (const field of ["timeoutMs", "maxRuntimeMs", "turnBudget", "toolBudget", "usageBudget", "limits", "limitPolicy"]) {
    assert.equal(launchOverridePath({ lanes: [{ agent: "worker", [field]: 1 }] }, "lemonpi_dispatch"), `lemonpi_dispatch.lanes[0].${field}`);
  }
});

test("hard limits checkpoint first and stop only at a tool-free boundary", () => {
  const policy = workerExecutionBudget("worker", "implementation", { subagents: { agentLimits: { worker: { enabled: true, hardStopBehavior: "checkpoint-and-stop", toolHardStop: 45 } } } });
  const hard = workerBudgetPhase({ tokens: 0, turns: 12, toolCalls: 45, elapsedMs: 0 }, policy);
  assert.equal(hard.phase, "finalizing");
  assert.match(hard.hardStopReason ?? "", /optional tool hard stop/);
  assert.equal(hardLimitBoundaryDecision({ policy, hardStopReason: hard.hardStopReason, checkpointReady: false, hardLimitPending: false }), "checkpoint-and-finalize");
  assert.equal(hardLimitBoundaryDecision({ policy, hardStopReason: hard.hardStopReason, checkpointReady: true, hardLimitPending: true, currentTool: "bash" }), "wait-for-tool-boundary");
  assert.equal(hardLimitBoundaryDecision({ policy, hardStopReason: hard.hardStopReason, checkpointReady: true, hardLimitPending: true }), "stop-at-boundary");
});

test("warn-only never becomes destructive", () => {
  const policy = workerExecutionBudget("worker", "implementation", { subagents: { agentLimits: { worker: { enabled: true, hardStopBehavior: "warn-only", tokenHardStop: 5 } } } });
  const state = workerBudgetPhase({ tokens: 9, turns: 0, toolCalls: 0, elapsedMs: 0 }, policy);
  assert.deepEqual(state, { phase: "warning" });
  assert.equal(hardLimitBoundaryDecision({ policy, hardStopReason: "crossed", checkpointReady: false, hardLimitPending: false }), "continue");
});

test("initial model and thinking resolve exactly without fallback", () => {
  const binding = resolveAgentLaunchBinding({ agent: "worker", userSettings: routedSettings(), availableModels }).binding;
  assert.deepEqual([binding?.model, binding?.thinking], ["openai-codex/gpt-5.6-luna", "xhigh"]);
  assert.equal(resolveAgentLaunchBinding({ agent: "worker", userSettings: routedSettings("missing/model", "low"), availableModels }).binding, undefined);
});

test("continuation preserves the immutable model and reasoning binding", () => {
  const attempt = {
    runId: "run-a", agent: "worker", task: "Implement files", purpose: "Implement files", status: "partial",
    executionMode: "implementation", completedOrdinal: 1, sliceCount: 1, transcriptBytes: 1, tokens: 1,
    model: "openai-codex/gpt-5.6-luna", thinking: "xhigh", settingsSource: "user-agent-override", settingsHash: "settings-a",
  };
  assert.deepEqual(immutableResumeBinding(attempt), {
    agent: "worker", provider: "openai-codex", modelId: "gpt-5.6-luna", model: "openai-codex/gpt-5.6-luna",
    thinking: "xhigh", source: "user-agent-override", settingsHash: "settings-a",
  });
});

test("structured v3 continuation prompts stay bounded rather than recursive", () => {
  const attempt = {
    runId: "run-a", agent: "worker", originalObjective: "Ship the feature", originalTask: "Create two files\nDone when: focused check passes",
    task: "recursive text that must not become original", purpose: "Ship feature", status: "partial", executionMode: "implementation",
    completedOrdinal: 1, sliceCount: 1, transcriptBytes: 1, tokens: 1, model: "openai-codex/gpt-5.6-luna", thinking: "xhigh",
    settingsSource: "user-agent-override", settingsHash: "settings-a", ownedPaths: ["src/a.ts", "src/b.ts"],
    preservedPatchPath: "/durable/run-a.patch", checkpointRef: "refs/lemonpi/checkpoints/run-a", checkpointCommit: "a".repeat(40),
    checkpointBaseRevision: "b".repeat(40), checkpointPatchDigest: "c".repeat(64), checkpointChangedPaths: ["src/a.ts", "src/b.ts"],
    stopProvenance: { cause: "optional_budget", initiator: "test", reason: "configured limit", requestedAt: 1 },
  };
  const first = buildPartialWorkerHandoff({ attempt, evidence: { latestOutput: "First file complete" }, stopReason: "configured limit" });
  assert.equal(first?.version, 3);
  const prompt1 = renderContinuationPrompt(first);
  const second = { ...first, continuationOf: "run-b", latestUsefulOutput: prompt1.repeat(10) };
  const prompt2 = renderContinuationPrompt(second);
  assert.ok(Math.abs(prompt2.length - prompt1.length) < 80);
  assert.equal(prompt2.includes(prompt1), false);
  assert.equal(continuationIssue({ previous: attempt, handoff: first, priorFingerprints: [] }), undefined);
});

test("implementation continuation without a checkpoint is blocked", () => {
  const previous = { runId: "run", purpose: "x", status: "partial", executionMode: "implementation", completedOrdinal: 1, sliceCount: 1, transcriptBytes: 1, tokens: 1 };
  assert.match(continuationIssue({ previous, handoff: { continuationOf: "run" }, priorFingerprints: [] }), /filesystem checkpoint/);
});

test("mechanical ownership expansion succeeds and genuine conflicts block", () => {
  assert.equal(ownershipExpansionIssue({ runId: "a", currentPaths: ["src/a.ts"], requestedPaths: ["pnpm-lock.yaml"], category: "lockfile", reason: "dependency pin", activeLanes: [{ runId: "b", paths: ["src/b.ts"] }] }), undefined);
  assert.match(ownershipExpansionIssue({ runId: "a", currentPaths: ["src/a.ts"], requestedPaths: ["src/b.ts"], category: "direct-test", reason: "compile", activeLanes: [{ runId: "b", paths: ["src/b.ts"] }] }) ?? "", /conflicts/);
});

test("optional-budget and explicit-user stops remain distinct", () => {
  assert.equal(terminalOutcome({ reportedStatus: "stopped", stopCause: "optional_budget", budgetStopReason: "configured" }).status, "budget_exhausted");
  assert.equal(terminalOutcome({ reportedStatus: "stopped", stopCause: "user" }).status, "stopped");
  assert.equal(preferredTerminalStatus("partial", "budget_exhausted"), "partial");
});

test("four targeted telemetry records cannot contaminate one another", () => {
  const fleet = [{ runId: "a", totalTokens: 999_999 }, { runId: "b", totalTokens: 888_888 }];
  for (let index = 0; index < 4; index += 1) {
    const runId = `run-${index}`;
    const response = { ...typedTargetStatusFromRunStatus({ runId, state: "running", totalTokens: { total: 100 + index }, turnCount: index, toolCount: index + 1 }, runId), fleet };
    assert.equal(workerStatusMetrics(response, runId).tokens, 100 + index);
  }
  assert.throws(() => workerStatusMetrics({ protocolVersion: 2, target: { runId: "wrong", state: "running", metrics: {} }, fleet }, "run-0"), /mismatch/);
});

test("RPC compatibility fails clearly before launch", () => {
  assert.doesNotThrow(() => validateSubagentRpcHandshake({ version: 1, methods: ["ping", "status", "spawn", "steer", "stop"], capabilities: { processTerminalProof: { lifecycleArtifactVersion: 3 } } }));
  assert.throws(() => validateSubagentRpcHandshake({ version: 2, methods: [], capabilities: {} }), /Incompatible pi-subagents RPC protocol/);
  assert.throws(() => validateSubagentRpcHandshake({ version: 1, methods: ["ping"], capabilities: { processTerminalProof: { lifecycleArtifactVersion: 3 } } }), /missing 'status'/);
});

for (const { name, fn } of tests) {
  await fn();
  process.stdout.write(`ok ${name}\n`);
}
assert.equal(tests.length, 13);
console.log(JSON.stringify({ tests: tests.length, sourceRegexAssertions: 0, status: "passed" }));
