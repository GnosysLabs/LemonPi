import assert from "node:assert/strict";
import {
  asyncWriterLaunchFailure,
  appendCheckoutSnapshot,
  applyDelegationSafetyContracts,
  checkoutSnapshotPolicyIssue,
  compileDelegationContracts,
  declaredExecutionMode,
  delegatesImplementation,
  isManagedWorktreePatchCommand,
  missionHasActiveOwnership,
  parallelWriterPolicyIssue,
  remainingPlanFromTodoResult,
  retainWorkConservingLanes,
  replayMissionState,
  restoredStatusAction,
  shouldSuppressStatusPoll,
  shouldWakeForPlanContinuation,
  singleWriterDispatch,
  singletonWriterPolicyIssue,
  subagentStatusDisposition,
  workConservingLaneSelection,
} from "../src-tauri/resources/lemonpi-narration/extensions/narration.ts";

const planningTask = `Execution mode: read-only
Produce a concise architecture plan for implementing the feature. Do not modify any project files.

Each proposed implementation chunk should use this shape:
Chunk outcome: describe the outcome
In scope: describe its boundary
Done when: describe verification
Out of scope: describe later work`;

const implementationTask = `Execution mode: implementation
Chunk outcome: Add the compacting state
In scope: Update the existing status component
Done when: The UI renders the active state
Out of scope: Unrelated navigation changes`;

assert.equal(declaredExecutionMode(planningTask), "read-only");
assert.equal(delegatesImplementation({ agent: "any-custom-planner", task: planningTask }), false);
assert.equal(declaredExecutionMode(implementationTask), "implementation");
assert.equal(delegatesImplementation({ agent: "any-custom-executor", task: implementationTask }), true);
assert.equal(delegatesImplementation({
  agent: "worker",
  task: `${implementationTask}\nDo not edit unrelated files or modify the existing listener.`,
}), true);
assert.equal(declaredExecutionMode("Plan an implementation"), undefined);

const readOnlyLaunch = { agent: "any-custom-planner", task: planningTask };
applyDelegationSafetyContracts(readOnlyLaunch);
assert.deepEqual(readOnlyLaunch.agentContract, { version: 1 });
assert.match(readOnlyLaunch.task, /Do not modify any project files/);

const fastWorkerLaunch = { agent: "worker", task: "Add a startup splash screen and verify the loaded transition." };
compileDelegationContracts(fastWorkerLaunch);
assert.match(fastWorkerLaunch.task, /^Execution mode: implementation/m);
assert.match(fastWorkerLaunch.task, /^Chunk outcome:/m);
assert.match(fastWorkerLaunch.task, /^In scope:/m);
assert.match(fastWorkerLaunch.task, /^Done when:/m);
assert.match(fastWorkerLaunch.task, /^Out of scope:/m);
assert.match(fastWorkerLaunch.task, /^Child checklist:/m);
assert.match(fastWorkerLaunch.task, /^- Add a startup splash screen and verify the loaded transition\./m);
assert.doesNotMatch(fastWorkerLaunch.task, /Complete delegated outcome/);
assert.equal(delegatesImplementation(fastWorkerLaunch), true);

const substantialWorkerLaunch = {
  agent: "worker",
  task: `Review justification: This work crosses an authentication boundary.
Chunk outcome:
Activate authenticated state hydration without exposing host paths.

Shared endpoint rules:
- Authenticate before resource validation.

State endpoint:
- Resolve the active project through its opaque identifier.

Messages endpoint:
- Project a bounded transcript through its opaque session identifier.

Tests (deterministic):
- Cover authentication, strict queries, and path leakage.

Validation:
- Run the focused server suite and diff checks.`,
};
compileDelegationContracts(substantialWorkerLaunch);
assert.match(substantialWorkerLaunch.task, /^Child checklist:\n- Implement state endpoint :: Resolve the active project through its opaque identifier\./m);
assert.match(substantialWorkerLaunch.task, /^- Implement messages endpoint :: Project a bounded transcript through its opaque session identifier\./m);
assert.match(substantialWorkerLaunch.task, /^- Add focused tests :: Cover authentication, strict queries, and path leakage\./m);
assert.match(substantialWorkerLaunch.task, /^- Run focused validation :: Run the focused server suite and diff checks\./m);
assert.doesNotMatch(substantialWorkerLaunch.task, /Complete delegated outcome|Review justification: This work crosses.*\nChild checklist:\n- Review justification/s);

const customExecutorLaunch = { agent: "kimi-k3", task: "Build the bounded settings behavior described by Main Pi." };
compileDelegationContracts(customExecutorLaunch);
assert.match(customExecutorLaunch.task, /^Execution mode: implementation/m);

const plainPlannerLaunch = { agent: "planner", task: "Decide whether these two changes can safely run in parallel." };
compileDelegationContracts(plainPlannerLaunch);
assert.match(plainPlannerLaunch.task, /^Execution mode: read-only/m);
assert.doesNotMatch(plainPlannerLaunch.task, /^Chunk outcome:/m);

assert.deepEqual(
  remainingPlanFromTodoResult({
    details: {
      tasks: [
        { id: 1, subject: "Finished", status: "completed" },
        { id: 2, subject: "Continue implementation", status: "in_progress" },
        { id: 3, subject: "Polish", status: "pending" },
      ],
      nextId: 4,
    },
  }),
  { task: { id: 2, subject: "Continue implementation", status: "in_progress" } },
);
assert.deepEqual(
  remainingPlanFromTodoResult({ details: { tasks: [{ id: 1, subject: "Done", status: "completed" }], nextId: 2 } }),
  {},
);
assert.equal(shouldWakeForPlanContinuation({ hasRemainingTask: true, activeDelegationCount: 0, writerOccupied: false, intentionallyStopped: false, attempts: 0 }), true);
assert.equal(shouldWakeForPlanContinuation({ hasRemainingTask: true, activeDelegationCount: 1, writerOccupied: false, intentionallyStopped: false, attempts: 0 }), false);
assert.equal(shouldWakeForPlanContinuation({ hasRemainingTask: true, activeDelegationCount: 0, writerOccupied: false, intentionallyStopped: false, attempts: 2 }), true);
assert.equal(shouldWakeForPlanContinuation({ hasRemainingTask: true, activeDelegationCount: 0, writerOccupied: false, intentionallyStopped: false, attempts: 3 }), false);
assert.equal(shouldWakeForPlanContinuation({ hasRemainingTask: true, activeDelegationCount: 0, writerOccupied: false, intentionallyStopped: true, attempts: 0 }), false);
assert.equal(subagentStatusDisposition({ text: "Run: run-1\nState: running\nActivity: active" }), "active");
assert.equal(subagentStatusDisposition({ text: "Run: run-1\nState: running\nActivity: needs attention" }), "needs_attention");
assert.equal(subagentStatusDisposition({ text: "Run: run-1\nState: complete" }), "completed");
assert.equal(subagentStatusDisposition({ text: "No active async runs.", fleet: { totalActive: 0 } }), "empty");
assert.equal(restoredStatusAction("active"), "stay_silent");
assert.equal(restoredStatusAction("completed"), "wake_integration");
assert.equal(restoredStatusAction("needs_attention"), "wake_intervention");
assert.equal(shouldSuppressStatusPoll(true, "status"), true);
assert.equal(shouldSuppressStatusPoll(true, "steer"), false);
assert.equal(shouldSuppressStatusPoll(false, "status"), false);
assert.equal(missionHasActiveOwnership({ activeDelegationCount: 0, recordedRunCount: 1, writerOccupied: false, recordedWriterActive: false }), true);
assert.equal(missionHasActiveOwnership({ activeDelegationCount: 0, recordedRunCount: 0, writerOccupied: false, recordedWriterActive: true }), true);
assert.equal(missionHasActiveOwnership({ activeDelegationCount: 0, recordedRunCount: 0, writerOccupied: false, recordedWriterActive: false }), false);

const lane = (outcome, paths) => ({
  agent: "worker",
  task: `Execution mode: implementation
Chunk outcome: ${outcome}
In scope: ${outcome}
Done when: ${outcome} works
Out of scope: Other lanes
Owned paths: ${paths}
Depends on: none
Child checklist:
- Implement ${outcome} :: Keep changes inside the owned paths`,
});
assert.equal(parallelWriterPolicyIssue({ tasks: [lane("API", "src/api/"), lane("UI", "src/ui/")], worktree: true }), undefined);
assert.match(parallelWriterPolicyIssue({ tasks: [lane("API", "src/"), lane("UI", "src/ui/")], worktree: true }), /overlaps at src/);
assert.match(parallelWriterPolicyIssue({ tasks: [lane("API", "src/api/"), lane("UI", "src/ui/")] }), /worktree: true/);
assert.equal(parallelWriterPolicyIssue({ tasks: [lane("1", "src/1"), lane("2", "src/2"), lane("3", "src/3"), lane("4", "src/4"), lane("5", "src/5")], worktree: true }), undefined);
assert.match(parallelWriterPolicyIssue({ tasks: [{ ...lane("Repeated", "src/repeated"), count: 2 }], worktree: true }), /cannot use count/);
const multilineLane = (outcome, paths) => ({
  ...lane(outcome, paths.join(", ")),
  task: lane(outcome, paths.join(", ")).task.replace(`Owned paths: ${paths.join(", ")}`, `Owned paths:\n${paths.map((path) => `- ${path}`).join("\n")}`),
});
assert.equal(parallelWriterPolicyIssue({ tasks: [multilineLane("API", ["src/api/", "src/shared/api.ts"]), lane("UI", "src/ui/")], worktree: true }), undefined);

const crossRepositoryWave = {
  tasks: [
    { ...lane("Desktop", "src/desktop"), cwd: "/repo/desktop" },
    { ...lane("Apple", "App/Features"), cwd: "/repo/apple" },
  ],
};
compileDelegationContracts(crossRepositoryWave);
assert.equal(crossRepositoryWave.worktree, false);
assert.equal(crossRepositoryWave.concurrency, 2);
assert.equal(parallelWriterPolicyIssue(crossRepositoryWave), undefined);
assert.match(parallelWriterPolicyIssue({ ...crossRepositoryWave, tasks: crossRepositoryWave.tasks.map((task) => ({ ...task, cwd: "/repo/desktop" })) }), /distinct task cwd/);

assert.match(asyncWriterLaunchFailure({ content: [{ type: "text", text: "worktree isolation uses the shared cwd" }] }, false), /worktree isolation/);
assert.equal(asyncWriterLaunchFailure({ details: { runId: "run-123" } }, false), undefined);
assert.deepEqual(workConservingLaneSelection(["dirty checkout", undefined, "inspection failed", undefined]), {
  launchIndexes: [1, 3],
  deferred: [
    { index: 0, reason: "dirty checkout" },
    { index: 2, reason: "inspection failed" },
  ],
});
const degradedCrossRepositoryWave = {
  tasks: [
    { ...lane("Dirty desktop", "src-tauri/src/remote/"), cwd: "/repo/desktop" },
    { ...lane("Clean Apple", "App/Features/"), cwd: "/repo/apple" },
  ],
  concurrency: 2,
  worktree: false,
};
const degradedSelection = workConservingLaneSelection(["dirty checkout", undefined]);
retainWorkConservingLanes(degradedCrossRepositoryWave, degradedCrossRepositoryWave.tasks, degradedSelection);
assert.equal(degradedCrossRepositoryWave.tasks.length, 1);
assert.equal(degradedCrossRepositoryWave.tasks[0].cwd, "/repo/apple");
assert.equal(degradedCrossRepositoryWave.concurrency, 1);

const singleton = (reason, detail = "The change is one atomic outcome with one inseparable write surface.", paths) => ({
  agent: "worker",
  task: `${implementationTask}
Single-writer reason: ${reason}
Single-writer detail: ${detail}${paths ? `\nOwned paths: ${paths}` : ""}`,
});
assert.match(singletonWriterPolicyIssue({ agent: "worker", task: implementationTask }, "I’m using a single writer because this is atomic."), /Single-writer reason/);
assert.match(singletonWriterPolicyIssue(singleton("guess"), "I’m using a single writer because this is atomic."), /Unknown Single-writer reason/);
assert.match(singletonWriterPolicyIssue(singleton("overlapping_ownership"), "I’m using a single writer because these files overlap."), /cannot justify leaving other lanes idle/);
assert.match(singletonWriterPolicyIssue(singleton("atomic", "Too short"), "I’m using a single writer because this is atomic."), /concrete/);
assert.equal(singletonWriterPolicyIssue(singleton("atomic"), "Launching the worker now."), undefined);
const substantialSingleton = {
  agent: "worker",
  task: `${substantialWorkerLaunch.task}\nSingle-writer reason: atomic\nSingle-writer detail: This endpoint set is claimed as one atomic outcome.`,
};
assert.match(singletonWriterPolicyIssue(substantialSingleton), /mechanically substantial/);
assert.deepEqual(singleWriterDispatch(singleton("dependency_blocked", "The later lane requires this schema to exist before it can compile.")), {
  rawReason: "dependency_blocked",
  reason: "dependency_blocked",
  detail: "The later lane requires this schema to exist before it can compile.",
});

const cleanSnapshot = { root: "/repo", head: "a".repeat(40), dirtyEntries: [] };
const dirtySnapshot = { ...cleanSnapshot, dirtyEntries: [" M src/api/client.ts"] };
assert.equal(checkoutSnapshotPolicyIssue(singleton("atomic"), cleanSnapshot), undefined);
assert.match(checkoutSnapshotPolicyIssue(singleton("unsafe_checkout", undefined, "src/api/"), cleanSnapshot), /preflight is clean/);
assert.match(checkoutSnapshotPolicyIssue(singleton("atomic"), dirtySnapshot), /safely commit/);
assert.match(checkoutSnapshotPolicyIssue({ tasks: [lane("API", "src/api/"), lane("UI", "src/ui/")], worktree: true }, dirtySnapshot), /hygiene task/);
assert.match(checkoutSnapshotPolicyIssue(singleton("unsafe_checkout"), dirtySnapshot), /Owned paths/);
assert.match(checkoutSnapshotPolicyIssue(singleton("unsafe_checkout", undefined, "src/ui/"), dirtySnapshot), /do not overlap/);
assert.equal(checkoutSnapshotPolicyIssue(singleton("unsafe_checkout", undefined, "src/api/"), dirtySnapshot), undefined);
const multilineUnsafe = singleton("unsafe_checkout", undefined, "src/api/, src/shared/");
multilineUnsafe.task = multilineUnsafe.task.replace("Owned paths: src/api/, src/shared/", "Owned paths:\n- src/api/\n- src/shared/");
assert.equal(checkoutSnapshotPolicyIssue(multilineUnsafe, dirtySnapshot), undefined);

const snapshotLaunch = singleton("atomic");
appendCheckoutSnapshot(snapshotLaunch, cleanSnapshot);
assert.match(snapshotLaunch.task, /<lemonpi-checkout-snapshot>/);
assert.match(snapshotLaunch.task, new RegExp(`HEAD: ${"a".repeat(40)}`));
assert.match(snapshotLaunch.task, /Working tree:\nclean/);

const compiledParallelLaunch = {
  tasks: [
    { agent: "worker", task: "Build the API behavior.\nOwned paths: src/api/" },
    { agent: "worker", task: "Build the UI behavior.\nOwned paths: src/ui/" },
  ],
};
compileDelegationContracts(compiledParallelLaunch);
assert.equal(compiledParallelLaunch.worktree, true);
assert.equal(compiledParallelLaunch.concurrency, 2);
assert.equal(compiledParallelLaunch.artifacts, true);
assert.match(compiledParallelLaunch.tasks[0].task, /^Depends on: none/m);
assert.match(compiledParallelLaunch.tasks[1].task, /^Depends on: none/m);
assert.equal(parallelWriterPolicyIssue(compiledParallelLaunch), undefined);

const mission = replayMissionState([
  { type: "custom", customType: "lemonpi-mission-state", data: { version: 1, id: "older", phase: "planning", request: "old", activeRunIds: [], writerActive: false, wakeAttempts: 0, updatedAt: 1 } },
  { type: "custom", customType: "unrelated", data: { version: 1 } },
  { type: "custom", customType: "lemonpi-mission-state", data: { version: 1, id: "current", phase: "delegated", request: "ship it", activeRunIds: ["run-1"], writerActive: true, wakeAttempts: 1, updatedAt: 2, remainingTask: { id: 2, subject: "Integrate", status: "pending" } } },
]);
assert.equal(mission?.id, "current");
assert.deepEqual(mission?.activeRunIds, ["run-1"]);
assert.equal(mission?.remainingTask?.subject, "Integrate");

assert.equal(isManagedWorktreePatchCommand({ command: 'git apply --check -- ".pi-subagents/artifacts/worktree-diffs/run/task-0-worker.patch"' }), true);
assert.equal(isManagedWorktreePatchCommand({ command: 'git apply --3way -- "/repo/.pi-subagents/artifacts/worktree-diffs/run/task-0-worker.patch"' }), true);
assert.equal(isManagedWorktreePatchCommand({ command: "git apply .pi-subagents/artifacts/worktree-diffs/run/unchecked.patch" }), false);
assert.equal(isManagedWorktreePatchCommand({ command: "git apply /tmp/arbitrary.patch" }), false);
assert.equal(isManagedWorktreePatchCommand({ command: "git apply .pi-subagents/artifacts/worktree-diffs/run/good.patch && touch bad" }), false);

console.log("Narration dispatch and mission contracts passed.");
