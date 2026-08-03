import assert from "node:assert/strict";
import {
  authoritativeRuntimeWorkerState,
  appendCheckoutSnapshot,
  applyDelegationSafetyContracts,
  compileDelegationContracts,
  declaredExecutionMode,
  delegatesImplementation,
  groupedDelegationPolicyIssue,
  independentSpawnParams,
  isManagedWorktreePatchCommand,
  missionHasActiveOwnership,
  missionWakeIsBlocked,
  remainingPlanFromTodoResult,
  replayMissionState,
  restoredStatusAction,
  shouldSuppressStatusPoll,
  shouldWakeForPlanContinuation,
  subagentStatusDisposition,
} from "../src-tauri/resources/lemonpi-narration/extensions/narration.ts";

const planningTask = "Produce a concise architecture plan. Do not modify any project files.";
const implementationTask = `Add the compacting state to the existing status component.
Owned paths: src/components/Status.tsx`;

const readOnlyLaunch = { agent: "planner", task: planningTask };
compileDelegationContracts(readOnlyLaunch);
assert.match(readOnlyLaunch.task, /^Produce a concise architecture plan\./);
assert.match(readOnlyLaunch.task, /^Execution mode: read-only$/m);
assert.equal(declaredExecutionMode(readOnlyLaunch.task), "read-only");
applyDelegationSafetyContracts(readOnlyLaunch);
assert.deepEqual(readOnlyLaunch.agentContract, { version: 1 });
assert.match(readOnlyLaunch.task, /Do not modify any project files/);

const writerLaunch = { agent: "worker", task: implementationTask, cwd: "/tmp/example" };
compileDelegationContracts(writerLaunch);
assert.match(writerLaunch.task, /^Add the compacting state/);
assert.match(writerLaunch.task, /^Execution mode: implementation$/m);
assert.match(writerLaunch.task, /^Chunk outcome:/m);
assert.match(writerLaunch.task, /^Child checklist:/m);
assert.equal(delegatesImplementation(writerLaunch), true);

const writerSpawn = independentSpawnParams(writerLaunch);
assert.equal(writerSpawn.implementation, true);
assert.equal(writerSpawn.params.worktree, true);
assert.equal(writerSpawn.params.concurrency, 1);
assert.equal(writerSpawn.params.cwd, "/tmp/example");
assert.equal(writerSpawn.params.async, true);
assert.equal(writerSpawn.params.clarify, false);
assert.equal(writerSpawn.params.tasks.length, 1);
assert.equal(writerSpawn.params.tasks[0].cwd, undefined);

const readOnlySpawn = independentSpawnParams(readOnlyLaunch);
assert.equal(readOnlySpawn.implementation, false);
assert.equal(readOnlySpawn.params.agent, "planner");
assert.equal(readOnlySpawn.params.worktree, undefined);
assert.equal(readOnlySpawn.params.async, true);

assert.match(groupedDelegationPolicyIssue({
  tasks: [
    { agent: "scout", task: "Inspect the router." },
    { agent: "designer", task: "Review the settings layout." },
  ],
}), /lemonpi_dispatch/);
assert.equal(groupedDelegationPolicyIssue({
  tasks: [
    { agent: "oracle", task: "Produce one consensus verdict.\nAtomic aggregate: required" },
    { agent: "reviewer", task: "Contribute to the same indivisible verdict." },
  ],
}), undefined);
assert.equal(groupedDelegationPolicyIssue({ agent: "scout", task: "Inspect the router." }), undefined);

const snapshotted = { agent: "worker", task: writerLaunch.task };
appendCheckoutSnapshot(snapshotted, {
  root: "/repo",
  head: "0123456789012345678901234567890123456789",
  dirtyEntries: [],
});
assert.match(snapshotted.task, /Repository root: \/repo/);
assert.match(snapshotted.task, /Working tree:\nclean/);

assert.equal(shouldSuppressStatusPoll(true, "status"), true);
assert.equal(shouldSuppressStatusPoll(true, "steer"), false);
assert.equal(subagentStatusDisposition({ text: "Run: run-1\nState: running\nActivity: active" }), "active");
assert.equal(subagentStatusDisposition({ text: "Run: run-1\nState: complete" }), "completed");
assert.equal(restoredStatusAction("active"), "stay_silent");
assert.equal(restoredStatusAction("completed"), "wake_integration");
assert.equal(authoritativeRuntimeWorkerState({ fleet: { totalActive: 2 } }), "active");
assert.equal(authoritativeRuntimeWorkerState({ fleet: { totalActive: 0 } }), "idle");
assert.equal(authoritativeRuntimeWorkerState({ text: "No active async runs." }), "unknown");

assert.equal(missionHasActiveOwnership({ activeDelegationCount: 2, recordedRunCount: 0, writerOccupied: false, recordedWriterActive: false }), true);
assert.equal(missionHasActiveOwnership({ activeDelegationCount: 0, recordedRunCount: 0, writerOccupied: false, recordedWriterActive: false }), false);
assert.equal(missionWakeIsBlocked({ mainAgentRunning: false, activeToolExecutions: 0, wakeQueued: false }), false);
assert.equal(missionWakeIsBlocked({ mainAgentRunning: true, activeToolExecutions: 0, wakeQueued: false }), true);

assert.deepEqual(remainingPlanFromTodoResult({
  details: {
    tasks: [
      { id: 1, subject: "Finished", status: "completed" },
      { id: 2, subject: "Integrate first result", status: "in_progress" },
    ],
    nextId: 3,
  },
}), { task: { id: 2, subject: "Integrate first result", status: "in_progress" } });
assert.equal(shouldWakeForPlanContinuation({ hasRemainingTask: true, activeDelegationCount: 0, writerOccupied: false, intentionallyStopped: false, attempts: 0 }), true);
assert.equal(shouldWakeForPlanContinuation({ hasRemainingTask: true, activeDelegationCount: 1, writerOccupied: false, intentionallyStopped: false, attempts: 0 }), false);

const restored = replayMissionState([
  {
    type: "custom",
    customType: "lemonpi-mission-state",
    data: {
      version: 1,
      id: "mission-1",
      phase: "delegated",
      request: "Build settings",
      activeRunIds: ["run-a", "run-b"],
      activeRunWidths: { "run-a": 1, "run-b": 1 },
      writerActive: true,
      wakeAttempts: 0,
      updatedAt: Date.now(),
    },
  },
]);
assert.deepEqual(restored.activeRunIds, ["run-a", "run-b"]);
assert.deepEqual(restored.activeRunWidths, { "run-a": 1, "run-b": 1 });

assert.equal(isManagedWorktreePatchCommand({ command: "git apply --check .pi-subagents/artifacts/worktree-diffs/run.patch" }), true);
assert.equal(isManagedWorktreePatchCommand({ command: "git apply /tmp/untrusted.patch" }), false);

console.log("Narration orchestration contracts passed.");
