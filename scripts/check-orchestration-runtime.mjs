import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CURRENT_ORCHESTRATION_POLICY_VERSION,
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
  automaticTurnMayStart,
  sessionMutationMayPersist,
  independentSpawnParams,
  parsedMissionState,
} from "../src-tauri/resources/lemonpi-narration/extensions/narration.ts";

assert.equal(automaticTurnMayStart("passive-session"), false);
assert.equal(automaticTurnMayStart("user-input"), true);
assert.equal(automaticTurnMayStart("live-worker-event"), true);
assert.equal(sessionMutationMayPersist("passive-session"), false);
assert.equal(sessionMutationMayPersist("user-input"), true);
assert.equal(sessionMutationMayPersist("live-worker-event"), true);

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
assert.equal(migrated?.version, 5);
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
assert.equal(terminalPartialMission?.outcomes[0].status, "partial");
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
const defaultLimitPolicy = workerExecutionBudget("scout", "read-only", {});
assert.equal(defaultLimitPolicy.enabled, false);
assert.equal(defaultLimitPolicy.source, "disabled-default");
assert.deepEqual(defaultLimitPolicy.spawn, {});
assert.equal(workerBudgetPhase({ tokens: 130_730, turns: 44, toolCalls: 46, elapsedMs: 20 * 60_000 }, defaultLimitPolicy).hardStopReason, undefined);

const implementationBudget = workerExecutionBudget("worker", "implementation", {});
assert.equal(implementationBudget.enabled, false);
assert.deepEqual(implementationBudget.spawn, {});
assert.deepEqual(workerBudgetPhase({ tokens: 130_730, turns: 44, toolCalls: 46, elapsedMs: 60 * 60_000 }, implementationBudget), { phase: "work" });
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
const continuationRepo = join(root, "continuation-repo");
mkdirSync(join(continuationRepo, "src"), { recursive: true });
git(root, "init", continuationRepo);
git(continuationRepo, "config", "user.email", "lemonpi-tests@example.invalid");
git(continuationRepo, "config", "user.name", "LemonPi Tests");
writeFileSync(join(continuationRepo, "src", "feature.js"), "export const feature = 'base';\n");
writeFileSync(join(continuationRepo, "src", "registry.js"), "export const registry = [];\n");
writeFileSync(join(continuationRepo, "package.json"), "{\"type\":\"module\"}\n");
writeFileSync(join(continuationRepo, ".gitignore"), ".pi-subagents/\n");
commitAll(continuationRepo, "base continuation fixture");
const continuationBase = git(continuationRepo, "rev-parse", "HEAD");
writeFileSync(join(continuationRepo, "user-notes.txt"), "pre-existing unrelated work\n");

// Disabled limits allow a productive worker to cross the former thresholds,
// receive a diagnostic, fix it, and validate in the same filesystem state.
const unlimitedWorktree = join(root, "unlimited-worker");
git(continuationRepo, "worktree", "add", "--detach", unlimitedWorktree, continuationBase);
writeFileSync(join(unlimitedWorktree, "src", "feature.js"), "export const feature = { enabled: true };\n");
writeFileSync(join(unlimitedWorktree, "src", "registry.js"), "import { feature } from './feature.js';\nexport const registry = [feature]\n");
assert.equal(workerBudgetPhase({ tokens: 130_730, turns: 44, toolCalls: 46, elapsedMs: 20 * 60_000 }, implementationBudget).phase, "work");
assert.equal(spawnSync(process.execPath, ["--input-type=module", "-e", "import('./src/registry.js')"], { cwd: unlimitedWorktree }).status, 0);
git(continuationRepo, "worktree", "remove", "--force", unlimitedWorktree);

// Explicit hard-limit variant: preserve a substantial multi-file patch in a
// hidden checkpoint commit, then physically create continuation at that commit.
const interruptedWorktree = join(root, "interrupted-worker");
git(continuationRepo, "worktree", "add", "--detach", interruptedWorktree, continuationBase);
writeFileSync(join(interruptedWorktree, "src", "feature.js"), "export const feature = { enabled: true, unread: 3 };\n");
writeFileSync(join(interruptedWorktree, "src", "registry.js"), "import { feature } from './feature.js';\nexport const registry = [feature\n");
assert.notEqual(spawnSync(process.execPath, ["--input-type=module", "-e", "import('./src/registry.js')"], { cwd: interruptedWorktree }).status, 0);
const preservedPatch = join(continuationRepo, ".pi-subagents", "artifacts", "worktree-diffs", "budget-run.patch");
mkdirSync(join(continuationRepo, ".pi-subagents", "artifacts", "worktree-diffs"), { recursive: true });
const patchBytes = gitRaw(interruptedWorktree, "diff", "--binary", continuationBase, "--", "src/feature.js", "src/registry.js");
writeFileSync(preservedPatch, patchBytes);
const patchDigest = createHash("sha256").update(patchBytes).digest("hex");
git(interruptedWorktree, "add", "--", "src/feature.js", "src/registry.js");
git(interruptedWorktree, "commit", "-m", "LemonPi checkpoint budget-run");
const checkpointCommit = git(interruptedWorktree, "rev-parse", "HEAD");
git(continuationRepo, "update-ref", "refs/lemonpi/checkpoints/budget-run", checkpointCommit);
assert.equal(createHash("sha256").update(readFileSync(preservedPatch)).digest("hex"), patchDigest);
git(continuationRepo, "worktree", "remove", "--force", interruptedWorktree);

const resumedWorktree = join(root, "resumed-worker");
git(continuationRepo, "worktree", "add", "--detach", resumedWorktree, checkpointCommit);
assert.deepEqual(git(resumedWorktree, "diff", "--name-only", continuationBase, "HEAD").split("\n"), ["src/feature.js", "src/registry.js"]);
assert.match(readFileSync(join(resumedWorktree, "src", "feature.js"), "utf8"), /unread: 3/);
assert.notEqual(readFileSync(join(resumedWorktree, "src", "registry.js"), "utf8"), "export const registry = [];\n");
writeFileSync(join(resumedWorktree, "src", "registry.js"), "import { feature } from './feature.js';\nexport const registry = [feature];\n");
assert.equal(spawnSync(process.execPath, ["--input-type=module", "-e", "import('./src/registry.js')"], { cwd: resumedWorktree }).status, 0);
commitAll(resumedWorktree, "fix: complete checkpoint continuation");
const continuationFinalCommit = git(resumedWorktree, "rev-parse", "HEAD");
assert.equal(git(resumedWorktree, "merge-base", "--is-ancestor", checkpointCommit, continuationFinalCommit), "");
assert.equal(terminalOutcome({ reportedStatus: "stopped", budgetStopReason: "configured hard limit", stopCause: "optional_budget" }).status, "budget_exhausted");
assert.equal(terminalOutcome({ reportedStatus: "stopped", stopCause: "user" }).status, "stopped");

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
assert.match(validationDeduplicationIssue([validationRecord], { ...validation, scope: "final" }), /already passed/);
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

const continuationHandoffPath = join(continuationRepo, ".pi-subagents", "artifacts", "lemonpi-handoffs", "mission-checkpoint", "budget-run.json");
mkdirSync(join(continuationRepo, ".pi-subagents", "artifacts", "lemonpi-handoffs", "mission-checkpoint"), { recursive: true });
const checkpointAttempt = {
  runId: "budget-run",
  agent: "worker",
  originalObjective: "Complete the checkpoint feature",
  originalTask: "Complete the two-file feature.\nDone when: registry imports the feature and validation passes.",
  task: "Do not recursively embed this generated task.",
  purpose: "Complete checkpoint feature",
  status: "budget_exhausted",
  executionMode: "implementation",
  model: "openai/gpt-5.6",
  provider: "openai",
  modelId: "gpt-5.6",
  thinking: "high",
  settingsSource: "user-agent-override",
  settingsHash: "fixture-settings",
  completedOrdinal: 1,
  sliceCount: 1,
  transcriptBytes: 100,
  tokens: 130_730,
  repository: continuationRepo,
  baseRevision: continuationBase,
  ownedPaths: ["src/feature.js", "src/registry.js", "package.json"],
  preservedPatchPath: preservedPatch,
  checkpointRef: "refs/lemonpi/checkpoints/budget-run",
  checkpointCommit,
  checkpointBaseRevision: continuationBase,
  checkpointPatchDigest: patchDigest,
  checkpointChangedPaths: ["src/feature.js", "src/registry.js"],
  primaryValidation: { program: process.execPath, args: ["--input-type=module", "-e", "import('./src/registry.js')"] },
  checkpoint: "Feature files exist and focused validation is ready",
  stopProvenance: { cause: "optional_budget", initiator: "fixture", reason: "explicit fixture hard limit", requestedAt: 1 },
};
const checkpointHandoff = buildPartialWorkerHandoff({ attempt: checkpointAttempt, evidence: { latestOutput: "Compiler diagnostic remains in registry.js" }, stopReason: "explicit fixture hard limit" });
assert.ok(checkpointHandoff?.checkpoint);
writeFileSync(continuationHandoffPath, `${JSON.stringify(checkpointHandoff, null, 2)}\n`);

const continuationRpcListeners = new Map();
let actualContinuationWorktree = "";
let actualContinuationSpawn;
let actualContinuationSpawnCount = 0;
const continuationEvents = {
  on(name, handler) {
    const listeners = continuationRpcListeners.get(name) ?? new Set();
    listeners.add(handler);
    continuationRpcListeners.set(name, listeners);
    return () => listeners.delete(handler);
  },
  emit(name, payload) {
    if (name === "subagents:rpc:v1:request") {
      const request = payload;
      let data;
      if (request.method === "ping") {
        data = { version: 1, methods: ["ping", "status", "spawn", "steer", "stop"], capabilities: { processTerminalProof: { lifecycleArtifactVersion: 3 } } };
      } else if (request.method === "spawn") {
        actualContinuationSpawnCount += 1;
        actualContinuationSpawn = structuredClone(request.params);
        actualContinuationWorktree = request.params.cwd;
        assert.equal(request.params.tasks[0].reads, false);
        assert.equal(request.params.tasks[0].task.includes("context.md"), false);
        assert.equal(request.params.tasks[0].task.includes("plan.md"), false);
        assert.match(readFileSync(join(actualContinuationWorktree, "src", "feature.js"), "utf8"), /unread: 3/);
        assert.match(readFileSync(join(actualContinuationWorktree, "src", "registry.js"), "utf8"), /registry = \[feature/);
        assert.deepEqual(git(actualContinuationWorktree, "diff", "--name-only", continuationBase, "HEAD").split("\n"), ["src/feature.js", "src/registry.js"]);
        data = { runId: "continuation-run" };
      } else if (request.method === "status" && !request.params.id) {
        data = { protocolVersion: 2, fleet: { totalActive: 0 } };
      } else {
        data = { protocolVersion: 2, target: { runId: request.params.id, state: "running", metrics: { totalTokens: 1, turns: 1, toolCalls: 1, runtimeMs: 1 }, terminal: false, observedAt: Date.now() } };
      }
      continuationEvents.emit(`subagents:rpc:v1:reply:${request.requestId}`, { version: 1, requestId: request.requestId, method: request.method, success: true, data });
      return;
    }
    for (const handler of continuationRpcListeners.get(name) ?? []) handler(payload);
  },
};
const continuationTools = new Map();
const continuationHandlers = new Map();
const continuationSentMessages = [];
const continuationAppendedEntries = [];
const continuationPi = {
  registerTool(tool) { continuationTools.set(tool.name, tool); },
  on(event, handler) { continuationHandlers.set(event, handler); },
  appendEntry(customType, data) { continuationAppendedEntries.push({ customType, data: structuredClone(data) }); },
  sendMessage(message, options) { continuationSentMessages.push({ message, options }); },
  events: continuationEvents,
  async exec(program, args, options = {}) {
    const result = spawnSync(program, args, { cwd: options.cwd, encoding: "utf8", env: options.env ?? process.env, timeout: options.timeout });
    return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? result.error?.message ?? "" };
  },
};
lemonPiNarration(continuationPi);
const continuationBranch = [{ type: "custom", customType: "lemonpi-mission-state", data: {
  version: 5,
  policyVersion: CURRENT_ORCHESTRATION_POLICY_VERSION,
  id: "mission-checkpoint",
  phase: "delegated",
  request: "Complete the checkpoint feature",
  activeRunIds: [],
  writerActive: false,
  wakeAttempts: 0,
  updatedAt: Date.now(),
  attempts: [{ ...checkpointAttempt, partialHandoffPath: continuationHandoffPath, progressFingerprint: checkpointHandoff.progressFingerprint, outcomeId: "checkpoint-outcome" }],
  outcomes: [{ id: "checkpoint-outcome", subject: "Complete checkpoint feature", status: "partial", runIds: ["budget-run"], repository: continuationRepo, relevantPaths: checkpointAttempt.ownedPaths, updatedAt: Date.now() }],
  validations: [],
  reviews: [],
  pendingContinuations: [{ priorRunId: "budget-run", handoffPath: continuationHandoffPath, outcomeId: "checkpoint-outcome", progressFingerprint: checkpointHandoff.progressFingerprint, scheduledAt: Date.now() }],
} }];
const continuationContext = {
  cwd: continuationRepo,
  sessionManager: { getBranch: () => continuationBranch, getSessionId: () => "checkpoint-session" },
  modelRegistry: { getAvailable: () => [{ provider: "openai", id: "gpt-5.6" }] },
  getContextUsage: () => undefined,
  hasPendingMessages: () => false,
};
continuationHandlers.get("session_start")?.({ reason: "resume" }, continuationContext);
await continuationHandlers.get("agent_settled")?.({}, continuationContext);
await new Promise((resolve) => setTimeout(resolve, 650));
assert.equal(continuationSentMessages.some((entry) => entry.options?.triggerTurn === true), false);
assert.equal(continuationSentMessages.length, 0, "passive task restoration must not append invisible messages");
assert.equal(continuationAppendedEntries.length, 0, "passive task restoration must not append session metadata or change recency");
continuationHandlers.get("session_tree")?.({ reason: "switch" }, continuationContext);
await new Promise((resolve) => setTimeout(resolve, 650));
assert.equal(continuationSentMessages.length, 0, "passive task navigation must remain message-free after reconciliation");
assert.equal(continuationAppendedEntries.length, 0, "passive task navigation must preserve the conversation timestamp");
await continuationHandlers.get("input")?.({ source: "rpc", text: "Continue the checkpoint feature." }, continuationContext);
const actualContinuationLaunch = await continuationTools.get("lemonpi_dispatch").execute("actual-continuation", { lanes: [{
  agent: "worker",
  summary: "Finish checkpoint continuation",
  task: "Only the unresolved compiler correction remains.",
  cwd: continuationRepo,
  executionMode: "implementation",
  ownedPaths: checkpointAttempt.ownedPaths,
  primaryValidation: checkpointAttempt.primaryValidation,
  checkpoint: checkpointAttempt.checkpoint,
  continuationOf: "budget-run",
}] }, undefined, () => {}, continuationContext);
assert.equal(actualContinuationLaunch.isError, undefined);
assert.equal(actualContinuationLaunch.details.runs[0].runId, "continuation-run");
assert.equal(actualContinuationSpawn.turnBudget, undefined);
assert.equal(actualContinuationSpawn.toolBudget, undefined);
assert.equal(actualContinuationSpawn.usageBudget, undefined);
assert.equal(actualContinuationSpawn.timeoutMs, undefined);
const expandedOwnership = await continuationTools.get("lemonpi_expand_ownership").execute("expand-continuation-test", {
  runId: "continuation-run",
  paths: ["src/feature.test.js"],
  category: "direct-test",
  reason: "The focused fixture test imports the new feature directly.",
});
assert.equal(expandedOwnership.isError, undefined);
assert.deepEqual(expandedOwnership.details.paths, ["src/feature.test.js"]);
assert.equal(actualContinuationSpawnCount, 1);
await continuationHandlers.get("session_shutdown")?.();
if (actualContinuationWorktree) git(continuationRepo, "worktree", "remove", "--force", actualContinuationWorktree);

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
await extensionHandlers.get("input")?.({ source: "rpc", text: "Add an unread notification dot" }, {});
const gitTool = registeredTools.get("lemonpi_git");
assert.ok(gitTool);
const continuationIntegration = await gitTool.execute("checkpoint-continuation-integration", {
  action: "integrate_worktree",
  cwd: continuationRepo,
  worktreePath: resumedWorktree,
  paths: ["src/feature.js", "src/registry.js"],
  message: "integrate validated checkpoint continuation",
}, undefined, undefined, { cwd: continuationRepo });
assert.equal(continuationIntegration.isError, undefined);
assert.match(readFileSync(join(continuationRepo, "src", "feature.js"), "utf8"), /unread: 3/);
assert.match(readFileSync(join(continuationRepo, "src", "registry.js"), "utf8"), /\[feature\];/);
assert.equal(git(continuationRepo, "status", "--porcelain=v1"), "?? user-notes.txt");
assert.equal(git(continuationRepo, "log", "--format=%s", "--all").split("\n").filter((subject) => subject === "integrate validated checkpoint continuation").length, 1);
rmSync(join(continuationRepo, "user-notes.txt"));
assert.equal(git(continuationRepo, "status", "--porcelain=v1"), "");
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
console.log(JSON.stringify({
  policyVersion: CURRENT_ORCHESTRATION_POLICY_VERSION,
  scenarios: 31,
  physicalCheckpointContinuation: true,
  sourceRegexAssertions: 0,
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
