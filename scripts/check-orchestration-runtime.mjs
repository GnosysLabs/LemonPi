import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CURRENT_ORCHESTRATION_POLICY_VERSION,
  checkpointBlocker,
  classifyDirtyTree,
  classifyFailure,
  contentHash,
  invalidatesValidation,
  launchPreflightIssue,
  missionProgress,
  recoveryAction,
  recommendedReasoning,
  reducedIncidentReplay,
  resumeWorkerIssue,
  reviewDeduplicationIssue,
  scheduleOwnedLanes,
  supersedeHistoricalPolicy,
  uniqueArtifactPath,
  validationActivityLabel,
  validationDeduplicationIssue,
  workerContextLimits,
  workerStatusMetrics,
} from "../src-tauri/resources/lemonpi-narration/extensions/orchestration-runtime.ts";
import { parsedMissionState } from "../src-tauri/resources/lemonpi-narration/extensions/narration.ts";

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
});
assert.equal(migrated?.version, 2);
assert.equal(migrated?.policyVersion, CURRENT_ORCHESTRATION_POLICY_VERSION);
assert.equal(migrated?.migratedFromPolicyVersion, 0);
const staleSummary = "Product decision: keep opaque IDs. Workflow rule: use one writer at a time.";
const superseded = supersedeHistoricalPolicy(staleSummary);
assert.match(superseded, /Product decision: keep opaque IDs/);
assert.match(superseded, /superseded by LemonPi orchestration policy v2/);

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
assert.deepEqual(workerStatusMetrics({ details: { tokens: { total: 42_000 }, sessionFile: "/tmp/child.jsonl" } }), {
  tokens: 42_000,
  transcriptPaths: ["/tmp/child.jsonl"],
});

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
assert.equal(reviewDeduplicationIssue([{ ...review, accepted: true }], { ...review, diffHash: "diff-2" }), undefined);

const validation = { repository: repo, baseRevision: review.revision, diffHash: "diff-1", command: "pnpm test", relevantPaths: ["src/auth"], dependencyState: "deps-1", scope: "wave" };
const validationRecord = { ...validation, passed: true, elapsedMs: 2_000 };
assert.match(validationDeduplicationIssue([validationRecord], validation), /already passed/);
assert.equal(validationDeduplicationIssue([validationRecord], { ...validation, diffHash: "diff-2" }), undefined);
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
assert.doesNotMatch(readFileSync(new URL("../src-tauri/resources/lemonpi-narration/extensions/narration.ts", import.meta.url), "utf8"), /git\s+reset\s+--hard|git\s+clean\s+-|force-push/);
assert.match(readFileSync(new URL("../src-tauri/resources/lemonpi-narration/extensions/narration.ts", import.meta.url), "utf8"), /Refusing to commit.*classified as/);

console.log(JSON.stringify({
  policyVersion: CURRENT_ORCHESTRATION_POLICY_VERSION,
  scenarios: 16,
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
