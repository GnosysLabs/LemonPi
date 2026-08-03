import assert from "node:assert/strict";
import {
  applyDelegationSafetyContracts,
  declaredExecutionMode,
  delegatesImplementation,
  isManagedWorktreePatchCommand,
  parallelWriterPolicyIssue,
  remainingPlanFromTodoResult,
  shouldWakeForPlanContinuation,
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
assert.equal(shouldWakeForPlanContinuation({ hasRemainingTask: true, activeDelegationCount: 0, writerOccupied: false, intentionallyStopped: false, attempts: 2 }), false);
assert.equal(shouldWakeForPlanContinuation({ hasRemainingTask: true, activeDelegationCount: 0, writerOccupied: false, intentionallyStopped: true, attempts: 0 }), false);

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
assert.equal(isManagedWorktreePatchCommand({ command: 'git apply --check -- ".pi-subagents/artifacts/worktree-diffs/run/task-0-worker.patch"' }), true);
assert.equal(isManagedWorktreePatchCommand({ command: 'git apply --3way -- "/repo/.pi-subagents/artifacts/worktree-diffs/run/task-0-worker.patch"' }), true);
assert.equal(isManagedWorktreePatchCommand({ command: "git apply .pi-subagents/artifacts/worktree-diffs/run/unchecked.patch" }), false);
assert.equal(isManagedWorktreePatchCommand({ command: "git apply /tmp/arbitrary.patch" }), false);
assert.equal(isManagedWorktreePatchCommand({ command: "git apply .pi-subagents/artifacts/worktree-diffs/run/good.patch && touch bad" }), false);

console.log("Narration execution-mode contracts passed.");
