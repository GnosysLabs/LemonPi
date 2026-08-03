import assert from "node:assert/strict";
import {
  applyDelegationSafetyContracts,
  compileDelegationContracts,
  declaredExecutionMode,
  delegatesImplementation,
  isManagedWorktreePatchCommand,
  parallelWriterPolicyIssue,
  remainingPlanFromTodoResult,
  replayMissionState,
  restoredStatusAction,
  shouldWakeForPlanContinuation,
  subagentStatusDisposition,
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
assert.equal(delegatesImplementation(fastWorkerLaunch), true);

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
assert.match(parallelWriterPolicyIssue({ tasks: [lane("1", "src/1"), lane("2", "src/2"), lane("3", "src/3"), lane("4", "src/4"), lane("5", "src/5")], worktree: true }), /at most 4/);
assert.match(parallelWriterPolicyIssue({ tasks: [{ ...lane("Repeated", "src/repeated"), count: 2 }], worktree: true }), /cannot use count/);

const compiledParallelLaunch = {
  tasks: [
    { agent: "worker", task: "Build the API behavior.\nOwned paths: src/api/" },
    { agent: "worker", task: "Build the UI behavior.\nOwned paths: src/ui/" },
  ],
};
compileDelegationContracts(compiledParallelLaunch);
assert.equal(compiledParallelLaunch.worktree, true);
assert.equal(compiledParallelLaunch.concurrency, 4);
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
