import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildPartialWorkerHandoff,
  immutableResumeBinding,
  launchOverridePath,
  preferredTerminalStatus,
  resolveAgentLaunchBinding,
  terminalOutcome,
  workerBudgetPhase,
  workerExecutionBudget,
} from "../src-tauri/resources/lemonpi-narration/extensions/orchestration-runtime.ts";

const narration = readFileSync(new URL("../src-tauri/resources/lemonpi-narration/extensions/narration.ts", import.meta.url), "utf8");
const rust = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
const availableModels = [
  "openai-codex/gpt-5.6-luna",
  "openai-codex/gpt-5.6-terra",
  "anthropic/claude-sonnet-5",
];
const settings = (model, thinking, extra = {}) => ({
  subagents: {
    agentOverrides: { explorer: { model, thinking } },
    ...extra,
  },
});
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("1 dispatch rejects model and thinking before launch", () => {
  assert.equal(launchOverridePath({ lanes: [{ agent: "explorer", model: "openai-codex/gpt-5.6-mini:low" }] }, "lemonpi_dispatch"), "lemonpi_dispatch.lanes[0].model");
  assert.equal(launchOverridePath({ lanes: [{ agent: "explorer", thinking: "medium" }] }, "lemonpi_dispatch"), "lemonpi_dispatch.lanes[0].thinking");
  assert.doesNotMatch(narration.match(/const IndependentDispatchSchema[\s\S]*?const GitManagerSchema/)?.[0] ?? "", /\bmodel\s*:/);
});

test("2 direct subagent launch cannot bypass routing", () => {
  assert.equal(launchOverridePath({ agent: "explorer", task: "Inspect", thinking: "medium" }), "subagent.thinking");
  assert.equal(launchOverridePath({ agent: "explorer", task: "Inspect", model: "other/model" }), "subagent.model");
  assert.equal(launchOverridePath({ tasks: [{ agent: "explorer", model: "other/model" }] }), "subagent.tasks[0].model");
  assert.match(narration, /Direct child model and thinking overrides are forbidden; user settings are authoritative and zero children were started/);
});

test("3 configured explorer launches exactly Luna xhigh", () => {
  const resolved = resolveAgentLaunchBinding({ agent: "explorer", userSettings: settings("openai-codex/gpt-5.6-luna", "xhigh"), availableModels });
  assert.deepEqual({ model: resolved.binding?.model, thinking: resolved.binding?.thinking }, { model: "openai-codex/gpt-5.6-luna", thinking: "xhigh" });
});

test("4 heuristics cannot reduce configured thinking", () => {
  for (const thinking of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
    assert.equal(resolveAgentLaunchBinding({ agent: "explorer", userSettings: settings("openai-codex/gpt-5.6-luna", thinking), availableModels }).binding?.thinking, thinking);
  }
  assert.doesNotMatch(narration, /runtimeRoutedModel|desiredThinking|setThinkingLevel/);
});

test("5 repository settings cannot override populated user settings", () => {
  const resolved = resolveAgentLaunchBinding({
    agent: "explorer",
    userSettings: settings("openai-codex/gpt-5.6-luna", "xhigh", { allowProjectAgentRouting: true }),
    projectSettings: settings("openai-codex/gpt-5.6-terra", "low"),
    availableModels,
  });
  assert.equal(resolved.binding?.model, "openai-codex/gpt-5.6-luna");
  assert.equal(resolved.binding?.thinking, "xhigh");
  assert.equal(resolved.binding?.source, "user-agent-override");
});

test("6 unavailable configured model blocks with no fallback", () => {
  const resolved = resolveAgentLaunchBinding({ agent: "explorer", userSettings: settings("openai-codex/gpt-5.6-mini", "low"), availableModels });
  assert.equal(resolved.binding, undefined);
  assert.match(resolved.error ?? "", /explorer.*gpt-5\.6-mini.*No fallback.*no child/i);
  const fallbackConfigured = resolveAgentLaunchBinding({ agent: "explorer", userSettings: settings("openai-codex/gpt-5.6-luna", "xhigh"), availableModels, configuredFallbackModels: ["agent definition fallbackModels"] });
  assert.equal(fallbackConfigured.binding, undefined);
  assert.match(fallbackConfigured.error ?? "", /requires one exact model.*No child/i);
});

test("7 resume preserves immutable original binding", () => {
  const original = {
    runId: "run-original", agent: "explorer", task: "Inspect", purpose: "Inspect",
    status: "completed", executionMode: "read-only", completedOrdinal: 1, sliceCount: 1,
    transcriptBytes: 0, tokens: 10, model: "openai-codex/gpt-5.6-luna", thinking: "xhigh",
    settingsSource: "user-agent-override", settingsHash: "abc123",
  };
  assert.deepEqual(immutableResumeBinding(original), {
    agent: "explorer", model: "openai-codex/gpt-5.6-luna", thinking: "xhigh",
    source: "user-agent-override", settingsHash: "abc123",
  });
});

test("8 saved settings change affects next fresh resolution", () => {
  const before = resolveAgentLaunchBinding({ agent: "explorer", userSettings: settings("openai-codex/gpt-5.6-luna", "xhigh"), availableModels }).binding;
  const after = resolveAgentLaunchBinding({ agent: "explorer", userSettings: settings("openai-codex/gpt-5.6-terra", "medium"), availableModels }).binding;
  assert.notEqual(before?.settingsHash, after?.settingsHash);
  assert.deepEqual([after?.model, after?.thinking], ["openai-codex/gpt-5.6-terra", "medium"]);
});

test("9 binding metadata is persisted before spawn", () => {
  const persistIndex = narration.indexOf("persistPendingLaunch({", narration.indexOf("const launched = await Promise.all"));
  const spawnIndex = narration.indexOf("await requestSubagentSpawn(pi, spawn)", persistIndex);
  assert.ok(persistIndex > 0 && spawnIndex > persistIndex);
  for (const field of ["model", "thinking", "settingsSource", "settingsHash"]) assert.match(narration, new RegExp(`${field}: candidate\\.binding`));
});

test("10 warning threshold activates deterministic instructions", () => {
  const budget = workerExecutionBudget("explorer", "read-only", {});
  assert.equal(workerBudgetPhase({ tokens: 0, turns: budget.warning.turns, toolCalls: 0, elapsedMs: 0 }, budget).phase, "warning");
  assert.match(narration, /LemonPi budget warning: finish the current bounded action/);
});

test("11 work limit blocks tools but reserves final response turns", () => {
  const budget = workerExecutionBudget("explorer", "read-only", {});
  assert.deepEqual(budget.spawn.turnBudget, { maxTurns: 10, graceTurns: 2 });
  assert.deepEqual(budget.spawn.toolBudget, { soft: 25, hard: 30, block: "*" });
  assert.equal(workerBudgetPhase({ tokens: 0, turns: 10, toolCalls: 0, elapsedMs: 0 }, budget).phase, "finalizing");
});

test("12 valid final result at limit is completed", () => {
  const outcome = terminalOutcome({ reportedStatus: "failed", evidence: { exitCode: 0, turnBudgetExceeded: true, output: "Complete requested repository map." } });
  assert.equal(outcome.status, "completed");
});

test("13 clean output wins over racing budget stop", () => {
  const first = terminalOutcome({ reportedStatus: "completed", evidence: { exitCode: 0, output: "Final answer" } }).status;
  const racing = terminalOutcome({ reportedStatus: "stopped", budgetStopReason: "turn budget exhausted" }).status;
  assert.equal(preferredTerminalStatus(first, racing), "completed");
});

test("14 stopped incomplete child yields persisted partial handoff", () => {
  const attempt = {
    runId: "run-partial", agent: "explorer", task: "Inspect all routing paths", purpose: "Inspect routing",
    status: "partial", executionMode: "read-only", completedOrdinal: 1, sliceCount: 1,
    transcriptBytes: 1, tokens: 100, model: "openai-codex/gpt-5.6-luna", thinking: "xhigh",
    settingsSource: "user-agent-override", settingsHash: "hash", budgetStopReason: "turn budget exhausted",
  };
  const handoff = buildPartialWorkerHandoff({ attempt, evidence: { recentOutput: ["Found the settings precedence bug."], currentPath: "src/routing.ts" }, stopReason: attempt.budgetStopReason });
  assert.equal(handoff?.continuation.priorRunId, "run-partial");
  assert.deepEqual(handoff?.inspectedResources, ["src/routing.ts"]);
  assert.match(handoff?.latestUsefulOutput ?? "", /precedence bug/);
  assert.equal(terminalOutcome({ reportedStatus: "failed", budgetStopReason: "turn budget exhausted", evidence: {} }).status, "budget_exhausted");
  assert.equal(terminalOutcome({ reportedStatus: "stopped", evidence: { recentOutput: ["Useful partial finding"] } }).status, "partial");
});

test("15 implementation patch survives budget exhaustion", () => {
  const outcome = terminalOutcome({ reportedStatus: "failed", budgetStopReason: "token budget exhausted", evidence: { patchPath: "/tmp/run.patch", turnBudgetExceeded: true } });
  assert.equal(outcome.status, "partial");
  assert.deepEqual(outcome.summary.artifactPaths, ["/tmp/run.patch"]);
});

test("16 continuation contains unresolved scope only", () => {
  const attempt = {
    runId: "run-cont", agent: "explorer", task: "Map routes and report gaps", purpose: "Map routes",
    status: "budget_exhausted", executionMode: "read-only", completedOrdinal: 1, sliceCount: 1,
    transcriptBytes: 1, tokens: 100, model: "openai-codex/gpt-5.6-luna", thinking: "xhigh",
    settingsSource: "user-agent-override", settingsHash: "hash",
  };
  const handoff = buildPartialWorkerHandoff({ attempt, evidence: { output: "Mapped authentication routes." }, stopReason: "hard limit" });
  assert.match(handoff?.continuationTask ?? "", /Continue only the unresolved portion/);
  assert.match(narration, /candidate\.lane\.task = handoff\.continuationTask/);
});

test("17 genuine crash with no useful output remains failed", () => {
  assert.equal(terminalOutcome({ reportedStatus: "failed", evidence: { exitCode: 137, error: "segmentation fault" } }).status, "failed");
});

test("18 mission terminal status UI and artifacts use one authoritative attempt", () => {
  assert.match(rust, /lemonPiState/);
  for (const field of ["model", "thinking", "settingsSource", "settingsHash", "budgetPhase", "budgetStopReason", "partialHandoffPath"]) assert.match(rust, new RegExp(`"${field}"`));
  assert.match(narration, /terminalAttempt\?\.status/);
  assert.match(narration, /continuation handoff/);
});

test("19 repeated terminal events are idempotent", () => {
  assert.equal(preferredTerminalStatus("completed", "failed"), "completed");
  assert.equal(preferredTerminalStatus("partial", "budget_exhausted"), "partial");
  assert.equal(preferredTerminalStatus("failed", "failed"), "failed");
});

test("20 maxTurns crossed after valid final response stays accepted", () => {
  const exactIncident = {
    success: false,
    state: "failed",
    turnBudgetExceeded: true,
    turnBudget: { maxTurns: 8, graceTurns: 2, turnCount: 15, outcome: "exceeded" },
    results: [{ agent: "explorer", exitCode: 0, outputState: "present", structuredOutput: { files: ["src/runtime.ts"], conclusion: "complete" }, output: "Complete structured final response." }],
  };
  const outcome = terminalOutcome({ reportedStatus: "failed", evidence: exactIncident, budgetStopReason: "turn budget exhausted (15/8+2 finalization)" });
  assert.equal(outcome.status, "completed");
  assert.equal(outcome.usableOutput, true);
});

for (const { name, fn } of tests) {
  fn();
  process.stdout.write(`ok ${name}\n`);
}
assert.equal(tests.length, 20);
console.log(JSON.stringify({ tests: tests.length, modelRouting: 9, budgetAndTerminal: 11, status: "passed" }));
