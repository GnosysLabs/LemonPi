import assert from "node:assert/strict";
import {
  applyDelegationSafetyContracts,
  declaredExecutionMode,
  delegatesImplementation,
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

console.log("Narration execution-mode contracts passed.");
