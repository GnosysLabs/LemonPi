import assert from "node:assert/strict";
import {
  MAIN_PI_OPERATING_MANUAL,
  authoritativeRuntimeWorkerState,
  appendCheckoutSnapshot,
  applyDelegationSafetyContracts,
  authoredWorkerSummaryIssue,
  buildMainPiSystemPrompt,
  compileDelegationContracts,
  declaredExecutionMode,
  delegatesImplementation,
  groupedDelegationPolicyIssue,
  independentSpawnParams,
  isManagedWorktreePatchCommand,
  missionHasActiveOwnership,
  missionWakeIsBlocked,
  normalizeWorkerSummary,
  remainingPlanFromTodoResult,
  replayMissionState,
  restoredStatusAction,
  shouldInjectMainPiOperatingManual,
  shouldSuppressStatusPoll,
  shouldWakeForPlanContinuation,
  subagentStatusDisposition,
  upfrontRoadmapIssue,
  workerSummaryFromTask,
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

const writerLaunch = { agent: "worker", summary: "Implement compact status state", task: implementationTask, cwd: "/tmp/example" };
compileDelegationContracts(writerLaunch);
assert.match(writerLaunch.task, /^Add the compacting state/);
assert.match(writerLaunch.task, /^Execution mode: implementation$/m);
assert.match(writerLaunch.task, /^Chunk outcome:/m);
assert.doesNotMatch(writerLaunch.task, /^Child checklist:/m);
assert.match(writerLaunch.task, /^Worker summary: Implement compact status state$/m);
assert.equal(writerLaunch.summary, undefined);
assert.equal(delegatesImplementation(writerLaunch), true);
assert.equal(normalizeWorkerSummary("one two three four five six seven eight nine", implementationTask), "one two three four five six seven eight");
assert.match(authoredWorkerSummaryIssue(undefined), /required/);
assert.match(authoredWorkerSummaryIssue("one two three four five six seven eight nine"), /eight words/);
assert.match(authoredWorkerSummaryIssue("Complete delegated outcome"), /actual outcome/);
assert.equal(authoredWorkerSummaryIssue("Implement compact status state"), undefined);
assert.equal(
  workerSummaryFromTask("Continue the correction.\nWorker summary: Repair session creation RPC"),
  "Repair session creation RPC",
);
assert.equal(workerSummaryFromTask("Continue the correction."), undefined);

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
assert.equal(missionWakeIsBlocked({ mainAgentRunning: false, activeToolExecutions: 0, wakeQueued: false, turnSettled: false }), true);

assert.deepEqual(remainingPlanFromTodoResult({
  details: {
    tasks: [
      { id: 1, subject: "Finished", status: "completed" },
      { id: 2, subject: "Integrate first result", status: "in_progress" },
    ],
    nextId: 3,
  },
}), { task: { id: 2, subject: "Integrate first result", status: "in_progress" } });

const completeRoadmap = [
  { id: 1, subject: "Map affected surfaces", description: "Confirm the exact runtime and UI boundaries.", activeForm: "mapping affected surfaces", status: "in_progress" },
  { id: 2, subject: "Implement runtime guard", description: "Enforce the new dispatch invariant.", status: "pending", blockedBy: [1] },
  { id: 3, subject: "Integrate visible feedback", description: "Connect the guard result to user-facing progress.", status: "pending", blockedBy: [2] },
  { id: 4, subject: "Validate roadmap behavior", description: "Run focused contract and build checks.", status: "pending", blockedBy: [3] },
];
assert.equal(upfrontRoadmapIssue({
  tasks: completeRoadmap,
  freshForRequest: false,
  establishedForMission: false,
  laneCount: 2,
}), undefined);
assert.equal(upfrontRoadmapIssue({
  tasks: completeRoadmap,
  freshForRequest: true,
  establishedForMission: false,
  laneCount: 2,
}), undefined);
assert.match(upfrontRoadmapIssue({
  tasks: completeRoadmap.map((task, index) => index === 0 ? { ...task, subject: "Complete delegated outcome" } : task),
  freshForRequest: true,
  establishedForMission: false,
  laneCount: 2,
}), /generic placeholder/);
assert.match(upfrontRoadmapIssue({
  tasks: completeRoadmap.map((task, index) => index === 1 ? { ...task, description: undefined } : task),
  freshForRequest: true,
  establishedForMission: false,
  laneCount: 2,
}), /concrete description/);
assert.equal(upfrontRoadmapIssue({
  tasks: completeRoadmap.map((task) => ({ ...task, blockedBy: [] })),
  freshForRequest: true,
  establishedForMission: false,
  laneCount: 2,
}), undefined);
assert.equal(upfrontRoadmapIssue({
  tasks: completeRoadmap.map((task, index) => index === 3
    ? { ...task, subject: "Polish roadmap behavior", description: "Confirm the final presentation." }
    : task),
  freshForRequest: true,
  establishedForMission: false,
  laneCount: 2,
}), undefined);
assert.equal(upfrontRoadmapIssue({
  tasks: [{ id: 1, subject: "Add unread dot", status: "pending" }],
  freshForRequest: false,
  establishedForMission: false,
  laneCount: 1,
}), undefined);
assert.equal(upfrontRoadmapIssue({
  tasks: [{ ...completeRoadmap[3], status: "in_progress" }],
  freshForRequest: false,
  establishedForMission: true,
  laneCount: 1,
}), undefined);
assert.match(upfrontRoadmapIssue({
  tasks: completeRoadmap.map((task) => ({ ...task, status: "completed" })),
  freshForRequest: true,
  establishedForMission: true,
  laneCount: 1,
}), /no unfinished milestone/);
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

assert.match(MAIN_PI_OPERATING_MANUAL, /Follow this procedure from the beginning of every new user task/);
assert.match(MAIN_PI_OPERATING_MANUAL, /FAST PATH:[\s\S]*lemonpi_fast_path[\s\S]*one focused/);
assert.match(MAIN_PI_OPERATING_MANUAL, /lemonpi_fast_path\(\{ action: "start", cwd, paths, summary \}\)/);
assert.match(MAIN_PI_OPERATING_MANUAL, /lemonpi_validate\(\{ cwd, program, args, relevantPaths: paths, scope: "focused" \}\)/);
assert.match(MAIN_PI_OPERATING_MANUAL, /ONE READ-ONLY CHILD:[\s\S]*exactly one bounded read-only investigation/);
assert.match(MAIN_PI_OPERATING_MANUAL, /DISPATCH:[\s\S]*every implementation outside the fast path/);
assert.match(MAIN_PI_OPERATING_MANUAL, /subagent\(\{ action: "list" \}\)/);
assert.match(MAIN_PI_OPERATING_MANUAL, /Do not supply model, provider, thinking[\s\S]*usage budget[\s\S]*acceptance metadata/);
assert.match(MAIN_PI_OPERATING_MANUAL, /subagents\.agentOverrides\[agent\]\.model[\s\S]*\.thinking/);
assert.match(MAIN_PI_OPERATING_MANUAL, /subagent\(\{ action: "resume", id, message \}\)[\s\S]*Correction for previous slice:[\s\S]*Worker summary:/);
assert.match(MAIN_PI_OPERATING_MANUAL, /completed > partial > budget_exhausted > stopped > failed/);
assert.match(MAIN_PI_OPERATING_MANUAL, /partial[\s\S]*continuationOf[\s\S]*Do not repeat completed reads, edits, or validation/);
assert.match(MAIN_PI_OPERATING_MANUAL, /integrate_worker_result[\s\S]*exact terminal[\s\S]*artifactRunId/);
assert.match(MAIN_PI_OPERATING_MANUAL, /lemonpi_git\(\{ action: "integrate_worker_result", cwd, artifactRunId \}\)/);
assert.match(MAIN_PI_OPERATING_MANUAL, /Never call `subagent_wait`, sleep, or repeatedly poll status/);
assert.match(MAIN_PI_OPERATING_MANUAL, /same LemonPi tool contract fails twice[\s\S]*safe fallback/);
assert.match(MAIN_PI_OPERATING_MANUAL, /Never rerun an unchanged suite/);
assert.doesNotMatch(MAIN_PI_OPERATING_MANUAL, /Create the whole known roadmap before|complete visible roadmap/);
const injectedPrompt = buildMainPiSystemPrompt("BASE SYSTEM PROMPT", { runId: "run-attention", index: 2 });
assert.match(injectedPrompt, /^BASE SYSTEM PROMPT/);
assert.match(injectedPrompt, /lemonpi-authoritative-policy version="6"/);
assert.match(injectedPrompt, /lemonpi-visible-narration/);
assert.match(injectedPrompt, /lemonpi-main-pi-operating-manual version="1"/);
assert.match(injectedPrompt, /Run run-attention child 2 needs intervention now/);
assert.equal(shouldInjectMainPiOperatingManual({}), true);
assert.equal(shouldInjectMainPiOperatingManual({ PI_SUBAGENT_CHILD: "0" }), true);
assert.equal(shouldInjectMainPiOperatingManual({ PI_SUBAGENT_CHILD: "1" }), false);

console.log("Narration orchestration contracts passed.");
