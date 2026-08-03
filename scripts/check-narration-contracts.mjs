import assert from "node:assert/strict";
import {
  applyDelegationSafetyContracts,
  declaredExecutionMode,
  delegatesImplementation,
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

console.log("Narration execution-mode contracts passed.");
