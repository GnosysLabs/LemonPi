import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CURRENT_ORCHESTRATION_POLICY_VERSION,
  FINALIZATION_BLOCKED_TOOLS,
  checkpointBlocker,
  checkpointBlockersForSelection,
  classifyDirtyTree,
  classifyFailure,
  contentHash,
  buildPartialWorkerHandoff,
  continuationIssue,
  fastPathIssue,
  hiddenScopeExpansionIssue,
  finalizationToolIssue,
  finalizationInstructionNeeded,
  implementationLaneIssue,
  immutableResumeBinding,
  internalContractFallback,
  invalidatesValidation,
  likelyFastPathRequest,
  launchPreflightIssue,
  missionStateContentHash,
  missionProgress,
  recoveryAction,
  recommendedReasoning,
  resolveAgentLaunchBinding,
  reducedIncidentReplay,
  resumeWorkerIssue,
  reviewDeduplicationIssue,
  scheduleOwnedLanes,
  supersedeHistoricalPolicy,
  telemetryUpdateIssue,
  terminalOutcome,
  trustedWorkerPatchPath,
  uniqueArtifactPath,
  validationActivityLabel,
  validationDeduplicationIssue,
  validationLaunchFailure,
  validateSubagentRpcHandshake,
  workerContextLimits,
  workerBudgetPhase,
  workerExecutionBudget,
  workerStatusMetrics,
  typedTargetStatusFromRunStatus,
} from "../src-tauri/resources/lemonpi-narration/extensions/orchestration-runtime.ts";
import {
  default as lemonPiNarration,
  compileDelegationContracts,
  delegatesImplementation,
  independentSpawnParams,
  parsedMissionState,
} from "../src-tauri/resources/lemonpi-narration/extensions/narration.ts";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function gitRaw(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function commitAll(cwd, message) {
  git(cwd, "add", "--all");
  git(cwd, "commit", "-m", message);
}

const migrated = parsedMissionState({
  version: 1,
  id: "legacy",
  phase: "planning",
  request: "Continue the mission",
  activeRunIds: [],
  writerActive: false,
  wakeAttempts: 0,
  updatedAt: Date.now(),
  suppressedRunIds: ["manual-stop-run"],
});
assert.equal(migrated?.version, 4);
assert.equal(migrated?.policyVersion, CURRENT_ORCHESTRATION_POLICY_VERSION);
assert.equal(migrated?.migratedFromPolicyVersion, 0);
assert.deepEqual(migrated?.suppressedRunIds, ["manual-stop-run"]);
const compactedLegacyMission = parsedMissionState({
  version: 2,
  policyVersion: 6,
  id: "legacy-seventeen-step-mission",
  phase: "integration",
  request: "Add an unread notification dot",
  activeRunIds: [],
  writerActive: false,
  wakeAttempts: 2,
  updatedAt: Date.now(),
  remainingTask: { id: 7, subject: "Validate Apple app behavior", status: "pending" },
  attempts: Array.from({ length: 4 }, (_, index) => ({
    runId: `legacy-run-${index}`,
    purpose: `Finish product slice ${index + 1}`,
    status: index === 3 ? "failed" : "completed",
    executionMode: "implementation",
    completedOrdinal: index + 1,
    sliceCount: 1,
    transcriptBytes: 1,
    tokens: 1,
    integrationStatus: "pending",
  })),
});
assert.equal(compactedLegacyMission?.outcomes.length, 3);
assert.equal(compactedLegacyMission?.remainingTask, undefined);
assert.equal(compactedLegacyMission?.outcomes.some((outcome) => outcome.subject.includes("Validate Apple")), false);
const terminalPartialMission = parsedMissionState({
  version: 4,
  policyVersion: CURRENT_ORCHESTRATION_POLICY_VERSION,
  id: "terminal-partial",
  phase: "integration",
  request: "Implement bounded UI",
  activeRunIds: [],
  writerActive: false,
  wakeAttempts: 0,
  updatedAt: Date.now(),
  attempts: [{ runId: "partial-run", purpose: "Implement bounded UI", status: "partial", executionMode: "implementation", completedOrdinal: 1, sliceCount: 1, transcriptBytes: 1, tokens: 1 }],
});
assert.equal(terminalPartialMission?.attempts[0].status, "partial");
assert.equal(terminalPartialMission?.outcomes[0].status, "pending");
const staleSummary = "Product decision: keep opaque IDs. Workflow rule: use one writer at a time.";
const superseded = supersedeHistoricalPolicy(staleSummary);
assert.match(superseded, /Product decision: keep opaque IDs/);
assert.match(superseded, new RegExp(`superseded by LemonPi orchestration policy v${CURRENT_ORCHESTRATION_POLICY_VERSION}`));

const root = mkdtempSync(join(tmpdir(), "lemonpi-orchestration-"));
const repo = join(root, "repo");
mkdirSync(join(repo, "src"), { recursive: true });
git(root, "init", repo);
git(repo, "config", "user.email", "lemonpi-tests@example.invalid");
git(repo, "config", "user.name", "LemonPi Tests");
writeFileSync(join(repo, "src", "base.ts"), "export const base = true;\n");
writeFileSync(join(repo, ".gitignore"), "dist/\n.pi-subagents/\n");
commitAll(repo, "base");

writeFileSync(join(repo, "src", "base.ts"), "export const base = 'intentional';\n");
let dirty = classifyDirtyTree(gitRaw(repo, "status", "--porcelain=v1", "--untracked-files=all").split("\n"), ["src/base.ts"]);
assert.equal(dirty[0]?.classification, "mission-work");
assert.equal(checkpointBlocker(dirty), undefined);
git(repo, "switch", "-c", "codex/recovery-synthetic");
git(repo, "add", "--", "src/base.ts");
git(repo, "commit", "-m", "wip: recover intentional source");
assert.equal(git(repo, "status", "--porcelain=v1"), "");
assert.match(readFileSync(join(repo, "src", "base.ts"), "utf8"), /intentional/);

writeFileSync(join(repo, ".env"), "TOKEN=never-commit-this\n");
dirty = classifyDirtyTree(gitRaw(repo, "status", "--porcelain=v1", "--untracked-files=all").split("\n"));
assert.equal(checkpointBlocker(dirty)?.classification, "suspicious");
assert.equal(git(repo, "status", "--porcelain=v1", "--untracked-files=all").includes(".env"), true);
rmSync(join(repo, ".env"));
const generated = classifyDirtyTree(["?? dist/bundle.js"]);
assert.equal(generated[0]?.classification, "generated");
const ambiguous = classifyDirtyTree(["?? notes.noextension", "?? another.unknown"]);
assert.deepEqual(
  checkpointBlockersForSelection(ambiguous, ["notes.noextension"], []),
  [ambiguous[0]],
);
const suspicious = classifyDirtyTree(["?? .env"]);
assert.equal(
  checkpointBlockersForSelection(suspicious, [".env"], [".env"])[0]?.classification,
  "suspicious",
);
assert.deepEqual(
  checkpointBlockersForSelection(ambiguous, ["notes.noextension"], ["notes.noextension"]),
  [],
);

const structuredWriter = {
  agent: "worker",
  summary: "Repair authenticated session catalogue",
  executionMode: "implementation",
  task: "Implement the session catalogue.\nDo not edit App/**.",
};
compileDelegationContracts(structuredWriter);
assert.equal(delegatesImplementation({ agent: "worker", task: structuredWriter.task }), true);
assert.match(structuredWriter.task, /Execution mode: implementation/);
const preparedSpawn = independentSpawnParams({ ...structuredWriter, cwd: "/tmp/prepared", reusePreparedWorktree: true });
assert.equal(preparedSpawn.implementation, true);
assert.equal(preparedSpawn.params.worktree, false);
assert.equal(independentSpawnParams({ ...structuredWriter, todoId: 7 }).params.tasks[0].todoId, undefined);

assert.equal(fastPathIssue({ request: "Add an unread dot", paths: ["src/Inbox.tsx", "src/inbox.css"] }), undefined);
assert.equal(likelyFastPathRequest("Add an unread dot"), true);
assert.equal(likelyFastPathRequest("Review the unread indicator implementation"), false);
assert.match(fastPathIssue({ request: "Add synchronized unread state", paths: ["src/Inbox.tsx"] }), /separately scoped/);
assert.match(fastPathIssue({ request: "Add an unread dot", paths: ["src/server/events.ts"] }), /ordinary UI source/);
assert.match(hiddenScopeExpansionIssue("Add an unread dot", ["Add websocket synchronization protocol"]), /local visible slice first/);
assert.equal(hiddenScopeExpansionIssue("Add synchronized unread state", ["Add websocket synchronization protocol"]), undefined);
assert.equal(internalContractFallback(1), "retry");
assert.equal(internalContractFallback(2), "fallback");

const asyncRunId = "1e9cba46-2055-40b7-9a89-a35a5e2934be";
const asyncPatch = `/tmp/pi-subagents/async-subagent-runs/${asyncRunId}/worktree-diffs/step-0/task-0-worker.patch`;
assert.equal(trustedWorkerPatchPath(asyncPatch, asyncRunId, [asyncRunId]), true);
assert.equal(trustedWorkerPatchPath(asyncPatch, "another-run", [asyncRunId]), false);
assert.equal(trustedWorkerPatchPath(".pi-subagents/artifacts/worktree-diffs/task.patch", undefined, []), true);

const disjoint = scheduleOwnedLanes([
  { id: "contracts", paths: ["src/contracts"] },
  { id: "storage", paths: ["src/storage"] },
  { id: "ui", paths: ["src/ui"] },
]);
assert.equal(disjoint.ready.length, 3);
assert.equal(disjoint.blocked.length, 0);
const overlap = scheduleOwnedLanes([
  { id: "router", paths: ["src/server"] },
  { id: "rpc", paths: ["src/server/rpc.ts"] },
  { id: "ui", paths: ["src/ui"] },
]);
assert.deepEqual(overlap.ready.map((lane) => lane.id), ["router", "ui"]);
assert.match(overlap.blocked[0].reason, /conflicts.*src\/server/);

const worktreeRoot = join(root, "lemonpi-worktrees");
mkdirSync(worktreeRoot);
for (const lane of disjoint.ready) {
  const path = join(worktreeRoot, lane.id);
  git(repo, "worktree", "add", "-b", `codex/mission-${lane.id}`, path, "HEAD");
  writeFileSync(join(path, `${lane.id}.txt`), `${lane.id}\n`);
  commitAll(path, `feat: integrate ${lane.id}`);
}
assert.equal((git(repo, "worktree", "list", "--porcelain").match(/^worktree /gm) ?? []).length, 4);
for (const lane of [...disjoint.ready].reverse()) git(repo, "worktree", "remove", join(worktreeRoot, lane.id));

const priorAttempt = {
  runId: "run-1",
  purpose: "Implement session catalogue",
  status: "completed",
  executionMode: "implementation",
  completedOrdinal: 1,
  sliceCount: 1,
  transcriptBytes: 250_000,
  tokens: 25_000,
};
assert.match(resumeWorkerIssue({ run: priorAttempt, lastCompletedRunId: "run-1", purpose: "Implement messages endpoint", correction: false }), /only resume.*bounded correction/i);
assert.equal(resumeWorkerIssue({ run: priorAttempt, lastCompletedRunId: "run-1", purpose: "Correct session query parser", correction: true }), undefined);
assert.match(resumeWorkerIssue({ run: { ...priorAttempt, status: "failed" }, lastCompletedRunId: "run-1", purpose: "Correct parser", correction: true }), /fresh bounded context/);
assert.match(resumeWorkerIssue({ run: { ...priorAttempt, transcriptBytes: 10_000_000 }, lastCompletedRunId: "run-1", purpose: "Correct parser", correction: true }), /too large/);
assert.match(resumeWorkerIssue({ run: { ...priorAttempt, executionMode: "read-only" }, lastCompletedRunId: "run-1", purpose: "Apply patch", correction: true }), /wrong-execution-mode/);
assert.deepEqual(workerContextLimits({ LEMONPI_WORKER_MAX_TRANSCRIPT_BYTES: "500000", LEMONPI_WORKER_MAX_TOKENS: "30000", LEMONPI_WORKER_MAX_SLICES: "1" }), {
  maxTranscriptBytes: 500_000,
  maxTokens: 30_000,
  maxSlices: 1,
});
const typedLegacyStatus = typedTargetStatusFromRunStatus({
  runId: "run-1",
  state: "running",
  totalTokens: { input: 40_000, output: 2_000, total: 42_000 },
  turnCount: 3,
  toolCount: 7,
  sessionFile: "/tmp/child.jsonl",
  lastUpdate: 49_000,
}, "run-1", 50_000);
assert.deepEqual(workerStatusMetrics(typedLegacyStatus, "run-1", 50_000), {
  runId: "run-1",
  tokens: 42_000,
  turns: 3,
  toolCalls: 7,
  elapsedMs: 0,
  activityState: "running",
  terminal: false,
  transcriptPaths: ["/tmp/child.jsonl"],
  observedAt: 49_000,
});
assert.deepEqual(workerStatusMetrics(typedTargetStatusFromRunStatus({ runId: "run-2", state: "running", totalTokens: 275_603, turnCount: 19, toolCount: 75, startedAt: 1_000, durationMs: 45_000, activityState: "running", lastUpdate: 50_000 }, "run-2", 51_000), "run-2", 51_000), {
  runId: "run-2",
  tokens: 275_603,
  turns: 19,
  toolCalls: 75,
  startedAt: 1_000,
  elapsedMs: 50_000,
  activityState: "running",
  terminal: false,
  transcriptPaths: [],
  observedAt: 50_000,
});
/* Target metrics are the only budget input; fleet order and fleet maxima are irrelevant. */
const fleet = [
  { runId: "run-a", metrics: { totalTokens: 128_168, turns: 17, toolCalls: 61 } },
  { runId: "run-b", metrics: { totalTokens: 39_319, turns: 4, toolCalls: 12 } },
  { runId: "run-c", metrics: { totalTokens: 85_663, turns: 9, toolCalls: 31 } },
  { runId: "run-d", metrics: { totalTokens: 61_547, turns: 7, toolCalls: 22 } },
];
function permutations(values) {
  if (values.length < 2) return [values];
  return values.flatMap((value, index) => permutations(values.filter((_, candidate) => candidate !== index)).map((rest) => [value, ...rest]));
}
const contaminatedFleetStatus = {
  protocolVersion: 2,
  target: {
    runId: "run-b",
    state: "running",
    metrics: { inputTokens: 30_000, outputTokens: 9_319, totalTokens: 39_319, turns: 4, toolCalls: 12, runtimeMs: 41_000 },
    terminal: false,
    observedAt: 49_000,
  },
  fleet,
};
for (const orderedFleet of permutations(fleet)) {
  assert.deepEqual(workerStatusMetrics({ ...contaminatedFleetStatus, fleet: orderedFleet }, "run-b", 50_000), {
    runId: "run-b",
    tokens: 39_319,
    turns: 4,
    toolCalls: 12,
    elapsedMs: 41_000,
    activityState: "running",
    terminal: false,
    transcriptPaths: [],
    observedAt: 49_000,
  });
}
assert.throws(() => workerStatusMetrics({ protocolVersion: 2, fleet }, "run-b"), /missing target|missing target\.runId/i);
assert.throws(() => workerStatusMetrics({ protocolVersion: 2, target: [{ runId: "run-b" }, { runId: "run-b" }] }, "run-b"), /ambiguous/i);
assert.throws(() => workerStatusMetrics({ ...contaminatedFleetStatus, targets: [contaminatedFleetStatus.target] }, "run-b"), /ambiguous/i);
assert.throws(() => workerStatusMetrics({ protocolVersion: 2, target: { runId: "run-b", state: "running", metrics: { totalTokens: "39319" } } }, "run-b"), /malformed totalTokens/i);
assert.throws(() => workerStatusMetrics({ ...contaminatedFleetStatus, target: { ...contaminatedFleetStatus.target, runId: "run-a" } }, "run-b"), /mismatch/i);
assert.equal(telemetryUpdateIssue({ telemetryObservedAt: 50_000 }, { observedAt: 49_000 }), "stale telemetry observation");
assert.equal(telemetryUpdateIssue({ telemetrySequence: 10 }, { observedAt: 51_000, sequence: 9 }), "stale telemetry sequence");
assert.equal(telemetryUpdateIssue({ telemetrySequence: 10 }, { observedAt: 51_000, sequence: 10 }), undefined);
assert.deepEqual(workerExecutionBudget("scout", "read-only", {}), {
  warning: { tokens: 48_000, turns: 8, toolCalls: 25, runtimeMs: 480_000 },
  work: { tokens: 60_000, turns: 10, toolCalls: 30, runtimeMs: 600_000 },
  finalization: { tokens: 6_000, turns: 2, runtimeMs: 120_000 },
  hard: { tokens: 66_000, turns: 12, toolCalls: 30, runtimeMs: 720_000 },
  spawn: {
    timeoutMs: 720_000,
    turnBudget: { maxTurns: 10, graceTurns: 2 },
    toolBudget: { soft: 25, hard: 30, block: FINALIZATION_BLOCKED_TOOLS },
    usageBudget: { tokens: { soft: 48_000, hard: 66_000 } },
  },
});

const implementationBudget = workerExecutionBudget("worker", "implementation", {});
const workerTotals = new Map([["run-a", 128_168], ["run-b", 39_319], ["run-c", 85_663], ["run-d", 61_547]]);
const stoppedByBudget = [];
for (const [runId, tokens] of workerTotals) {
  const phase = workerBudgetPhase({ tokens, turns: 1, toolCalls: 1, elapsedMs: 1_000 }, implementationBudget);
  if (phase.hardStopReason) stoppedByBudget.push(runId);
}
assert.deepEqual(stoppedByBudget, ["run-a"]);
const finalizingAtBoundary = workerBudgetPhase({ tokens: implementationBudget.work.tokens, turns: 1, toolCalls: 1, elapsedMs: 1_000 }, implementationBudget);
assert.equal(finalizingAtBoundary.phase, "finalizing");
assert.equal(finalizingAtBoundary.hardStopReason, undefined);
const finalizationAttempt = { finalizationInstructionSent: false };
assert.equal(finalizationInstructionNeeded(finalizationAttempt, "finalizing"), true);
finalizationAttempt.finalizationInstructionSent = true;
assert.equal(finalizationInstructionNeeded(finalizationAttempt, "finalizing"), false);
assert.equal(finalizationToolIssue({ toolName: "read", toolInput: { path: "/repo/src/ui.tsx" }, root: "/repo", ownedPaths: ["src/ui.tsx"] }), undefined);
assert.equal(finalizationToolIssue({ toolName: "bash", toolInput: { command: "git diff -- src/ui.tsx" }, ownedPaths: ["src/ui.tsx"] }), undefined);
assert.equal(finalizationToolIssue({ toolName: "bash", toolInput: { command: "pnpm test -- ui" }, ownedPaths: ["src/ui.tsx"], primaryValidation: { program: "pnpm", args: ["test", "--", "ui"] } }), undefined);
assert.match(finalizationToolIssue({ toolName: "edit", toolInput: { path: "src/ui.tsx" }, ownedPaths: ["src/ui.tsx"] }), /blocks new exploration/i);
assert.match(finalizationToolIssue({ toolName: "read", toolInput: { path: "/repo/src/backend.ts" }, root: "/repo", ownedPaths: ["src/ui.tsx"] }), /only inside/i);
assert.match(implementationLaneIssue({ ownedPaths: Array.from({ length: 9 }, (_, index) => `src/file-${index}.ts`), primaryValidation: { program: "pnpm", args: ["check"] }, checkpoint: "Runtime slice" }), /split/i);
assert.match(implementationLaneIssue({ ownedPaths: ["src-tauri/src/lib.rs", "src/App.tsx", "scripts/check.mjs"], primaryValidation: { program: "pnpm", args: ["check"] }, checkpoint: "Everything" }), /ownership boundaries/i);
assert.equal(implementationLaneIssue({ ownedPaths: ["src/ui/Inbox.tsx"], primaryValidation: { program: "pnpm", args: ["test", "Inbox"] }, checkpoint: "Unread indicator renders" }), undefined);

const bindingResolution = resolveAgentLaunchBinding({
  agent: "worker",
  userSettings: { subagents: { agentOverrides: { worker: { model: "openai/gpt-5.6", thinking: "high" } } } },
  availableModels: ["openai/gpt-5.6"],
});
assert.ok(bindingResolution.binding);
const boundAttempt = {
  runId: "budget-run",
  agent: "worker",
  task: "Implement the bounded UI slice.\nDone when: unread dot renders.",
  purpose: "Render unread dot",
  status: "budget_exhausted",
  executionMode: "implementation",
  model: bindingResolution.binding.model,
  provider: bindingResolution.binding.provider,
  modelId: bindingResolution.binding.modelId,
  thinking: bindingResolution.binding.thinking,
  settingsSource: bindingResolution.binding.source,
  settingsHash: bindingResolution.binding.settingsHash,
  completedOrdinal: 1,
  sliceCount: 1,
  transcriptBytes: 10,
  tokens: 128_168,
  ownedPaths: ["src/ui/Inbox.tsx"],
  preservedPatchPath: "/tmp/budget-run.patch",
  primaryValidation: { program: "pnpm", args: ["test", "Inbox"] },
  checkpoint: "Unread indicator renders",
  stopProvenance: { cause: "budget", initiator: "lemonpi-budget-controller", reason: "token budget exhausted", requestedAt: 5_000 },
};
const partialHandoff = buildPartialWorkerHandoff({ attempt: boundAttempt, evidence: { output: "Unread component implemented; integration remains." }, stopReason: "token budget exhausted" });
assert.ok(partialHandoff);
assert.equal(partialHandoff.stop.cause, "budget");
assert.equal(partialHandoff.currentDiff.patchPath, "/tmp/budget-run.patch");
assert.equal(partialHandoff.continuationOf, "budget-run");
assert.doesNotMatch(partialHandoff.continuationTask, /repeat discovery/i);
assert.match(partialHandoff.continuationTask, /restore the preserved patch at \/tmp\/budget-run\.patch from the exact prior base/i);
assert.equal(continuationIssue({ previous: boundAttempt, handoff: partialHandoff, priorFingerprints: [] }), undefined);
assert.match(continuationIssue({ previous: { ...boundAttempt, continuationDepth: 2 }, handoff: partialHandoff, priorFingerprints: [] }), /limit reached/i);
assert.match(continuationIssue({ previous: boundAttempt, handoff: partialHandoff, priorFingerprints: [partialHandoff.progressFingerprint] }), /no measurable progress/i);
assert.deepEqual(immutableResumeBinding(boundAttempt), bindingResolution.binding);

const continuationRepo = join(root, "continuation-repo");
mkdirSync(join(continuationRepo, "src"), { recursive: true });
git(root, "init", continuationRepo);
git(continuationRepo, "config", "user.email", "lemonpi-tests@example.invalid");
git(continuationRepo, "config", "user.name", "LemonPi Tests");
writeFileSync(join(continuationRepo, "src", "Inbox.tsx"), "export const unread = false;\n");
commitAll(continuationRepo, "base continuation fixture");
const continuationBase = git(continuationRepo, "rev-parse", "HEAD");
const interruptedWorktree = join(root, "interrupted-worker");
git(continuationRepo, "worktree", "add", "--detach", interruptedWorktree, continuationBase);
writeFileSync(join(interruptedWorktree, "src", "Inbox.tsx"), "export const unread = true; // preserved partial slice\n");
const preservedPatch = join(root, "budget-run.patch");
writeFileSync(preservedPatch, gitRaw(interruptedWorktree, "diff", "--binary", continuationBase, "--", "src/Inbox.tsx"));
git(continuationRepo, "worktree", "remove", "--force", interruptedWorktree);
const resumedWorktree = join(root, "resumed-worker");
git(continuationRepo, "worktree", "add", "--detach", resumedWorktree, continuationBase);
git(resumedWorktree, "apply", "--3way", preservedPatch);
assert.match(readFileSync(join(resumedWorktree, "src", "Inbox.tsx"), "utf8"), /preserved partial slice/);
assert.equal(git(resumedWorktree, "diff", "--name-only", continuationBase), "src/Inbox.tsx");
assert.equal(terminalOutcome({ reportedStatus: "stopped", budgetStopReason: "token budget exhausted", stopCause: "budget" }).status, "budget_exhausted");
assert.equal(terminalOutcome({ reportedStatus: "stopped", stopCause: "user" }).status, "stopped");
assert.equal(terminalOutcome({ reportedStatus: "stopped", stopCause: "user", evidence: { output: "Completed before stop", exitCode: 0 } }).status, "completed");
assert.equal(terminalOutcome({ reportedStatus: "stopped", budgetStopReason: "token budget exhausted", stopCause: "budget", evidence: { output: "Completed bounded slice", exitCode: 0 } }).status, "completed");

const simulatedFourWorkerMission = [...workerTotals].map(([runId, tokens]) => {
  const budgetState = workerBudgetPhase({ tokens, turns: 1, toolCalls: 1, elapsedMs: 1_000 }, implementationBudget);
  if (!budgetState.hardStopReason) return { runId, state: "running", tokens, stop: undefined };
  const attempt = { ...boundAttempt, runId, tokens, stopProvenance: { ...boundAttempt.stopProvenance, reason: budgetState.hardStopReason } };
  const handoff = buildPartialWorkerHandoff({ attempt, evidence: { patchPath: attempt.preservedPatchPath, output: "Bounded partial implementation preserved." }, stopReason: budgetState.hardStopReason });
  return { runId, state: "budget_exhausted", tokens, stop: attempt.stopProvenance, handoff, continuationAllowed: continuationIssue({ previous: attempt, handoff, priorFingerprints: [] }) === undefined };
});
assert.deepEqual(simulatedFourWorkerMission.map(({ runId, state }) => [runId, state]), [
  ["run-a", "budget_exhausted"],
  ["run-b", "running"],
  ["run-c", "running"],
  ["run-d", "running"],
]);
assert.equal(simulatedFourWorkerMission[0].stop.cause, "budget");
assert.equal(simulatedFourWorkerMission[0].continuationAllowed, true);
assert.equal(JSON.stringify(simulatedFourWorkerMission).includes("stopped by user"), false);

assert.doesNotThrow(() => validateSubagentRpcHandshake({
  version: 1,
  methods: ["ping", "status", "spawn", "steer", "stop"],
  capabilities: { processTerminalProof: { lifecycleArtifactVersion: 3 } },
}));
assert.throws(() => validateSubagentRpcHandshake({ version: 2, methods: [], capabilities: {} }), /expected 1/i);
assert.throws(() => validateSubagentRpcHandshake({ version: 1, methods: ["ping"], capabilities: { processTerminalProof: { lifecycleArtifactVersion: 3 } } }), /missing 'status'/i);
assert.equal(
  missionStateContentHash({ id: "mission", updatedAt: 1, attempts: [] }),
  missionStateContentHash({ attempts: [], updatedAt: 999, id: "mission" }),
);

assert.match(launchPreflightIssue({
  agent: "planner",
  availableAgents: ["planner"],
  mode: "implementation",
  agentTools: ["read", "grep"],
  repositoryExists: true,
  ownedPaths: ["src"],
  outputPath: "out-1",
  existingOutputPaths: new Set(),
}), /no write or edit tool/);
assert.equal(launchPreflightIssue({
  agent: "worker",
  availableAgents: ["worker"],
  mode: "implementation",
  agentTools: ["read", "apply_patch"],
  repositoryExists: true,
  ownedPaths: ["src"],
  outputPath: "out-1",
  existingOutputPaths: new Set(),
}), undefined);

const review = { repository: repo, revision: git(repo, "rev-parse", "HEAD"), diffHash: "diff-1", scope: ["src/auth"], riskBoundary: "authentication" };
assert.match(reviewDeduplicationIssue([{ ...review, accepted: true }], review), /already has an accepted review/);
assert.match(reviewDeduplicationIssue([{ ...review, accepted: true }], { ...review, riskBoundary: "rewritten security rationale" }), /already has an accepted review/);
assert.equal(reviewDeduplicationIssue([{ ...review, accepted: true }], { ...review, diffHash: "diff-2" }), undefined);

const validation = { repository: repo, baseRevision: review.revision, diffHash: "diff-1", executable: "/usr/local/bin/pnpm", args: ["test"], cwd: repo, environmentHash: "env-1", command: "pnpm test", relevantPaths: ["src/auth"], dependencyState: "deps-1", scope: "wave" };
const validationRecord = { ...validation, passed: true, elapsedMs: 2_000 };
assert.match(validationDeduplicationIssue([validationRecord], validation), /already passed/);
assert.equal(validationDeduplicationIssue([validationRecord], { ...validation, scope: "final" }), undefined);
assert.equal(validationDeduplicationIssue([validationRecord], { ...validation, diffHash: "diff-2" }), undefined);
assert.equal(validationDeduplicationIssue([validationRecord], { ...validation, executable: "C:/tools/pnpm.cmd" }), undefined);
assert.equal(validationLaunchFailure(-1, "spawn pnpm ENOENT"), true);
assert.equal(validationLaunchFailure(1, "Tests failed: assertion mismatch"), false);
assert.equal(invalidatesValidation(validationRecord, ["src/ui/button.tsx"], "deps-1"), false);
assert.equal(invalidatesValidation(validationRecord, ["src/auth/token.ts"], "deps-1"), true);
assert.equal(invalidatesValidation(validationRecord, [], "deps-2"), true);
assert.equal(validationActivityLabel("pnpm test", 1_000, 66_000), "Validation active: pnpm test · 65s elapsed");

assert.equal(classifyFailure("rg: invalid option -- z"), "command-syntax");
assert.equal(recoveryAction("command-syntax", 0), "correct-command-in-context");
assert.equal(recoveryAction("command-syntax", 1), "preserve-partial-work-and-launch-fresh-smaller-context");
assert.equal(recoveryAction("test-failure", 0), "preserve-work-and-retry-failed-check");

const artifacts = new Set(Array.from({ length: 10 }, (_, index) => uniqueArtifactPath("mission", `slice-${index}`, index + 1)));
assert.equal(artifacts.size, 10);
assert.ok([...artifacts].every((value) => value.endsWith(".json")));
assert.deepEqual(missionProgress([
  { id: "contracts", status: "accepted" },
  { id: "storage", status: "accepted" },
  { id: "ui", status: "active" },
  { id: "final", status: "pending" },
]), { accepted: 2, total: 4, percentage: 50 });

assert.equal(recommendedReasoning("scout", "Find the router"), "low");
assert.equal(recommendedReasoning("worker", "Implement routine UI"), "medium");
assert.equal(recommendedReasoning("reviewer", "Review authentication boundary"), "high");

const transactionRepo = join(root, "transaction-repo");
mkdirSync(join(transactionRepo, "src"), { recursive: true });
git(root, "init", transactionRepo);
git(transactionRepo, "config", "user.email", "lemonpi-tests@example.invalid");
git(transactionRepo, "config", "user.name", "LemonPi Tests");
writeFileSync(join(transactionRepo, "src", "indicator.ts"), "export const indicator = 'base';\n");
commitAll(transactionRepo, "base transaction fixture");
const transactionBase = git(transactionRepo, "rev-parse", "HEAD");
const sourceOne = join(root, "transaction-source-one");
git(transactionRepo, "worktree", "add", "-b", "source-one", sourceOne, transactionBase);
writeFileSync(join(sourceOne, "src", "indicator.ts"), "export const indicator = 'implemented';\n");
writeFileSync(join(sourceOne, "src", "badge.ts"), "export const badge = true;\n");
commitAll(sourceOne, "implement complete visible slice");
writeFileSync(join(sourceOne, "src", "indicator.ts"), "export const indicator = 'corrected';\n");
commitAll(sourceOne, "correct visible slice");
writeFileSync(join(transactionRepo, "local-notes.txt"), "unrelated baseline change\n");

const registeredTools = new Map();
const extensionHandlers = new Map();
const sentMessages = [];
const appendedEntries = [];
let simulatePnpmLaunchFailure = false;
let simulatePnpmCmdSuccess = false;
const fakePi = {
  registerTool(tool) { registeredTools.set(tool.name, tool); },
  on(event, handler) { extensionHandlers.set(event, handler); },
  appendEntry(customType, data) { appendedEntries.push({ customType, data: structuredClone(data) }); },
  sendMessage(message, options) { sentMessages.push({ message, options }); },
  events: { on() { return () => {}; }, emit() {} },
  async exec(program, args, options = {}) {
    if (program === "pnpm" && simulatePnpmLaunchFailure) return { code: -1, stdout: "", stderr: "spawn pnpm ENOENT" };
    if (program === "pnpm.cmd" && simulatePnpmCmdSuccess) return { code: 0, stdout: "corrected validation launched", stderr: "" };
    const result = spawnSync(program, args, {
      cwd: options.cwd,
      encoding: "utf8",
      env: process.env,
      timeout: options.timeout,
    });
    return {
      code: result.status ?? 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? result.error?.message ?? "",
    };
  },
};
lemonPiNarration(fakePi);
const gitTool = registeredTools.get("lemonpi_git");
assert.ok(gitTool);
const integrationResult = await gitTool.execute("transaction-success", {
  action: "integrate_worktree",
  cwd: transactionRepo,
  worktreePath: sourceOne,
  paths: ["src/indicator.ts", "src/badge.ts"],
  message: "integrate full parent and correction",
}, undefined, undefined, { cwd: transactionRepo });
assert.equal(integrationResult.isError, undefined);
assert.match(readFileSync(join(transactionRepo, "src", "indicator.ts"), "utf8"), /corrected/);
assert.match(readFileSync(join(transactionRepo, "src", "badge.ts"), "utf8"), /true/);
assert.equal(git(transactionRepo, "status", "--porcelain=v1"), "?? local-notes.txt");
assert.match(readFileSync(join(transactionRepo, "local-notes.txt"), "utf8"), /unrelated baseline/);
rmSync(join(transactionRepo, "local-notes.txt"));
assert.equal(git(transactionRepo, "status", "--porcelain=v1"), "");

const sourceTwo = join(root, "transaction-source-two");
git(transactionRepo, "worktree", "add", "-b", "source-two", sourceTwo, transactionBase);
writeFileSync(join(sourceTwo, "src", "indicator.ts"), "export const indicator = 'conflicting-worker';\n");
commitAll(sourceTwo, "create conflicting worker slice");
const targetBeforeConflict = git(transactionRepo, "rev-parse", "HEAD");
const conflictResult = await gitTool.execute("transaction-conflict", {
  action: "integrate_worktree",
  cwd: transactionRepo,
  worktreePath: sourceTwo,
  paths: ["src/indicator.ts"],
  message: "reject conflicting worker slice",
}, undefined, undefined, { cwd: transactionRepo });
assert.equal(conflictResult.isError, true);
assert.equal(conflictResult.details?.targetUnchanged, true);
assert.equal(git(transactionRepo, "rev-parse", "HEAD"), targetBeforeConflict);
assert.equal(git(transactionRepo, "status", "--porcelain=v1"), "");
assert.notEqual(spawnSync("git", ["rev-parse", "--verify", "CHERRY_PICK_HEAD"], { cwd: transactionRepo }).status, 0);

const conflictRecoveryRepo = join(root, "conflict-recovery");
mkdirSync(join(conflictRecoveryRepo, "src"), { recursive: true });
git(root, "init", conflictRecoveryRepo);
git(conflictRecoveryRepo, "config", "user.email", "lemonpi-tests@example.invalid");
git(conflictRecoveryRepo, "config", "user.name", "LemonPi Tests");
writeFileSync(join(conflictRecoveryRepo, "src", "conflict.ts"), "export const side = 'base';\n");
commitAll(conflictRecoveryRepo, "base conflict fixture");
const conflictBaseBranch = git(conflictRecoveryRepo, "branch", "--show-current");
git(conflictRecoveryRepo, "switch", "-c", "incoming-conflict");
writeFileSync(join(conflictRecoveryRepo, "src", "conflict.ts"), "export const side = 'incoming';\n");
commitAll(conflictRecoveryRepo, "incoming conflict");
const incomingConflict = git(conflictRecoveryRepo, "rev-parse", "HEAD");
git(conflictRecoveryRepo, "switch", conflictBaseBranch);
writeFileSync(join(conflictRecoveryRepo, "src", "conflict.ts"), "export const side = 'current';\n");
commitAll(conflictRecoveryRepo, "current conflict");
assert.notEqual(spawnSync("git", ["cherry-pick", incomingConflict], { cwd: conflictRecoveryRepo, encoding: "utf8" }).status, 0);
const incompleteConflictConfirmation = await gitTool.execute("conflict-confirmation-incomplete", {
  action: "resolve_conflicts_to_head",
  cwd: conflictRecoveryRepo,
  paths: ["src/conflict.ts"],
  confirmedPaths: [],
}, undefined, undefined, { cwd: conflictRecoveryRepo });
assert.equal(incompleteConflictConfirmation.isError, true);
assert.equal(git(conflictRecoveryRepo, "diff", "--name-only", "--diff-filter=U"), "src/conflict.ts");
const recoveredConflict = await gitTool.execute("conflict-confirmation-complete", {
  action: "resolve_conflicts_to_head",
  cwd: conflictRecoveryRepo,
  paths: ["src/conflict.ts"],
  confirmedPaths: ["src/conflict.ts"],
}, undefined, undefined, { cwd: conflictRecoveryRepo });
assert.equal(recoveredConflict.isError, undefined);
assert.equal(git(conflictRecoveryRepo, "diff", "--name-only", "--diff-filter=U"), "");
assert.match(readFileSync(join(conflictRecoveryRepo, "src", "conflict.ts"), "utf8"), /current/);
assert.equal(spawnSync("git", ["cherry-pick", "--skip"], { cwd: conflictRecoveryRepo }).status, 0);

const canaryRepo = join(root, "fast-path-canary");
mkdirSync(join(canaryRepo, "src"), { recursive: true });
git(root, "init", canaryRepo);
git(canaryRepo, "config", "user.email", "lemonpi-tests@example.invalid");
git(canaryRepo, "config", "user.name", "LemonPi Tests");
writeFileSync(join(canaryRepo, "src", "Inbox.tsx"), "export const Inbox = () => null;\n");
commitAll(canaryRepo, "base fast-path canary");
writeFileSync(join(canaryRepo, "user-notes.txt"), "pre-existing unrelated user work\n");
await extensionHandlers.get("message_start")?.({ message: { role: "user", content: "Add an unread notification dot" } });
await extensionHandlers.get("before_agent_start")?.({ prompt: "Add an unread notification dot", systemPrompt: "base" });
const dispatchTool = registeredTools.get("lemonpi_dispatch");
const fastPathTool = registeredTools.get("lemonpi_fast_path");
const validationTool = registeredTools.get("lemonpi_validate");
const canaryContext = { cwd: canaryRepo, sessionManager: { getSessionId: () => "canary-session" } };
const dispatchedCanary = await dispatchTool.execute("fast-path-dispatch", {
  lanes: [{
    agent: "worker",
    summary: "Add unread notification dot",
    task: "Add the local visible unread notification dot.",
    cwd: canaryRepo,
    executionMode: "implementation",
    ownedPaths: ["src/Inbox.tsx"],
  }],
}, undefined, undefined, canaryContext);
assert.equal(dispatchedCanary.isError, undefined);
assert.equal(dispatchedCanary.details?.mode, "fast-path");
const mutationGuard = await extensionHandlers.get("tool_call")?.({ toolName: "edit", toolCallId: "canary-edit", input: { path: "src/Inbox.tsx" } }, { ui: { notify() {} } });
assert.equal(mutationGuard, undefined);
writeFileSync(join(canaryRepo, "src", "Inbox.tsx"), "export const Inbox = () => <i data-unread />;\n");
simulatePnpmLaunchFailure = true;
const failedPnpmValidation = await validationTool.execute("canary-validation-pnpm", {
  cwd: canaryRepo,
  program: "pnpm",
  args: ["check"],
  relevantPaths: ["src/Inbox.tsx"],
  scope: "focused",
}, undefined, undefined, canaryContext);
assert.equal(failedPnpmValidation.isError, true);
assert.equal(failedPnpmValidation.details?.infrastructureFailure, true);
simulatePnpmLaunchFailure = false;
simulatePnpmCmdSuccess = true;
const canaryValidation = await validationTool.execute("canary-validation-pnpm-cmd", {
  cwd: canaryRepo,
  program: "pnpm.cmd",
  args: ["check"],
  relevantPaths: ["src/Inbox.tsx"],
  scope: "focused",
}, undefined, undefined, canaryContext);
assert.equal(canaryValidation.isError, undefined);
assert.notEqual(failedPnpmValidation.details?.candidate.executable, canaryValidation.details?.candidate.executable);
simulatePnpmCmdSuccess = false;
const finishedCanary = await fastPathTool.execute("canary-finish", {
  action: "finish",
  cwd: canaryRepo,
  paths: ["src/Inbox.tsx"],
  summary: "Add unread notification dot",
}, undefined, undefined, canaryContext);
assert.equal(finishedCanary.isError, undefined);
assert.equal(finishedCanary.details?.validationCount, 1);
await new Promise((resolvePromise) => setTimeout(resolvePromise, 80));
const fastPathMission = [...appendedEntries].reverse().find((entry) => entry.customType === "lemonpi-mission-state")?.data;
assert.equal(fastPathMission?.pathProvenance?.some((item) => item.path === "src/Inbox.tsx" && item.source === "fast-path"), true);
assert.equal(fastPathMission?.pathProvenance?.some((item) => item.path === "user-notes.txt" && item.source === "baseline"), true);
assert.equal(sentMessages.some((entry) => entry.message?.customType === "lemonpi-mission-outcomes"), false);
const repeatedFastPath = await fastPathTool.execute("canary-repeat", {
  action: "start",
  cwd: canaryRepo,
  paths: ["src/Inbox.tsx"],
  summary: "Add unread notification dot",
}, undefined, undefined, canaryContext);
assert.equal(repeatedFastPath.isError, true);
assert.match(repeatedFastPath.content[0].text, /already implemented and validated/);
for (let index = 0; index < 13; index += 1) {
  const readGuard = await extensionHandlers.get("tool_call")?.({
    toolName: "read",
    toolCallId: `post-finish-read-${index}`,
    input: { path: "src/Inbox.tsx" },
  }, { ui: { notify() {} } });
  assert.equal(readGuard, undefined);
}
const commitGuard = await extensionHandlers.get("tool_call")?.({
  toolName: "lemonpi_git",
  toolCallId: "canary-finalize",
  input: { action: "commit", paths: ["src/Inbox.tsx"] },
}, { cwd: canaryRepo, ui: { notify() {} } });
assert.equal(commitGuard, undefined);
const committedCanary = await gitTool.execute("canary-finalize", {
  action: "commit",
  cwd: canaryRepo,
  paths: ["src/Inbox.tsx"],
  message: "feat: add unread indicator",
}, undefined, undefined, canaryContext);
assert.equal(committedCanary.isError, undefined);
assert.equal(git(canaryRepo, "status", "--porcelain=v1"), "?? user-notes.txt");
assert.match(readFileSync(join(canaryRepo, "user-notes.txt"), "utf8"), /pre-existing unrelated/);
rmSync(join(canaryRepo, "user-notes.txt"));
assert.equal(git(canaryRepo, "status", "--porcelain=v1"), "");
await new Promise((resolvePromise) => setTimeout(resolvePromise, 80));
assert.equal(sentMessages.some((entry) => entry.message?.customType === "lemonpi-mission-outcomes"), false);
await extensionHandlers.get("message_end")?.({ message: { role: "assistant", content: "Unread dot implemented, checked, and committed.", stopReason: "stop" } });
await extensionHandlers.get("agent_settled")?.({}, {
  getContextUsage: () => ({ percent: 0 }),
  hasPendingMessages: () => false,
  compact() {},
});
const outcomePublications = sentMessages.filter((entry) => entry.message?.customType === "lemonpi-mission-outcomes");
assert.equal(outcomePublications.length, 1);
assert.equal(outcomePublications[0].options?.triggerTurn, false);
assert.equal(Object.hasOwn(outcomePublications[0].options ?? {}, "deliverAs"), false);
await extensionHandlers.get("session_shutdown")?.();

const oldMetrics = reducedIncidentReplay("old");
const currentMetrics = reducedIncidentReplay("current");
assert.ok(currentMetrics.criticalPathMinutes < oldMetrics.criticalPathMinutes);
assert.ok(currentMetrics.modelTurns < oldMetrics.modelTurns);
assert.equal(currentMetrics.reviewerRuns, 2);
assert.equal(currentMetrics.failedLaunches, 0);
assert.equal(currentMetrics.duplicateValidations, 0);
assert.equal(currentMetrics.workerTranscriptReuses, 1);
assert.equal(currentMetrics.checkpoints, 1);
assert.ok(currentMetrics.integrationCommits > 0);

writeFileSync(join(repo, "logical.txt"), `${contentHash(JSON.stringify(currentMetrics))}\n`);
commitAll(repo, "feat: logical final integration");
assert.equal(git(repo, "status", "--porcelain=v1"), "");
const narrationSource = readFileSync(new URL("../src-tauri/resources/lemonpi-narration/extensions/narration.ts", import.meta.url), "utf8");
assert.doesNotMatch(narrationSource, /git\s+reset\s+--hard|git\s+clean\s+-|force-push/);
assert.match(narrationSource, /Refusing to commit.*classified as/);
assert.doesNotMatch(narrationSource, /branches must use codex|Recovery branches must use codex/i);
assert.match(narrationSource, /subagentOnlyExtensions = \[FINALIZATION_GUARD_PATH\]/);
assert.match(narrationSource, /worktree", "add", "--detach", continuationWorktree/);
assert.match(narrationSource, /"apply", "--3way", canonicalPatch/);
assert.match(narrationSource, /Continue from the existing diff; do not recreate completed work/);
const hardStopBlock = narrationSource.slice(narrationSource.indexOf("if (!state.hardStopReason) return"), narrationSource.indexOf("const recordTerminalAttempt"));
assert.ok(hardStopBlock.indexOf("preserveAttemptPatch") < hardStopBlock.indexOf("requestSubagentStop"));

console.log(JSON.stringify({
  policyVersion: CURRENT_ORCHESTRATION_POLICY_VERSION,
  scenarios: 29,
  oldPolicy: oldMetrics,
  currentPolicy: currentMetrics,
  deltas: {
    criticalPathMinutes: currentMetrics.criticalPathMinutes - oldMetrics.criticalPathMinutes,
    modelTurns: currentMetrics.modelTurns - oldMetrics.modelTurns,
    reviewerRuns: currentMetrics.reviewerRuns - oldMetrics.reviewerRuns,
    duplicateValidations: currentMetrics.duplicateValidations - oldMetrics.duplicateValidations,
    contextKilobytes: currentMetrics.contextKilobytes - oldMetrics.contextKilobytes,
    testMinutes: currentMetrics.testMinutes - oldMetrics.testMinutes,
  },
}, null, 2));

rmSync(root, { recursive: true, force: true });
