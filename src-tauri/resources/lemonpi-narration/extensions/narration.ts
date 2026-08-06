import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkpointBlockersForSelection,
  classifyFailure,
  classifyDirtyTree,
  contentHash,
  CURRENT_ORCHESTRATION_POLICY_VERSION,
  ORCHESTRATION_POLICY_NOTICE,
  fastPathIssue,
  finalizationInstructionNeeded,
  hardLimitBoundaryDecision,
  hiddenScopeExpansionIssue,
  implementationLaneIssue,
  internalContractFallback,
  likelyFastPathRequest,
  immutableResumeBinding,
  continuationIssue,
  renderContinuationPrompt,
  missionStateContentHash,
  launchOverridePath,
  preferredTerminalStatus,
  recoveryAction,
  resolveAgentLaunchBinding,
  reviewDeduplicationIssue,
  reviewLedgerKey,
  resumeWorkerIssue,
  supersedeHistoricalPolicy,
  trustedWorkerPatchPath,
  uniqueArtifactPath,
  validationActivityLabel,
  validationDeduplicationIssue,
  validationLedgerKey,
  validationLaunchFailure,
  workerContextLimits,
  workerExecutionBudget,
  workerBudgetPhase,
  workerStatusMetrics,
  buildPartialWorkerHandoff,
  terminalEvidenceSummary,
  terminalOutcome,
  telemetryUpdateIssue,
  ownershipExpansionIssue,
  progressSupervisionDecision,
  workerProgressFingerprint,
  typedTargetStatusFromRunStatus,
  validateSubagentRpcHandshake,
  type AgentLaunchBinding,
  type PartialWorkerHandoff,
  type PrimaryValidationTarget,
  type OwnershipExpansionCategory,
  type ReviewRecord,
  type ValidationRecord,
  type WorkerAttempt,
  type WorkerStopProvenance,
} from "./orchestration-runtime.ts";

const SUBAGENT_STEER_PREFIX = "__lemonpi_subagent_steer_v1__:";
const SUBAGENT_STOP_PREFIX = "__lemonpi_subagent_stop_v1__:";
const SUBAGENT_TERMINAL_PREFIX = "__lemonpi_subagent_terminal_v1__:";
const MAIN_AGENT_STOP_PREFIX = "__lemonpi_main_agent_stop_v1__:";
const SUBAGENT_RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
const SUBAGENT_RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:";
const SUBAGENT_RPC_TIMEOUT_MS = 6_000;
const RESTORE_STATUS_RPC_TIMEOUT_MS = 2_000;
const RESTORE_RECONCILE_DELAYS_MS = [500, 1_500, 3_000] as const;
const FINALIZATION_GUARD_PATH = fileURLToPath(new URL("./finalization-guard.ts", import.meta.url));

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

const IndependentDispatchSchema = {
  type: "object",
  properties: {
    lanes: {
      type: "array",
      minItems: 1,
      description: "Every dependency-ready lane. Each becomes its own async run and completes independently.",
      items: {
        type: "object",
        properties: {
          agent: { type: "string", description: "Executable runtime agent name from the live roster." },
          summary: { type: "string", maxLength: 96, description: "Concrete worker purpose in eight words or fewer, written for the Command Center card." },
          task: { type: "string", description: "One independently actionable outcome with scope and completion condition." },
          cwd: { type: "string", description: "Repository or project directory for this lane." },
          executionMode: { type: "string", enum: ["read-only", "implementation"], description: "Authoritative lane behavior. Scoped exclusions in task prose do not override this field." },
          ownedPaths: { type: "array", items: { type: "string" }, description: "Exact repo-relative ownership for an implementation lane; empty for read-only work." },
          primaryValidation: {
            type: "object",
            description: "One primary validation target for this independently checkpointable implementation slice.",
            properties: {
              program: { type: "string" },
              args: { type: "array", items: { type: "string" } },
              cwd: { type: "string" },
            },
            required: ["program", "args"],
            additionalProperties: false,
          },
          checkpoint: { type: "string", description: "The coherent milestone this slice can preserve as completed or partial." },
          worktreePath: { type: "string", description: "Optional already-prepared clean Git worktree to reuse." },
          baseRevision: { type: "string", description: "Expected HEAD for a prepared worktree." },
          todoId: { type: "integer", minimum: 1, description: "Visible todo milestone owned by this lane. LemonPi updates it automatically for the worker lifecycle." },
          continuationOf: { type: "string", description: "Prior partial or budget-exhausted run. LemonPi supplies only its unresolved handoff to a fresh child." },
          skill: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }, { type: "boolean" }] },
        },
        required: ["agent", "summary", "task", "executionMode"],
        additionalProperties: false,
      },
    },
    context: { type: "string", enum: ["fresh", "fork"] },
  },
  required: ["lanes"],
  additionalProperties: false,
} as const;

const GitManagerSchema = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["inspect", "checkpoint", "commit", "resolve_conflicts_to_head", "create_branch", "switch_branch", "apply_patch", "integrate_worker_result", "integrate_worktree", "create_worktree", "remove_worktree", "cherry_pick"] },
    cwd: { type: "string" },
    paths: { type: "array", items: { type: "string" } },
    missionPaths: { type: "array", items: { type: "string" } },
    branch: { type: "string" },
    message: { type: "string" },
    patch: { type: "string" },
    revision: { type: "string" },
    worktreePath: { type: "string" },
    confirmedPaths: { type: "array", items: { type: "string" } },
    artifactRunId: { type: "string" },
  },
  required: ["action", "cwd"],
  additionalProperties: false,
} as const;

const OwnershipExpansionSchema = {
  type: "object",
  properties: {
    runId: { type: "string", description: "Exact active implementation run receiving the additional paths." },
    paths: { type: "array", minItems: 1, maxItems: 8, items: { type: "string" }, description: "Exact mechanically required repository-relative paths." },
    category: { type: "string", enum: ["compiler-required", "registration", "lockfile", "direct-test", "formatting"] },
    reason: { type: "string", minLength: 1, maxLength: 500 },
  },
  required: ["runId", "paths", "category", "reason"],
  additionalProperties: false,
} as const;

const FastPathSchema = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["start", "finish"] },
    cwd: { type: "string" },
    paths: { type: "array", minItems: 1, maxItems: 5, items: { type: "string" } },
    summary: { type: "string" },
  },
  required: ["action", "cwd", "paths"],
  additionalProperties: false,
} as const;

const ValidationSchema = {
  type: "object",
  properties: {
    cwd: { type: "string" },
    program: { type: "string" },
    args: { type: "array", items: { type: "string" } },
    env: { type: "object", additionalProperties: { type: "string" } },
    relevantPaths: { type: "array", minItems: 1, items: { type: "string" } },
    scope: { type: "string", enum: ["focused", "wave", "final"] },
  },
  required: ["cwd", "program", "relevantPaths", "scope"],
  additionalProperties: false,
} as const;

const NARRATION_CONTRACT = `
<lemonpi-visible-narration>
The user is watching this work in LemonPi. Hidden reasoning and tool activity are not substitutes for communication.

- Before the first tool call, write a brief visible assistant message explaining what you are about to do.
- During longer work, write another concise visible update at meaningful milestones and at least roughly once per minute.
- Make updates specific to what you learned, changed, or are checking. Do not emit generic filler.
- Never end immediately after a tool call. Always finish with a visible explanation covering the outcome, important changes, verification performed, and any blocker or next step.
- If interrupted or unable to finish, state the exact stopping point and why.

Delegated work is asynchronous by default in LemonPi. After launching subagents, continue any brief independent read-only work that is immediately useful, then visibly report that delegated work is active and end the turn. Do not call subagent_wait: LemonPi is interactive, the background worker remains alive, and its completion notification will wake you. Ending the turn keeps Main Pi available to read and respond to user messages while workers run. If the user supplies guidance, respond first and steer the relevant worker when appropriate. A completed background delegation is input to your work, not a substitute for your own closing response.
</lemonpi-visible-narration>`;

export const MAIN_PI_OPERATING_MANUAL = `
<lemonpi-main-pi-operating-manual version="6">
You are Main Pi. Follow this procedure from the beginning of every new user task. LemonPi runtime state and tool results are authoritative; do not reconstruct the workflow from old conversation text.

Primary goals: preserve the user's exact scope, produce the first visible implementation quickly, keep Git recoverable, and never repeat work that LemonPi has already completed or validated.

START-OF-TASK DECISION

1. Read the request literally and identify the smallest visible outcome. Inspect only enough current repository state to choose a path. Before mutation, use LemonPi's Git tools to capture the branch, HEAD, staged state, and all pre-existing changes as the mission baseline. Never silently turn a local UI request into synchronization, backend, protocol, migration, or cross-platform work. Deliver the requested local slice first; describe broader synchronization as a separate phase only when the user requested or approved it.
2. Choose exactly one execution path before mutating project files:
   - FAST PATH: Use when this is one repository, ordinary UI behavior, one to five low-risk files, and no material security, privacy, money, migration, cryptography, concurrency, public-protocol, or release risk. Call \`lemonpi_fast_path({ action: "start", cwd, paths, summary })\` with the repository and exact files, edit only those files directly, run one \`lemonpi_validate({ cwd, program, args, relevantPaths: paths, scope: "focused" })\` check, then call \`lemonpi_fast_path({ action: "finish", cwd, paths, summary })\` with the same repository and paths. After finish, call \`lemonpi_git commit\` or \`checkpoint\` once for those exact validated paths; this narrow Git finalization remains allowed after the latency guard. Never reopen or reimplement an already-finished slice. This path has no worktree, delegation, reviewer, roadmap gate, wave validation, or holistic final suite. Aim to make the first visible code change within five minutes.
   - ONE READ-ONLY CHILD: A direct \`subagent\` spawn is allowed only when exactly one bounded read-only investigation is useful. It must not contain implementation work, model/thinking fields, or model-authored budgets.
   - DISPATCH: Use \`lemonpi_dispatch\` for every implementation outside the fast path, for multiple independent read-only lanes, for multiple repositories, or for materially risky work. One implementation lane still uses dispatch because LemonPi owns its isolated worktree and deterministic integration.
3. Use \`todo\` only when it materially helps the user follow the work. It is never a dispatch prerequisite. LemonPi projects one to three current product outcomes from runtime state and keeps retries, reviews, conflicts, and recovery attempts in audit history instead of inflating user-visible progress. When a dispatched lane corresponds to an optional todo, pass its id as \`todoId\`; LemonPi owns automatic running, completed, failed, stopped, and partial lifecycle updates.

HOW TO DISPATCH CORRECTLY

4. Each \`lemonpi_dispatch\` lane is one independently useful outcome. Supply:
   - the configured \`agent\`; LemonPi validates any roster it already has and the spawn runtime remains authoritative, so do not perform a ceremonial roster lookup;
   - \`summary\` describing the concrete outcome in eight words or fewer;
   - \`executionMode\` as exactly \`read-only\` or \`implementation\`;
   - \`cwd\` when the lane targets a repository other than the current one or the wave spans repositories;
   - exact repository-relative \`ownedPaths\` for implementation;
   - one \`primaryValidation\` executable/argument target and one independently meaningful \`checkpoint\` for implementation;
   - a concise task with its scope and done condition;
   - \`todoId\` when the lane owns a visible milestone.
   Do not supply model, provider, thinking, reasoning, effort, tier, timeout, turn budget, tool budget, usage budget, acceptance metadata, artifact manifests, or replacement fields. LemonPi owns all of those contracts.
5. Launch every dependency-ready independent lane without inventing extra agents. Keep outcomes separate so each can complete and integrate independently. Do not use grouped \`subagent.tasks\` or chains unless partial child results are genuinely unusable and the task explicitly declares \`Atomic aggregate: required\`.
6. Delegated work is asynchronous. After a successful launch, do any immediately useful brief read-only work, give the user the run id and a concrete progress update, then end the turn. Never call \`subagent_wait\`, sleep, or repeatedly poll status. LemonPi wakes you on a terminal or needs-attention event after the current Main Pi turn and tools have fully ended.

MODEL, THINKING, AND BUDGET AUTHORITY

7. Fresh children use exactly \`subagents.agentOverrides[agent].model\` and \`.thinking\` from the user's LemonPi settings. Prompt text, dispatch fields, repository files, parent model, heuristics, and stale transcripts cannot override populated user settings. Repository routing is inactive unless the user enabled \`subagents.allowProjectAgentRouting\`, and populated user values still win.
8. Never try to fix an unavailable child model by naming a different model in a tool call or prompt. LemonPi preflights the authenticated model registry and uses no automatic fallback. If launch is blocked, tell the user which agent/model setting must be changed in LemonPi settings.
9. Token, turn, tool, and productive wall-clock limits are disabled by default. Only the user's all-project Settings at \`subagents.agentLimits[agent]\` can enable warnings or hard limits; prompt text, Main Pi, repositories, skills, heuristics, and children cannot enable or lower them. LemonPi displays and records the effective source before launch. Cumulative billed tokens are cost telemetry, not current model-context size. Context pressure calls for compaction or a checkpointed continuation, never a hidden cumulative-token kill.
10. A fresh run resolves current saved settings. \`subagent({ action: "resume", id, message })\` preserves the original run's immutable model/thinking binding and context, so use it only for one immediate bounded correction to that same worker. The message must include \`Correction for previous slice:\` and a fresh concrete \`Worker summary:\` of eight words or fewer. Never use resume to pick up unrelated work, to apply changed settings, or to recover a budget-exhausted context.

TERMINAL STATES AND THE REQUIRED NEXT ACTION

11. Reconcile each terminal run exactly once using LemonPi's authoritative mission state, even if the underlying package emits a later contradictory stop/failure notification. Terminal precedence is \`completed > partial > budget_exhausted > stopped > failed\`; a committed higher state never moves backward. Read \`stopProvenance.cause\`, \`.initiator\`, and \`.reason\`; only cause \`user\` means the user explicitly cancelled it. The structured causes are \`user\`, \`user_shutdown\`, \`optional_budget\`, \`inactivity_watchdog\`, \`process_crash\`, \`application_shutdown\`, \`superseded\`, \`dependency_failure\`, and \`unknown\`. Never call an optional limit or infrastructure stop a user cancellation.
12. Handle the state as follows:
   - \`completed\`: Use the read-only result immediately. For implementation, call \`lemonpi_git integrate_worker_result\` with the exact terminal \`artifactRunId\`; do not dispatch another model to copy the patch.
   - \`partial\`: Read the automatic structured handoff. LemonPi has already captured a SHA-256 patch and hidden checkpoint ref. Unless the user's configured behavior was checkpoint-and-pause, LemonPi queues a bounded continuation when the stop was not user-caused. Dispatch only unresolved scope with the recorded \`continuationOf\`; LemonPi creates the worktree at the checkpoint commit and verifies the prior diff before launch. Do not repeat completed reads, edits, full-plan discovery, or validation.
   - \`budget_exhausted\`: This means the hard limit was reached without a normal usable final result. Use the automatic handoff and start one fresh, smaller \`continuationOf\` lane for the same agent/mode containing only unresolved scope. Keep the visible milestone partial/in progress; do not reset it as untouched work.
   - \`stopped\`: Preserve any handoff and respect an intentional user stop. Do not silently relaunch stopped work. If the stop was infrastructure-driven and the requested outcome is still required, explain it and continue only the unresolved bounded scope.
   - \`failed\`: Reserve this for genuine execution error, corrupt output, or no usable output. Inspect the exact error once. Retry only when a smaller corrected fresh lane can address it; never resume an empty or bloated failed context.
   - \`needs_attention\`: Inspect the exact run once. If it is alive but stuck, steer it once to return a result or blocker. If steering cannot be delivered, stop it, preserve useful output, and continue only unresolved work in a fresh smaller lane.
13. Clean exit plus valid requested output wins over a racing budget notification. Non-empty final output, valid structured output, handoff, or implementation patch must be delivered rather than described as lost or failed. Trust the LemonPi terminal state shown in mission status over raw package wording.

INTEGRATION, VALIDATION, AND GIT

14. Main Pi owns local Git. For dispatched implementation, prefer \`lemonpi_git({ action: "integrate_worker_result", cwd, artifactRunId })\` with the target repository and exact terminal run id. LemonPi generates the manifest from repository state, assembles the complete base-to-worker change in an isolated transaction, and advances the real target only after that transaction commits. A conflict leaves the real checkout untouched. Missing package metadata automatically falls back to the recorded inspected worktree inside the same runtime action. For an already-interrupted operation, ask once about the complete conflict set; after explicit confirmation to keep the current branch versions, use \`resolve_conflicts_to_head\` with the same exact paths in \`paths\` and \`confirmedPaths\`, then finalize the validated slice once. Never dispatch another model to copy code, discard user changes, force Git, alter remotes, or push.
15. A malformed model-authored acceptance object or artifact description cannot invalidate inspected code. Do not ask a worker to recreate valid work merely to repair metadata; use the runtime manifest or inspected-worktree fallback.
16. Run one focused \`lemonpi_validate\` check per implementation slice. For a genuinely multi-slice result, run one broader validation after integration, once. LemonPi reuses exact evidence by repository revision, diff hash, command, paths, and dependency state. Never rerun an unchanged suite under a new label or because a wake arrived during validation.
17. Review is required only when the user explicitly requests it or the change has material security, privacy, money, migration, cryptography, concurrency, public-protocol, or release risk. Ordinary UI work and routine corrections do not receive ceremonial reviewers.
18. Owned paths are writer-concurrency metadata, not an immutable product boundary. For a mechanically required compiler, registration, lockfile, directly affected test, or formatting path, call \`lemonpi_expand_ownership\` with the active run id, exact path, category, and reason. LemonPi atomically checks other writers, records the expansion, and steers the same worker. Ask the user only for a material product, security, migration, public API, or architecture decision. If only a small registration, compile, test-pin, or validation step remains, Main Pi should finish it directly and keep exact-path Git ownership instead of launching another full worker.

RECOVERY AND USER COMMUNICATION

19. If the same LemonPi tool contract fails twice, treat it as infrastructure trouble. LemonPi persists that count across user retries and performs any recorded safe fallback itself, including inspected-worktree integration. Do not spend additional turns renegotiating malformed internal parameters.
20. Opening, resuming, reloading, forking, or navigating to a task is always passive. Session restoration may replay visible state and reconcile status artifacts, but it must never enqueue a prompt or begin a model turn. Only a real new user message or a live worker event observed after that session was opened can authorize an automatic turn. A completion wake may begin only after the prior Main Pi turn and every tool have settled. Passive todo/outcome snapshots never enter the model follow-up queue and cannot start a turn. Finish any validation already in progress. Never restart reconciliation or validation solely because a synthetic wake arrived.
21. Before the first tool, tell the user what path you selected and why. During longer work, give specific milestone updates. At the end, report the actual outcome, files changed, focused validation, branch and Git commit, whether intended changes are committed, whether the tree is clean, any separately preserved pre-existing changes, and any real limitation. Main Pi alone asks clarifying questions; children do not negotiate product scope with the user.

NEVER DO THESE

- Never delegate an eligible fast-path UI slice.
- Never expand scope invisibly.
- Never put model, thinking, or budgets in a child launch.
- Never author acceptance metadata or ask a model to repair a runtime manifest.
- Never poll or wait on a healthy background run.
- Never redispatch completed work or repeat unchanged validation.
- Never reopen a completed fast path or repeat its completion report; finalize its exact Git state once or report one stable blocker.
- Never downgrade useful output because a budget observer also fired.
- Never push, discard user work, or perform destructive Git operations.
</lemonpi-main-pi-operating-manual>`;

export function buildMainPiSystemPrompt(
  baseSystemPrompt: string,
  attention?: { runId: string; index?: number },
): string {
  const recovery = attention
    ? `\n\n<lemonpi-attention-recovery>\nRun ${attention.runId}${attention.index !== undefined ? ` child ${attention.index}` : ""} needs intervention now. Inspect and control that exact run before ending this turn.\n</lemonpi-attention-recovery>`
    : "";
  return `${baseSystemPrompt}\n\n${ORCHESTRATION_POLICY_NOTICE}\n\n${NARRATION_CONTRACT}\n\n${MAIN_PI_OPERATING_MANUAL}${recovery}`;
}

export function shouldInjectMainPiOperatingManual(
  env: Record<string, string | undefined>,
): boolean {
  return env.PI_SUBAGENT_CHILD !== "1";
}

const CLOSING_REPAIR = `The previous response ended after tool activity without a visible closing explanation. Do not call more tools. Give the user a concise, specific closing explanation now: state the outcome, what changed, what was verified, and any blocker or next step. If the task is incomplete, say exactly where it stopped and why.`;
const DELEGATION_RECOVERY = `A delegated run failed and no replacement delegation was launched before the turn settled. Own the failure now: inspect the exact status/error and any partial output, identify whether the cause was a runtime budget, unavailable model/tool, configuration problem, or task failure, preserve valid partial work, and re-delegate only the next bounded chunk with a concise corrected outcome. LemonPi compiles and enforces execution budgets. For an implementation handoff, call lemonpi_git integrate_worker_result with the exact artifactRunId and retry only failed or conflicting work, never the completed patch. If a legacy completion guard says a read-only child made no edits, treat that as a classification error and use its valid artifact. If the model produced no output, launch a fresh smaller question instead of resuming bloated context. If the blocker is external, give the user the exact evidence instead of claiming recovery.`;
const ATTENTION_RECOVERY = `A delegated run reported needs_attention and the previous response did not inspect or control it. Act now instead of narrating passive waiting. Use the subagent status/transcript controls for the exact run. If it remains alive without an active tool or new output, steer it once to return its result or blocker immediately. If intervention cannot be delivered, stop it and preserve useful transcript findings for one fresh, smaller replacement. Do not leave it marked running indefinitely and do not launch a competing writer.`;
const PLAN_CONTINUATION = `Your visible task plan still contains unfinished work, but you settled with no delegated agent active. Continue the stranded plan now instead of waiting for another user message. Give the user a concise visible update, then execute or delegate the next bounded action. If the task is genuinely blocked or waiting for the user, move it out of in-progress state and explain the exact blocker; never leave an idle task spinning.`;
const MISSION_INTEGRATION = `A durable LemonPi mission has delegated results waiting for Main Pi, but no child is active. For completed implementation, call lemonpi_git integrate_worker_result with the exact artifactRunId; do not dispatch another model to copy the patch. If more work remains, dispatch only the next bounded lane. If complete or blocked, give the user a concrete explanation.`;
const MISSION_RECONCILE_ATTENTION = `LemonPi could not automatically reconcile a recorded delegated run after a session lifecycle transition. Inspect the exact recorded run once and take the appropriate action. Do not poll it repeatedly: if it is active, end the turn; if it is terminal, integrate it; if it needs attention, intervene.`;
const ACTIVE_DELEGATION_HANDOFF = `<lemonpi-active-delegation-handoff>
The immediately preceding launch, resume, or status result is authoritative: delegated work is active. Do not call status again, do not wait or sleep, and do not run another tool merely to monitor it. Give the user one concise, specific progress update and end the turn now. LemonPi will wake Main Pi when the run completes or needs attention; a real new user message may still be answered and used to steer the worker.
</lemonpi-active-delegation-handoff>`;

function visibleText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type?: string; text?: string } => Boolean(part) && typeof part === "object")
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

const subagentProtocolReady = new WeakMap<object, Promise<void>>();

function requestSubagentRpcRaw<T>(
  pi: ExtensionAPI,
  method: "ping" | "spawn" | "status" | "steer" | "stop",
  params: Record<string, unknown>,
  timeoutMs = SUBAGENT_RPC_TIMEOUT_MS,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const requestId = globalThis.crypto.randomUUID();
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout>;
    const unsubscribe = pi.events.on(`${SUBAGENT_RPC_REPLY_PREFIX}${requestId}`, (payload) => {
      const reply = payload as { version?: number; requestId?: string; method?: string; success?: boolean; data?: T; error?: { message?: string } };
      if (reply.requestId !== requestId || settled) return;
      settled = true;
      clearTimeout(timeoutId);
      unsubscribe();
      if (reply.version !== 1 || (reply.method !== undefined && reply.method !== method)) {
        reject(new Error(`Incompatible pi-subagents RPC reply for '${method}'.`));
      } else if (reply.success === true) resolve(reply.data as T);
      else reject(new Error(reply.error?.message ?? `The subagent rejected the ${method} request.`));
    });
    timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      unsubscribe();
      reject(new Error(`The subagent did not acknowledge the ${method} request.`));
    }, timeoutMs);

    pi.events.emit(SUBAGENT_RPC_REQUEST_EVENT, {
      version: 1,
      requestId,
      method,
      params,
    });
  });
}

async function ensureSubagentRpcCompatible(pi: ExtensionAPI): Promise<void> {
  const cached = subagentProtocolReady.get(pi as object);
  if (cached) return cached;
  const pending = requestSubagentRpcRaw<unknown>(pi, "ping", {}, SUBAGENT_RPC_TIMEOUT_MS)
    .then((value) => { validateSubagentRpcHandshake(value); })
    .catch((error) => {
      subagentProtocolReady.delete(pi as object);
      throw error;
    });
  subagentProtocolReady.set(pi as object, pending);
  return pending;
}

async function requestSubagentRpc<T>(
  pi: ExtensionAPI,
  method: "spawn" | "status" | "steer" | "stop",
  params: Record<string, unknown>,
  timeoutMs = SUBAGENT_RPC_TIMEOUT_MS,
): Promise<T> {
  await ensureSubagentRpcCompatible(pi);
  return requestSubagentRpcRaw<T>(pi, method, params, timeoutMs);
}

function requestSubagentSteer(pi: ExtensionAPI, id: string, index: number, message: string): Promise<void> {
  return requestSubagentRpc<void>(pi, "steer", { id, index, message });
}

function requestSubagentStop(pi: ExtensionAPI, id: string, provenance: WorkerStopProvenance): Promise<void> {
  return requestSubagentRpc<void>(pi, "stop", {
    id,
    cause: provenance.cause,
    initiator: provenance.initiator,
    initiatingRunId: provenance.initiatingRunId ?? id,
    reason: provenance.reason,
    requestedAt: provenance.requestedAt,
  });
}

async function requestSubagentStatus(pi: ExtensionAPI, id?: string): Promise<unknown> {
  const value = await requestSubagentRpc<unknown>(pi, "status", id ? { id } : {}, RESTORE_STATUS_RPC_TIMEOUT_MS);
  if (!id) return value;
  const root = asRecord(value);
  if (root?.protocolVersion === 2) return value;
  const text = typeof root?.text === "string" ? root.text : "";
  const reportedRunId = /^Run:\s*([^\s]+)\s*$/im.exec(text)?.[1]?.trim();
  const directory = /^Dir:\s*(.+?)\s*$/im.exec(text)?.[1]?.trim();
  if (reportedRunId !== id || !directory) throw new Error(`pi-subagents returned no exact status artifact for targeted run '${id}'.`);
  let canonicalDirectory: string;
  try {
    canonicalDirectory = realpathSync(directory);
  } catch {
    throw new Error(`pi-subagents targeted status directory is unavailable for '${id}'.`);
  }
  if (!/(?:^|[\\/])pi-subagents-[^\\/]+(?:[\\/]|$)/.test(canonicalDirectory)) {
    throw new Error(`pi-subagents targeted status directory is outside the managed runtime for '${id}'.`);
  }
  const statusPath = resolve(canonicalDirectory, "status.json");
  if (statSync(statusPath).size > 2 * 1024 * 1024) throw new Error(`pi-subagents status artifact is too large for '${id}'.`);
  const artifact = JSON.parse(readFileSync(statusPath, "utf8"));
  const typed = typedTargetStatusFromRunStatus(artifact, id);
  let stopProvenance: unknown;
  try {
    const sidecar = resolve(canonicalDirectory, "stop-provenance.json");
    if (statSync(sidecar).size <= 64 * 1024) stopProvenance = JSON.parse(readFileSync(sidecar, "utf8"));
  } catch { /* Optional LemonPi compatibility sidecar. */ }
  return { ...typed, runtimeDirectory: canonicalDirectory, ...(stopProvenance ? { stopProvenance } : {}), artifact, ...(root?.fleet ? { fleet: root.fleet } : {}), evidence: value };
}

export function executableAgentNames(value: unknown): string[] {
  const text = visibleText(asRecord(value)?.content ?? value);
  return [...text.matchAll(/^\s*-\s+([^\s(]+)\s+\(/gm)].map((match) => match[1]!.trim());
}

function requestSubagentSpawn(pi: ExtensionAPI, params: Record<string, unknown>): Promise<unknown> {
  return requestSubagentRpc<unknown>(pi, "spawn", params, 15_000);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function readJsonObject(path: string): Record<string, unknown> {
  try { return asRecord(JSON.parse(readFileSync(path, "utf8"))) ?? {}; } catch { return {}; }
}

function userLemonPiSettings(): Record<string, unknown> {
  const agentDir = process.env.PI_CODING_AGENT_DIR || resolve(homedir(), ".pi/agent");
  return readJsonObject(resolve(agentDir, "settings.json"));
}

function availableModelIds(ctx: unknown): string[] {
  const registry = asRecord(ctx)?.modelRegistry as { getAvailable?: () => unknown[] } | undefined;
  const models = registry?.getAvailable?.() ?? [];
  return [...new Set(models.flatMap((candidate) => {
    const model = asRecord(candidate);
    const provider = typeof model?.provider === "string" ? model.provider.trim() : "";
    const id = typeof model?.id === "string" ? model.id.trim() : "";
    return provider && id ? [`${provider}/${id}`] : [];
  }))];
}

function configuredAgentDefinitionFallbacks(agent: string, cwd: string | undefined): string[] {
  const agentDir = process.env.PI_CODING_AGENT_DIR || resolve(homedir(), ".pi/agent");
  const directories = [
    resolve(agentDir, "npm/node_modules/pi-subagents/agents"),
    resolve(agentDir, "agents"),
    resolve(homedir(), ".agents"),
    ...(cwd ? [resolve(cwd, ".pi/agents"), resolve(cwd, ".agents")] : []),
  ];
  const configured: string[] = [];
  for (const directory of directories) {
    let entries: Array<{ isFile(): boolean; name: string }>;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries.slice(0, 512)) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const path = resolve(directory, entry.name);
      let text = "";
      try {
        if (statSync(path).size > 256 * 1024) continue;
        text = readFileSync(path, "utf8");
      } catch { continue; }
      const frontmatter = /^---\s*\r?\n([\s\S]*?)\r?\n---/m.exec(text)?.[1] ?? "";
      const name = /^\s*name\s*:\s*["']?([^\r\n"']+)/mi.exec(frontmatter)?.[1]?.trim();
      if (name !== agent) continue;
      const fallback = /^\s*fallbackModels\s*:\s*(.*)$/mi.exec(frontmatter);
      if (fallback && fallback[1]?.trim() !== "[]") configured.push(`${path} fallbackModels`);
    }
  }
  return configured;
}

function runtimeLaunchBinding(agent: string, cwd: string | undefined, ctx: unknown): ReturnType<typeof resolveAgentLaunchBinding> {
  const userSettings = userLemonPiSettings();
  return resolveAgentLaunchBinding({
    agent,
    userSettings,
    projectSettings: cwd ? readJsonObject(resolve(cwd, ".pi/settings.json")) : {},
    availableModels: availableModelIds(ctx),
    configuredFallbackModels: configuredAgentDefinitionFallbacks(agent, cwd),
  });
}

function expectedManagedWorktreePath(repositoryRoot: string, runId: string): string {
  const settings = asRecord(userLemonPiSettings()) ?? {};
  const subagents = asRecord(settings.subagents) ?? {};
  const configured = typeof subagents.worktreeBaseDir === "string" && subagents.worktreeBaseDir.trim()
    ? subagents.worktreeBaseDir.trim()
    : process.env.PI_SUBAGENTS_WORKTREE_DIR?.trim();
  let base = tmpdir();
  if (configured) {
    const expanded = configured.startsWith("~/") ? resolve(homedir(), configured.slice(2)) : configured;
    base = /^(?:[A-Za-z]:[\\/]|\/)/.test(expanded) ? expanded : resolve(repositoryRoot, expanded);
  }
  return resolve(base, `pi-worktree-${runId}-s0-0`);
}

const CHUNK_OUTCOME = /(?:^|\n)\s*chunk outcome\s*:\s*\S/i;
const CHUNK_IN_SCOPE = /(?:^|\n)\s*in scope\s*:\s*\S/i;
const CHUNK_DONE_WHEN = /(?:^|\n)\s*done when\s*:\s*\S/i;
const CHUNK_OUT_OF_SCOPE = /(?:^|\n)\s*out of scope\s*:\s*\S/i;
const NO_DEPENDENCIES = /(?:^|\n)\s*depends on\s*:\s*none\s*(?:\n|$)/i;
const SLICE_TARGET = /(?:^|\n)\s*slice target\s*:\s*under 5 minutes\s*(?:\n|$)/i;
const WORKER_SUMMARY = /(?:^|\n)\s*worker summary\s*:\s*\S/i;
const CHECKOUT_SNAPSHOT_START = "<lemonpi-checkout-snapshot>";
const CHECKOUT_SNAPSHOT_END = "</lemonpi-checkout-snapshot>";
const CHECKOUT_SNAPSHOT_BLOCK = /\n*<lemonpi-checkout-snapshot>[\s\S]*?<\/lemonpi-checkout-snapshot>\s*/gi;
const MAIN_MUTATION_TOOLS = new Set(["edit", "write", "apply_patch", "patch", "write_file", "edit_file", "create_file", "delete_file", "move_file"]);
const IMPLEMENTATION_TASK = /\b(?:implement|build|create|edit|modify|update|change|fix|add|remove|refactor|wire|style|replace|rename|delete|patch)\b/i;
const EXPLICIT_READ_ONLY_TASK = /(?:^|\n)\s*(?:execution mode:\s*read[- ]only|read[- ]only(?:\s+(?:task|mode))?|no code changes(?:\s+requested)?|do not (?:edit|write|modify) any project files|plan only|report only|analysis only)\s*[.!]?(?:\n|$)/i;
const EXECUTION_MODE = /(?:^|\n)\s*execution mode\s*:\s*(read[- ]only|implementation)\s*(?:\n|$)/i;
const PACKAGE_READ_ONLY_GUARD = "Do not modify any project files. Return only the requested read-only artifact.";
const ATOMIC_AGGREGATE = /(?:^|\n)\s*atomic aggregate\s*:\s*required\s*(?:\n|$)/i;

interface DelegatedSpec {
  agent: string;
  task: string;
}

export interface CheckoutSnapshot {
  root: string;
  head: string;
  branch: string;
  dirtyEntries: string[];
  stagedEntries: string[];
}

function directConcurrentDelegationSpecs(input: Record<string, unknown>): DelegatedSpec[] {
  const candidates = Array.isArray(input.tasks)
    ? input.tasks
    : Array.isArray(input.parallel)
      ? input.parallel
      : [input];
  const direct = candidates
    .map(asRecord)
    .filter((record): record is Record<string, unknown> => Boolean(record) && typeof record.agent === "string")
    .map((record) => ({
      agent: String(record.agent).trim().toLowerCase(),
      task: typeof record.task === "string" ? record.task : "",
    }));
  if (direct.length > 0) return direct;
  const nested = delegatedSpecs(input);
  return nested.length > 0 ? [nested[0]!] : [];
}

export function groupedDelegationPolicyIssue(input: Record<string, unknown>): string | undefined {
  const groupedCount = Array.isArray(input.tasks)
    ? input.tasks.length
    : Array.isArray(input.chain)
      ? input.chain.length
      : 0;
  if (groupedCount <= 1) return undefined;
  const declaration = delegatedSpecs(input).map((spec) => spec.task).join("\n");
  if (ATOMIC_AGGREGATE.test(declaration)) return undefined;
  return "Grouped subagent runs delay every actionable result until the whole group finishes. Dispatch these lanes through lemonpi_dispatch so each gets its own async run and wakes Main Pi independently. Use a grouped tasks/chain call only for a truly indivisible aggregate and declare `Atomic aggregate: required` in its task.";
}

function delegatedSpecs(value: unknown): DelegatedSpec[] {
  const specs: DelegatedSpec[] = [];
  const visit = (candidate: unknown) => {
    const record = asRecord(candidate);
    if (!record) return;
    if (typeof record.agent === "string") {
      specs.push({
        agent: record.agent.trim().toLowerCase(),
        task: typeof record.task === "string" ? record.task : "",
      });
    }
    if (Array.isArray(record.tasks)) record.tasks.forEach(visit);
    if (Array.isArray(record.chain)) record.chain.forEach(visit);
    if (Array.isArray(record.parallel)) record.parallel.forEach(visit);
    else if (record.parallel) visit(record.parallel);
  };
  visit(value);
  return specs;
}

const PER_DISPATCH_BUDGET_FIELDS = ["timeoutMs", "maxRuntimeMs", "turnBudget", "toolBudget", "usageBudget"] as const;

function stripPerDispatchBudgets(value: unknown): void {
  const visit = (candidate: unknown) => {
    const record = asRecord(candidate);
    if (!record) return;
    for (const field of PER_DISPATCH_BUDGET_FIELDS) delete record[field];
    for (const key of ["tasks", "chain", "parallel"] as const) {
      const nested = record[key];
      if (Array.isArray(nested)) nested.forEach(visit);
      else if (nested !== undefined) visit(nested);
    }
  };
  visit(value);
}

function hasBoundedChunkContract(task: string): boolean {
  return CHUNK_OUTCOME.test(task)
    && CHUNK_IN_SCOPE.test(task)
    && CHUNK_DONE_WHEN.test(task)
    && CHUNK_OUT_OF_SCOPE.test(task);
}

const READ_ONLY_ROLE_NAMES = new Set(["advisor", "context-builder", "oracle", "planner", "researcher", "reviewer", "scout"]);

function conciseTaskSummary(task: string): string {
  const chunkOutcome = sectionLead(task, "chunk outcome");
  if (chunkOutcome) return chunkOutcome.slice(0, 180);
  const line = task
    .split("\n")
    .map((value) => value.trim())
    .find((value) => value && !/^(?:worker summary|execution mode|chunk outcome|in scope|done when|out of scope|owned paths|depends on|single-writer reason|single-writer detail|review justification|child checklist|normative contract|shared .+ rules|tests?|validation)\s*:/i.test(value));
  return (line ?? "Complete the delegated outcome").replace(/^[-*]\s+/, "").slice(0, 180);
}

export function normalizeWorkerSummary(value: unknown, task: string): string {
  const authored = typeof value === "string" ? value : "";
  const candidate = cleanChecklistText(authored).replace(/^worker summary\s*:\s*/i, "")
    || conciseTaskSummary(task);
  return candidate.split(/\s+/).filter(Boolean).slice(0, 8).join(" ").slice(0, 96)
    || "Complete delegated outcome";
}

export function workerSummaryFromTask(task: string): string | undefined {
  const line = task.replace(/\r\n/g, "\n").split("\n")
    .find((candidate) => /^\s*worker summary\s*:/i.test(candidate));
  if (!line) return undefined;
  const summary = cleanChecklistText(line.replace(/^\s*worker summary\s*:\s*/i, ""));
  return summary || undefined;
}

export function authoredWorkerSummaryIssue(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return "is required and must describe this lane's concrete purpose";
  }
  const summary = cleanChecklistText(value).replace(/^worker summary\s*:\s*/i, "");
  const words = summary.split(/\s+/).filter(Boolean);
  if (words.length > 8) return "must contain eight words or fewer";
  if (/^(?:complete|handle|perform|execute|work on)(?: the)?(?: delegated)?(?: task| outcome| work)?[.!]?$/i.test(summary)) {
    return "must describe the actual outcome, not generic delegation boilerplate";
  }
  return undefined;
}

function cleanChecklistText(value: string): string {
  return value
    .replace(/^\s*(?:#{1,6}\s*|[-*+]\s+)/, "")
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function sectionLead(task: string, wantedHeading: string): string | undefined {
  const lines = task.replace(/\r\n/g, "\n").split("\n");
  const heading = wantedHeading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matcher = new RegExp(`^\\s*(?:#{1,6}\\s*)?${heading}\\s*:\\s*(.*)$`, "i");
  for (let index = 0; index < lines.length; index += 1) {
    const match = matcher.exec(lines[index]);
    if (!match) continue;
    const inline = cleanChecklistText(match[1]);
    if (inline) return inline;
    for (let offset = index + 1; offset < lines.length; offset += 1) {
      const raw = lines[offset];
      if (/^\s*(?:#{1,6}\s*)?[^:\n]{2,80}:\s*$/.test(raw)) break;
      const candidate = cleanChecklistText(raw);
      if (candidate) return candidate;
    }
  }
  return undefined;
}

function inferredExecutionMode(agent: string, task: string, structuredMode?: unknown): "read-only" | "implementation" {
  if (structuredMode === "read-only" || structuredMode === "implementation") return structuredMode;
  const declared = declaredExecutionMode(task);
  if (declared) return declared;
  if (EXPLICIT_READ_ONLY_TASK.test(task) || READ_ONLY_ROLE_NAMES.has(agent.trim().toLowerCase())) return "read-only";
  if (hasBoundedChunkContract(task) || IMPLEMENTATION_TASK.test(task) || agent.trim().toLowerCase() === "worker") return "implementation";
  return "read-only";
}

function appendMissingImplementationContract(task: string, summary: string): string {
  const fields: string[] = [];
  if (!CHUNK_OUTCOME.test(task)) fields.push(`Chunk outcome: ${summary}`);
  if (!CHUNK_IN_SCOPE.test(task)) fields.push("In scope: Only changes required to deliver the delegated outcome.");
  if (!CHUNK_DONE_WHEN.test(task)) fields.push("Done when: The outcome works and focused validation evidence is reported.");
  if (!CHUNK_OUT_OF_SCOPE.test(task)) fields.push("Out of scope: Unrelated cleanup, later backlog items, and unapproved product or architecture changes.");
  return fields.length > 0 ? `${task.trimEnd()}\n${fields.join("\n")}` : task;
}

export function compileDelegationContracts(input: Record<string, unknown>): void {
  const directTasks = Array.isArray(input.tasks) ? input.tasks.map(asRecord).filter(Boolean) : [];
  const directAgentCount = directTasks.filter((record) => typeof record?.agent === "string").length;
  const directWriters = directTasks.filter((record) =>
    typeof record?.agent === "string"
    && inferredExecutionMode(record.agent, typeof record.task === "string" ? record.task : "", record.executionMode) === "implementation"
  );
  const directWriterCount = directWriters.length;
  const writerCwds = directWriters
    .map((record) => typeof record?.cwd === "string" ? record.cwd.trim() : "")
    .filter(Boolean);
  const spansDeclaredCheckouts = directWriterCount > 1
    && writerCwds.length === directWriterCount
    && new Set(writerCwds).size === directWriterCount;

  const visit = (candidate: unknown) => {
    const record = asRecord(candidate);
    if (!record) return;
    if (typeof record.agent === "string") {
      const originalTask = typeof record.task === "string" ? record.task.trim() : "";
      const summary = normalizeWorkerSummary(record.summary, originalTask);
      delete record.summary;
      const mode = inferredExecutionMode(record.agent, originalTask, record.executionMode);
      delete record.executionMode;
      // Reasoning is a runtime-owned launch override. Keeping it out of the public
      // task schema prevents model-authored or stale agent defaults from winning.
      delete record.thinking;
      let task = originalTask;
      // Keep the human task first so Command Center shows the delegated outcome instead of
      // generic runtime metadata such as "Execution mode: read-only".
      if (!declaredExecutionMode(task)) task = `${task.trimEnd()}\nExecution mode: ${mode}`.trim();
      if (mode === "implementation") task = appendMissingImplementationContract(task, summary);
      if (directWriterCount > 1 && mode === "implementation" && !NO_DEPENDENCIES.test(task)) {
        task = `${task.trimEnd()}\nDepends on: none`;
      }
      if (!SLICE_TARGET.test(task)) task = `${task.trimEnd()}\nSlice target: under 5 minutes`;
      if (!WORKER_SUMMARY.test(task)) task = `${task.trimEnd()}\nWorker summary: ${summary}`;
      record.task = task;
    }
    for (const key of ["tasks", "chain", "parallel"] as const) {
      const nested = record[key];
      if (Array.isArray(nested)) nested.forEach(visit);
      else if (nested !== undefined) visit(nested);
    }
  };
  visit(input);

  if (directWriterCount > 1) {
    // pi-subagents' managed worktree mode is intentionally single-repository. Distinct explicit
    // task cwd values are authoritative cross-repository isolation and are revalidated below.
    input.worktree = !spansDeclaredCheckouts;
    input.artifacts = true;
  }
  if (directAgentCount > 1) {
    const requestedConcurrency = typeof input.concurrency === "number" && Number.isFinite(input.concurrency)
      ? Math.max(1, Math.floor(input.concurrency))
      : directAgentCount;
    input.concurrency = Math.max(directAgentCount, requestedConcurrency);
  }
}

export function independentSpawnParams(lane: Record<string, unknown>): {
  implementation: boolean;
  params: Record<string, unknown>;
} {
  const task = typeof lane.task === "string" ? lane.task : "";
  const agent = typeof lane.agent === "string" ? lane.agent : "";
  const implementation = delegatesImplementation({ agent, task });
  const cwd = typeof lane.cwd === "string" && lane.cwd.trim() ? lane.cwd.trim() : undefined;
  const prepared = { ...lane };
  delete prepared.cwd;
  const reusePreparedWorktree = prepared.reusePreparedWorktree === true;
  delete prepared.reusePreparedWorktree;
  delete prepared.worktreePath;
  delete prepared.baseRevision;
  delete prepared.ownedPaths;
  delete prepared.todoId;
  delete prepared.thinking;
  delete prepared.primaryValidation;
  delete prepared.checkpoint;
  delete prepared.continuationOf;
  // Standalone LemonPi lanes do not have chain-generated context.md/plan.md.
  // Explicit false overrides bundled agent defaultReads instead of injecting
  // instructions for files that do not exist.
  prepared.reads = false;

  if (implementation) {
    return {
      implementation: true,
      params: {
        tasks: [prepared],
        concurrency: 1,
        worktree: !reusePreparedWorktree,
        artifacts: true,
        async: true,
        clarify: false,
        ...(cwd ? { cwd } : {}),
      },
    };
  }

  return {
    implementation: false,
    params: {
      ...prepared,
      artifacts: true,
      async: true,
      clarify: false,
      ...(cwd ? { cwd } : {}),
    },
  };
}

function ownedPathFieldValues(task: string): string[] | undefined {
  const lines = task.split(/\r?\n/);
  const fieldIndex = lines.findIndex((line) => /^\s*owned paths\s*:/i.test(line));
  if (fieldIndex < 0) return undefined;

  const firstLine = lines[fieldIndex]!.replace(/^\s*owned paths\s*:\s*/i, "").trim();
  const values: string[] = firstLine ? [firstLine] : [];
  for (let index = fieldIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!line.trim()) break;
    const bullet = /^\s*[-*]\s+(.+?)\s*$/.exec(line);
    if (!bullet) break;
    values.push(bullet[1]!);
  }

  return values.flatMap((value) => value.split(","));
}

function normalizedOwnedPaths(task: string): string[] | undefined {
  const values = ownedPathFieldValues(task);
  if (!values) return undefined;
  const paths = values
    .map((value) => value.trim().replace(/^`|`$/g, "").normalize("NFC").replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, ""))
    .filter(Boolean);
  if (paths.length === 0 || paths.some((value) =>
    value === "."
    || value.startsWith("/")
    || /^[A-Za-z]:\//.test(value)
    || value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
    || /[*?\[\]{}]/.test(value)
  )) return undefined;
  return [...new Set(paths.map((value) => value.toLowerCase()))];
}

function normalizedOwnedPathList(values: unknown): string[] | undefined {
  if (!Array.isArray(values)) return undefined;
  const paths = values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim().normalize("NFC").replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, ""))
    .filter(Boolean);
  if (paths.length === 0 || paths.some((value) =>
    value === "."
    || value.startsWith("/")
    || /^[A-Za-z]:\//.test(value)
    || value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
    || /[*?\[\]{}]/.test(value)
  )) return undefined;
  return [...new Set(paths)];
}

function ownedPathsOverlap(left: string[], right: string[]): string | undefined {
  for (const leftPath of left) {
    for (const rightPath of right) {
      if (leftPath === rightPath || leftPath.startsWith(`${rightPath}/`) || rightPath.startsWith(`${leftPath}/`)) {
        return leftPath.length <= rightPath.length ? leftPath : rightPath;
      }
    }
  }
  return undefined;
}

export function parallelWriterPolicyIssue(input: Record<string, unknown>): string | undefined {
  const allWriters = delegatedSpecs(input).filter(delegatesImplementation);
  const taskRecords = Array.isArray(input.tasks) ? input.tasks.map(asRecord).filter(Boolean) : [];
  const directWriters = taskRecords.filter((record) =>
    typeof record?.agent === "string"
    && delegatesImplementation({ agent: record.agent, task: typeof record.task === "string" ? record.task : "" })
  );
  const repeatedWriter = directWriters.find((record) => typeof record?.count === "number" && record.count > 1);
  if (allWriters.length <= 1 && !repeatedWriter) return undefined;
  if (!Array.isArray(input.tasks)) {
    return "Parallel implementation must use one top-level tasks wave; keep sequential writers in separate dispatches.";
  }
  const writers = directWriters;
  if (writers.length !== allWriters.length) {
    return "Parallel implementation writers must all be direct top-level tasks, not nested chain or fanout children.";
  }
  const declaredCwds = writers.map((writer) => typeof writer?.cwd === "string" ? writer.cwd.trim() : "");
  const separateDeclaredCheckouts = input.worktree !== true
    && declaredCwds.every(Boolean)
    && new Set(declaredCwds).size === writers.length;
  if (input.worktree !== true && !separateDeclaredCheckouts) {
    return "Parallel writers in one repository require worktree: true. Cross-repository writers must each declare a distinct task cwd.";
  }
  const lanes: Array<{ agent: string; paths: string[]; cwd?: string }> = [];
  for (const writer of writers) {
    if (typeof writer?.count === "number" && writer.count > 1) {
      return "Implementation lanes cannot use count; author each lane explicitly with distinct ownership.";
    }
    const task = typeof writer?.task === "string" ? writer.task : "";
    const agent = typeof writer?.agent === "string" ? writer.agent : "writer";
    const paths = normalizedOwnedPaths(task);
    if (!paths) {
      return `Parallel writer ${agent} needs a valid Owned paths: field with exact repo-relative files or directories and no globs.`;
    }
    if (!NO_DEPENDENCIES.test(task)) {
      return `Parallel writer ${agent} must declare Depends on: none; dependent chunks belong in a later wave.`;
    }
    const cwd = declaredCwds[writers.indexOf(writer)] || undefined;
    for (const lane of lanes) {
      if (separateDeclaredCheckouts && lane.cwd !== cwd) continue;
      const overlap = ownedPathsOverlap(lane.paths, paths);
      if (overlap) return `Parallel writer ownership overlaps at ${overlap}; serialize or redraw the lane boundaries.`;
    }
    lanes.push({ agent, paths, ...(cwd ? { cwd } : {}) });
  }
  return undefined;
}

function directImplementationRecords(input: Record<string, unknown>): Record<string, unknown>[] {
  if (!Array.isArray(input.tasks)) return [];
  return input.tasks
    .map(asRecord)
    .filter((record): record is Record<string, unknown> => Boolean(record)
      && typeof record?.agent === "string"
      && delegatesImplementation({ agent: record.agent, task: typeof record.task === "string" ? record.task : "" }));
}

function implementationSpecs(input: Record<string, unknown>): DelegatedSpec[] {
  return delegatedSpecs(input).filter(delegatesImplementation);
}

export function workConservingLaneSelection(issues: Array<string | undefined>): {
  launchIndexes: number[];
  deferred: Array<{ index: number; reason: string }>;
} {
  const launchIndexes: number[] = [];
  const deferred: Array<{ index: number; reason: string }> = [];
  issues.forEach((reason, index) => {
    if (reason) deferred.push({ index, reason });
    else launchIndexes.push(index);
  });
  return { launchIndexes, deferred };
}

export function retainWorkConservingLanes(
  input: Record<string, unknown>,
  writerRecords: Record<string, unknown>[],
  selection: ReturnType<typeof workConservingLaneSelection>,
): void {
  if (selection.deferred.length === 0) return;
  const blockedRecords = new Set(selection.deferred.map(({ index }) => writerRecords[index]!));
  const originalTasks = Array.isArray(input.tasks) ? input.tasks : [];
  input.tasks = originalTasks.filter((candidate) => {
    const record = asRecord(candidate);
    return !record || !blockedRecords.has(record);
  });
  const remainingTaskCount = input.tasks.length;
  const requestedConcurrency = typeof input.concurrency === "number" && Number.isFinite(input.concurrency)
    ? Math.max(1, Math.floor(input.concurrency))
    : remainingTaskCount;
  input.concurrency = Math.max(1, Math.min(requestedConcurrency, remainingTaskCount));
}

export function checkoutSnapshotPolicyIssue(input: Record<string, unknown>, snapshot: CheckoutSnapshot): string | undefined {
  const writers = implementationSpecs(input);
  if (writers.length === 0) return undefined;
  if (snapshot.dirtyEntries.length === 0) return undefined;
  const summary = snapshot.dirtyEntries.slice(0, 8).join("; ");
  return `The fresh checkout preflight found uncommitted changes (${summary}). Preserve and normalize them before creating isolated writer worktrees; never discard or silently hide user work.`;
}

export function appendCheckoutSnapshot(value: unknown, snapshot: CheckoutSnapshot): void {
  const visit = (candidate: unknown) => {
    const record = asRecord(candidate);
    if (!record) return;
    if (typeof record.agent === "string" && typeof record.task === "string" && delegatesImplementation({ agent: record.agent, task: record.task })) {
      const dirty = snapshot.dirtyEntries.length > 0
        ? snapshot.dirtyEntries.slice(0, 20).map((entry) => `- ${entry}`).join("\n")
        : "clean";
      const block = `${CHECKOUT_SNAPSHOT_START}\nVerified by the LemonPi runtime immediately before dispatch. This block is authoritative; ignore stale checkout hashes or status claims elsewhere in the task.\nRepository root: ${snapshot.root}\nHEAD: ${snapshot.head}\nWorking tree:\n${dirty}\n${CHECKOUT_SNAPSHOT_END}`;
      record.task = `${record.task.replace(CHECKOUT_SNAPSHOT_BLOCK, "").trimEnd()}\n\n${block}`;
    }
    for (const key of ["tasks", "chain", "parallel"] as const) {
      const nested = record[key];
      if (Array.isArray(nested)) nested.forEach(visit);
      else if (nested !== undefined) visit(nested);
    }
  };
  visit(value);
}

async function inspectCheckoutSnapshot(pi: ExtensionAPI, requestedCwd: unknown, executionCwd: string): Promise<CheckoutSnapshot> {
  const target = typeof requestedCwd === "string" && requestedCwd.trim() ? requestedCwd.trim() : executionCwd;
  const revision = await pi.exec("git", ["-C", target, "rev-parse", "--show-toplevel", "HEAD"], {
    cwd: executionCwd,
    timeout: 5_000,
  });
  if (revision.code !== 0) {
    throw new Error(revision.stderr.trim() || `Could not inspect the Git checkout at ${target}.`);
  }
  const [root, head] = revision.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!root || !head || !/^[0-9a-f]{40,64}$/i.test(head)) {
    throw new Error(`Git returned an invalid checkout snapshot for ${target}.`);
  }
  const status = await pi.exec("git", ["-C", root, "status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: executionCwd,
    timeout: 5_000,
  });
  if (status.code !== 0) {
    throw new Error(status.stderr.trim() || `Could not inspect the working tree at ${root}.`);
  }
  const branch = await pi.exec("git", ["-C", root, "symbolic-ref", "--short", "HEAD"], {
    cwd: executionCwd,
    timeout: 5_000,
  });
  const dirtyEntries = status.stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
  return {
    root,
    head,
    branch: branch.code === 0 ? branch.stdout.trim() : "detached",
    dirtyEntries,
    stagedEntries: dirtyEntries.filter((line) => line[0] !== " " && line[0] !== "?"),
  };
}

function commandText(input: Record<string, unknown>): string {
  return typeof input.command === "string"
    ? input.command
    : typeof input.cmd === "string"
      ? input.cmd
      : "";
}

export function isManagedWorktreePatchCommand(input: Record<string, unknown>): boolean {
  const command = commandText(input);
  if (!command || /[\n;&|><`]|\$\(/.test(command)) return false;
  const match = /^\s*git\s+apply\s+(.+?)\s*$/.exec(command);
  if (!match) return false;
  const tokens = match[1].match(/"(?:\\.|[^"\\])*"|'[^']*'|\S+/g) ?? [];
  const allowedOptions = new Set(["--check", "--3way", "--index", "--recount", "--verbose", "--whitespace=nowarn", "--whitespace=fix", "--"]);
  const paths = tokens
    .filter((token) => !allowedOptions.has(token))
    .map((token) => token.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, (_whole, doubleQuoted, singleQuoted) => doubleQuoted ?? singleQuoted));
  if ((!tokens.includes("--check") && !tokens.includes("--3way"))
    || tokens.some((token) => token.startsWith("-") && !allowedOptions.has(token))
    || paths.length !== 1) return false;
  const normalized = paths[0].replace(/\\/g, "/");
  return (normalized.startsWith(".pi-subagents/artifacts/worktree-diffs/")
    || normalized.includes("/.pi-subagents/artifacts/worktree-diffs/"))
    && normalized.endsWith(".patch");
}

export function declaredExecutionMode(task: string): "read-only" | "implementation" | undefined {
  const match = EXECUTION_MODE.exec(task);
  if (!match) return undefined;
  return match[1].toLowerCase().replace(" ", "-") as "read-only" | "implementation";
}

export function delegatesImplementation(spec: DelegatedSpec): boolean {
  const mode = declaredExecutionMode(spec.task);
  if (mode === "read-only") return false;
  if (mode === "implementation") return true;
  if (EXPLICIT_READ_ONLY_TASK.test(spec.task)) return false;
  return hasBoundedChunkContract(spec.task) && IMPLEMENTATION_TASK.test(spec.task);
}

function reinforceReadOnlyContracts(value: unknown): void {
  const visit = (candidate: unknown) => {
    const record = asRecord(candidate);
    if (!record) return;
    if (typeof record.agent === "string" && typeof record.task === "string" && declaredExecutionMode(record.task) === "read-only") {
      if (!record.task.includes(PACKAGE_READ_ONLY_GUARD)) record.task = `${record.task.trimEnd()}\n\n${PACKAGE_READ_ONLY_GUARD}`;
    }
    for (const key of ["tasks", "chain", "parallel"] as const) {
      const nested = record[key];
      if (Array.isArray(nested)) nested.forEach(visit);
      else if (nested !== undefined) visit(nested);
    }
  };
  visit(value);
}

export function applyDelegationSafetyContracts(input: Record<string, unknown>): void {
  if (input.agentContract === undefined) input.agentContract = { version: 1 };
  reinforceReadOnlyContracts(input);
}

function escapedRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function writerNotificationStatus(content: string, agent: string | undefined): "completed" | "failed" | "paused" | "stopped" | undefined {
  const escapedAgent = agent ? escapedRegExp(agent) : "[^*]+";
  const single = content.match(new RegExp(`^(?:Background task|Detached foreground task) (completed|failed|paused|stopped): \\*\\*${escapedAgent}\\*\\*`, "mi"));
  if (single) return single[1] as "completed" | "failed" | "paused" | "stopped";
  if (agent && new RegExp(`^Background tasks completed \\(\\d+\\):.*\\*\\*${escapedAgent}\\*\\*`, "mi").test(content)) return "completed";
  return undefined;
}

type WriterLifecycleStatus = "completed" | "failed" | "paused" | "stopped";

function writerLifecycleStatus(value: unknown): WriterLifecycleStatus | undefined {
  const result = asRecord(value);
  if (!result) return undefined;
  const target = asRecord(result.target);
  if (target && target !== result) return writerLifecycleStatus(target);
  const children = Array.isArray(result.results) ? result.results.map(asRecord).filter(Boolean) : [];
  const stopped = result.stopped === true
    || result.state === "stopped"
    || children.some((child) => child?.stopped === true || child?.status === "stopped");
  if (stopped) return "stopped";
  const summary = typeof result.summary === "string" ? result.summary : "";
  const paused = result.state === "paused"
    || (result.success !== true && result.exitCode === 0)
    || summary.startsWith("Paused after interrupt.");
  if (paused) return "paused";
  if (result.success === true || result.state === "complete" || result.state === "completed") return "completed";
  if (result.success === false || result.state === "failed" || result.state === "rejected" || children.some((child) => child?.status === "failed" || child?.status === "rejected" || child?.success === false)) {
    return "failed";
  }
  return undefined;
}

export type SubagentStatusDisposition = "active" | "needs_attention" | "completed" | "failed" | "paused" | "stopped" | "empty" | "unknown";

export function subagentStatusDisposition(value: unknown): SubagentStatusDisposition {
  const root = asRecord(value);
  if (!root) return "unknown";
  const details = asRecord(root.details);
  const target = asRecord(root.target);
  const lifecycle = writerLifecycleStatus(root) ?? writerLifecycleStatus(details);
  if (lifecycle) return lifecycle;
  const rawState = typeof target?.state === "string" ? target.state : typeof root.state === "string" ? root.state : typeof details?.state === "string" ? details.state : undefined;
  const rawActivity = typeof target?.activityState === "string" ? target.activityState : typeof root.activityState === "string" ? root.activityState : typeof details?.activityState === "string" ? details.activityState : undefined;
  if (rawActivity === "needs_attention") return "needs_attention";
  if (rawState === "queued" || rawState === "pending" || rawState === "running") return "active";

  const text = typeof root.text === "string"
    ? root.text
    : visibleText(root.content);
  const state = /^State:\s*(queued|pending|running|complete|completed|failed|paused|stopped|rejected)\b/im.exec(text)?.[1]?.toLowerCase();
  if (/^Activity:\s*needs attention\b/im.test(text)) return "needs_attention";
  if (state === "queued" || state === "pending" || state === "running") return "active";
  if (state === "complete" || state === "completed") return "completed";
  if (state === "failed" || state === "rejected") return "failed";
  if (state === "paused") return "paused";
  if (state === "stopped") return "stopped";

  const fleet = asRecord(root.fleet);
  if (typeof fleet?.totalActive === "number") {
    if (fleet.totalActive > 0) return "active";
    if (/\bno active\b/i.test(text)) return "empty";
  }
  return "unknown";
}

export function restoredStatusAction(disposition: SubagentStatusDisposition): "stay_silent" | "wake_integration" | "wake_intervention" {
  if (disposition === "active") return "stay_silent";
  if (disposition === "completed" || disposition === "failed" || disposition === "stopped" || disposition === "empty") return "wake_integration";
  return "wake_intervention";
}

export function shouldSuppressStatusPoll(activeHandoffPending: boolean, action: unknown): boolean {
  return activeHandoffPending && action === "status";
}

export function missionHasActiveOwnership(input: {
  activeDelegationCount: number;
  recordedRunCount: number;
  writerOccupied: boolean;
  recordedWriterActive: boolean;
}): boolean {
  return input.activeDelegationCount > 0
    || input.recordedRunCount > 0
    || input.writerOccupied
    || input.recordedWriterActive;
}

export function missionWakeIsBlocked(input: {
  mainAgentRunning: boolean;
  activeToolExecutions: number;
  wakeQueued: boolean;
  turnSettled?: boolean;
}): boolean {
  return input.turnSettled === false || input.mainAgentRunning || input.activeToolExecutions > 0 || input.wakeQueued;
}

export type AuthoritativeRuntimeWorkerState = "active" | "idle" | "unknown";

export function authoritativeRuntimeWorkerState(value: unknown): AuthoritativeRuntimeWorkerState {
  const root = asRecord(value);
  const fleet = asRecord(root?.fleet);
  const totalActive = fleet?.totalActive;
  if (typeof totalActive !== "number" || !Number.isSafeInteger(totalActive) || totalActive < 0) return "unknown";
  return totalActive > 0 ? "active" : "idle";
}

function delegationRunId(value: unknown): string | undefined {
  const result = asRecord(value);
  const details = asRecord(result?.details);
  const candidate = details?.runId ?? details?.asyncId ?? result?.runId ?? result?.id;
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : undefined;
}

function delegationSessionId(value: unknown): string | undefined {
  const result = asRecord(value);
  const details = asRecord(result?.details);
  const candidate = details?.sessionId ?? result?.sessionId;
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : undefined;
}

function workerHandoffPath(value: unknown): string | undefined {
  const seen = new Set<object>();
  const visit = (candidate: unknown, depth: number): string | undefined => {
    if (depth > 8 || !candidate || typeof candidate !== "object" || seen.has(candidate as object)) return undefined;
    seen.add(candidate as object);
    if (Array.isArray(candidate)) {
      for (const entry of candidate.slice(0, 128)) {
        const found = visit(entry, depth + 1);
        if (found) return found;
      }
      return undefined;
    }
    const record = candidate as Record<string, unknown>;
    if (typeof record.handoffPath === "string" && record.handoffPath.trim()) return record.handoffPath.trim();
    const parallel = asRecord(record.parallelHandoff);
    if (typeof parallel?.path === "string" && parallel.path.trim()) return parallel.path.trim();
    for (const entry of Object.values(record).slice(0, 128)) {
      const found = visit(entry, depth + 1);
      if (found) return found;
    }
    return undefined;
  };
  return visit(value, 0);
}

function workerWorktreePath(value: unknown): string | undefined {
  const seen = new Set<object>();
  const visit = (candidate: unknown, depth: number): string | undefined => {
    if (depth > 8 || !candidate || typeof candidate !== "object" || seen.has(candidate as object)) return undefined;
    seen.add(candidate as object);
    if (Array.isArray(candidate)) {
      for (const entry of candidate.slice(0, 128)) {
        const found = visit(entry, depth + 1);
        if (found) return found;
      }
      return undefined;
    }
    const record = candidate as Record<string, unknown>;
    for (const key of ["worktreePath", "worktree", "workspacePath"] as const) {
      if (typeof record[key] === "string" && record[key].trim()) return record[key].trim();
    }
    for (const entry of Object.values(record).slice(0, 128)) {
      const found = visit(entry, depth + 1);
      if (found) return found;
    }
    return undefined;
  };
  return visit(value, 0);
}

function terminalRunKey(sessionId: string | undefined, runId: string): string {
  return `${sessionId ?? "unknown"}:${runId}`;
}

function verifiedAcceptanceWithoutRuntimeCommands(value: unknown): boolean {
  if (value === "verified") return true;
  const acceptance = asRecord(value);
  if (acceptance?.level !== "verified") return false;
  if (!Array.isArray(acceptance.verify) || acceptance.verify.length === 0) return true;
  return !acceptance.verify.some((candidate) => {
    const command = asRecord(candidate);
    return typeof command?.id === "string"
      && command.id.trim().length > 0
      && typeof command.command === "string"
      && command.command.trim().length > 0;
  });
}

function invalidVerifiedAcceptancePath(input: Record<string, unknown>): string | undefined {
  const visit = (candidate: unknown, path: string): string | undefined => {
    const record = asRecord(candidate);
    if (!record) return undefined;
    if (Object.hasOwn(record, "acceptance") && verifiedAcceptanceWithoutRuntimeCommands(record.acceptance)) {
      return `${path}.acceptance`;
    }
    for (const key of ["tasks", "chain", "parallel"] as const) {
      const nested = record[key];
      if (Array.isArray(nested)) {
        for (let index = 0; index < nested.length; index += 1) {
          const issue = visit(nested[index], `${path}.${key}[${index}]`);
          if (issue) return issue;
        }
      } else if (nested !== undefined) {
        const issue = visit(nested, `${path}.${key}`);
        if (issue) return issue;
      }
    }
    return undefined;
  };
  return visit(input, "subagent");
}

function shellMutatesProject(input: Record<string, unknown>): boolean {
  const command = commandText(input);
  if (!command) return false;
  if (/\bcargo\s+fmt\b/i.test(command) && !/--check\b/i.test(command)) return true;
  return [
    /(?:^|[;&|]\s*)(?:rm|mv|cp|mkdir|touch|install|truncate|mkfifo|ln)\b/m,
    /\b(?:sed\s+-[^\n]*i|perl\s+-[^\n]*pi)\b/i,
    /\b(?:prettier\b[^\n]*--write|eslint\b[^\n]*--fix|gofmt\b[^\n]*-w|rustfmt\b(?![^\n]*--check))\b/i,
    /\b(?:npm|pnpm|yarn|bun)\s+(?:add|install|remove|uninstall|update)\b/i,
    /\b(?:tee|patch|git\s+(?:apply|am))\b/i,
    /(?:^|[;&|]\s*)(?:echo|printf|cat)\b[^\n]*(?<![0-9])>{1,2}(?!>)/m,
    /\b(?:Set-Content|Add-Content|Out-File|New-Item|Remove-Item|Move-Item|Copy-Item)\b/i,
  ].some((pattern) => pattern.test(command));
}

function delegationFailure(result: unknown, isError: boolean): string | undefined {
  const root = asRecord(result);
  const details = asRecord(root?.details);
  const rawResults = Array.isArray(details?.results) ? details.results : Array.isArray(root?.results) ? root.results : [];
  const results = rawResults.map(asRecord).filter(Boolean);
  const failedResult = results.find((item) =>
    item?.timedOut === true
    || item?.error != null
    || item?.success === false
    || (typeof item?.exitCode === "number" && item.exitCode !== 0)
    || ["failed", "rejected"].includes(String(item?.status ?? "")),
  );
  const state = String(details?.state ?? root?.state ?? "");
  const failed = isError
    || details?.timedOut === true
    || root?.timedOut === true
    || details?.success === false
    || root?.success === false
    || (typeof root?.exitCode === "number" && root.exitCode !== 0)
    || ["failed", "rejected"].includes(state)
    || Boolean(failedResult);
  if (!failed) return undefined;
  const content = Array.isArray(root?.content)
    ? root.content.map(asRecord).filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part?.text).join("\n")
    : "";
  return String(failedResult?.error ?? details?.error ?? root?.error ?? (content || "Delegated run failed.")).slice(0, 800);
}

export function asyncWriterLaunchFailure(result: unknown, isError: boolean): string | undefined {
  const explicit = delegationFailure(result, isError);
  if (explicit) return explicit;
  if (delegationRunId(result)) return undefined;
  const explanation = visibleText(asRecord(result)?.content ?? result);
  return (explanation || "The writer launch returned without starting a run.").slice(0, 800);
}

interface RemainingPlanTask {
  id: number;
  subject: string;
  status: "in_progress" | "pending";
}

export interface VisibleRoadmapTask {
  id: number;
  subject: string;
  description?: string;
  activeForm?: string;
  status: "pending" | "in_progress" | "completed" | "deleted";
  blockedBy?: number[];
}

function visibleRoadmapTasksFromTodoResult(value: unknown): VisibleRoadmapTask[] | undefined {
  const root = asRecord(value);
  const details = asRecord(root?.details) ?? root;
  if (!details || !Array.isArray(details.tasks) || typeof details.nextId !== "number") return undefined;
  return details.tasks.flatMap((value) => {
    const task = asRecord(value);
    const status = task?.status;
    if (
      typeof task?.id !== "number"
      || typeof task.subject !== "string"
      || !["pending", "in_progress", "completed", "deleted"].includes(String(status))
    ) return [];
    return [{
      id: task.id,
      subject: task.subject.trim(),
      ...(typeof task.description === "string" && task.description.trim() ? { description: task.description.trim() } : {}),
      ...(typeof task.activeForm === "string" && task.activeForm.trim() ? { activeForm: task.activeForm.trim() } : {}),
      status: status as VisibleRoadmapTask["status"],
      ...(Array.isArray(task.blockedBy)
        ? { blockedBy: task.blockedBy.filter((id): id is number => typeof id === "number" && Number.isInteger(id)) }
        : {}),
    }];
  });
}

const MISSION_ENTRY = "lemonpi-mission-state";
const MISSION_OUTCOME_ENTRY = "lemonpi-mission-outcomes";
type MissionPhase = "planning" | "delegated" | "integration" | "complete" | "paused";

type MissionOutcomeStatus = "pending" | "in_progress" | "partial" | "validating" | "completed" | "needs_attention";

interface FastPathFinalization {
  root: string;
  repository: string;
  paths: string[];
  outcomeId: string;
  completedAt: number;
}

interface MissionOutcome {
  id: string;
  subject: string;
  status: MissionOutcomeStatus;
  detail?: string;
  todoId?: number;
  runIds: string[];
  repository?: string;
  relevantPaths?: string[];
  updatedAt: number;
}

interface MissionGitBaseline {
  repository: string;
  branch: string;
  head: string;
  status: string[];
  staged: string[];
  capturedAt: number;
}

interface MissionPathProvenance {
  repository: string;
  path: string;
  source: "baseline" | "fast-path" | "worker" | "integration";
  runId?: string;
  fingerprint: string;
  recordedAt: number;
}

interface PendingContinuation {
  priorRunId: string;
  handoffPath: string;
  outcomeId?: string;
  progressFingerprint: string;
  scheduledAt: number;
}

interface MissionState {
  version: 5;
  policyVersion: number;
  migratedFromPolicyVersion?: number;
  id: string;
  phase: MissionPhase;
  request: string;
  activeRunIds: string[];
  activeRunWidths?: Record<string, number>;
  writerActive: boolean;
  wakeAttempts: number;
  updatedAt: number;
  remainingTask?: RemainingPlanTask;
  attempts: WorkerAttempt[];
  outcomes: MissionOutcome[];
  lastCompletedRunId?: string;
  validations: ValidationRecord[];
  reviews: ReviewRecord[];
  baselines?: MissionGitBaseline[];
  pathProvenance?: MissionPathProvenance[];
  pendingContinuations?: PendingContinuation[];
  contractFailures?: Record<string, number>;
  fastPathFinalization?: FastPathFinalization;
  suppressedRunIds?: string[];
  pendingLaunches?: Array<{
    launchId: string;
    agent: string;
    purpose: string;
    task: string;
    executionMode: "read-only" | "implementation";
    provider: string;
    modelId: string;
    model: string;
    thinking: AgentLaunchBinding["thinking"];
    settingsSource: AgentLaunchBinding["source"];
    settingsHash: string;
    startedAt: number;
  }>;
}

export function parsedMissionState(value: unknown): MissionState | undefined {
  const record = asRecord(value);
  if ((record?.version !== 1 && record?.version !== 2 && record?.version !== 3 && record?.version !== 4 && record?.version !== 5)
    || typeof record.id !== "string"
    || !["planning", "delegated", "integration", "complete", "paused"].includes(String(record.phase))
    || typeof record.request !== "string"
    || !Array.isArray(record.activeRunIds)
    || !record.activeRunIds.every((runId) => typeof runId === "string")
    || typeof record.writerActive !== "boolean"
    || !Number.isInteger(record.wakeAttempts)
    || typeof record.updatedAt !== "number") return undefined;
  const remaining = asRecord(record.remainingTask);
  const rawFastPathFinalization = asRecord(record.fastPathFinalization);
  const policyMigrated = (record.policyVersion ?? 0) !== CURRENT_ORCHESTRATION_POLICY_VERSION;
  const attempts = Array.isArray(record.attempts)
    ? record.attempts.map(asRecord).filter((attempt): attempt is Record<string, unknown> => Boolean(attempt))
      .filter((attempt) => typeof attempt.runId === "string"
        && typeof attempt.purpose === "string"
        && ["running", "completed", "partial", "budget_exhausted", "failed", "stopped"].includes(String(attempt.status)))
      .slice(-64)
      .map((attempt) => ({
        runId: String(attempt.runId).slice(0, 128),
        ...(typeof attempt.launchId === "string" ? { launchId: attempt.launchId.slice(0, 128) } : {}),
        ...(typeof attempt.agent === "string" ? { agent: attempt.agent.slice(0, 160) } : {}),
        ...(typeof attempt.task === "string" ? { task: attempt.task.slice(0, 20_000) } : {}),
        ...(typeof attempt.originalObjective === "string" ? { originalObjective: attempt.originalObjective.slice(0, 4_000) } : {}),
        ...(typeof attempt.originalTask === "string" ? { originalTask: attempt.originalTask.slice(0, 20_000) } : {}),
        purpose: String(attempt.purpose).slice(0, 96),
        status: attempt.status as WorkerAttempt["status"],
        executionMode: attempt.executionMode === "implementation" ? "implementation" as const : "read-only" as const,
        completedOrdinal: Number.isInteger(attempt.completedOrdinal) ? Number(attempt.completedOrdinal) : 0,
        sliceCount: Number.isInteger(attempt.sliceCount) ? Math.max(1, Number(attempt.sliceCount)) : 1,
        transcriptBytes: typeof attempt.transcriptBytes === "number" ? Math.max(0, attempt.transcriptBytes) : 0,
        tokens: typeof attempt.tokens === "number" ? Math.max(0, attempt.tokens) : 0,
        ...(typeof attempt.turns === "number" ? { turns: Math.max(0, Math.floor(attempt.turns)) } : {}),
        ...(typeof attempt.toolCalls === "number" ? { toolCalls: Math.max(0, Math.floor(attempt.toolCalls)) } : {}),
        ...(typeof attempt.startedAt === "number" ? { startedAt: attempt.startedAt } : {}),
        ...(typeof attempt.elapsedMs === "number" ? { elapsedMs: Math.max(0, attempt.elapsedMs) } : {}),
        ...(typeof attempt.activityState === "string" ? { activityState: attempt.activityState.slice(0, 64) } : {}),
        ...(typeof attempt.currentTool === "string" ? { currentTool: attempt.currentTool.slice(0, 160) } : {}),
        ...(typeof attempt.currentPath === "string" ? { currentPath: attempt.currentPath.slice(0, 2_000) } : {}),
        ...(typeof attempt.budgetStopReason === "string" ? { budgetStopReason: attempt.budgetStopReason.slice(0, 240) } : {}),
        ...(attempt.budgetPhase === "work" || attempt.budgetPhase === "warning" || attempt.budgetPhase === "finalizing" ? { budgetPhase: attempt.budgetPhase as WorkerAttempt["budgetPhase"] } : {}),
        ...(attempt.budgetWarningSent === true ? { budgetWarningSent: true } : {}),
        ...(asRecord(attempt.limitPolicy) && typeof asRecord(attempt.limitPolicy)!.enabled === "boolean"
          ? { limitPolicy: attempt.limitPolicy as WorkerAttempt["limitPolicy"] }
          : {}),
        ...(attempt.hardLimitPending === true ? { hardLimitPending: true } : {}),
        ...(typeof attempt.hardLimitBoundaryToolCount === "number" ? { hardLimitBoundaryToolCount: Math.max(0, Math.floor(attempt.hardLimitBoundaryToolCount)) } : {}),
        ...(typeof attempt.terminalCommittedAt === "number" ? { terminalCommittedAt: attempt.terminalCommittedAt } : {}),
        ...(attempt.usableOutput === true ? { usableOutput: true } : {}),
        ...(typeof attempt.partialHandoffPath === "string" ? { partialHandoffPath: attempt.partialHandoffPath } : {}),
        ...(typeof attempt.model === "string" ? { model: attempt.model.slice(0, 240) } : {}),
        ...(typeof attempt.provider === "string" ? { provider: attempt.provider.slice(0, 120) } : {}),
        ...(typeof attempt.modelId === "string" ? { modelId: attempt.modelId.slice(0, 200) } : {}),
        ...(typeof attempt.thinking === "string" ? { thinking: attempt.thinking as WorkerAttempt["thinking"] } : {}),
        ...(typeof attempt.settingsSource === "string" ? { settingsSource: attempt.settingsSource as WorkerAttempt["settingsSource"] } : {}),
        ...(typeof attempt.settingsHash === "string" ? { settingsHash: attempt.settingsHash.slice(0, 128) } : {}),
        ...(attempt.finalizationInstructionSent === true ? { finalizationInstructionSent: true } : {}),
        ...(typeof attempt.finalizationMarkerPath === "string" ? { finalizationMarkerPath: attempt.finalizationMarkerPath } : {}),
        ...(typeof attempt.preservedPatchPath === "string" ? { preservedPatchPath: attempt.preservedPatchPath } : {}),
        ...(typeof attempt.telemetryObservedAt === "number" ? { telemetryObservedAt: attempt.telemetryObservedAt } : {}),
        ...(typeof attempt.telemetrySequence === "number" ? { telemetrySequence: attempt.telemetrySequence } : {}),
        ...(typeof attempt.lastHealthCheckAt === "number" ? { lastHealthCheckAt: attempt.lastHealthCheckAt } : {}),
        ...(typeof attempt.healthCheckFailures === "number" ? { healthCheckFailures: Math.max(0, Math.floor(attempt.healthCheckFailures)) } : {}),
        ...(typeof attempt.lastMeaningfulProgressAt === "number" ? { lastMeaningfulProgressAt: attempt.lastMeaningfulProgressAt } : {}),
        ...(typeof attempt.lastProgressFingerprint === "string" ? { lastProgressFingerprint: attempt.lastProgressFingerprint.slice(0, 128) } : {}),
        ...(typeof attempt.repeatedProgressFingerprint === "number" ? { repeatedProgressFingerprint: Math.max(0, Math.floor(attempt.repeatedProgressFingerprint)) } : {}),
        ...(typeof attempt.progressNudgeCount === "number" ? { progressNudgeCount: Math.max(0, Math.floor(attempt.progressNudgeCount)) } : {}),
        ...(typeof attempt.continuationOf === "string" ? { continuationOf: attempt.continuationOf.slice(0, 128) } : {}),
        ...(typeof attempt.continuationDepth === "number" ? { continuationDepth: Math.max(0, Math.floor(attempt.continuationDepth)) } : {}),
        ...(typeof attempt.progressFingerprint === "string" ? { progressFingerprint: attempt.progressFingerprint.slice(0, 128) } : {}),
        ...(typeof attempt.checkpoint === "string" ? { checkpoint: attempt.checkpoint.slice(0, 500) } : {}),
        ...(typeof attempt.checkpointRef === "string" ? { checkpointRef: attempt.checkpointRef.slice(0, 500) } : {}),
        ...(typeof attempt.checkpointCommit === "string" ? { checkpointCommit: attempt.checkpointCommit.slice(0, 128) } : {}),
        ...(typeof attempt.checkpointPatchDigest === "string" ? { checkpointPatchDigest: attempt.checkpointPatchDigest.slice(0, 128) } : {}),
        ...(typeof attempt.checkpointBaseRevision === "string" ? { checkpointBaseRevision: attempt.checkpointBaseRevision.slice(0, 128) } : {}),
        ...(Array.isArray(attempt.checkpointChangedPaths) ? { checkpointChangedPaths: attempt.checkpointChangedPaths.filter((path): path is string => typeof path === "string").slice(0, 128) } : {}),
        ...(typeof attempt.checkpointCreatedAt === "number" ? { checkpointCreatedAt: attempt.checkpointCreatedAt } : {}),
        ...(typeof attempt.checkpointArchivedAt === "number" ? { checkpointArchivedAt: attempt.checkpointArchivedAt } : {}),
        ...(Array.isArray(attempt.latestDiagnostics) ? { latestDiagnostics: attempt.latestDiagnostics.filter((entry): entry is string => typeof entry === "string").slice(-8) } : {}),
        ...(Array.isArray(attempt.completedConditions) ? { completedConditions: attempt.completedConditions.filter((entry): entry is string => typeof entry === "string").slice(-16) } : {}),
        ...(Array.isArray(attempt.unresolvedConditions) ? { unresolvedConditions: attempt.unresolvedConditions.filter((entry): entry is string => typeof entry === "string").slice(-16) } : {}),
        ...(Array.isArray(attempt.ownershipExpansions) ? { ownershipExpansions: attempt.ownershipExpansions.map(asRecord).filter((entry): entry is Record<string, unknown> => Boolean(entry)
          && Array.isArray(entry.paths)
          && typeof entry.reason === "string"
          && ["compiler-required", "registration", "lockfile", "direct-test", "formatting"].includes(String(entry.category))
          && typeof entry.expandedAt === "number")
          .map((entry) => ({
            paths: (entry.paths as unknown[]).filter((path): path is string => typeof path === "string").slice(0, 8),
            reason: String(entry.reason).slice(0, 500),
            category: entry.category as OwnershipExpansionCategory,
            expandedAt: Number(entry.expandedAt),
          })).slice(-32) } : {}),
        ...(asRecord(attempt.primaryValidation)
          && typeof asRecord(attempt.primaryValidation)!.program === "string"
          && Array.isArray(asRecord(attempt.primaryValidation)!.args)
          ? { primaryValidation: asRecord(attempt.primaryValidation) as unknown as PrimaryValidationTarget }
          : {}),
        ...(asRecord(attempt.stopProvenance)
          && ["user", "user_shutdown", "optional_budget", "inactivity_watchdog", "process_crash", "application_shutdown", "superseded", "dependency_failure", "unknown", "budget", "runtime_shutdown", "main_agent", "operator"].includes(String(asRecord(attempt.stopProvenance)!.cause))
          && typeof asRecord(attempt.stopProvenance)!.initiator === "string"
          && typeof asRecord(attempt.stopProvenance)!.reason === "string"
          && typeof asRecord(attempt.stopProvenance)!.requestedAt === "number"
          ? { stopProvenance: {
            ...(asRecord(attempt.stopProvenance) as unknown as WorkerStopProvenance),
            cause: String(asRecord(attempt.stopProvenance)!.cause) === "budget"
              ? "optional_budget" as const
              : String(asRecord(attempt.stopProvenance)!.cause) === "runtime_shutdown"
                ? "application_shutdown" as const
                : ["main_agent", "operator"].includes(String(asRecord(attempt.stopProvenance)!.cause))
                  ? "unknown" as const
                  : asRecord(attempt.stopProvenance)!.cause as WorkerStopProvenance["cause"],
          } }
          : {}),
        ...(attempt.emptyOutput === true ? { emptyOutput: true } : {}),
        ...(attempt.corrupted === true ? { corrupted: true } : {}),
        ...(typeof attempt.todoId === "number" && Number.isInteger(attempt.todoId) ? { todoId: attempt.todoId } : {}),
        ...(typeof attempt.outcomeId === "string"
          ? { outcomeId: attempt.outcomeId.slice(0, 128) }
          : typeof attempt.todoId === "number" && Number.isInteger(attempt.todoId)
            ? { outcomeId: `todo-${attempt.todoId}` }
            : {}),
        ...(typeof attempt.worktreePath === "string" ? { worktreePath: attempt.worktreePath } : {}),
        ...(typeof attempt.runtimeDirectory === "string" ? { runtimeDirectory: attempt.runtimeDirectory } : {}),
        ...(typeof attempt.repository === "string" ? { repository: attempt.repository } : {}),
        ...(typeof attempt.baseRevision === "string" ? { baseRevision: attempt.baseRevision } : {}),
        ...(typeof attempt.integrationBaseRevision === "string" ? { integrationBaseRevision: attempt.integrationBaseRevision } : {}),
        ...(Array.isArray(attempt.ownedPaths) ? { ownedPaths: attempt.ownedPaths.filter((path): path is string => typeof path === "string") } : {}),
        ...(typeof attempt.artifactPath === "string" ? { artifactPath: attempt.artifactPath } : {}),
        ...(typeof attempt.handoffPath === "string" ? { handoffPath: attempt.handoffPath } : {}),
        ...(typeof attempt.integratedRevision === "string" ? { integratedRevision: attempt.integratedRevision } : {}),
        ...(attempt.integrationStatus === "integrated" || attempt.integrationStatus === "no-changes" || attempt.integrationStatus === "pending"
          ? { integrationStatus: attempt.integrationStatus }
          : {}),
        ...(attempt.cleanupPending === true ? { cleanupPending: true } : {}),
      }))
    : [];
  const validations = Array.isArray(record.validations)
    ? record.validations.map(asRecord).filter((item): item is Record<string, unknown> => Boolean(item))
      .filter((item) => typeof item.repository === "string" && typeof item.command === "string" && item.passed === true)
      .slice(-128) as unknown as ValidationRecord[]
    : [];
  const reviews = Array.isArray(record.reviews)
    ? record.reviews.map(asRecord).filter((item): item is Record<string, unknown> => Boolean(item))
      .filter((item) => typeof item.repository === "string" && typeof item.revision === "string" && item.accepted === true)
      .slice(-64) as unknown as ReviewRecord[]
    : [];
  const widths = asRecord(record.activeRunWidths);
  const activeRunWidths = Object.fromEntries(
    Object.entries(widths ?? {})
      .filter(([runId, width]) => record.activeRunIds.includes(runId) && Number.isInteger(width) && Number(width) > 0)
      .map(([runId, width]) => [runId.slice(0, 128), Math.min(1_000, Number(width))]),
  );
  const remainingTask = remaining
    && typeof remaining.id === "number"
    && typeof remaining.subject === "string"
    && (remaining.status === "in_progress" || remaining.status === "pending")
    ? { id: remaining.id, subject: remaining.subject, status: remaining.status } as RemainingPlanTask
    : undefined;
  const persistedOutcomes = Array.isArray(record.outcomes)
    ? record.outcomes.map(asRecord).filter((outcome): outcome is Record<string, unknown> => Boolean(outcome))
      .filter((outcome) => typeof outcome.id === "string"
        && typeof outcome.subject === "string"
        && ["pending", "in_progress", "partial", "validating", "completed", "needs_attention"].includes(String(outcome.status)))
      .slice(-24)
      .map((outcome) => ({
        id: String(outcome.id).slice(0, 128),
        subject: String(outcome.subject).slice(0, 160),
        status: outcome.status as MissionOutcomeStatus,
        ...(typeof outcome.detail === "string" ? { detail: outcome.detail.slice(0, 500) } : {}),
        ...(typeof outcome.todoId === "number" && Number.isInteger(outcome.todoId) ? { todoId: outcome.todoId } : {}),
        runIds: Array.isArray(outcome.runIds) ? outcome.runIds.filter((runId): runId is string => typeof runId === "string").slice(-16) : [],
        ...(typeof outcome.repository === "string" ? { repository: outcome.repository } : {}),
        ...(Array.isArray(outcome.relevantPaths) ? { relevantPaths: outcome.relevantPaths.filter((path): path is string => typeof path === "string") } : {}),
        updatedAt: typeof outcome.updatedAt === "number" ? outcome.updatedAt : record.updatedAt,
      }))
    : [];
  const migratedOutcomes = persistedOutcomes.length > 0 ? persistedOutcomes : attempts
    .filter((attempt) => attempt.executionMode === "implementation"
      && (attempt.status === "running"
        || attempt.status === "partial"
        || attempt.status === "budget_exhausted"
        || attempt.status === "failed"
        || attempt.status === "stopped"
        || (attempt.status === "completed" && attempt.integrationStatus !== "integrated" && attempt.integrationStatus !== "no-changes")))
    .reduce<MissionOutcome[]>((outcomes, attempt) => {
      const recoveredId = attempt.outcomeId ?? `recovered-${attempt.runId}`;
      const existing = outcomes.find((outcome) => outcome.id === recoveredId || outcome.subject.toLowerCase() === attempt.purpose.toLowerCase());
      const status: MissionOutcomeStatus = attempt.status === "failed" || attempt.status === "stopped"
        ? "needs_attention"
        : attempt.status === "partial" || attempt.status === "budget_exhausted"
          ? "partial"
          : "in_progress";
      if (existing) {
        existing.runIds.push(attempt.runId);
        existing.status = status === "needs_attention" ? status : existing.status;
        existing.updatedAt = Math.max(existing.updatedAt, attempt.terminalCommittedAt ?? attempt.startedAt ?? record.updatedAt);
        return outcomes;
      }
      outcomes.push({
        id: recoveredId.slice(0, 128),
        subject: attempt.purpose.slice(0, 160),
        status,
        detail: attempt.status === "completed" ? "Implementation complete; deterministic integration remains." : `Worker ${attempt.status}.`,
        ...(attempt.todoId ? { todoId: attempt.todoId } : {}),
        runIds: [attempt.runId],
        ...(attempt.repository ? { repository: attempt.repository } : {}),
        ...(attempt.ownedPaths ? { relevantPaths: [...attempt.ownedPaths] } : {}),
        updatedAt: attempt.terminalCommittedAt ?? attempt.startedAt ?? record.updatedAt,
      });
      return outcomes;
    }, [])
    .slice(0, 3);
  if (migratedOutcomes.length === 0 && remainingTask) {
    migratedOutcomes.push({
      id: `recovered-todo-${remainingTask.id}`,
      subject: remainingTask.subject.slice(0, 160),
      status: remainingTask.status,
      todoId: remainingTask.id,
      runIds: [],
      updatedAt: record.updatedAt,
    });
  }
  return {
    version: 5,
    policyVersion: CURRENT_ORCHESTRATION_POLICY_VERSION,
    ...(policyMigrated
      ? { migratedFromPolicyVersion: typeof record.policyVersion === "number" ? record.policyVersion : 0 }
      : {}),
    id: record.id.slice(0, 128),
    phase: record.phase === "complete" && migratedOutcomes.some((outcome) => outcome.status !== "completed") ? "integration" : record.phase as MissionPhase,
    request: record.request.slice(0, 500),
    activeRunIds: [...new Set(record.activeRunIds.map((runId) => runId.slice(0, 128)))],
    activeRunWidths,
    writerActive: record.writerActive,
    wakeAttempts: Math.max(0, Math.min(3, record.wakeAttempts as number)),
    updatedAt: record.updatedAt,
    attempts,
    outcomes: migratedOutcomes,
    validations,
    reviews,
    ...(Array.isArray(record.baselines)
      ? { baselines: record.baselines.map(asRecord).filter((item): item is Record<string, unknown> => Boolean(item))
        .filter((item) => typeof item.repository === "string" && typeof item.branch === "string" && typeof item.head === "string" && Array.isArray(item.status) && Array.isArray(item.staged) && typeof item.capturedAt === "number")
        .slice(-16) as unknown as MissionGitBaseline[] }
      : {}),
    ...(Array.isArray(record.pathProvenance)
      ? { pathProvenance: record.pathProvenance.map(asRecord).filter((item): item is Record<string, unknown> => Boolean(item))
        .filter((item) => typeof item.repository === "string" && typeof item.path === "string" && typeof item.fingerprint === "string" && typeof item.recordedAt === "number")
        .slice(-256) as unknown as MissionPathProvenance[] }
      : {}),
    ...(Array.isArray(record.pendingContinuations)
      ? { pendingContinuations: record.pendingContinuations.map(asRecord).filter((item): item is Record<string, unknown> => Boolean(item))
        .filter((item) => typeof item.priorRunId === "string" && typeof item.handoffPath === "string" && typeof item.progressFingerprint === "string" && typeof item.scheduledAt === "number")
        .slice(-16) as unknown as PendingContinuation[] }
      : {}),
    ...(asRecord(record.contractFailures)
      ? { contractFailures: Object.fromEntries(Object.entries(asRecord(record.contractFailures)!)
        .filter(([, count]) => typeof count === "number" && Number.isInteger(count) && count > 0)
        .map(([signature, count]) => [signature.slice(0, 240), Math.min(2, Number(count))])) }
      : {}),
    ...(Array.isArray(record.pendingLaunches)
      ? { pendingLaunches: record.pendingLaunches.map(asRecord).filter((item): item is Record<string, unknown> => Boolean(item))
        .filter((item) => typeof item.launchId === "string"
          && typeof item.agent === "string"
          && typeof item.purpose === "string"
          && typeof item.task === "string"
          && (item.executionMode === "read-only" || item.executionMode === "implementation")
          && typeof item.provider === "string"
          && typeof item.modelId === "string"
          && typeof item.model === "string"
          && typeof item.thinking === "string"
          && typeof item.settingsSource === "string"
          && typeof item.settingsHash === "string"
          && typeof item.startedAt === "number")
        .slice(-32) as MissionState["pendingLaunches"] }
      : {}),
    ...(Array.isArray(record.suppressedRunIds)
      ? { suppressedRunIds: [...new Set(record.suppressedRunIds.filter((runId): runId is string => typeof runId === "string").map((runId) => runId.slice(0, 128)))].slice(-64) }
      : {}),
    ...(typeof record.lastCompletedRunId === "string" ? { lastCompletedRunId: record.lastCompletedRunId.slice(0, 128) } : {}),
    ...(!policyMigrated
      && typeof rawFastPathFinalization?.root === "string"
      && typeof rawFastPathFinalization.repository === "string"
      && Array.isArray(rawFastPathFinalization.paths)
      && rawFastPathFinalization.paths.every((path) => typeof path === "string")
      && typeof rawFastPathFinalization.outcomeId === "string"
      && typeof rawFastPathFinalization.completedAt === "number"
      ? { fastPathFinalization: {
        root: rawFastPathFinalization.root,
        repository: rawFastPathFinalization.repository,
        paths: [...new Set(rawFastPathFinalization.paths as string[])].slice(0, 5),
        outcomeId: rawFastPathFinalization.outcomeId.slice(0, 128),
        completedAt: rawFastPathFinalization.completedAt,
      } }
      : {}),
    ...(!policyMigrated && remainingTask ? { remainingTask } : {}),
  };
}

export function replayMissionState(branch: Iterable<unknown>): MissionState | undefined {
  let latest: MissionState | undefined;
  for (const value of branch) {
    const entry = asRecord(value);
    if (entry?.type !== "custom" || entry.customType !== MISSION_ENTRY) continue;
    latest = parsedMissionState(entry.data) ?? latest;
  }
  return latest;
}

export function remainingPlanFromTodoResult(value: unknown): { task?: RemainingPlanTask } | undefined {
  const root = asRecord(value);
  const details = asRecord(root?.details) ?? root;
  if (!details || !Array.isArray(details.tasks) || typeof details.nextId !== "number") return undefined;
  const tasks = details.tasks.map(asRecord).filter(Boolean);
  const candidate = tasks.find((task) => task?.status === "in_progress")
    ?? tasks.find((task) => task?.status === "pending");
  if (!candidate) return {};
  if (typeof candidate.id !== "number" || typeof candidate.subject !== "string") return undefined;
  return {
    task: {
      id: candidate.id,
      subject: candidate.subject,
      status: candidate.status as RemainingPlanTask["status"],
    },
  };
}

export function shouldWakeForPlanContinuation(input: {
  hasRemainingTask: boolean;
  activeDelegationCount: number;
  writerOccupied: boolean;
  intentionallyStopped: boolean;
  attempts: number;
}): boolean {
  return input.hasRemainingTask
    && input.activeDelegationCount === 0
    && !input.writerOccupied
    && !input.intentionallyStopped
    && input.attempts < 3;
}

export type AutomaticTurnAuthority = "passive-session" | "user-input" | "live-worker-event";

export function automaticTurnMayStart(authority: AutomaticTurnAuthority): boolean {
  return authority === "user-input" || authority === "live-worker-event";
}

export default function lemonPiNarration(pi: ExtensionAPI) {
  let sawToolActivity = false;
  let visibleExplanationAfterLastTool = false;
  let currentAssistantVisibleText = "";
  let lastAssistantStopReason: string | undefined;
  let delegationRepairRequested = false;
  let closingRepairAttempts = 0;
  let delegationFailurePending = false;
  let lastDelegationFailure: string | undefined;
  let latestUserRequest = "";
  let requestStartedAt = Date.now();
  let writerOccupied = false;
  let attentionRecovery: { runId: string; index?: number } | undefined;
  let attentionActionObserved = false;
  let attentionRepairRequested = false;
  let remainingPlanTask: RemainingPlanTask | undefined;
  let planContinuationAttempts = 0;
  let mission: MissionState | undefined;
  let mainAgentRunning = false;
  let mainTurnSettled = true;
  let activeMainToolExecutions = 0;
  let missionWakeQueued = false;
  let lastMissionWakeAt = 0;
  let missionWakeCheck: Promise<boolean> | undefined;
  let missionWakeGeneration = 0;
  let automaticTurnAuthority: AutomaticTurnAuthority = "passive-session";
  let delegationLaunchesInFlight = 0;
  let lastDelegationLaunchAt = 0;
  let proactiveCompactionInFlight = false;
  let restoreWakeTimer: ReturnType<typeof setTimeout> | undefined;
  let restoreReconcileGeneration = 0;
  const activeDelegationRuns = new Set<string>();
  const runsStartedInThisSessionRuntime = new Set<string>();
  const delegationToolCalls = new Set<string>();
  const delegationLaunchToolCalls = new Set<string>();
  const delegationLaunchWidths = new Map<string, number>();
  const delegationAttemptMetadata = new Map<string, { launchId: string; agent: string; task: string; purpose: string; executionMode: "read-only" | "implementation"; repository: string; startedAt: number; binding: AgentLaunchBinding; limitPolicy: ReturnType<typeof workerExecutionBudget> }>();
  const activeDelegationWidths = new Map<string, number>();
  const activeWriterRuns = new Set<string>();
  const manuallyStoppedRuns = new Set<string>();
  const independentDispatchRuns = new Set<string>();
  const pendingIndependentCompletions = new Map<string, {
    runId: string;
    sessionId?: string;
    status: Exclude<WriterLifecycleStatus, "paused">;
    agent?: string;
    evidence?: unknown;
  }>();
  let independentCompletionTimer: ReturnType<typeof setTimeout> | undefined;
  const statusToolCalls = new Map<string, { key: string; target?: string }>();
  const activeStatusChecksThisTurn = new Set<string>();
  const resumeToolCalls = new Map<string, { launchId: string; implementation: boolean; previousRunId: string; purpose: string; sliceCount: number; binding: AgentLaunchBinding; task: string; agent: string; repository?: string; outcomeId?: string }>();
  const rosterToolCalls = new Set<string>();
  const executableAgents = new Set<string>();
  let activeDelegationHandoffPending = false;
  const writerToolCalls = new Map<string, { agent: string; async: boolean }>();
  const deferredWriterLanesByToolCall = new Map<string, string[]>();
  const deferredWriterLanesByRun = new Map<string, string[]>();
  const terminalWriterRuns = new Map<string, WriterLifecycleStatus>();
  const integratedTerminalRuns = new Set<string>();
  const restoreInterventionMissions = new Set<string>();
  const activeReviewKeys = new Set<string>();
  const reviewByRun = new Map<string, Omit<ReviewRecord, "accepted">>();
  let visiblePlanTasks: VisibleRoadmapTask[] = [];
  let todoSessionId = "";
  let activeFastPath: { root: string; repository: string; paths: string[]; summary: string; outcomeId: string; startedAt: number; firstMutationAt?: number; validationCount: number; lastValidationKey?: string; validationPassed?: boolean } | undefined;
  let completedFastPath: FastPathFinalization | undefined;
  let uiExplorationToolCalls = 0;
  const pendingIntegrationNotices: string[] = [];
  const internalContractCalls = new Map<string, string>();
  const internalContractFailures = new Map<string, number>();
  const budgetStopsInFlight = new Set<string>();
  let missionPersistTimer: ReturnType<typeof setTimeout> | undefined;
  let lastPersistedMissionHash = "";
  let lastPublishedOutcomeHash = "";
  const pendingPassiveCustomMessages = new Map<string, { content: string; onDelivered?: () => void }>();
  const validationLedgerPath = resolve(homedir(), ".pi", "lemonpi", "validation-evidence-v2.json");
  let persistentValidations: ValidationRecord[] = (() => {
    try {
      const parsed = JSON.parse(readFileSync(validationLedgerPath, "utf8")) as { records?: unknown[] };
      return (parsed.records ?? []).map(asRecord).filter((record): record is Record<string, unknown> => Boolean(record))
        .filter((record) => typeof record.repository === "string"
          && typeof record.baseRevision === "string"
          && typeof record.diffHash === "string"
          && typeof record.executable === "string"
          && Array.isArray(record.args)
          && typeof record.cwd === "string"
          && typeof record.environmentHash === "string"
          && typeof record.command === "string"
          && Array.isArray(record.relevantPaths)
          && typeof record.dependencyState === "string"
          && record.passed === true)
        .slice(-512) as unknown as ValidationRecord[];
    } catch {
      return [];
    }
  })();

  const persistValidationEvidence = () => {
    const directory = resolve(homedir(), ".pi", "lemonpi");
    const temporary = `${validationLedgerPath}.${process.pid}.tmp`;
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      writeFileSync(temporary, `${JSON.stringify({ version: 2, records: persistentValidations.slice(-512) }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      renameSync(temporary, validationLedgerPath);
    } catch {
      rmSync(temporary, { force: true });
    }
  };

  const missionOutcomePayload = (current: MissionState) => {
    const outcomes = current.outcomes
      .filter((outcome) => outcome.status !== "completed")
      .sort((left, right) => left.updatedAt - right.updatedAt)
      .slice(0, 3);
    const completed = current.outcomes
      .filter((outcome) => outcome.status === "completed")
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, Math.max(0, 3 - outcomes.length));
    const visible = [...outcomes, ...completed];
    return {
      source: "mission",
      missionId: current.id,
      historyCount: current.attempts.length,
      tasks: visible.map((outcome, index) => ({
        id: index + 1,
        subject: outcome.subject,
        status: outcome.status === "completed" ? "completed" : outcome.status === "pending" || outcome.status === "partial" || outcome.status === "needs_attention" ? "pending" : "in_progress",
        description: outcome.detail,
        runtimeStatus: outcome.status,
        owner: outcome.runIds.length > 0 ? `${outcome.runIds.length} run${outcome.runIds.length === 1 ? "" : "s"}` : undefined,
      })),
      nextId: visible.length + 1,
    };
  };

  const sendPassiveCustomMessage = (customType: string, content: string, onDelivered?: () => void) => {
    if (mainAgentRunning || activeMainToolExecutions > 0 || !mainTurnSettled) {
      pendingPassiveCustomMessages.set(customType, { content, onDelivered });
      return false;
    }
    pi.sendMessage({ customType, content, display: false }, { triggerTurn: false });
    onDelivered?.();
    return true;
  };

  const flushPassiveCustomMessages = () => {
    if (mainAgentRunning || activeMainToolExecutions > 0 || !mainTurnSettled) return;
    const pending = [...pendingPassiveCustomMessages.entries()];
    pendingPassiveCustomMessages.clear();
    for (const [customType, publication] of pending) {
      pi.sendMessage({ customType, content: publication.content, display: false }, { triggerTurn: false });
      publication.onDelivered?.();
    }
  };

  const publishMissionOutcomes = (current: MissionState) => {
    const payload = missionOutcomePayload(current);
    const hash = missionStateContentHash(payload);
    const content = JSON.stringify(payload);
    if (hash === lastPublishedOutcomeHash || pendingPassiveCustomMessages.get(MISSION_OUTCOME_ENTRY)?.content === content) return;
    sendPassiveCustomMessage(MISSION_OUTCOME_ENTRY, content, () => { lastPublishedOutcomeHash = hash; });
  };

  const ensureOutcome = (input: {
    id: string;
    subject: string;
    status?: MissionOutcomeStatus;
    detail?: string;
    todoId?: number;
    runId?: string;
    repository?: string;
    relevantPaths?: string[];
  }): MissionOutcome => {
    const currentMission = ensureMission("planning");
    let outcome = currentMission.outcomes.find((candidate) => candidate.id === input.id
      || (input.todoId !== undefined && candidate.todoId === input.todoId));
    if (!outcome) {
      outcome = {
        id: input.id.slice(0, 128),
        subject: input.subject.trim().slice(0, 160) || "Complete requested outcome",
        status: input.status ?? "pending",
        ...(input.detail ? { detail: input.detail.slice(0, 500) } : {}),
        ...(input.todoId !== undefined ? { todoId: input.todoId } : {}),
        runIds: input.runId ? [input.runId] : [],
        ...(input.repository ? { repository: input.repository } : {}),
        ...(input.relevantPaths ? { relevantPaths: [...input.relevantPaths] } : {}),
        updatedAt: Date.now(),
      };
      currentMission.outcomes.push(outcome);
    } else {
      if (input.subject.trim()) outcome.subject = input.subject.trim().slice(0, 160);
      if (input.status) outcome.status = input.status;
      if (input.detail) outcome.detail = input.detail.slice(0, 500);
      if (input.runId && !outcome.runIds.includes(input.runId)) outcome.runIds.push(input.runId);
      if (input.repository) outcome.repository = input.repository;
      if (input.relevantPaths) outcome.relevantPaths = [...input.relevantPaths];
      outcome.updatedAt = Date.now();
    }
    return outcome;
  };

  const publishTodoLifecycle = async (todoId: number, status: "pending" | "in_progress" | "completed") => {
    if (!todoSessionId) return;
    try {
      const moduleName = "@juicesharp/rpiv-todo/state/store.js";
      const store = await import(moduleName) as {
        getState(sessionId: string): { tasks: VisibleRoadmapTask[]; nextId: number };
        commitState(sessionId: string, state: { tasks: VisibleRoadmapTask[]; nextId: number }): void;
      };
      const current = store.getState(todoSessionId);
      if (!current.tasks.some((task) => task.id === todoId && task.status !== "deleted")) return;
      const next = {
        tasks: current.tasks.map((task) => task.id === todoId ? { ...task, status } : task),
        nextId: current.nextId,
      };
      store.commitState(todoSessionId, next);
      visiblePlanTasks = next.tasks.map((task) => ({ ...task }));
      const payload = JSON.stringify({ tasks: next.tasks, nextId: next.nextId });
      sendPassiveCustomMessage("lemonpi-todo-lifecycle", payload);
    } catch {
      // Todo lifecycle is useful orchestration state, but a package mismatch must
      // never prevent the worker or its inspected code from continuing.
    }
  };

  const restoreTodoLifecycle = (branch: unknown[]) => {
    const snapshot = [...branch].reverse().flatMap((entry) => {
      const root = asRecord(entry);
      const message = asRecord(root?.message) ?? root;
      if (message?.role !== "custom" || message.customType !== "lemonpi-todo-lifecycle" || typeof message.content !== "string") return [];
      try {
        const parsed = JSON.parse(message.content) as { tasks?: VisibleRoadmapTask[]; nextId?: number };
        return Array.isArray(parsed.tasks) && typeof parsed.nextId === "number" ? [parsed] : [];
      } catch {
        return [];
      }
    })[0];
    if (!snapshot || !todoSessionId) return;
    visiblePlanTasks = snapshot.tasks!.map((task) => ({ ...task }));
    setTimeout(() => {
      void (async () => {
        try {
          const moduleName = "@juicesharp/rpiv-todo/state/store.js";
          const store = await import(moduleName) as { commitState(sessionId: string, state: { tasks: VisibleRoadmapTask[]; nextId: number }): void };
          store.commitState(todoSessionId, { tasks: snapshot.tasks!, nextId: snapshot.nextId! });
        } catch {
          // Frontend replay still consumes the custom snapshot.
        }
      })();
    }, 0);
  };

  const missionSnapshot = (): MissionState | undefined => mission ? {
    ...mission,
    activeRunIds: [...mission.activeRunIds],
    activeRunWidths: Object.fromEntries(
      [...activeDelegationRuns].map((runId) => [runId, activeDelegationWidths.get(runId) ?? 1]),
    ),
    ...(mission.remainingTask ? { remainingTask: { ...mission.remainingTask } } : {}),
    ...(completedFastPath ? { fastPathFinalization: { ...completedFastPath, paths: [...completedFastPath.paths] } } : {}),
  } : undefined;

  const persistMissionNow = () => {
    if (missionPersistTimer) {
      clearTimeout(missionPersistTimer);
      missionPersistTimer = undefined;
    }
    if (!mission) return;
    const snapshot = missionSnapshot()!;
    const hash = missionStateContentHash(snapshot);
    if (hash === lastPersistedMissionHash) return;
    mission.updatedAt = Date.now();
    snapshot.updatedAt = mission.updatedAt;
    pi.appendEntry<MissionState>(MISSION_ENTRY, snapshot);
    publishMissionOutcomes(snapshot);
    lastPersistedMissionHash = hash;
  };

  const persistMission = () => {
    if (!mission || missionPersistTimer) return;
    missionPersistTimer = setTimeout(persistMissionNow, 40);
  };

  const isManuallyStoppedRun = (runId: string) => [...manuallyStoppedRuns, ...(mission?.suppressedRunIds ?? [])]
    .some((candidate) => candidate === runId);

  const ensureMission = (phase: MissionPhase): MissionState => {
    if (!mission || mission.phase === "complete" || mission.phase === "paused") {
      const suppressedRunIds = mission?.suppressedRunIds;
      const priorValidations = mission?.validations ?? [];
      const priorReviews = mission?.reviews ?? [];
      mission = {
        version: 5,
        policyVersion: CURRENT_ORCHESTRATION_POLICY_VERSION,
        id: globalThis.crypto.randomUUID(),
        phase,
        request: latestUserRequest.slice(0, 500),
        activeRunIds: [],
        writerActive: false,
        wakeAttempts: 0,
        updatedAt: Date.now(),
        attempts: [],
        outcomes: [],
        validations: priorValidations.slice(-128),
        reviews: priorReviews.slice(-128),
        contractFailures: {},
        ...(remainingPlanTask ? { remainingTask: { ...remainingPlanTask } } : {}),
        ...(suppressedRunIds?.length ? { suppressedRunIds: [...suppressedRunIds] } : {}),
      };
    } else {
      mission.phase = phase;
      if (latestUserRequest) mission.request = latestUserRequest.slice(0, 500);
    }
    return mission;
  };

  const statusEntryPath = (entry: string) => {
    const raw = entry.slice(3).trim();
    return (raw.includes(" -> ") ? raw.split(" -> ").at(-1)! : raw).replace(/\\/g, "/").replace(/^\.\//, "");
  };

  const recordGitBaseline = (snapshot: CheckoutSnapshot) => {
    const currentMission = ensureMission(mission && mission.phase !== "complete" && mission.phase !== "paused" ? mission.phase : "planning");
    currentMission.baselines ??= [];
    if (!currentMission.baselines.some((baseline) => baseline.repository === snapshot.root && baseline.head === snapshot.head && baseline.branch === snapshot.branch)) {
      currentMission.baselines.push({
        repository: snapshot.root,
        branch: snapshot.branch,
        head: snapshot.head,
        status: [...snapshot.dirtyEntries],
        staged: [...snapshot.stagedEntries],
        capturedAt: Date.now(),
      });
    }
    currentMission.pathProvenance ??= [];
    for (const entry of snapshot.dirtyEntries) {
      const path = statusEntryPath(entry);
      if (!path || currentMission.pathProvenance.some((item) => item.repository === snapshot.root && item.path === path && item.source === "baseline")) continue;
      currentMission.pathProvenance.push({
        repository: snapshot.root,
        path,
        source: "baseline",
        fingerprint: contentHash(entry),
        recordedAt: Date.now(),
      });
    }
  };

  const recordPathProvenance = (input: Omit<MissionPathProvenance, "recordedAt">) => {
    const currentMission = ensureMission(mission && mission.phase !== "complete" && mission.phase !== "paused" ? mission.phase : "integration");
    currentMission.pathProvenance ??= [];
    currentMission.pathProvenance = currentMission.pathProvenance.filter((item) => !(item.repository === input.repository && item.path === input.path && item.source !== "baseline"));
    currentMission.pathProvenance.push({ ...input, recordedAt: Date.now() });
  };

  const persistPendingLaunch = (input: {
    launchId: string;
    agent: string;
    purpose: string;
    task: string;
    executionMode: "read-only" | "implementation";
    binding: AgentLaunchBinding;
    startedAt: number;
  }) => {
    const currentMission = ensureMission("delegated");
    currentMission.pendingLaunches ??= [];
    currentMission.pendingLaunches.push({
      launchId: input.launchId,
      agent: input.agent,
      purpose: input.purpose,
      task: input.task,
      executionMode: input.executionMode,
      provider: input.binding.provider,
      modelId: input.binding.modelId,
      model: input.binding.model,
      thinking: input.binding.thinking,
      settingsSource: input.binding.source,
      settingsHash: input.binding.settingsHash,
      startedAt: input.startedAt,
    });
    persistMissionNow();
  };

  const clearPendingLaunch = (launchId: string) => {
    if (!mission?.pendingLaunches) return;
    mission.pendingLaunches = mission.pendingLaunches.filter((launch) => launch.launchId !== launchId);
    if (mission.pendingLaunches.length === 0) delete mission.pendingLaunches;
    persistMission();
  };

  const writeAutomaticPartialHandoff = (attempt: WorkerAttempt, evidence: unknown): string | undefined => {
    const handoff = buildPartialWorkerHandoff({
      attempt,
      evidence,
      stopReason: attempt.stopProvenance?.reason ?? attempt.budgetStopReason ?? attempt.status,
    });
    if (!handoff || !mission) return undefined;
    const root = attempt.repository ?? process.cwd();
    const handoffDirectory = resolve(root, ".pi-subagents", "artifacts", "lemonpi-handoffs", mission.id);
    const safeRunId = attempt.runId.replace(/[^a-zA-Z0-9._-]+/g, "-");
    const handoffPath = resolve(handoffDirectory, `${safeRunId}.json`);
    try {
      mkdirSync(handoffDirectory, { recursive: true });
      writeFileSync(handoffPath, `${JSON.stringify(handoff, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      attempt.progressFingerprint = handoff.progressFingerprint;
      return handoffPath;
    } catch {
      return undefined;
    }
  };

  const writeCompletedWorkerManifest = (attempt: WorkerAttempt): string | undefined => {
    if (!mission || attempt.executionMode !== "implementation" || !attempt.worktreePath || !attempt.baseRevision || !attempt.ownedPaths?.length) return undefined;
    const directory = resolve(homedir(), ".pi", "lemonpi", "runtime-manifests", mission.id);
    const safeRunId = attempt.runId.replace(/[^a-zA-Z0-9._-]+/g, "-");
    const path = resolve(directory, `${safeRunId}.json`);
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      writeFileSync(path, `${JSON.stringify({
        version: 2,
        runId: attempt.runId,
        repository: attempt.repository,
        worktreePath: realpathSync(attempt.worktreePath),
        baseRevision: attempt.baseRevision,
        ownedPaths: attempt.ownedPaths,
        generatedAt: Date.now(),
      }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      return path;
    } catch {
      return undefined;
    }
  };

  const persistWorkerHeartbeat = (attempt: WorkerAttempt) => {
    if (!mission) return;
    const directory = resolve(homedir(), ".pi", "lemonpi", "mission-heartbeats");
    const safeRunId = attempt.runId.replace(/[^a-zA-Z0-9._-]+/g, "-");
    const path = resolve(directory, `${mission.id}-${safeRunId}.json`);
    const temporary = `${path}.${process.pid}.tmp`;
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      writeFileSync(temporary, `${JSON.stringify({
        version: 1,
        missionId: mission.id,
        runId: attempt.runId,
        metrics: {
          tokens: attempt.tokens,
          turns: attempt.turns ?? 0,
          toolCalls: attempt.toolCalls ?? 0,
          elapsedMs: attempt.elapsedMs ?? 0,
          activityState: attempt.activityState,
          observedAt: attempt.telemetryObservedAt,
          sequence: attempt.telemetrySequence,
        },
      })}\n`, { encoding: "utf8", mode: 0o600 });
      renameSync(temporary, path);
    } catch {
      rmSync(temporary, { force: true });
    }
  };

  const writeFinalizationMarker = (attempt: WorkerAttempt): string | undefined => {
    const directory = resolve(homedir(), ".pi", "lemonpi", "finalization");
    const safeRunId = attempt.runId.replace(/[^a-zA-Z0-9._-]+/g, "-");
    const path = resolve(directory, `${safeRunId}.json`);
    const temporary = `${path}.${process.pid}.tmp`;
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      writeFileSync(temporary, `${JSON.stringify({
        version: 1,
        runId: attempt.runId,
        phase: "finalizing",
        root: attempt.worktreePath ?? attempt.repository,
        ownedPaths: attempt.ownedPaths ?? [],
        primaryValidation: attempt.primaryValidation,
        activatedAt: Date.now(),
      })}\n`, { encoding: "utf8", mode: 0o600 });
      renameSync(temporary, path);
      return path;
    } catch {
      rmSync(temporary, { force: true });
      return undefined;
    }
  };

  const writeStopProvenanceArtifact = (attempt: WorkerAttempt, provenance: WorkerStopProvenance): string | undefined => {
    if (!attempt.runtimeDirectory) return undefined;
    let directory = "";
    try {
      directory = realpathSync(attempt.runtimeDirectory);
      if (!statSync(directory).isDirectory() || !/(?:^|[\\/])pi-subagents-[^\\/]+(?:[\\/]|$)/.test(directory)) return undefined;
    } catch { return undefined; }
    const path = resolve(directory, "stop-provenance.json");
    const temporary = `${path}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify({ version: 1, runId: attempt.runId, ...provenance }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      renameSync(temporary, path);
      return path;
    } catch {
      rmSync(temporary, { force: true });
      return undefined;
    }
  };

  const preserveAttemptPatch = async (attempt: WorkerAttempt, evidence?: unknown): Promise<string | undefined> => {
    if (attempt.executionMode !== "implementation" || !attempt.ownedPaths?.length) return undefined;
    const cwd = attempt.worktreePath ?? attempt.repository;
    if (!cwd) return undefined;
    const base = attempt.baseRevision || "HEAD";
    let patch = "";
    try {
      const tracked = await pi.exec("git", ["diff", "--binary", base, "--", ...attempt.ownedPaths], { cwd, timeout: 30_000 });
      if (tracked.code === 0) {
        patch = tracked.stdout;
        const untracked = await pi.exec("git", ["ls-files", "--others", "--exclude-standard", "--", ...attempt.ownedPaths], { cwd, timeout: 10_000 });
        if (untracked.code === 0) {
          for (const path of untracked.stdout.split(/\r?\n/).filter(Boolean).slice(0, 64)) {
            const emptyPath = process.platform === "win32" ? "NUL" : "/dev/null";
            const addition = await pi.exec("git", ["diff", "--no-index", "--binary", emptyPath, path], { cwd, timeout: 10_000 });
            if ((addition.code === 0 || addition.code === 1) && addition.stdout) patch += `${patch.endsWith("\n") || !patch ? "" : "\n"}${addition.stdout}`;
          }
        }
      }
    } catch {
      // The package may have retired its temporary worktree after capturing its own patch.
    }
    if (!patch.trim() && evidence !== undefined) {
      const evidenceRoot = asRecord(evidence);
      const artifact = asRecord(evidenceRoot?.artifact);
      const isolatedEvidence = evidenceRoot?.protocolVersion === 2
        ? { target: evidenceRoot.target, ...(artifact?.runId === attempt.runId ? { artifact } : {}) }
        : evidence;
      const candidate = terminalEvidenceSummary(isolatedEvidence).artifactPaths.find((path) => {
        try {
          const canonical = realpathSync(path);
          return statSync(canonical).isFile() && trustedWorkerPatchPath(canonical, attempt.runId, mission?.attempts.map((candidate) => candidate.runId) ?? []);
        } catch { return false; }
      });
      if (candidate) patch = readFileSync(candidate, "utf8");
    }
    if (!patch.trim() || Buffer.byteLength(patch, "utf8") > 16 * 1024 * 1024) return undefined;
    const directory = resolve(homedir(), ".pi", "lemonpi", "preserved-patches");
    const safeRunId = attempt.runId.replace(/[^a-zA-Z0-9._-]+/g, "-");
    const path = resolve(directory, `${mission?.id ?? "mission"}-${safeRunId}.patch`);
    const temporary = `${path}.${process.pid}.tmp`;
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      writeFileSync(temporary, patch, { encoding: "utf8", mode: 0o600 });
      renameSync(temporary, path);
      attempt.preservedPatchPath = path;
      attempt.checkpointPatchDigest = sha256(patch);
      return path;
    } catch {
      rmSync(temporary, { force: true });
      return undefined;
    }
  };

  const createAttemptCheckpoint = async (attempt: WorkerAttempt, evidence?: unknown): Promise<string | undefined> => {
    if (attempt.executionMode !== "implementation" || !attempt.repository || !attempt.baseRevision || !attempt.ownedPaths?.length) return undefined;
    const patchPath = await preserveAttemptPatch(attempt, evidence) ?? attempt.preservedPatchPath;
    if (!patchPath) return undefined;
    let canonicalPatch = "";
    try {
      canonicalPatch = realpathSync(patchPath);
      if (!statSync(canonicalPatch).isFile()) return undefined;
    } catch { return undefined; }
    const patch = readFileSync(canonicalPatch, "utf8");
    const digest = sha256(patch);
    if (attempt.checkpointPatchDigest && attempt.checkpointPatchDigest !== digest) return undefined;
    const repository = attempt.repository;
    const verifiedBase = await pi.exec("git", ["-C", repository, "rev-parse", `${attempt.baseRevision}^{commit}`], { cwd: repository, timeout: 10_000 });
    if (verifiedBase.code !== 0 || !verifiedBase.stdout.trim()) return undefined;
    const baseRevision = verifiedBase.stdout.trim();
    const safeRunId = attempt.runId.replace(/[^a-zA-Z0-9._-]+/g, "-");
    const checkpointRef = `refs/lemonpi/checkpoints/${safeRunId}`;
    const indexDirectory = resolve(homedir(), ".pi", "lemonpi", "checkpoint-indexes");
    const indexPath = resolve(indexDirectory, `${safeRunId}.index`);
    mkdirSync(indexDirectory, { recursive: true, mode: 0o700 });
    rmSync(indexPath, { force: true });
    rmSync(`${indexPath}.lock`, { force: true });
    const checkpointEnv = {
      ...process.env,
      GIT_INDEX_FILE: indexPath,
      GIT_AUTHOR_NAME: "LemonPi checkpoint",
      GIT_AUTHOR_EMAIL: "checkpoint@lemonpi.local",
      GIT_COMMITTER_NAME: "LemonPi checkpoint",
      GIT_COMMITTER_EMAIL: "checkpoint@lemonpi.local",
    };
    try {
      const readTree = await pi.exec("git", ["read-tree", baseRevision], { cwd: repository, timeout: 10_000, env: checkpointEnv });
      if (readTree.code !== 0) return undefined;
      let materialized = false;
      const worktree = attempt.worktreePath;
      if (worktree) {
        try {
          const canonicalWorktree = realpathSync(worktree);
          const sourceCommon = await pi.exec("git", ["rev-parse", "--git-common-dir"], { cwd: canonicalWorktree, timeout: 10_000 });
          const repositoryCommon = await pi.exec("git", ["rev-parse", "--git-common-dir"], { cwd: repository, timeout: 10_000 });
          if (sourceCommon.code === 0 && repositoryCommon.code === 0
            && realpathSync(sourceCommon.stdout.trim().startsWith("/") ? sourceCommon.stdout.trim() : resolve(canonicalWorktree, sourceCommon.stdout.trim()))
              === realpathSync(repositoryCommon.stdout.trim().startsWith("/") ? repositoryCommon.stdout.trim() : resolve(repository, repositoryCommon.stdout.trim()))) {
            const staged = await pi.exec("git", ["add", "-A", "--", ...attempt.ownedPaths], { cwd: canonicalWorktree, timeout: 30_000, env: checkpointEnv });
            materialized = staged.code === 0;
          }
        } catch {
          materialized = false;
        }
      }
      if (!materialized) {
        const applied = await pi.exec("git", ["apply", "--cached", "--3way", canonicalPatch], { cwd: repository, timeout: 30_000, env: checkpointEnv });
        if (applied.code !== 0) return undefined;
      }
      const tree = await pi.exec("git", ["write-tree"], { cwd: repository, timeout: 10_000, env: checkpointEnv });
      if (tree.code !== 0 || !tree.stdout.trim()) return undefined;
      const committed = await pi.exec("git", ["commit-tree", tree.stdout.trim(), "-p", baseRevision, "-m", `LemonPi checkpoint ${attempt.runId}`], { cwd: repository, timeout: 10_000, env: checkpointEnv });
      if (committed.code !== 0 || !committed.stdout.trim()) return undefined;
      const commit = committed.stdout.trim();
      const changed = await pi.exec("git", ["diff", "--name-only", baseRevision, commit], { cwd: repository, timeout: 10_000 });
      const changedPaths = changed.stdout.split(/\r?\n/).filter(Boolean);
      if (changed.code !== 0 || changedPaths.length === 0 || changedPaths.some((path) => !ownedPathsOverlap(attempt.ownedPaths ?? [], [path]))) return undefined;
      const updated = await pi.exec("git", ["update-ref", checkpointRef, commit], { cwd: repository, timeout: 10_000 });
      if (updated.code !== 0) return undefined;
      attempt.checkpointRef = checkpointRef;
      attempt.checkpointCommit = commit;
      attempt.checkpointPatchDigest = digest;
      attempt.checkpointBaseRevision = baseRevision;
      attempt.checkpointChangedPaths = changedPaths;
      attempt.checkpointCreatedAt = Date.now();
      return commit;
    } finally {
      rmSync(indexPath, { force: true });
      rmSync(`${indexPath}.lock`, { force: true });
    }
  };

  const updateAttemptTelemetry = (runId: string, value: unknown): WorkerAttempt | undefined => {
    const attempt = mission?.attempts.find((candidate) => candidate.runId === runId);
    if (!attempt) return undefined;
    const metrics = workerStatusMetrics(value, runId);
    if (telemetryUpdateIssue(attempt, metrics)) return undefined;
    attempt.tokens = Math.max(attempt.tokens, metrics.tokens);
    attempt.turns = Math.max(attempt.turns ?? 0, metrics.turns);
    attempt.toolCalls = Math.max(attempt.toolCalls ?? 0, metrics.toolCalls);
    attempt.elapsedMs = Math.max(attempt.elapsedMs ?? 0, metrics.elapsedMs, attempt.startedAt ? Date.now() - attempt.startedAt : 0);
    if (metrics.startedAt !== undefined) attempt.startedAt = Math.min(attempt.startedAt ?? metrics.startedAt, metrics.startedAt);
    if (metrics.activityState) attempt.activityState = metrics.activityState;
    attempt.currentTool = metrics.currentTool;
    attempt.currentPath = metrics.currentPath;
    attempt.telemetryObservedAt = Math.max(attempt.telemetryObservedAt ?? 0, metrics.observedAt);
    if (metrics.sequence !== undefined) attempt.telemetrySequence = Math.max(attempt.telemetrySequence ?? 0, metrics.sequence);
    const handoffPath = workerHandoffPath(value);
    if (handoffPath) attempt.handoffPath = handoffPath;
    const worktreePath = workerWorktreePath(value);
    if (worktreePath) attempt.worktreePath = worktreePath;
    const valueRoot = asRecord(value);
    const runtimeDirectory = typeof valueRoot?.runtimeDirectory === "string" ? valueRoot.runtimeDirectory : undefined;
    if (runtimeDirectory) attempt.runtimeDirectory = runtimeDirectory;
    attempt.transcriptBytes = Math.max(
      attempt.transcriptBytes,
      ...metrics.transcriptPaths.map((filePath) => {
        try { return statSync(filePath).size; } catch { return 0; }
      }),
    );
    persistWorkerHeartbeat(attempt);
    return attempt;
  };

  const superviseAttemptProgress = async (attempt: WorkerAttempt, healthCheckFailed = false): Promise<void> => {
    if (attempt.status !== "running") return;
    if (healthCheckFailed) {
      attempt.healthCheckFailures = (attempt.healthCheckFailures ?? 0) + 1;
      attempt.lastHealthCheckAt = Date.now();
    } else {
      attempt.healthCheckFailures = 0;
    }
    let diffFingerprint: string | undefined;
    if (attempt.executionMode === "implementation" && attempt.worktreePath && attempt.baseRevision && attempt.ownedPaths?.length) {
      try {
        const diff = await pi.exec("git", ["diff", "--binary", attempt.baseRevision, "--", ...attempt.ownedPaths], { cwd: attempt.worktreePath, timeout: 15_000 });
        if (diff.code === 0) diffFingerprint = sha256(diff.stdout);
      } catch {
        // A failed worktree inspection is health evidence, not permission to scan another run.
        attempt.healthCheckFailures = (attempt.healthCheckFailures ?? 0) + 1;
      }
    }
    const fingerprint = workerProgressFingerprint({
      diffFingerprint,
      inspectedEvidence: attempt.currentPath,
      diagnostic: attempt.latestDiagnostics?.at(-1),
      checkpointCommit: attempt.checkpointCommit,
      currentTool: attempt.currentTool,
      currentPath: attempt.currentPath,
    });
    const changed = fingerprint !== attempt.lastProgressFingerprint;
    if (changed) {
      attempt.lastProgressFingerprint = fingerprint;
      attempt.lastMeaningfulProgressAt = Date.now();
      attempt.repeatedProgressFingerprint = 0;
      attempt.progressNudgeCount = 0;
    } else {
      attempt.repeatedProgressFingerprint = (attempt.repeatedProgressFingerprint ?? 0) + 1;
    }
    const decision = progressSupervisionDecision({
      now: Date.now(),
      lastMeaningfulProgressAt: attempt.lastMeaningfulProgressAt ?? attempt.startedAt,
      healthCheckFailures: attempt.healthCheckFailures ?? 0,
      progressNudgeCount: attempt.progressNudgeCount ?? 0,
      fingerprintChanged: changed,
    });
    if (decision === "nudge") {
      attempt.progressNudgeCount = (attempt.progressNudgeCount ?? 0) + 1;
      try {
        await requestSubagentSteer(pi, attempt.runId, 0, "LemonPi progress check: the last inspected evidence and diff are unchanged. Continue from the newest diagnostic or exact next action; avoid repeating the same read, search, or failed command.");
      } catch {
        attempt.healthCheckFailures = (attempt.healthCheckFailures ?? 0) + 1;
      }
    } else if (decision === "checkpoint-and-escalate" || decision === "health-check-escalation") {
      attempt.preservedPatchPath = await preserveAttemptPatch(attempt) ?? attempt.preservedPatchPath;
      await createAttemptCheckpoint(attempt);
      const outcome = attempt.outcomeId ? mission?.outcomes.find((candidate) => candidate.id === attempt.outcomeId) : undefined;
      if (outcome) {
        outcome.status = "needs_attention";
        outcome.detail = decision === "health-check-escalation"
          ? "Worker health checks failed repeatedly without measurable progress; the current patch was checkpointed."
          : "Worker repeated unchanged work after a progress nudge; the current patch was checkpointed for Main Pi inspection.";
        outcome.updatedAt = Date.now();
      }
      if (decision === "health-check-escalation" && !attempt.currentTool && attempt.checkpointCommit) {
        attempt.stopProvenance = {
          cause: "inactivity_watchdog",
          initiator: "lemonpi-progress-supervisor",
          initiatingRunId: attempt.runId,
          reason: "Repeated failed health checks plus measured inactivity; productive total runtime was not used.",
          requestedAt: Date.now(),
        };
        writeStopProvenanceArtifact(attempt, attempt.stopProvenance);
        try { await requestSubagentStop(pi, attempt.runId, attempt.stopProvenance); } catch { /* Retain the checkpoint and visible escalation. */ }
      }
    }
    persistMission();
  };

  const enforceAttemptBudget = async (attempt: WorkerAttempt): Promise<void> => {
    if (attempt.status !== "running" || budgetStopsInFlight.has(attempt.runId)) return;
    const budget = attempt.limitPolicy ?? workerExecutionBudget(attempt.agent ?? "worker", attempt.executionMode, userLemonPiSettings());
    attempt.limitPolicy ??= budget;
    const elapsedMs = Math.max(attempt.elapsedMs ?? 0, attempt.startedAt ? Date.now() - attempt.startedAt : 0);
    const state = workerBudgetPhase({ tokens: attempt.tokens, turns: attempt.turns ?? 0, toolCalls: attempt.toolCalls ?? 0, elapsedMs }, budget);
    const previousPhase = attempt.budgetPhase;
    attempt.budgetPhase = state.phase;
    if (state.phase === "warning" && !attempt.budgetWarningSent) {
      attempt.budgetWarningSent = true;
      persistMission();
      try {
        await requestSubagentSteer(pi, attempt.runId, 0, "LemonPi budget warning: finish the current bounded action, then return the requested result without expanding scope.");
      } catch {
        // The package also receives native soft/hard budget contracts at launch.
      }
    }
    if (finalizationInstructionNeeded(attempt, state.phase)) {
      attempt.finalizationInstructionSent = true;
      attempt.finalizationMarkerPath ??= writeFinalizationMarker(attempt);
      attempt.preservedPatchPath ??= await preserveAttemptPatch(attempt);
      persistMission();
      try {
        await requestSubagentSteer(pi, attempt.runId, 0, "LemonPi finalization-only mode is active. New exploration, broad reads, scope expansion, delegation, and unrelated edits are blocked. Inspect only the owned diff, run the one declared bounded validation if useful, then return the structured result or handoff now.");
      } catch {
        // The child finalization extension enforces the marker even when live steering is unavailable.
      }
    } else if (previousPhase !== state.phase) {
      persistMission();
    }
    if (!state.hardStopReason) return;
    attempt.budgetStopReason = state.hardStopReason;
    const boundary = hardLimitBoundaryDecision({
      policy: budget,
      hardStopReason: state.hardStopReason,
      checkpointReady: Boolean(attempt.checkpointCommit && attempt.checkpointPatchDigest),
      hardLimitPending: attempt.hardLimitPending === true,
      currentTool: attempt.currentTool,
    });
    if (boundary === "checkpoint-and-finalize") {
      attempt.preservedPatchPath = await preserveAttemptPatch(attempt) ?? attempt.preservedPatchPath;
      const checkpoint = await createAttemptCheckpoint(attempt);
      if (!checkpoint) {
        attempt.stopProvenance = {
          cause: "dependency_failure",
          initiator: "lemonpi-limit-controller",
          initiatingRunId: attempt.runId,
          reason: `Optional hard limit was reached, but LemonPi could not create a durable checkpoint: ${state.hardStopReason}`,
          requestedAt: Date.now(),
        };
        attempt.hardLimitPending = false;
        persistMission();
        return;
      }
      attempt.hardLimitPending = true;
      attempt.hardLimitBoundaryToolCount = attempt.toolCalls ?? 0;
      persistMission();
      return;
    }
    if (boundary === "wait-for-tool-boundary" || boundary === "continue") return;
    attempt.preservedPatchPath = await preserveAttemptPatch(attempt) ?? attempt.preservedPatchPath;
    await createAttemptCheckpoint(attempt);
    attempt.stopProvenance = {
      cause: "optional_budget",
      initiator: "lemonpi-limit-controller",
      initiatingRunId: attempt.runId,
      reason: state.hardStopReason,
      requestedAt: Date.now(),
    };
    writeStopProvenanceArtifact(attempt, attempt.stopProvenance);
    budgetStopsInFlight.add(attempt.runId);
    persistMission();
    try {
      await requestSubagentStop(pi, attempt.runId, attempt.stopProvenance);
    } catch {
      budgetStopsInFlight.delete(attempt.runId);
    }
  };

  const recordTerminalAttempt = async (runId: string, status: Exclude<WriterLifecycleStatus, "paused">, evidence?: unknown) => {
    if (!mission) return;
    const attempt = [...mission.attempts].reverse().find((candidate) => candidate.runId === runId);
    if (!attempt) return;
    if (status === "stopped" && !attempt.stopProvenance) {
      attempt.stopProvenance = {
        cause: "unknown",
        initiator: "pi-subagents-runtime",
        initiatingRunId: runId,
        reason: "The runtime reported a stop without structured provenance.",
        requestedAt: Date.now(),
      };
    }
    if (status === "failed" && !attempt.stopProvenance) {
      attempt.stopProvenance = {
        cause: "process_crash",
        initiator: "pi-subagents-runtime",
        initiatingRunId: runId,
        reason: "The worker process failed before a normal terminal result.",
        requestedAt: Date.now(),
      };
    }
    const wasRunning = attempt.status === "running";
    const outcome = terminalOutcome({
      reportedStatus: status,
      evidence,
      budgetStopReason: attempt.budgetStopReason,
      stopCause: attempt.stopProvenance?.cause ?? (isManuallyStoppedRun(runId) ? "user" : undefined),
    });
    if (attempt.executionMode === "implementation" && outcome.status !== "completed") {
      attempt.preservedPatchPath = await preserveAttemptPatch(attempt, evidence) ?? attempt.preservedPatchPath;
      await createAttemptCheckpoint(attempt, evidence);
    }
    const terminalStatus = (attempt.stopProvenance?.cause === "optional_budget" && attempt.limitPolicy?.behavior === "checkpoint-and-pause")
      || (outcome.status !== "completed" && Boolean(attempt.checkpointCommit))
      ? "partial" as const
      : outcome.status;
    attempt.status = preferredTerminalStatus(attempt.status, terminalStatus);
    attempt.usableOutput = attempt.usableOutput === true || outcome.usableOutput;
    attempt.worktreePath ??= workerWorktreePath(evidence);
    attempt.handoffPath ??= workerHandoffPath(evidence);
    attempt.terminalCommittedAt ??= Date.now();
    attempt.elapsedMs = Math.max(attempt.elapsedMs ?? 0, attempt.startedAt ? Date.now() - attempt.startedAt : 0);
    if (wasRunning) attempt.completedOrdinal = Math.max(0, ...mission.attempts.map((candidate) => candidate.completedOrdinal)) + 1;
    if (attempt.status === "completed") mission.lastCompletedRunId = runId;
    if ((attempt.status === "partial" || attempt.status === "budget_exhausted") && !attempt.partialHandoffPath) {
      const handoffPath = writeAutomaticPartialHandoff(attempt, evidence);
      if (handoffPath) {
        attempt.partialHandoffPath = handoffPath;
        attempt.handoffPath ??= handoffPath;
      }
    }
    if ((attempt.status === "partial" || attempt.status === "budget_exhausted")
      && attempt.partialHandoffPath
      && attempt.progressFingerprint
      && attempt.stopProvenance?.cause !== "user"
      && attempt.stopProvenance?.cause !== "user_shutdown"
      && attempt.limitPolicy?.behavior !== "checkpoint-and-pause") {
      mission.pendingContinuations ??= [];
      if (!mission.pendingContinuations.some((pending) => pending.priorRunId === runId)) {
        mission.pendingContinuations.push({
          priorRunId: runId,
          handoffPath: attempt.partialHandoffPath,
          ...(attempt.outcomeId ? { outcomeId: attempt.outcomeId } : {}),
          progressFingerprint: attempt.progressFingerprint,
          scheduledAt: Date.now(),
        });
      }
    }
    if (attempt.status === "completed" && attempt.executionMode === "implementation") {
      const generated = writeCompletedWorkerManifest(attempt);
      if (generated) attempt.handoffPath = generated;
    }
    if (attempt.executionMode === "implementation" && attempt.repository && attempt.ownedPaths?.length) {
      const fingerprint = attempt.progressFingerprint
        ?? contentHash(`${attempt.runId}:${attempt.preservedPatchPath ?? attempt.handoffPath ?? attempt.status}`);
      for (const path of attempt.ownedPaths) {
        recordPathProvenance({ repository: attempt.repository, path, source: "worker", runId: attempt.runId, fingerprint });
      }
    }
    const linkedOutcome = attempt.outcomeId ? mission.outcomes.find((candidate) => candidate.id === attempt.outcomeId) : undefined;
    if (linkedOutcome) {
      if (attempt.status === "completed" && attempt.executionMode === "read-only") {
        linkedOutcome.status = "completed";
        linkedOutcome.detail = "Investigation completed.";
      } else if (attempt.status === "completed") {
        linkedOutcome.status = "in_progress";
        linkedOutcome.detail = "Implementation completed; deterministic integration remains.";
      } else if (attempt.status === "partial" || attempt.status === "budget_exhausted") {
        linkedOutcome.status = "partial";
        linkedOutcome.detail = attempt.partialHandoffPath ? "Worker ended with partial work preserved; a bounded continuation is pending." : "Worker ended with partial work preserved.";
      } else if (attempt.status === "failed" || attempt.status === "stopped") {
        linkedOutcome.status = "needs_attention";
        linkedOutcome.detail = attempt.status === "stopped"
          ? `Worker stopped (${attempt.stopProvenance?.cause ?? "unknown"}): ${attempt.stopProvenance?.reason ?? "no structured reason supplied"}`
          : "Worker failed; preserved output remains available for recovery.";
      }
      linkedOutcome.updatedAt = Date.now();
    }
    if (attempt.finalizationMarkerPath) rmSync(attempt.finalizationMarkerPath, { force: true });
    if (attempt.stopProvenance?.cause === "optional_budget" && attempt.limitPolicy?.behavior === "checkpoint-and-pause") {
      mission.phase = "paused";
    }
    budgetStopsInFlight.delete(runId);
    if (attempt.todoId) void publishTodoLifecycle(attempt.todoId, attempt.status === "completed" ? "completed" : attempt.status === "failed" || attempt.status === "stopped" ? "pending" : "in_progress");
    const review = reviewByRun.get(runId);
    if (review) {
      const key = reviewLedgerKey(review);
      activeReviewKeys.delete(key);
      reviewByRun.delete(runId);
      if (attempt.status === "completed" && !reviewDeduplicationIssue(mission.reviews, review)) {
        mission.reviews.push({ ...review, accepted: true });
      }
    }
    persistMission();
  };

  const missionNeedsMain = () => Boolean(mission
    && mission.phase !== "complete"
    && mission.phase !== "paused"
    && (mission.phase === "integration" || mission.remainingTask));

  const missionHasOwnedWork = () => delegationLaunchesInFlight > 0 || missionHasActiveOwnership({
    activeDelegationCount: activeDelegationRuns.size,
    recordedRunCount: mission?.activeRunIds.length ?? 0,
    writerOccupied,
    recordedWriterActive: mission?.writerActive ?? false,
  });

  const requestMissionWake = (reason: "plan" | "integration"): Promise<boolean> => {
    if (!automaticTurnMayStart(automaticTurnAuthority)) return Promise.resolve(false);
    if (missionWakeCheck) return Promise.resolve(false);
    if (proactiveCompactionInFlight) return Promise.resolve(false);
    if (!mission || missionWakeIsBlocked({ mainAgentRunning, activeToolExecutions: activeMainToolExecutions, wakeQueued: missionWakeQueued, turnSettled: mainTurnSettled })) return Promise.resolve(false);
    if (delegationLaunchesInFlight > 0 || Date.now() - lastDelegationLaunchAt < 5_000) return Promise.resolve(false);
    if (missionHasOwnedWork() || !missionNeedsMain()) return Promise.resolve(false);
    if (lastAssistantStopReason === "aborted" || lastAssistantStopReason === "error") return Promise.resolve(false);

    const missionId = mission.id;
    const generation = missionWakeGeneration;
    const pending = (async () => {
      let runtimeStatus: unknown;
      try {
        runtimeStatus = await requestSubagentStatus(pi);
      } catch {
        // Synthetic wakes are optional recovery. If the authoritative runtime
        // cannot be queried, fail closed instead of waking Main Pi from stale
        // mission or checklist state.
        return false;
      }

      if (authoritativeRuntimeWorkerState(runtimeStatus) !== "idle") return false;
      if (generation !== missionWakeGeneration || !mission || mission.id !== missionId) return false;
      if (missionWakeIsBlocked({ mainAgentRunning, activeToolExecutions: activeMainToolExecutions, wakeQueued: missionWakeQueued, turnSettled: mainTurnSettled })) return false;
      if (missionHasOwnedWork() || !missionNeedsMain()) return false;
      if (lastAssistantStopReason === "aborted" || lastAssistantStopReason === "error") return false;
      if (mission.wakeAttempts >= 3) {
        for (const outcome of mission.outcomes.filter((candidate) => candidate.status !== "completed")) {
          outcome.status = "needs_attention";
          outcome.detail = "Automatic reconciliation could not start after three queued attempts. Work and evidence are preserved; a user message can resume it without repeating completed work.";
          outcome.updatedAt = Date.now();
        }
        persistMission();
        return false;
      }
      const now = Date.now();
      if (now - lastMissionWakeAt < 4_000) return false;
      // Recheck the authoritative runtime immediately before enqueueing. The first status
      // protects the expensive reconciliation path; this one closes the launch/status race.
      let finalRuntimeStatus: unknown;
      try {
        finalRuntimeStatus = await requestSubagentStatus(pi);
      } catch {
        return false;
      }
      if (authoritativeRuntimeWorkerState(finalRuntimeStatus) !== "idle") return false;
      if (!mainTurnSettled || generation !== missionWakeGeneration || delegationLaunchesInFlight > 0 || missionHasOwnedWork()) return false;
      mission.wakeAttempts += 1;
      persistMission();
      lastMissionWakeAt = now;
      const resolvedReason = mission.phase === "integration" ? "integration" : reason;
      const task = mission.remainingTask;
      const notices = pendingIntegrationNotices.join("\n");
      const continuations = (mission.pendingContinuations ?? []).map((pending) =>
        `- Continue exact run ${pending.priorRunId} from ${pending.handoffPath}; call lemonpi_dispatch once with continuationOf='${pending.priorRunId}', the same recorded agent and execution mode, and no rewritten discovery task.`).join("\n");
      const content = resolvedReason === "integration"
        ? `${MISSION_INTEGRATION}${notices ? `\n\nTerminal results queued after the previous turn:\n${notices}` : ""}${continuations ? `\n\nAutomatically scheduled bounded continuations:\n${continuations}` : ""}`
        : `${PLAN_CONTINUATION}${task ? `\n\nStranded task #${task.id}: ${task.subject} (${task.status})` : ""}`;
      // This remains set until the exact hidden wake begins a model turn. The runtime status
      // query promise finishing is not consumption: clearing here allowed the scheduler to queue
      // several identical follow-ups behind one long tool-running turn.
      missionWakeQueued = true;
      try {
        pi.sendMessage(
          { customType: `lemonpi-mission-${resolvedReason}`, content, display: false },
          { deliverAs: "followUp", triggerTurn: true },
        );
        if (notices) pendingIntegrationNotices.splice(0, pendingIntegrationNotices.length);
      } catch (error) {
        missionWakeQueued = false;
        throw error;
      }
      return true;
    })();
    missionWakeCheck = pending;
    void pending.finally(() => {
      if (missionWakeCheck === pending) missionWakeCheck = undefined;
    });
    return pending;
  };

  const sendRestoreIntervention = (missionId: string, runId: string | undefined, reason: string) => {
    if (!automaticTurnMayStart(automaticTurnAuthority)) return;
    if (restoreInterventionMissions.has(missionId)) return;
    restoreInterventionMissions.add(missionId);
    pi.sendMessage(
      {
        customType: "lemonpi-mission-reconcile-attention",
        content: `${MISSION_RECONCILE_ATTENTION}${runId ? `\n\nRecorded run: ${runId}` : ""}\nReconciliation result: ${reason}`,
        display: false,
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  };

  const scheduleRestoredMissionReconciliation = (missionId: string, generation: number, attempt: number) => {
    if (restoreWakeTimer) clearTimeout(restoreWakeTimer);
    const delay = RESTORE_RECONCILE_DELAYS_MS[Math.min(attempt, RESTORE_RECONCILE_DELAYS_MS.length - 1)]!;
    restoreWakeTimer = setTimeout(() => {
      restoreWakeTimer = undefined;
      void reconcileRestoredMission(missionId, generation, attempt);
    }, delay);
  };

  const reconcileRestoredMission = async (missionId: string, generation: number, attempt: number): Promise<void> => {
    if (!mission || mission.id !== missionId || generation !== restoreReconcileGeneration) return;
    const targets = mission.activeRunIds.length > 0
      ? [...mission.activeRunIds]
      : mission.writerActive
        ? [undefined]
        : [];

    if (targets.length === 0) {
      if (mission.phase === "delegated") mission.phase = "integration";
      mission.writerActive = false;
      writerOccupied = false;
      persistMission();
      await requestMissionWake(mission.phase === "integration" ? "integration" : "plan");
      return;
    }

    const settled = await Promise.allSettled(targets.map((runId) => requestSubagentStatus(pi, runId)));
    if (!mission || mission.id !== missionId || generation !== restoreReconcileGeneration) return;
    const dispositions = settled.map((result) => result.status === "fulfilled" ? subagentStatusDisposition(result.value) : "unknown" as const);
    if (dispositions.some((disposition) => disposition === "unknown")) {
      if (attempt + 1 < RESTORE_RECONCILE_DELAYS_MS.length) {
        scheduleRestoredMissionReconciliation(missionId, generation, attempt + 1);
        return;
      }
      const failure = settled.find((result) => result.status === "rejected");
      const reason = failure?.status === "rejected"
        ? failure.reason instanceof Error ? failure.reason.message : String(failure.reason)
        : "The subagent runtime returned an unrecognized status.";
      sendRestoreIntervention(missionId, targets[dispositions.indexOf("unknown")], reason);
      return;
    }

    const terminal: Array<{ runId: string; status: Exclude<WriterLifecycleStatus, "paused"> }> = [];
    let intervention: { runId?: string; reason: string; needsAttention?: boolean } | undefined;
    dispositions.forEach((disposition, index) => {
      const runId = targets[index];
      if (restoredStatusAction(disposition) === "stay_silent") return;
      if (disposition === "needs_attention") {
        intervention ??= { ...(runId ? { runId } : {}), reason: "The worker needs attention.", needsAttention: true };
        return;
      }
      if (disposition === "paused") {
        intervention ??= { ...(runId ? { runId } : {}), reason: "The recorded worker is paused." };
        return;
      }
      if (runId) {
        activeDelegationRuns.delete(runId);
        activeDelegationWidths.delete(runId);
        activeWriterRuns.delete(runId);
      } else {
        activeDelegationRuns.clear();
        activeDelegationWidths.clear();
        activeWriterRuns.clear();
      }
      if (runId && (disposition === "completed" || disposition === "failed" || disposition === "stopped")) {
        terminal.push({ runId, status: disposition });
      }
    });

    mission.activeRunIds = mission.activeRunIds.filter((runId) => activeDelegationRuns.has(runId));
    const untargetedWriterActive = targets.some((runId, index) => runId === undefined
      && ["active", "needs_attention", "paused"].includes(dispositions[index]!));
    writerOccupied = activeWriterRuns.size > 0 || untargetedWriterActive;
    mission.writerActive = writerOccupied;
    if (!writerOccupied) activeWriterRuns.clear();
    if (mission.activeRunIds.length === 0 && !writerOccupied) mission.phase = "integration";
    mission.wakeAttempts = 0;
    persistMission();

    for (const item of terminal) void wakeForTerminalRun(item.runId, undefined, item.status);
    if (intervention?.needsAttention && intervention.runId && automaticTurnMayStart(automaticTurnAuthority)) {
      attentionRecovery = { runId: intervention.runId };
      attentionActionObserved = false;
      attentionRepairRequested = false;
      pi.sendMessage(
        { customType: "lemonpi-attention-recovery", content: `${ATTENTION_RECOVERY}\n\nTarget run: ${intervention.runId}`, display: false },
        { deliverAs: "followUp", triggerTurn: true },
      );
    } else if (intervention && automaticTurnMayStart(automaticTurnAuthority)) {
      sendRestoreIntervention(missionId, intervention.runId, intervention.reason);
    } else if (terminal.length === 0 && mission.activeRunIds.length === 0) {
      await requestMissionWake("integration");
    }
  };

  const restoreMission = (ctx: { sessionManager: { getBranch(): Iterable<unknown> } }) => {
    todoSessionId = (ctx.sessionManager as { getSessionId?: () => string }).getSessionId?.() ?? todoSessionId;
    missionWakeGeneration += 1;
    missionWakeCheck = undefined;
    missionWakeQueued = false;
    const branch = [...ctx.sessionManager.getBranch()];
    const restored = replayMissionState(branch);
    restoreTodoLifecycle(branch);
    restoreReconcileGeneration += 1;
    const generation = restoreReconcileGeneration;
    mission = restored;
    completedFastPath = restored?.fastPathFinalization && Date.now() - restored.fastPathFinalization.completedAt <= 24 * 60 * 60 * 1_000
      ? { ...restored.fastPathFinalization, paths: [...restored.fastPathFinalization.paths] }
      : undefined;
    lastPersistedMissionHash = restored && restored.migratedFromPolicyVersion === undefined
      ? missionStateContentHash(restored)
      : "";
    activeDelegationRuns.clear();
    activeDelegationWidths.clear();
    activeWriterRuns.clear();
    independentDispatchRuns.clear();
    internalContractFailures.clear();
    Object.entries(restored?.contractFailures ?? {}).forEach(([signature, count]) => internalContractFailures.set(signature, count));
    remainingPlanTask = restored?.remainingTask ? { ...restored.remainingTask } : undefined;
    planContinuationAttempts = restored?.wakeAttempts ?? 0;
    writerOccupied = restored?.writerActive ?? false;
    if (restored) restored.activeRunIds.forEach((runId) => {
      activeDelegationRuns.add(runId);
      const width = restored.activeRunWidths?.[runId] ?? 1;
      activeDelegationWidths.set(runId, width);
      if (width === 1) independentDispatchRuns.add(runId);
    });
    if (restored?.writerActive) restored.activeRunIds.forEach((runId) => activeWriterRuns.add(runId));
    if (restored?.migratedFromPolicyVersion !== undefined) persistMission();
    if (restoreWakeTimer) clearTimeout(restoreWakeTimer);
    if (!restored
      || restored.phase === "complete"
      || restored.phase === "paused"
      || Date.now() - restored.updatedAt > 7 * 24 * 60 * 60 * 1_000) return;
    scheduleRestoredMissionReconciliation(restored.id, generation, 0);
  };

  pi.on("session_start", async (_event, ctx) => {
    automaticTurnAuthority = "passive-session";
    runsStartedInThisSessionRuntime.clear();
    restoreMission(ctx);
  });
  pi.on("session_compact", async (_event, ctx) => restoreMission(ctx));
  pi.on("session_tree", async (_event, ctx) => {
    automaticTurnAuthority = "passive-session";
    runsStartedInThisSessionRuntime.clear();
    restoreMission(ctx);
  });

  pi.on("context", async (event) => {
    const messages = event.messages.map((message) => {
      if (message.role !== "user" || typeof message.content !== "string") return message;
      return { ...message, content: supersedeHistoricalPolicy(message.content) };
    });
    return {
      messages: [
        ...messages,
        { role: "user", content: ORCHESTRATION_POLICY_NOTICE, timestamp: Date.now() },
        ...(activeDelegationHandoffPending
          ? [{ role: "user" as const, content: ACTIVE_DELEGATION_HANDOFF, timestamp: Date.now() }]
          : []),
      ],
    };
  });

  const missionScheduler = setInterval(() => {
    if (!automaticTurnMayStart(automaticTurnAuthority)
      || proactiveCompactionInFlight
      || !mainTurnSettled
      || !missionNeedsMain()
      || missionWakeIsBlocked({ mainAgentRunning, activeToolExecutions: activeMainToolExecutions, wakeQueued: missionWakeQueued, turnSettled: mainTurnSettled })
      || missionHasOwnedWork()) return;
    void requestMissionWake(mission?.phase === "integration" ? "integration" : "plan");
  }, 5_000);

  const workerTelemetryScheduler = setInterval(() => {
    const running = mission?.attempts.filter((attempt) => attempt.status === "running") ?? [];
    if (running.length === 0) return;
    void Promise.allSettled(running.map(async (attempt) => {
      let status: unknown;
      try {
        status = await requestSubagentStatus(pi, attempt.runId);
      } catch {
        await superviseAttemptProgress(attempt, true);
        return;
      }
      const refreshed = updateAttemptTelemetry(attempt.runId, status);
      const observed = writerLifecycleStatus(status);
      if (refreshed && observed && observed !== "paused") {
        activeDelegationRuns.delete(attempt.runId);
        activeDelegationWidths.delete(attempt.runId);
        activeWriterRuns.delete(attempt.runId);
        if (mission) {
          mission.activeRunIds = mission.activeRunIds.filter((runId) => runId !== attempt.runId);
          mission.writerActive = activeWriterRuns.size > 0;
          if (mission.phase !== "paused") mission.phase = "integration";
        }
        if (independentDispatchRuns.has(attempt.runId)) {
          queueIndependentCompletion({ runId: attempt.runId, status: observed, evidence: status });
        } else {
          await wakeForTerminalRun(attempt.runId, undefined, observed, attempt.agent, false, status);
        }
      } else if (refreshed && !workerStatusMetrics(status, attempt.runId).terminal) {
        await superviseAttemptProgress(refreshed);
        await enforceAttemptBudget(refreshed);
      }
    }));
  }, 5_000);

  pi.on("session_shutdown", async () => {
    automaticTurnAuthority = "passive-session";
    runsStartedInThisSessionRuntime.clear();
    missionWakeGeneration += 1;
    missionWakeCheck = undefined;
    missionWakeQueued = false;
    if (restoreWakeTimer) clearTimeout(restoreWakeTimer);
    if (independentCompletionTimer) clearTimeout(independentCompletionTimer);
    pendingIndependentCompletions.clear();
    pendingPassiveCustomMessages.clear();
    activeFastPath = undefined;
    await Promise.allSettled((mission?.attempts ?? []).filter((attempt) => attempt.status === "running" && attempt.executionMode === "implementation").map(async (attempt) => {
      attempt.stopProvenance ??= {
        cause: "application_shutdown",
        initiator: "lemonpi-application",
        initiatingRunId: attempt.runId,
        reason: "LemonPi application session shut down while the worker was active.",
        requestedAt: Date.now(),
      };
      writeStopProvenanceArtifact(attempt, attempt.stopProvenance);
      attempt.preservedPatchPath = await preserveAttemptPatch(attempt) ?? attempt.preservedPatchPath;
      await createAttemptCheckpoint(attempt);
    }));
    persistMissionNow();
    clearInterval(missionScheduler);
    clearInterval(workerTelemetryScheduler);
  });

  const rememberTerminalRun = (key: string) => {
    integratedTerminalRuns.add(key);
    if (integratedTerminalRuns.size > 128) integratedTerminalRuns.delete(integratedTerminalRuns.values().next().value!);
  };

  async function wakeForTerminalRun(
    runId: string,
    sessionId: string | undefined,
    status: Exclude<WriterLifecycleStatus, "paused">,
    agent?: string,
    force = false,
    evidence?: unknown,
  ) {
    await recordTerminalAttempt(runId, status, evidence);
    const key = terminalRunKey(sessionId, runId);
    if (isManuallyStoppedRun(runId)) {
      rememberTerminalRun(key);
      if (mission && mission.activeRunIds.length === 0) {
        mission.phase = "paused";
        mission.wakeAttempts = 0;
        if (remainingPlanTask) mission.remainingTask = { ...remainingPlanTask };
        persistMission();
      }
      return;
    }
    if (integratedTerminalRuns.has(key) && !force) return;
    if (mission?.phase === "paused") return;
    rememberTerminalRun(key);
    const deferred = deferredWriterLanesByRun.get(runId) ?? [];
    deferredWriterLanesByRun.delete(runId);
    const terminalAttempt = mission?.attempts.find((attempt) => attempt.runId === runId);
    const implementationHandle = terminalAttempt?.executionMode === "implementation" && terminalAttempt.status === "completed"
      ? `; integrate deterministically with lemonpi_git { action: "integrate_worker_result", artifactRunId: "${runId}" }`
      : "";
    const stopNotice = terminalAttempt?.stopProvenance ? `; stop cause=${terminalAttempt.stopProvenance.cause}, initiator=${terminalAttempt.stopProvenance.initiator}, reason=${terminalAttempt.stopProvenance.reason}` : "";
    pendingIntegrationNotices.push(`- ${runId}${agent ? ` (${agent})` : ""}: ${terminalAttempt?.status ?? status}${stopNotice}${implementationHandle}${terminalAttempt?.partialHandoffPath ? `; continuation handoff: ${terminalAttempt.partialHandoffPath}` : ""}${deferred.length > 0 ? `; deferred lanes: ${deferred.join(", ")}` : ""}`);
    const currentMission = ensureMission("integration");
    currentMission.wakeAttempts = 0;
    persistMission();
    void requestMissionWake("integration");
  }

  const flushIndependentCompletions = async () => {
    independentCompletionTimer = undefined;
    if (mission?.phase === "paused") {
      pendingIndependentCompletions.clear();
      return;
    }
    const completed = [...pendingIndependentCompletions.values()]
      .filter(({ runId, sessionId }) => !integratedTerminalRuns.has(terminalRunKey(sessionId, runId)));
    pendingIndependentCompletions.clear();
    if (completed.length === 0) return;
    await Promise.all(completed.map(({ runId, status, evidence }) => recordTerminalAttempt(runId, status, evidence)));
    completed.forEach(({ runId, sessionId }) => rememberTerminalRun(terminalRunKey(sessionId, runId)));
    pendingIntegrationNotices.push(...completed.map(({ runId, status, agent }) => {
      const terminalAttempt = mission?.attempts.find((attempt) => attempt.runId === runId);
      const implementationHandle = terminalAttempt?.executionMode === "implementation" && terminalAttempt.status === "completed"
        ? `; integrate deterministically with lemonpi_git { action: "integrate_worker_result", artifactRunId: "${runId}" }`
        : "";
      const stopNotice = terminalAttempt?.stopProvenance ? `; stop cause=${terminalAttempt.stopProvenance.cause}, initiator=${terminalAttempt.stopProvenance.initiator}, reason=${terminalAttempt.stopProvenance.reason}` : "";
      return `- ${runId}${agent ? ` (${agent})` : ""}: ${terminalAttempt?.status ?? status}${stopNotice}${implementationHandle}${terminalAttempt?.partialHandoffPath ? `; continuation handoff: ${terminalAttempt.partialHandoffPath}` : ""}`;
    }));
    const currentMission = ensureMission("integration");
    currentMission.wakeAttempts = 0;
    persistMission();
    void requestMissionWake("integration");
  };

  function queueIndependentCompletion(completion: {
    runId: string;
    sessionId?: string;
    status: Exclude<WriterLifecycleStatus, "paused">;
    agent?: string;
    evidence?: unknown;
  }) {
    const key = terminalRunKey(completion.sessionId, completion.runId);
    if (integratedTerminalRuns.has(key)) return;
    pendingIndependentCompletions.set(key, completion);
    if (independentCompletionTimer) return;
    // Coalesce only completions that arrive together; do not recreate a group barrier.
    independentCompletionTimer = setTimeout(() => { void flushIndependentCompletions(); }, 300);
  }

  const completedFastPathMatches = (requestedCwd: string, paths: string[]) => {
    if (!completedFastPath || Date.now() - completedFastPath.completedAt > 24 * 60 * 60 * 1_000) return false;
    let canonicalCwd = "";
    try { canonicalCwd = realpathSync(requestedCwd); } catch { return false; }
    const inRepository = canonicalCwd === completedFastPath.root || canonicalCwd.startsWith(`${completedFastPath.root}/`);
    const requestedPaths = [...new Set(paths)];
    return inRepository
      && requestedPaths.length === completedFastPath.paths.length
      && requestedPaths.every((path) => completedFastPath!.paths.includes(path));
  };

  const completedFastPathRepositoryMatches = (requestedCwd: string) => {
    if (!completedFastPath || Date.now() - completedFastPath.completedAt > 24 * 60 * 60 * 1_000) return false;
    try {
      const canonicalCwd = realpathSync(requestedCwd);
      return canonicalCwd === completedFastPath.root || canonicalCwd.startsWith(`${completedFastPath.root}/`);
    } catch {
      return false;
    }
  };

  const openFastPath = async (requestedCwd: string, paths: string[], summary?: string) => {
    const issue = fastPathIssue({ request: latestUserRequest, paths });
    if (issue) return { error: issue };
    if (activeFastPath) return { error: "Finish the current fast-path slice before opening another." };
    const identity = await pi.exec("git", ["rev-parse", "--show-toplevel", "--git-common-dir"], { cwd: requestedCwd, timeout: 10_000 });
    if (identity.code !== 0) return { error: identity.stderr || "Fast path requires one Git repository." };
    const [root, commonRaw] = identity.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const repository = realpathSync(commonRaw.startsWith("/") ? commonRaw : resolve(root, commonRaw));
    const baseline = await inspectCheckoutSnapshot(pi, root, requestedCwd);
    recordGitBaseline(baseline);
    if (completedFastPathMatches(root, paths)) {
      return { error: "This exact fast-path slice is already implemented and validated. Do not reopen or repeat it; use lemonpi_git commit/checkpoint for the same exact files, or report the existing Git blocker once." };
    }
    const dirty = await pi.exec("git", ["status", "--porcelain=v1", "--untracked-files=all", "--", ...paths], { cwd: root, timeout: 10_000 });
    if (dirty.code !== 0 || dirty.stdout.trim()) {
      return { error: `Fast path will not overwrite pre-existing selected-file changes. Inspect them first.\n${dirty.stdout.trim() || dirty.stderr}` };
    }
    const outcomeId = `fast-path-${globalThis.crypto.randomUUID()}`;
    const outcomeSummary = summary?.trim().slice(0, 160) || latestUserRequest.trim().slice(0, 160) || "Complete local UI change";
    activeFastPath = {
      root,
      repository,
      paths: [...new Set(paths)],
      summary: outcomeSummary,
      outcomeId,
      startedAt: requestStartedAt,
      validationCount: 0,
    };
    ensureOutcome({ id: outcomeId, subject: outcomeSummary, status: "in_progress", detail: "Direct UI implementation is active.", repository, relevantPaths: paths });
    persistMission();
    return { active: activeFastPath };
  };

  const fastPathTool: ToolDefinition<any, Record<string, unknown>> = {
    name: "lemonpi_fast_path",
    label: "Use direct UI fast path",
    description: "Opens or closes one low-risk, one-repository UI implementation slice. While open, Main Pi may edit only the declared files and run one focused check.",
    parameters: FastPathSchema,
    async execute(_toolCallId, rawParams, _signal, onUpdate, ctx) {
      const params = rawParams as { action: "start" | "finish"; cwd?: string; paths: string[]; summary?: string };
      const requestedCwd = params.cwd || ctx.cwd;
      const issue = fastPathIssue({ request: latestUserRequest, paths: params.paths });
      if (issue) return { content: [{ type: "text", text: issue }], isError: true };
      const rootResult = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd: requestedCwd, timeout: 10_000 });
      if (rootResult.code !== 0) return { content: [{ type: "text", text: rootResult.stderr || "Fast path requires one Git repository." }], isError: true };
      const root = rootResult.stdout.trim();
      if (params.action === "finish") {
        if (!activeFastPath || activeFastPath.root !== root || params.paths.some((path) => !activeFastPath!.paths.includes(path))) {
          return { content: [{ type: "text", text: "This does not match the active fast-path repository and owned files." }], isError: true };
        }
        if (!activeFastPath.firstMutationAt || !activeFastPath.validationPassed) {
          return { content: [{ type: "text", text: "Finish requires the declared visible edit and one passing focused check." }], isError: true };
        }
        const completed = activeFastPath;
        const hashes = await pi.exec("git", ["hash-object", "--", ...completed.paths], { cwd: completed.root, timeout: 10_000 });
        const pathHashes = hashes.stdout.split(/\r?\n/).filter(Boolean);
        completed.paths.forEach((path, index) => recordPathProvenance({
          repository: completed.root,
          path,
          source: "fast-path",
          fingerprint: pathHashes[index] ?? contentHash(path),
        }));
        completedFastPath = {
          root: completed.root,
          repository: completed.repository,
          paths: [...completed.paths],
          outcomeId: completed.outcomeId,
          completedAt: Date.now(),
        };
        const outcome = mission?.outcomes.find((candidate) => candidate.id === completed.outcomeId);
        if (outcome) {
          outcome.status = "completed";
          outcome.detail = `Visible UI slice completed with ${completed.validationCount} focused check${completed.validationCount === 1 ? "" : "s"}; exact local Git finalization is allowed without reopening implementation.`;
          outcome.updatedAt = Date.now();
        }
        activeFastPath = undefined;
        if (mission) {
          mission.fastPathFinalization = { ...completedFastPath, paths: [...completedFastPath.paths] };
          mission.phase = mission.outcomes.every((candidate) => candidate.status === "completed") ? "complete" : mission.phase;
          persistMission();
        }
        return {
          content: [{ type: "text", text: `Fast path complete in ${Math.round((Date.now() - completed.startedAt) / 1_000)}s with ${completed.validationCount} focused check${completed.validationCount === 1 ? "" : "s"}.` }],
          details: { firstMutationMs: completed.firstMutationAt ? completed.firstMutationAt - completed.startedAt : undefined, validationCount: completed.validationCount, gitFinalizationPending: true, paths: completed.paths },
        };
      }
      const opened = await openFastPath(requestedCwd, params.paths, params.summary);
      if (opened.error || !opened.active) return { content: [{ type: "text", text: opened.error ?? "Fast path could not be opened." }], isError: true };
      const elapsedMs = Date.now() - requestStartedAt;
      return { content: [{ type: "text", text: `Fast path opened for ${activeFastPath.paths.length} UI file${activeFastPath.paths.length === 1 ? "" : "s"}. Make the visible edit now; first implementation is expected within five minutes.${elapsedMs > 5 * 60_000 ? " The latency guardrail is already exceeded, so stop investigating and implement the declared slice immediately." : ""}` }], details: { root, paths: activeFastPath.paths, requestElapsedMs: elapsedMs } };
    },
  };

  const gitManagerTool: ToolDefinition<any, Record<string, unknown>> = {
    name: "lemonpi_git",
    label: "Manage mission Git state",
    description: "Auditable local-only Git lifecycle operations for Main Pi. Inspects and checkpoints exact paths, integrates accepted patches or commits, and manages clean worktrees. It cannot discard changes, force operations, alter remotes, or push.",
    parameters: GitManagerSchema,
    async execute(_toolCallId, rawParams, _signal, onUpdate, ctx) {
      const params = rawParams as Record<string, unknown>;
      const action = String(params.action ?? "");
      const requestedCwd = String(params.cwd ?? ctx.cwd);
      const git = async (args: string[], cwd = requestedCwd) => pi.exec("git", args, { cwd, timeout: 30_000 });
      const rootResult = await git(["rev-parse", "--show-toplevel", "HEAD"]);
      if (rootResult.code !== 0) return { content: [{ type: "text", text: rootResult.stderr || "Not a Git repository." }], isError: true };
      const [root, head] = rootResult.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const statusResult = await git(["status", "--porcelain=v1", "--untracked-files=all"], root);
      if (statusResult.code !== 0) return { content: [{ type: "text", text: statusResult.stderr || "Could not inspect Git status." }], isError: true };
      const statusLines = statusResult.stdout.split(/\r?\n/).filter(Boolean);
      const recordedMissionPaths = mission?.pathProvenance
        ?.filter((item) => item.repository === root && item.source !== "baseline")
        .map((item) => item.path) ?? [];
      const classified = classifyDirtyTree(statusLines, [
        ...(Array.isArray(params.missionPaths) ? params.missionPaths.map(String) : []),
        ...recordedMissionPaths,
      ]);
      const safePath = (value: string) => value.length > 0
        && !value.startsWith("/")
        && !/^[A-Za-z]:[\\/]/.test(value)
        && !value.split(/[\\/]/).some((segment) => segment === "" || segment === "." || segment === "..");
      const paths = Array.isArray(params.paths) ? params.paths.map(String) : [];
      let branchName = typeof params.branch === "string" ? params.branch.trim() : "";
      const validLocalBranch = async () => branchName.length > 0
        && (await git(["check-ref-format", "--branch", branchName], root)).code === 0;
      if (action === "inspect") {
        if (paths.some((path) => !safePath(path))) return { content: [{ type: "text", text: "Inspection paths must be exact repository-relative paths." }], isError: true };
        const [branch, upstream, branches, commits, unstaged, stagedDiff, worktrees, ignored] = await Promise.all([
          git(["branch", "--show-current"], root),
          git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], root),
          git(["branch", "--list", "--verbose", "--no-abbrev"], root),
          git(["log", "-5", "--oneline", "--decorate"], root),
          git(["diff", "--stat", "HEAD", "--", ...(paths.length ? paths : ["."])], root),
          git(["diff", "--cached", "--stat", "--", ...(paths.length ? paths : ["."])], root),
          git(["worktree", "list", "--porcelain"], root),
          paths.length ? git(["check-ignore", "-v", "--", ...paths], root) : Promise.resolve({ code: 1, stdout: "", stderr: "" }),
        ]);
        return {
          content: [{ type: "text", text: `Repository: ${root}\nHEAD: ${head}\nBranch: ${branch.stdout.trim() || "detached"}\nUpstream: ${upstream.code === 0 ? upstream.stdout.trim() : "none"}\nDirty paths: ${classified.length}\n${classified.map((entry) => `- ${entry.status} ${entry.path} — ${entry.classification}: ${entry.reason}`).join("\n") || "- clean"}\n\nUnstaged diff:\n${unstaged.stdout.trim() || "none"}\n\nStaged diff:\n${stagedDiff.stdout.trim() || "none"}\n\nRecent commits:\n${commits.stdout.trim() || "none"}\n\nLocal branches:\n${branches.stdout.trim() || "none"}\n\nManaged worktrees:\n${worktrees.stdout.trim() || "none"}${paths.length ? `\n\nIgnored path evidence:\n${ignored.stdout.trim() || "none"}` : ""}`.slice(0, 24_000) }],
          details: { action, root, head, branch: branch.stdout.trim(), upstream: upstream.code === 0 ? upstream.stdout.trim() : undefined, paths: classified },
        };
      }

      const message = typeof params.message === "string" ? params.message.trim() : "";
      if (action === "resolve_conflicts_to_head") {
        const confirmedPaths = Array.isArray(params.confirmedPaths) ? params.confirmedPaths.map(String) : [];
        if (!paths.length
          || paths.some((path) => !safePath(path))
          || confirmedPaths.length !== paths.length
          || confirmedPaths.some((path) => !paths.includes(path))) {
          return { content: [{ type: "text", text: "Keeping current-branch conflict versions requires every exact unmerged path in both paths and confirmedPaths after one explicit user confirmation." }], isError: true };
        }
        const unmerged = await git(["diff", "--name-only", "--diff-filter=U"], root);
        const unmergedPaths = [...new Set(unmerged.stdout.split(/\r?\n/).filter(Boolean))];
        if (unmerged.code !== 0
          || unmergedPaths.length !== paths.length
          || unmergedPaths.some((path) => !paths.includes(path))) {
          return { content: [{ type: "text", text: `Conflict recovery must name the complete current unmerged set exactly. Current set: ${unmergedPaths.join(", ") || "none"}.` }], isError: true };
        }
        const operationChecks = await Promise.all([
          git(["rev-parse", "--verify", "CHERRY_PICK_HEAD"], root),
          git(["rev-parse", "--verify", "REVERT_HEAD"], root),
          git(["rev-parse", "--verify", "MERGE_HEAD"], root),
        ]);
        if (operationChecks.every((result) => result.code !== 0)) {
          return { content: [{ type: "text", text: "No interrupted cherry-pick, revert, or merge is active; conflict recovery was not applied." }], isError: true };
        }
        const restored = await git(["restore", "--source=HEAD", "--staged", "--worktree", "--", ...paths], root);
        if (restored.code !== 0) return { content: [{ type: "text", text: restored.stderr || "Could not preserve the current branch versions for the confirmed conflict set." }], isError: true };
        const remaining = await git(["diff", "--name-only", "--diff-filter=U"], root);
        if (remaining.code !== 0 || remaining.stdout.trim()) {
          return { content: [{ type: "text", text: `Conflict recovery did not reach a deterministic resolved state. Remaining: ${remaining.stdout.trim() || remaining.stderr}.` }], isError: true };
        }
        return {
          content: [{ type: "text", text: `Kept the current branch version of the complete confirmed conflict set:\n- ${paths.join("\n- ")}\nOther working changes were preserved. Finalize the already-validated fast-path files once; do not reopen or repeat implementation.` }],
          details: { action, root, paths, resolution: "head", unmergedRemaining: false },
        };
      }
      const integrateWorktreeTransaction = async (input: {
        worktreePath: string;
        ownedPaths: string[];
        linkedAttempt?: WorkerAttempt;
        commitMessage?: string;
      }) => {
        const transactionOwnedPaths = [...new Set([
          ...input.ownedPaths,
          ...(input.linkedAttempt?.outcomeId
            ? mission?.attempts
              .filter((attempt) => attempt.outcomeId === input.linkedAttempt!.outcomeId)
              .flatMap((attempt) => attempt.ownedPaths ?? []) ?? []
            : []),
        ])];
        if (!input.worktreePath || transactionOwnedPaths.length === 0 || transactionOwnedPaths.some((path) => !safePath(path))) {
          return { content: [{ type: "text", text: "Transactional integration requires an inspected worktree and exact repository-relative owned paths." }], isError: true };
        }
        const targetOwnedDirty = statusLines.filter((entry) => ownedPathsOverlap(transactionOwnedPaths, [statusEntryPath(entry)]));
        if (targetOwnedDirty.length > 0) {
          return { content: [{ type: "text", text: `Transactional integration will not overwrite pre-existing changes inside owned paths: ${targetOwnedDirty.join("; ")}. Unrelated baseline changes remain untouched.` }], isError: true };
        }
        let sourceRoot = "";
        try { sourceRoot = realpathSync(input.worktreePath); } catch { /* reported below */ }
        const worktrees = await git(["worktree", "list", "--porcelain"], root);
        const registered = sourceRoot && worktrees.stdout.split(/\r?\n/)
          .filter((line) => line.startsWith("worktree "))
          .some((line) => {
            try { return realpathSync(line.slice("worktree ".length).trim()) === sourceRoot; } catch { return false; }
          });
        if (!registered || sourceRoot === realpathSync(root)) {
          return { content: [{ type: "text", text: "The source must be a different registered worktree of this repository." }], isError: true };
        }
        const sourceIdentity = await git(["rev-parse", "--show-toplevel", "HEAD", "--git-common-dir"], sourceRoot);
        if (sourceIdentity.code !== 0) return { content: [{ type: "text", text: sourceIdentity.stderr || "Could not inspect the worker worktree." }], isError: true };
        const [canonicalSource, sourceInitialHead, sourceCommonRaw] = sourceIdentity.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        const targetCommon = await git(["rev-parse", "--git-common-dir"], root);
        const sourceCommon = realpathSync(sourceCommonRaw.startsWith("/") ? sourceCommonRaw : resolve(canonicalSource, sourceCommonRaw));
        const targetCommonPath = realpathSync(targetCommon.stdout.trim().startsWith("/") ? targetCommon.stdout.trim() : resolve(root, targetCommon.stdout.trim()));
        if (sourceCommon !== targetCommonPath) return { content: [{ type: "text", text: "The worktree does not share the target repository's Git object store." }], isError: true };

        const sourceStatus = await git(["status", "--porcelain=v1", "--untracked-files=all"], canonicalSource);
        const sourceEntries = classifyDirtyTree(sourceStatus.stdout.split(/\r?\n/).filter(Boolean), transactionOwnedPaths);
        const ownedEntries = sourceEntries.filter((entry) => transactionOwnedPaths.some((owned) => entry.path === owned || entry.path.startsWith(`${owned}/`)));
        const preStaged = await git(["diff", "--cached", "--name-only"], canonicalSource);
        const preStagedPaths = preStaged.stdout.split(/\r?\n/).filter(Boolean);
        if (preStagedPaths.some((path) => !transactionOwnedPaths.some((owned) => path === owned || path.startsWith(`${owned}/`)))) {
          return { content: [{ type: "text", text: `The worker already staged out-of-scope paths: ${preStagedPaths.join(", ")}.` }], isError: true };
        }
        let sourceCommit = sourceInitialHead;
        if (ownedEntries.length > 0 || preStagedPaths.length > 0) {
          const staged = await git(["add", "--", ...transactionOwnedPaths], canonicalSource);
          if (staged.code !== 0) return { content: [{ type: "text", text: staged.stderr || "Could not stage the owned worker files." }], isError: true };
          const stagedNames = await git(["diff", "--cached", "--name-only"], canonicalSource);
          const stagedPaths = stagedNames.stdout.split(/\r?\n/).filter(Boolean);
          if (!stagedPaths.length || stagedPaths.some((path) => !transactionOwnedPaths.some((owned) => path === owned || path.startsWith(`${owned}/`)))) {
            return { content: [{ type: "text", text: `Runtime ownership rejected staged paths: ${stagedPaths.join(", ") || "none"}.` }], isError: true };
          }
          const checked = await git(["diff", "--cached", "--check"], canonicalSource);
          if (checked.code !== 0) return { content: [{ type: "text", text: checked.stdout || checked.stderr || "The worker diff failed Git's whitespace check." }], isError: true };
          const committed = await git(["commit", "-m", input.commitMessage || "LemonPi: capture inspected worker slice"], canonicalSource);
          if (committed.code !== 0) return { content: [{ type: "text", text: committed.stderr || committed.stdout || "Could not commit the inspected worker state." }], isError: true };
          const resolved = await git(["rev-parse", "HEAD"], canonicalSource);
          sourceCommit = resolved.stdout.trim();
        }

        let baseRevision = input.linkedAttempt?.baseRevision ?? "";
        const validSourceBase = baseRevision
          ? await git(["merge-base", "--is-ancestor", baseRevision, sourceCommit], canonicalSource)
          : { code: 1, stdout: "", stderr: "" };
        const validTargetBase = baseRevision
          ? await git(["merge-base", "--is-ancestor", baseRevision, head], root)
          : { code: 1, stdout: "", stderr: "" };
        if (!baseRevision || validSourceBase.code !== 0 || validTargetBase.code !== 0) {
          const mergeBase = await git(["merge-base", head, sourceCommit], canonicalSource);
          if (mergeBase.code !== 0 || !mergeBase.stdout.trim()) return { content: [{ type: "text", text: "Could not determine the worker's exact integration base." }], isError: true };
          baseRevision = mergeBase.stdout.trim();
        }
        const allChanged = await git(["diff", "--name-only", baseRevision, sourceCommit], canonicalSource);
        const manifestPaths = allChanged.stdout.split(/\r?\n/).filter(Boolean);
        if (manifestPaths.length === 0) {
          if (input.linkedAttempt) {
            input.linkedAttempt.integrationStatus = "no-changes";
            input.linkedAttempt.integratedRevision = head;
            const outcome = input.linkedAttempt.outcomeId ? mission?.outcomes.find((candidate) => candidate.id === input.linkedAttempt!.outcomeId) : undefined;
            if (outcome) { outcome.status = "completed"; outcome.detail = "Worker completed with no code changes."; outcome.updatedAt = Date.now(); }
            persistMission();
          }
          return { content: [{ type: "text", text: "The inspected worker contains no changes beyond its recorded base." }], details: { changed: false, revision: head } };
        }
        if (manifestPaths.some((path) => !transactionOwnedPaths.some((owned) => path === owned || path.startsWith(`${owned}/`)))) {
          return { content: [{ type: "text", text: `Runtime ownership rejected the complete worker change set: ${manifestPaths.join(", ")}.` }], isError: true };
        }
        const patchResult = await git(["diff", "--binary", baseRevision, sourceCommit, "--", ...transactionOwnedPaths], canonicalSource);
        if (patchResult.code !== 0 || !patchResult.stdout) return { content: [{ type: "text", text: patchResult.stderr || "Could not generate the complete worker patch." }], isError: true };

        const transactionId = globalThis.crypto.randomUUID();
        const transactionParent = resolve(homedir(), ".pi", "lemonpi", "integration-transactions");
        const transactionPath = resolve(transactionParent, transactionId);
        const patchPath = resolve(transactionParent, `${transactionId}.patch`);
        mkdirSync(transactionParent, { recursive: true, mode: 0o700 });
        writeFileSync(patchPath, patchResult.stdout, { encoding: "utf8", mode: 0o600 });
        const cleanup = async () => {
          await git(["worktree", "remove", "--force", transactionPath], root);
          rmSync(patchPath, { force: true });
        };
        const created = await git(["worktree", "add", "--detach", transactionPath, head], root);
        if (created.code !== 0) {
          rmSync(patchPath, { force: true });
          return { content: [{ type: "text", text: created.stderr || "Could not create the isolated integration transaction." }], isError: true };
        }
        const applied = await git(["apply", "--3way", "--index", patchPath], transactionPath);
        if (applied.code !== 0) {
          await cleanup();
          return { content: [{ type: "text", text: `${applied.stderr || "The worker change conflicts with the target."}\nThe real checkout was not modified.` }], isError: true, details: { targetUnchanged: true, baseRevision, sourceCommit } };
        }
        const checked = await git(["diff", "--cached", "--check"], transactionPath);
        const stagedNames = await git(["diff", "--cached", "--name-only"], transactionPath);
        const stagedPaths = stagedNames.stdout.split(/\r?\n/).filter(Boolean);
        if (checked.code !== 0 || [...stagedPaths].sort().join("\n") !== [...manifestPaths].sort().join("\n")) {
          await cleanup();
          return { content: [{ type: "text", text: checked.stdout || checked.stderr || "Transaction verification did not reproduce the exact worker manifest. The real checkout was not modified." }], isError: true, details: { targetUnchanged: true } };
        }
        const transactionCommit = await git(["commit", "-m", input.commitMessage || "LemonPi: integrate inspected worker slice"], transactionPath);
        if (transactionCommit.code !== 0) {
          await cleanup();
          return { content: [{ type: "text", text: transactionCommit.stderr || transactionCommit.stdout || "Could not commit the isolated integration transaction." }], isError: true, details: { targetUnchanged: true } };
        }
        const transactionHead = await git(["rev-parse", "HEAD"], transactionPath);
        const targetRecheck = await git(["rev-parse", "HEAD"], root);
        const targetStatus = await git(["status", "--porcelain=v1", "--untracked-files=all"], root);
        if (targetRecheck.stdout.trim() !== head || targetStatus.stdout !== statusResult.stdout) {
          await cleanup();
          return { content: [{ type: "text", text: "The target revision or baseline working state changed while the transaction was prepared. Nothing was integrated; inspect the new target state first." }], isError: true, details: { targetUnchanged: true } };
        }
        const advanced = await git(["merge", "--ff-only", transactionHead.stdout.trim()], root);
        if (advanced.code !== 0) {
          await cleanup();
          return { content: [{ type: "text", text: `${advanced.stderr || "The target could not be advanced to the verified transaction."}\nNo conflict was left in the real checkout.` }], isError: true, details: { targetUnchanged: true } };
        }
        const integratedHead = await git(["rev-parse", "HEAD"], root);
        await cleanup();
        for (const path of manifestPaths) {
          recordPathProvenance({
            repository: root,
            path,
            source: "integration",
            ...(input.linkedAttempt?.runId ? { runId: input.linkedAttempt.runId } : {}),
            fingerprint: contentHash(`${integratedHead.stdout.trim()}:${path}`),
          });
        }
        if (input.linkedAttempt) {
          input.linkedAttempt.integrationStatus = "integrated";
          input.linkedAttempt.integratedRevision = integratedHead.stdout.trim();
          input.linkedAttempt.worktreePath = canonicalSource;
          input.linkedAttempt.cleanupPending = true;
          if (input.linkedAttempt.checkpointRef && input.linkedAttempt.checkpointCommit) {
            const archivedRef = `refs/lemonpi/archive/${input.linkedAttempt.runId.replace(/[^a-zA-Z0-9._-]+/g, "-")}`;
            const archived = await git(["update-ref", archivedRef, input.linkedAttempt.checkpointCommit], root);
            if (archived.code === 0) {
              await git(["update-ref", "-d", input.linkedAttempt.checkpointRef, input.linkedAttempt.checkpointCommit], root);
              input.linkedAttempt.checkpointArchivedAt = Date.now();
            }
          }
          const outcome = input.linkedAttempt.outcomeId ? mission?.outcomes.find((candidate) => candidate.id === input.linkedAttempt!.outcomeId) : undefined;
          if (outcome) { outcome.status = "validating"; outcome.detail = "Integrated transactionally; one focused check remains."; outcome.updatedAt = Date.now(); }
          persistMission();
        }
        return {
          content: [{ type: "text", text: `Integrated the complete inspected worker change transactionally as ${integratedHead.stdout.trim().slice(0, 12)}:\n- ${manifestPaths.join("\n- ")}` }],
          details: { action, root, worktreePath: canonicalSource, baseRevision, sourceCommit, paths: manifestPaths, revision: integratedHead.stdout.trim(), targetUnchangedUntilCommit: true, unrelatedBaselineChangesPreserved: statusLines.map(statusEntryPath), cleanupPending: Boolean(input.linkedAttempt) },
        };
      };
      if (["create_branch", "switch_branch"].includes(action)) {
        if (statusLines.length) return { content: [{ type: "text", text: "Mission branch changes require a clean recoverable checkout." }], isError: true };
        if (!await validLocalBranch()) return { content: [{ type: "text", text: "Git rejected this local branch name. Use any valid project-appropriate local branch name." }], isError: true };
        const exists = await git(["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], root);
        if (action === "create_branch" && exists.code === 0) return { content: [{ type: "text", text: `Local mission branch ${branchName} already exists.` }], isError: true };
        if (action === "switch_branch" && exists.code !== 0) return { content: [{ type: "text", text: `Local mission branch ${branchName} does not exist.` }], isError: true };
        const switched = await git(action === "create_branch" ? ["switch", "-c", branchName] : ["switch", branchName], root);
        return switched.code === 0
          ? { content: [{ type: "text", text: `${action === "create_branch" ? "Created and switched to" : "Switched to"} local mission branch ${branchName}.` }], details: { action, root, branch: branchName } }
          : { content: [{ type: "text", text: switched.stderr || "Could not update the local mission branch." }], isError: true };
      }
      if (["checkpoint", "commit"].includes(action)) {
        if (!paths.length || paths.some((path) => !safePath(path))) return { content: [{ type: "text", text: "Checkpoint and commit require exact repository-relative paths." }], isError: true };
        const confirmedPaths = Array.isArray(params.confirmedPaths) ? params.confirmedPaths.map(String) : [];
        if (confirmedPaths.some((path) => !safePath(path) || !paths.some((rootPath) => path === rootPath || path.startsWith(`${rootPath}/`)))) {
          return { content: [{ type: "text", text: "confirmedPaths must be exact selected repository-relative paths from the user's explicit confirmation." }], isError: true };
        }
        const selected = classified.filter((entry) => paths.some((path) => entry.path === path || entry.path.startsWith(`${path}/`)));
        const blockers = checkpointBlockersForSelection(classified, paths, confirmedPaths);
        if (blockers.length > 0) {
          return {
            content: [{ type: "text", text: `Clarification required before Git mutation for ${blockers.length} selected path${blockers.length === 1 ? "" : "s"}:\n${blockers.map((blocker) => `- ${blocker.path} is ${blocker.classification} (${blocker.reason})`).join("\n")}\nAsk once about this complete set. After explicit confirmation, retry once with every confirmed ambiguous path in confirmedPaths. Suspicious paths are never confirmation-bypassable.` }],
            isError: true,
            details: { action, requiresClarification: true, blockers },
          };
        }
        const nonSource = selected.find((entry) => entry.classification === "generated" || entry.classification === "agent-artifact");
        if (nonSource) {
          return {
            content: [{ type: "text", text: `Refusing to commit ${nonSource.path}: it is classified as ${nonSource.classification}. Preserve it outside Git if needed and delegate an exact .gitignore correction for reproducible output.` }],
            isError: true,
            details: { action, nonSource },
          };
        }
        if (action === "checkpoint") {
          if (!await validLocalBranch()) {
            branchName = `codex/lemonpi-recovery-${head.slice(0, 8)}-${contentHash(JSON.stringify({ paths: [...paths].sort(), message })).slice(0, 6)}`;
          }
          const current = await git(["branch", "--show-current"], root);
          if (current.stdout.trim() !== branchName) {
            const exists = await git(["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], root);
            const switched = await git(exists.code === 0 ? ["switch", branchName] : ["switch", "-c", branchName], root);
            if (switched.code !== 0) return { content: [{ type: "text", text: switched.stderr || "Could not create the recovery branch." }], isError: true };
          }
        }
        if (!message) return { content: [{ type: "text", text: "A truthful local commit message is required." }], isError: true };
        const staged = await git(["add", "--", ...paths], root);
        if (staged.code !== 0) return { content: [{ type: "text", text: staged.stderr || "Could not stage the reviewed paths." }], isError: true };
        const stagedNames = await git(["diff", "--cached", "--name-only"], root);
        const stagedPaths = stagedNames.stdout.split(/\r?\n/).filter(Boolean);
        if (!stagedPaths.length || stagedPaths.some((path) => !paths.some((owned) => path === owned || path.startsWith(`${owned}/`)))) {
          return { content: [{ type: "text", text: `Staged-content verification failed. Staged paths: ${stagedPaths.join(", ") || "none"}. Nothing was committed.` }], isError: true };
        }
        const check = await git(["diff", "--cached", "--check"], root);
        if (check.code !== 0) return { content: [{ type: "text", text: check.stdout || check.stderr || "The staged diff failed validation." }], isError: true };
        const committed = await git(["commit", "-m", message], root);
        if (committed.code !== 0) return { content: [{ type: "text", text: committed.stderr || committed.stdout || "Commit failed." }], isError: true };
        if (completedFastPathMatches(root, stagedPaths)) {
          const finalizedOutcomeId = completedFastPath?.outcomeId;
          completedFastPath = undefined;
          if (mission) {
            delete mission.fastPathFinalization;
            const outcome = finalizedOutcomeId ? mission.outcomes.find((candidate) => candidate.id === finalizedOutcomeId) : undefined;
            if (outcome) {
              outcome.detail = "Visible UI slice completed, validated, and checkpointed locally.";
              outcome.updatedAt = Date.now();
            }
            persistMission();
          }
        }
        const clean = await git(["status", "--porcelain=v1", "--untracked-files=all"], root);
        return { content: [{ type: "text", text: `${action === "checkpoint" ? "Recovery checkpoint" : "Logical integration commit"} created locally.\n${committed.stdout.trim()}\nRemaining dirty paths: ${clean.stdout.split(/\r?\n/).filter(Boolean).length}` }], details: { action, root, paths: stagedPaths, clean: !clean.stdout.trim() } };
      }

      if (action === "apply_patch") {
        const patch = typeof params.patch === "string" ? params.patch : "";
        const artifactRunId = typeof params.artifactRunId === "string" ? params.artifactRunId.trim() : undefined;
        const missionRunIds = mission?.attempts.map((attempt) => attempt.runId) ?? [];
        const candidatePath = patch.startsWith("/") || /^[A-Za-z]:[\\/]/.test(patch) ? patch : resolve(root, patch);
        let canonicalPatch = "";
        try {
          canonicalPatch = realpathSync(candidatePath);
          if (!statSync(canonicalPatch).isFile()) throw new Error("not a regular file");
        } catch {
          return { content: [{ type: "text", text: "The worker patch artifact is missing or is not a regular file." }], isError: true };
        }
        if (!trustedWorkerPatchPath(canonicalPatch, artifactRunId, missionRunIds)) {
          return { content: [{ type: "text", text: "Only package-generated worktree patches or an async artifact tied to the exact recorded mission run may be applied. Supply artifactRunId for async handoffs." }], isError: true };
        }
        const checked = await git(["apply", "--check", canonicalPatch], root);
        if (checked.code !== 0) return { content: [{ type: "text", text: checked.stderr || "Patch preflight failed; no changes were applied." }], isError: true };
        const applied = await git(["apply", "--3way", canonicalPatch], root);
        return applied.code === 0
          ? { content: [{ type: "text", text: "Accepted worker patch applied after a clean preflight. Review and commit its exact paths next." }], details: { action, root, patch: canonicalPatch, artifactRunId } }
          : { content: [{ type: "text", text: applied.stderr || "Patch integration failed." }], isError: true };
      }

      if (action === "integrate_worker_result") {
        const runId = typeof params.artifactRunId === "string" ? params.artifactRunId.trim() : "";
        const attempt = mission?.attempts.find((candidate) => candidate.runId === runId);
        if (!runId || !attempt || attempt.executionMode !== "implementation") {
          return { content: [{ type: "text", text: "Integration requires the exact artifactRunId of a recorded implementation worker." }], isError: true };
        }
        if (attempt.integrationStatus === "integrated" || attempt.integrationStatus === "no-changes") {
          return { content: [{ type: "text", text: `Worker ${runId} was already integrated; reusing revision ${attempt.integratedRevision ?? head}.` }], details: { action, root, runId, deduplicated: true, revision: attempt.integratedRevision ?? head } };
        }
        if (attempt.status !== "completed") {
          return { content: [{ type: "text", text: `Worker ${runId} is ${attempt.status}; only a completed implementation handoff can be integrated atomically.` }], isError: true };
        }
        if (!attempt.handoffPath) {
          try {
            const workerStatus = await requestSubagentStatus(pi, runId);
            updateAttemptTelemetry(runId, workerStatus);
          } catch {
            // The persisted exact runtime handle below remains authoritative.
          }
          const generated = writeCompletedWorkerManifest(attempt);
          if (generated) attempt.handoffPath = generated;
        }
        const handoffPath = attempt.handoffPath;
        if (!handoffPath) {
          return { content: [{ type: "text", text: "The runtime did not publish its generated handoff manifest yet. Inspect this exact run once; do not launch another worker to copy its patch." }], isError: true };
        }
        let canonicalHandoff = "";
        let manifest: Record<string, unknown>;
        try {
          canonicalHandoff = realpathSync(handoffPath);
          if (!statSync(canonicalHandoff).isFile()) throw new Error("not a regular file");
          manifest = JSON.parse(readFileSync(canonicalHandoff, "utf8")) as Record<string, unknown>;
        } catch (error) {
          return { content: [{ type: "text", text: `The generated handoff manifest is missing or malformed: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
        }
        if (manifest.version === 2) {
          const manifestPaths = Array.isArray(manifest.ownedPaths) ? manifest.ownedPaths.filter((path): path is string => typeof path === "string") : [];
          const manifestWorktree = typeof manifest.worktreePath === "string" ? manifest.worktreePath : "";
          const manifestBase = typeof manifest.baseRevision === "string" ? manifest.baseRevision : "";
          if (manifest.runId !== runId || !manifestWorktree || !manifestBase || manifestPaths.length === 0
            || manifestPaths.some((path) => !(attempt.ownedPaths ?? []).includes(path))) {
            return { content: [{ type: "text", text: "The runtime-generated integration manifest does not match the recorded worker identity, base, or ownership." }], isError: true };
          }
          attempt.worktreePath = manifestWorktree;
          attempt.baseRevision = manifestBase;
          return integrateWorktreeTransaction({
            worktreePath: manifestWorktree,
            ownedPaths: manifestPaths,
            linkedAttempt: attempt,
            commitMessage: `LemonPi: integrate ${attempt.purpose}`.slice(0, 120),
          });
        }
        if (manifest.version !== 1 || manifest.runId !== runId || !Array.isArray(manifest.groups)) {
          return { content: [{ type: "text", text: "The handoff manifest identity or version does not match the recorded worker run." }], isError: true };
        }
        const groups = manifest.groups.map(asRecord).filter((group): group is Record<string, unknown> => Boolean(group));
        const children = groups.flatMap((group) => Array.isArray(group.children)
          ? group.children.map(asRecord).filter((child): child is Record<string, unknown> => Boolean(child)).map((child) => ({ group, child }))
          : []);
        if (children.length !== 1 || children[0]!.child.status !== "completed") {
          return { content: [{ type: "text", text: "Atomic worker integration requires the runtime-generated one-child completed handoff for this independent lane." }], isError: true };
        }
        const { group, child } = children[0]!;
        const patchRecord = asRecord(child.patch);
        if (!patchRecord || patchRecord.error || typeof patchRecord.path !== "string") {
          return { content: [{ type: "text", text: `The runtime could not generate a usable worker patch${patchRecord?.error ? `: ${String(patchRecord.error)}` : "."}` }], isError: true };
        }
        const ownedPaths = attempt.ownedPaths ?? [];
        if (ownedPaths.length === 0) {
          return { content: [{ type: "text", text: "The runtime record has no exact owned paths, so deterministic integration is closed." }], isError: true };
        }
        if (patchRecord.changed !== true) {
          attempt.integrationStatus = "no-changes";
          attempt.integratedRevision = head;
          persistMission();
          return { content: [{ type: "text", text: `Worker ${runId} completed with no code changes; no copy worker or commit is needed.` }], details: { action, root, runId, manifest: canonicalHandoff, changed: false, revision: head } };
        }
        const runtimeWorktree = groups.flatMap((candidate) => {
          const cleanup = asRecord(candidate.cleanup);
          return Array.isArray(cleanup?.tasks) ? cleanup.tasks.map(asRecord).filter(Boolean) : [];
        }).find((task) => typeof task?.path === "string")?.path;
        if (typeof runtimeWorktree === "string") {
          try {
            attempt.worktreePath = realpathSync(runtimeWorktree);
            return integrateWorktreeTransaction({
              worktreePath: attempt.worktreePath,
              ownedPaths,
              linkedAttempt: attempt,
              commitMessage: `LemonPi: integrate ${attempt.purpose}`.slice(0, 120),
            });
          } catch {
            // pi-subagents normally removes its worktree after capturing the durable patch.
          }
        }
        let canonicalPatch = "";
        try {
          canonicalPatch = realpathSync(patchRecord.path);
          if (!trustedWorkerPatchPath(canonicalPatch, runId, mission?.attempts.map((candidate) => candidate.runId) ?? [])) throw new Error("untrusted patch path");
        } catch (error) {
          return { content: [{ type: "text", text: `The runtime patch is not an inspectable artifact: ${error instanceof Error ? error.message : String(error)}` }], isError: true, details: { targetUnchanged: true, runId } };
        }
        const manifestBase = typeof group.baseCommit === "string" ? group.baseCommit : attempt.baseRevision;
        if (!manifestBase) return { content: [{ type: "text", text: "The runtime patch has no exact base revision." }], isError: true, details: { targetUnchanged: true, runId } };
        const verifiedBase = await git(["rev-parse", `${manifestBase}^{commit}`], root);
        if (verifiedBase.code !== 0) return { content: [{ type: "text", text: "The runtime patch base is not a local commit." }], isError: true, details: { targetUnchanged: true, runId } };
        const reconstructionRoot = resolve(homedir(), ".pi", "lemonpi", "reconstructed-worktrees");
        const reconstruction = resolve(reconstructionRoot, globalThis.crypto.randomUUID());
        mkdirSync(reconstructionRoot, { recursive: true, mode: 0o700 });
        const created = await git(["worktree", "add", "--detach", reconstruction, verifiedBase.stdout.trim()], root);
        if (created.code !== 0) return { content: [{ type: "text", text: created.stderr || "Could not reconstruct the inspected runtime patch." }], isError: true, details: { targetUnchanged: true, runId } };
        const applied = await git(["apply", "--3way", canonicalPatch], reconstruction);
        if (applied.code !== 0) {
          await git(["worktree", "remove", "--force", reconstruction], root);
          return { content: [{ type: "text", text: applied.stderr || "The runtime patch did not reproduce from its exact base." }], isError: true, details: { targetUnchanged: true, runId } };
        }
        attempt.worktreePath = reconstruction;
        attempt.baseRevision = verifiedBase.stdout.trim();
        const integrated = await integrateWorktreeTransaction({
          worktreePath: reconstruction,
          ownedPaths,
          linkedAttempt: attempt,
          commitMessage: `LemonPi: integrate ${attempt.purpose}`.slice(0, 120),
        });
        const reconstructedStatus = await git(["status", "--porcelain=v1", "--untracked-files=all"], reconstruction);
        if (reconstructedStatus.code === 0 && !reconstructedStatus.stdout.trim()) {
          await git(["worktree", "remove", reconstruction], root);
          attempt.cleanupPending = false;
          persistMission();
        }
        return integrated;
      }

      if (action === "integrate_worktree") {
        const worktreePath = typeof params.worktreePath === "string" ? params.worktreePath.trim() : "";
        if (!worktreePath || !paths.length || paths.some((path) => !safePath(path))) {
          return { content: [{ type: "text", text: "Worktree integration requires its inspected path and exact repository-relative owned paths." }], isError: true };
        }
        const transactionAttempt = mission?.attempts.find((attempt) => {
          if (typeof params.artifactRunId === "string" && attempt.runId === params.artifactRunId) return true;
          try { return Boolean(attempt.worktreePath && realpathSync(attempt.worktreePath) === realpathSync(worktreePath)); } catch { return false; }
        });
        return integrateWorktreeTransaction({
          worktreePath,
          ownedPaths: paths,
          linkedAttempt: transactionAttempt,
          commitMessage: message || (transactionAttempt ? `LemonPi: integrate ${transactionAttempt.purpose}` : "LemonPi: integrate inspected worker slice"),
        });
      }

      if (action === "create_worktree") {
        if (statusLines.length) return { content: [{ type: "text", text: "Create a recoverable checkpoint before adding managed worktrees; the primary checkout is still dirty." }], isError: true };
        const worktreePath = typeof params.worktreePath === "string" ? params.worktreePath : "";
        if (!worktreePath.replace(/\\/g, "/").includes("/lemonpi-worktrees/") || !await validLocalBranch()) {
          return { content: [{ type: "text", text: "Managed worktrees require a dedicated lemonpi-worktrees path and any Git-valid local branch name." }], isError: true };
        }
        const created = await git(["worktree", "add", "-b", branchName, worktreePath, head], root);
        return created.code === 0
          ? { content: [{ type: "text", text: `Managed worktree created at ${worktreePath} from ${head}.` }], details: { action, root, head, branch: branchName, worktreePath } }
          : { content: [{ type: "text", text: created.stderr || "Could not create the managed worktree." }], isError: true };
      }

      if (action === "remove_worktree") {
        const worktreePath = typeof params.worktreePath === "string" ? params.worktreePath : "";
        if (!worktreePath.replace(/\\/g, "/").includes("/lemonpi-worktrees/")) return { content: [{ type: "text", text: "Refusing to remove a path outside LemonPi's managed worktree root." }], isError: true };
        const removed = await git(["worktree", "remove", worktreePath], root);
        return removed.code === 0
          ? { content: [{ type: "text", text: `Clean managed worktree removed: ${worktreePath}` }], details: { action, root, worktreePath } }
          : { content: [{ type: "text", text: removed.stderr || "Worktree is dirty, locked, missing, or otherwise unsafe to remove." }], isError: true };
      }

      if (action === "cherry_pick") {
        const revision = typeof params.revision === "string" ? params.revision.trim() : "";
        if (!/^[0-9a-f]{7,64}$/i.test(revision) || statusLines.length) return { content: [{ type: "text", text: "Cherry-pick requires a clean checkout and an exact local commit revision." }], isError: true };
        const picked = await git(["cherry-pick", revision], root);
        return picked.code === 0
          ? { content: [{ type: "text", text: picked.stdout.trim() || `Integrated local commit ${revision}.` }], details: { action, root, revision } }
          : { content: [{ type: "text", text: `${picked.stderr || "Cherry-pick conflicted."}\nLemonPi did not abort, reset, or discard anything; resolve through a bounded integration correction.` }], isError: true };
      }

      return { content: [{ type: "text", text: `Unsupported safe Git action: ${action}` }], isError: true };
    },
  };

  const retireValidatedWorktrees = async (checkoutRoot: string, relevantPaths: string[]): Promise<string[]> => {
    const retired: string[] = [];
    const candidates = mission?.attempts.filter((attempt) =>
      attempt.integrationStatus === "integrated"
      && attempt.cleanupPending
      && attempt.worktreePath
      && attempt.ownedPaths?.some((owned) => relevantPaths.some((relevant) => ownedPathsOverlap([owned], [relevant])))) ?? [];
    if (candidates.length === 0) return retired;
    const listed = await pi.exec("git", ["worktree", "list", "--porcelain"], { cwd: checkoutRoot, timeout: 10_000 });
    if (listed.code !== 0) return retired;
    const registered = listed.stdout.split(/\r?\n/).filter((line) => line.startsWith("worktree ")).map((line) => line.slice("worktree ".length).trim());
    for (const attempt of candidates) {
      const worktreePath = attempt.worktreePath!;
      let canonical = "";
      try { canonical = realpathSync(worktreePath); } catch {
        attempt.cleanupPending = false;
        continue;
      }
      if (canonical === realpathSync(checkoutRoot) || !registered.some((path) => {
        try { return realpathSync(path) === canonical; } catch { return false; }
      })) continue;
      const status = await pi.exec("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: canonical, timeout: 10_000 });
      if (status.code !== 0 || status.stdout.trim()) continue;
      const removed = await pi.exec("git", ["worktree", "remove", canonical], { cwd: checkoutRoot, timeout: 30_000 });
      if (removed.code === 0) {
        attempt.cleanupPending = false;
        retired.push(canonical);
      }
    }
    if (retired.length > 0) persistMission();
    return retired;
  };

  const validationTool: ToolDefinition<any, Record<string, unknown>> = {
    name: "lemonpi_validate",
    label: "Run deduplicated validation",
    description: "Runs a focused, integration-wave, or final validation command only when its revision, relevant inputs, and dependency state have changed. Long commands emit visible heartbeat updates.",
    parameters: ValidationSchema,
    async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
      const params = rawParams as { cwd: string; program: string; args?: string[]; env?: Record<string, string>; relevantPaths: string[]; scope: "focused" | "wave" | "final" };
      const cwd = params.cwd || ctx.cwd;
      const revision = await pi.exec("git", ["rev-parse", "--show-toplevel", "HEAD"], { cwd, timeout: 10_000 });
      if (revision.code !== 0) return { content: [{ type: "text", text: revision.stderr || "Validation target is not a Git repository." }], isError: true };
      const [checkoutRoot, baseRevision] = revision.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const commonDir = await pi.exec("git", ["rev-parse", "--git-common-dir"], { cwd: checkoutRoot, timeout: 10_000 });
      const rawCommonDir = commonDir.stdout.trim();
      const repository = commonDir.code === 0 && rawCommonDir
        ? realpathSync(rawCommonDir.startsWith("/") ? rawCommonDir : resolve(checkoutRoot, rawCommonDir))
        : checkoutRoot;
      const lockfiles = ["Cargo.lock", "pnpm-lock.yaml", "package-lock.json", "yarn.lock", "Package.resolved"];
      const [diff, status, pathHashes, dependencyDiff, dependencyStatus, dependencyHashes] = await Promise.all([
        pi.exec("git", ["diff", "--binary", "HEAD", "--", ...params.relevantPaths], { cwd: checkoutRoot, timeout: 10_000 }),
        pi.exec("git", ["status", "--porcelain=v1", "--untracked-files=all", "--", ...params.relevantPaths], { cwd: checkoutRoot, timeout: 10_000 }),
        pi.exec("git", ["hash-object", "--", ...params.relevantPaths], { cwd: checkoutRoot, timeout: 10_000 }),
        pi.exec("git", ["diff", "HEAD", "--", ...lockfiles], { cwd: checkoutRoot, timeout: 10_000 }),
        pi.exec("git", ["status", "--porcelain=v1", "--untracked-files=all", "--", ...lockfiles], { cwd: checkoutRoot, timeout: 10_000 }),
        pi.exec("git", ["hash-object", "--", ...lockfiles], { cwd: checkoutRoot, timeout: 10_000 }),
      ]);
      let executable = params.program.trim();
      try {
        if (/^(?:[A-Za-z]:[\\/]|\/)/.test(executable)) executable = realpathSync(executable);
        else {
          const lookup = await pi.exec(process.platform === "win32" ? "where.exe" : "which", [executable], { cwd: checkoutRoot, timeout: 5_000 });
          const resolvedExecutable = lookup.code === 0 ? lookup.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) : undefined;
          if (resolvedExecutable) executable = realpathSync(resolvedExecutable);
        }
      } catch {
        // Preserve the exact requested program when lookup itself is unavailable.
      }
      if (process.platform === "win32") executable = executable.toLowerCase();
      const environmentHash = contentHash(JSON.stringify(Object.entries(params.env ?? {}).sort(([left], [right]) => left.localeCompare(right))));
      const candidate = {
        repository,
        baseRevision,
        diffHash: contentHash(`${diff.stdout}\n${status.stdout}\n${pathHashes.stdout}`),
        executable,
        args: [...(params.args ?? [])],
        cwd: checkoutRoot,
        environmentHash,
        command: [params.program, ...(params.args ?? [])].join(" "),
        relevantPaths: [...new Set(params.relevantPaths)],
        dependencyState: contentHash(`${dependencyDiff.stdout}\n${dependencyStatus.stdout}\n${dependencyHashes.stdout}`),
        scope: params.scope,
      } satisfies Omit<ValidationRecord, "passed" | "elapsedMs">;
      const currentMission = ensureMission("integration");
      if (activeFastPath) {
        if (params.scope !== "focused") return { content: [{ type: "text", text: "Fast path permits one focused check, not wave or final validation." }], isError: true };
        if (activeFastPath.root !== checkoutRoot || params.relevantPaths.some((path) => !activeFastPath!.paths.includes(path))) {
          return { content: [{ type: "text", text: "Fast-path validation must target only the active slice repository and declared files." }], isError: true };
        }
      }
      const duplicate = validationDeduplicationIssue([...persistentValidations, ...currentMission.validations], candidate);
      if (duplicate) {
        if (activeFastPath) {
          activeFastPath.validationPassed = true;
          activeFastPath.validationCount = Math.max(1, activeFastPath.validationCount);
        }
        for (const outcome of currentMission.outcomes) {
          if (outcome.status !== "validating" || outcome.repository !== candidate.repository || !outcome.relevantPaths?.length) continue;
          const covered = outcome.relevantPaths.every((path) => candidate.relevantPaths.some((relevant) => path === relevant || path.startsWith(`${relevant}/`) || relevant.startsWith(`${path}/`)));
          if (!covered) continue;
          outcome.status = "completed";
          outcome.detail = "Integrated and verified by unchanged focused validation evidence.";
          outcome.updatedAt = Date.now();
        }
        persistMission();
        const retired = await retireValidatedWorktrees(checkoutRoot, params.relevantPaths);
        return { content: [{ type: "text", text: `${duplicate} Reusing the recorded passing evidence.${retired.length ? ` Retired ${retired.length} clean managed worktree${retired.length === 1 ? "" : "s"}.` : ""}` }], details: { deduplicated: true, candidate, retiredWorktrees: retired } };
      }
      if (activeFastPath) {
        if (activeFastPath.validationPassed) return { content: [{ type: "text", text: "The fast-path slice already has passing focused evidence. Do not run another suite." }], isError: true };
        if (activeFastPath.lastValidationKey === validationLedgerKey(candidate)) return { content: [{ type: "text", text: "The same focused command already produced a genuine test failure for this exact validation identity. Change the code or correct the command before retrying." }], isError: true };
      }
      const startedAt = Date.now();
      const heartbeat = setInterval(() => {
        onUpdate?.({ content: [{ type: "text", text: validationActivityLabel(candidate.command, startedAt, Date.now()) }] });
      }, 5_000);
      try {
        const result = await pi.exec(params.program, params.args ?? [], { cwd: checkoutRoot, timeout: 30 * 60_000, signal, ...(params.env ? { env: { ...process.env, ...params.env } } : {}) });
        const elapsedMs = Date.now() - startedAt;
        const infrastructureFailure = validationLaunchFailure(result.code, result.stderr);
        if (activeFastPath && !infrastructureFailure) activeFastPath.validationCount += 1;
        if (result.code === 0) {
          const evidence = { ...candidate, passed: true, elapsedMs } satisfies ValidationRecord;
          currentMission.validations.push(evidence);
          persistentValidations = persistentValidations.filter((record) => validationLedgerKey(record) !== validationLedgerKey(evidence));
          persistentValidations.push(evidence);
          persistValidationEvidence();
          if (activeFastPath) activeFastPath.validationPassed = true;
          for (const outcome of currentMission.outcomes) {
            if (outcome.status !== "validating" || outcome.repository !== candidate.repository || !outcome.relevantPaths?.length) continue;
            const covered = outcome.relevantPaths.every((path) => candidate.relevantPaths.some((relevant) => path === relevant || path.startsWith(`${relevant}/`) || relevant.startsWith(`${path}/`)));
            if (!covered) continue;
            outcome.status = "completed";
            outcome.detail = "Integrated and verified with focused validation.";
            outcome.updatedAt = Date.now();
          }
          persistMission();
        } else if (activeFastPath && !infrastructureFailure) {
          activeFastPath.lastValidationKey = validationLedgerKey(candidate);
        }
        const retired = result.code === 0 ? await retireValidatedWorktrees(checkoutRoot, params.relevantPaths) : [];
        return {
          content: [{ type: "text", text: `${result.code === 0 ? "Validation passed" : "Validation failed"}: ${candidate.command} (${Math.round(elapsedMs / 100) / 10}s)${retired.length ? `; retired ${retired.length} clean managed worktree${retired.length === 1 ? "" : "s"}` : ""}\n${(result.stdout || result.stderr).trim().slice(-4_000)}` }],
          ...(result.code === 0 ? {} : { isError: true }),
          details: { deduplicated: false, active: false, infrastructureFailure, elapsedMs, exitCode: result.code, candidate, retiredWorktrees: retired },
        };
      } finally {
        clearInterval(heartbeat);
      }
    },
  };

  const ownershipExpansionTool: ToolDefinition<any, Record<string, unknown>> = {
    name: "lemonpi_expand_ownership",
    label: "Expand worker ownership",
    description: "Atomically add exact mechanically required paths to an active implementation lane after checking other writers.",
    parameters: OwnershipExpansionSchema,
    async execute(_toolCallId, rawParams) {
      const params = rawParams as { runId: string; paths: string[]; category: OwnershipExpansionCategory; reason: string };
      const attempt = mission?.attempts.find((candidate) => candidate.runId === params.runId && candidate.status === "running" && candidate.executionMode === "implementation");
      if (!attempt || !attempt.repository) {
        return { content: [{ type: "text", text: `No active implementation lane matches '${params.runId}'.` }], isError: true };
      }
      const requestedPaths = normalizedOwnedPathList(params.paths) ?? [];
      const issue = ownershipExpansionIssue({
        runId: attempt.runId,
        currentPaths: attempt.ownedPaths ?? [],
        requestedPaths,
        reason: params.reason,
        category: params.category,
        activeLanes: (mission?.attempts ?? []).filter((candidate) => candidate.status === "running" && candidate.executionMode === "implementation" && candidate.repository === attempt.repository)
          .map((candidate) => ({ runId: candidate.runId, paths: candidate.ownedPaths ?? [] })),
      });
      if (issue) return { content: [{ type: "text", text: issue }], isError: true };
      attempt.ownedPaths = [...new Set([...(attempt.ownedPaths ?? []), ...requestedPaths])];
      attempt.ownershipExpansions ??= [];
      attempt.ownershipExpansions.push({ paths: requestedPaths, reason: params.reason.slice(0, 500), category: params.category, expandedAt: Date.now() });
      const outcome = attempt.outcomeId ? mission?.outcomes.find((candidate) => candidate.id === attempt.outcomeId) : undefined;
      if (outcome) {
        outcome.relevantPaths = [...attempt.ownedPaths];
        outcome.detail = `Implementation is running; ownership expanded for ${params.category}.`;
        outcome.updatedAt = Date.now();
      }
      persistMissionNow();
      try {
        await requestSubagentSteer(pi, attempt.runId, 0, `LemonPi atomically expanded this lane's ownership for ${params.category}: ${requestedPaths.join(", ")}. Reason: ${params.reason}. Continue the same run; no new worker is needed.`);
      } catch {
        return { content: [{ type: "text", text: `Ownership expanded to ${requestedPaths.join(", ")}, but live notification failed. The durable mission record is authoritative.` }], details: { runId: attempt.runId, paths: requestedPaths, category: params.category, notificationDelivered: false } };
      }
      return { content: [{ type: "text", text: `Expanded ${attempt.runId} ownership to include ${requestedPaths.join(", ")} (${params.category}).` }], details: { runId: attempt.runId, paths: requestedPaths, category: params.category, reason: params.reason } };
    },
  };

  const independentDispatchTool: ToolDefinition<any, Record<string, unknown>> = {
    name: "lemonpi_dispatch",
    label: "Dispatch independent lanes",
    description: "Launch dependency-ready lanes as separate async subagent runs. Use this instead of grouped subagent tasks whenever two or more results can be acted on independently. Each lane completes and wakes Main Pi on its own; implementation lanes are isolated in separate package-managed Git worktrees.",
    parameters: IndependentDispatchSchema,
    async execute(_toolCallId, rawParams, _signal, onUpdate, ctx) {
      const params = rawParams as { lanes: Array<Record<string, unknown>>; context?: "fresh" | "fork" };
      const forbiddenOverride = launchOverridePath(params, "lemonpi_dispatch");
      if (forbiddenOverride) {
        return { content: [{ type: "text", text: `LemonPi rejected ${forbiddenOverride} before launch. Agent model and thinking come only from user settings; no child was launched.` }], isError: true, details: { mode: "independent", runs: [], failures: [{ reason: "launch override rejected" }] } };
      }
      todoSessionId = (ctx.sessionManager as { getSessionId?: () => string }).getSessionId?.() ?? todoSessionId;
      const scopeIssue = hiddenScopeExpansionIssue(latestUserRequest, params.lanes.flatMap((lane) => [String(lane.task ?? ""), String(lane.cwd ?? "") ]));
      if (scopeIssue) {
        return { content: [{ type: "text", text: scopeIssue }], isError: true, details: { mode: "independent", runs: [], failures: [{ reason: "hidden scope expansion" }] } };
      }
      const onlyLane = params.lanes.length === 1 ? params.lanes[0] : undefined;
      const directPaths = onlyLane?.executionMode === "implementation" ? normalizedOwnedPathList(onlyLane.ownedPaths) : undefined;
      if (onlyLane && !onlyLane.worktreePath && directPaths && !fastPathIssue({ request: latestUserRequest, paths: directPaths })) {
        const opened = await openFastPath(typeof onlyLane.cwd === "string" ? onlyLane.cwd : ctx.cwd, directPaths, typeof onlyLane.summary === "string" ? onlyLane.summary : undefined);
        if (opened.error || !opened.active) {
          return {
            content: [{ type: "text", text: opened.error ?? "The direct UI fast path could not be opened." }],
            isError: true,
            details: { mode: "fast-path", runs: [], failures: [{ reason: opened.error ?? "fast path unavailable" }] },
          };
        }
        return {
          content: [{ type: "text", text: `Converted this eligible UI lane directly to the fast path for ${directPaths.length} file${directPaths.length === 1 ? "" : "s"}. Edit the declared slice now; no worker, worktree, reviewer, or roadmap was created.` }],
          details: { mode: "fast-path", runs: [], root: opened.active.root, paths: opened.active.paths },
        };
      }
      const availableAgents = [...executableAgents];
      const prepared = params.lanes.map((lane, index) => ({
        index,
        agent: String(lane.agent ?? "").trim(),
        purpose: String(lane.summary ?? "").trim(),
        originalObjective: latestUserRequest,
        originalTask: String(lane.task ?? "").trim(),
        lane: { ...lane },
        implementation: lane.executionMode === "implementation",
        executionMode: lane.executionMode === "implementation" ? "implementation" as const : "read-only" as const,
        ownedPaths: normalizedOwnedPathList(lane.ownedPaths),
        sourceCwd: typeof lane.cwd === "string" ? lane.cwd.trim() : "",
        preparedWorktreePath: typeof lane.worktreePath === "string" ? lane.worktreePath.trim() : "",
        baseRevision: typeof lane.baseRevision === "string" ? lane.baseRevision.trim() : "",
        integrationBaseRevision: "",
        integrationRoot: "",
        snapshot: undefined as CheckoutSnapshot | undefined,
        reviewRecord: undefined as Omit<ReviewRecord, "accepted"> | undefined,
        todoId: typeof lane.todoId === "number" && Number.isInteger(lane.todoId) ? lane.todoId : undefined,
        primaryValidation: asRecord(lane.primaryValidation) as unknown as PrimaryValidationTarget | undefined,
        checkpoint: typeof lane.checkpoint === "string" ? lane.checkpoint.trim() : "",
        continuationOf: "",
        continuationDepth: 0,
        progressFingerprint: "",
        checkpointRef: "",
        checkpointCommit: "",
        checkpointPatchDigest: "",
        checkpointChangedPaths: [] as string[],
        generatedContinuationWorktree: false,
        artifactPath: "",
        launchId: globalThis.crypto.randomUUID(),
        outcomeId: typeof lane.todoId === "number" && Number.isInteger(lane.todoId)
          ? `todo-${lane.todoId}`
          : `outcome-${globalThis.crypto.randomUUID()}`,
        binding: undefined as AgentLaunchBinding | undefined,
        budget: undefined as ReturnType<typeof workerExecutionBudget> | undefined,
        spawnAttempted: false,
        issue: undefined as string | undefined,
      }));

      await Promise.all(prepared.map(async (candidate) => {
        stripPerDispatchBudgets(candidate.lane);
        const continuationOf = typeof candidate.lane.continuationOf === "string" ? candidate.lane.continuationOf.trim() : "";
        candidate.continuationOf = continuationOf;
        delete candidate.lane.continuationOf;
        if (continuationOf) {
          const previous = mission?.attempts.find((attempt) => attempt.runId === continuationOf);
          if (!previous || (previous.status !== "partial" && previous.status !== "budget_exhausted") || !previous.partialHandoffPath) {
            candidate.issue = `continuationOf '${continuationOf}' is not a recorded partial or budget-exhausted run with a deterministic handoff.`;
            return;
          }
            candidate.outcomeId = previous.outcomeId ?? candidate.outcomeId;
          try {
            const handoff = JSON.parse(readFileSync(previous.partialHandoffPath, "utf8")) as PartialWorkerHandoff;
            if (handoff.version !== 3 || !handoff.checkpoint || typeof handoff.exactNextAction !== "string" || !handoff.exactNextAction.trim()) throw new Error("invalid versioned checkpoint handoff");
            const issue = continuationIssue({
              previous,
              handoff,
              priorFingerprints: mission?.attempts
                .filter((attempt) => attempt.runId !== previous.runId && attempt.outcomeId === previous.outcomeId)
                .flatMap((attempt) => attempt.progressFingerprint ? [attempt.progressFingerprint] : []) ?? [],
            });
            if (issue) throw new Error(issue);
            if (candidate.agent !== previous.agent || candidate.executionMode !== previous.executionMode) throw new Error("continuation must preserve the prior agent and execution mode");
            const binding = immutableResumeBinding(previous);
            if (!binding) throw new Error("prior run is missing its immutable model binding");
            if (!availableModelIds(ctx).map((model) => model.toLowerCase()).includes(binding.model.toLowerCase())) throw new Error(`configured continuation model '${binding.model}' is no longer authenticated and available`);
            candidate.binding = binding;
            candidate.originalObjective = handoff.originalObjective;
            candidate.originalTask = handoff.originalTask;
            candidate.continuationDepth = (previous.continuationDepth ?? 0) + 1;
            candidate.progressFingerprint = handoff.progressFingerprint;
            candidate.checkpointRef = handoff.checkpoint?.ref ?? "";
            candidate.checkpointCommit = handoff.checkpoint?.commit ?? "";
            candidate.checkpointPatchDigest = handoff.checkpoint?.patchDigest ?? "";
            candidate.checkpointChangedPaths = [...(handoff.checkpoint?.changedPaths ?? [])];
            candidate.ownedPaths = [...(previous.ownedPaths ?? handoff.ownedPaths)];
            candidate.primaryValidation = previous.primaryValidation;
            candidate.checkpoint = previous.checkpoint ?? candidate.checkpoint;
            candidate.lane.task = renderContinuationPrompt(handoff);
            if (candidate.implementation) {
              if (!previous.repository || !previous.baseRevision) throw new Error("prior implementation run is missing its exact repository or base revision");
              candidate.sourceCwd = previous.repository;
              candidate.lane.cwd = previous.repository;
              const canonicalPatch = realpathSync(handoff.checkpoint.patchPath);
              if (!statSync(canonicalPatch).isFile()
                || !trustedWorkerPatchPath(canonicalPatch, previous.runId, mission?.attempts.map((attempt) => attempt.runId) ?? [])) {
                throw new Error("prior implementation patch is missing or not tied to the exact mission run");
              }
              if (sha256(readFileSync(canonicalPatch)) !== handoff.checkpoint.patchDigest) throw new Error("prior implementation patch digest no longer matches its SHA-256 handoff");
              const verifiedBase = await pi.exec("git", ["-C", previous.repository, "rev-parse", `${handoff.checkpoint.baseRevision}^{commit}`], { cwd: ctx.cwd, timeout: 10_000 });
              const verifiedCheckpoint = await pi.exec("git", ["-C", previous.repository, "rev-parse", `${handoff.checkpoint.ref}^{commit}`], { cwd: ctx.cwd, timeout: 10_000 });
              if (verifiedBase.code !== 0 || verifiedBase.stdout.trim() !== handoff.checkpoint.baseRevision) throw new Error("checkpoint base revision is missing or has changed");
              if (verifiedCheckpoint.code !== 0 || verifiedCheckpoint.stdout.trim() !== handoff.checkpoint.commit) throw new Error("checkpoint ref no longer resolves to the promised commit");
              const checkpointPaths = await pi.exec("git", ["-C", previous.repository, "diff", "--name-only", handoff.checkpoint.baseRevision, handoff.checkpoint.commit], { cwd: ctx.cwd, timeout: 10_000 });
              const materializedPaths = checkpointPaths.stdout.split(/\r?\n/).filter(Boolean);
              if (checkpointPaths.code !== 0 || materializedPaths.length === 0
                || materializedPaths.some((path) => !ownedPathsOverlap(candidate.ownedPaths ?? [], [path]))) {
                throw new Error("checkpoint changed paths do not match the recorded ownership");
              }
              const conflict = mission?.attempts.find((attempt) => attempt.status === "running"
                && attempt.runId !== previous.runId
                && attempt.executionMode === "implementation"
                && attempt.repository === previous.repository
                && ownedPathsOverlap(attempt.ownedPaths ?? [], candidate.ownedPaths ?? []));
              if (conflict) throw new Error(`checkpoint ownership conflicts with active run '${conflict.runId}'`);
              const continuationRoot = resolve(homedir(), ".pi", "lemonpi", "continuation-worktrees");
              const continuationWorktree = resolve(continuationRoot, candidate.launchId);
              mkdirSync(continuationRoot, { recursive: true, mode: 0o700 });
              const created = await pi.exec("git", ["-C", previous.repository, "worktree", "add", "--detach", continuationWorktree, handoff.checkpoint.commit], { cwd: ctx.cwd, timeout: 30_000 });
              if (created.code !== 0) throw new Error(created.stderr || "could not create an isolated continuation worktree from the checkpoint");
              const firstDiff = await pi.exec("git", ["-C", continuationWorktree, "diff", "--name-only", handoff.checkpoint.baseRevision, "HEAD"], { cwd: ctx.cwd, timeout: 10_000 });
              if (firstDiff.code !== 0 || firstDiff.stdout.split(/\r?\n/).filter(Boolean).sort().join("\n") !== materializedPaths.sort().join("\n")) {
                await pi.exec("git", ["-C", previous.repository, "worktree", "remove", "--force", continuationWorktree], { cwd: ctx.cwd, timeout: 30_000 });
                throw new Error("continuation worktree did not physically materialize the promised prior diff");
              }
              candidate.generatedContinuationWorktree = true;
              candidate.preparedWorktreePath = continuationWorktree;
              candidate.baseRevision = handoff.checkpoint.commit;
              candidate.integrationBaseRevision = handoff.checkpoint.baseRevision;
              candidate.lane.cwd = continuationWorktree;
              candidate.lane.worktreePath = continuationWorktree;
              candidate.lane.baseRevision = candidate.baseRevision;
            }
          } catch (error) {
            candidate.issue = `Could not load continuation handoff for '${continuationOf}': ${error instanceof Error ? error.message : String(error)}`;
            return;
          }
        }
        const rawTask = typeof candidate.lane.task === "string" ? candidate.lane.task : "";
        if (availableAgents.length > 0 && !availableAgents.includes(candidate.agent)) {
          candidate.issue = `Agent '${candidate.agent}' is not in the live executable roster.`;
          return;
        }
        if (!candidate.binding) {
          const routing = runtimeLaunchBinding(candidate.agent, String(candidate.lane.cwd ?? ctx.cwd), ctx);
          if (!routing.binding) {
            candidate.issue = routing.error ?? `LemonPi settings could not resolve agent '${candidate.agent}'. No child was launched.`;
            return;
          }
          candidate.binding = routing.binding;
        }
        candidate.budget = workerExecutionBudget(candidate.agent, candidate.executionMode, userLemonPiSettings());
        if (candidate.todoId !== undefined && !visiblePlanTasks.some((task) => task.id === candidate.todoId && task.status !== "deleted" && task.status !== "completed")) {
          candidate.issue = `todoId ${candidate.todoId} is not an unfinished visible milestone.`;
          return;
        }
        if (candidate.preparedWorktreePath && !/^[0-9a-f]{7,64}$/i.test(candidate.baseRevision)) {
          candidate.issue = "Prepared worktree reuse requires a resolvable baseRevision so stale work cannot be dispatched.";
          return;
        }
        if (candidate.baseRevision && !candidate.preparedWorktreePath) {
          delete candidate.lane.baseRevision;
          candidate.baseRevision = "";
        }
        if (READ_ONLY_ROLE_NAMES.has(candidate.agent.toLowerCase()) && candidate.executionMode === "implementation") {
          candidate.issue = `Agent '${candidate.agent}' is read-only but this lane requires implementation. Choose a write-enabled agent before spending model tokens.`;
          return;
        }
        const summaryIssue = authoredWorkerSummaryIssue(candidate.lane.summary);
        if (summaryIssue) {
          candidate.issue = `Worker summary ${summaryIssue}. Add a user-facing purpose such as \"Repair remote settings layout\".`;
          return;
        }
        if (candidate.executionMode === "implementation") {
          if (!candidate.ownedPaths) {
            candidate.issue = "Implementation lanes need a non-empty ownedPaths array of exact repo-relative paths with no globs.";
            return;
          }
          const laneIssue = implementationLaneIssue({
            ownedPaths: candidate.ownedPaths,
            primaryValidation: candidate.primaryValidation,
            checkpoint: candidate.checkpoint,
          });
          if (laneIssue) {
            candidate.issue = laneIssue;
            return;
          }
          candidate.lane.task = `${String(candidate.lane.task ?? rawTask).trimEnd()}\nOwned paths: ${candidate.ownedPaths.join(", ")}\nPrimary validation: ${candidate.primaryValidation!.program} ${candidate.primaryValidation!.args.join(" ")}\nCheckpoint: ${candidate.checkpoint}`;
        } else if (Array.isArray(candidate.lane.ownedPaths) && candidate.lane.ownedPaths.length > 0) {
          candidate.issue = "Read-only lanes cannot claim writer ownership paths.";
          return;
        }
        candidate.lane.executionMode = candidate.executionMode;
        compileDelegationContracts(candidate.lane);
        const currentMission = ensureMission("planning");
        candidate.artifactPath = uniqueArtifactPath(currentMission.id, candidate.purpose || candidate.agent, currentMission.attempts.length + candidate.index + 1);
        candidate.lane.task = `${String(candidate.lane.task ?? "").trimEnd()}\nArtifact path: ${candidate.artifactPath}`;
        candidate.implementation = candidate.executionMode === "implementation";
        const task = String(candidate.lane.task ?? "");
        const justification = /^\s*review justification\s*:\s*(.+)$/im.exec(task)?.[1]?.trim();
        if (justification) {
          try {
            const snapshot = await inspectCheckoutSnapshot(pi, candidate.lane.cwd, ctx.cwd);
            const paths = normalizedOwnedPaths(task) ?? ["."];
            const diff = await pi.exec("git", ["-C", snapshot.root, "diff", snapshot.head, "--", ...paths], { cwd: ctx.cwd, timeout: 10_000 });
            candidate.reviewRecord = {
              repository: snapshot.root,
              revision: snapshot.head,
              diffHash: contentHash(diff.stdout),
              scope: paths,
              riskBoundary: justification,
            };
            const key = reviewLedgerKey(candidate.reviewRecord);
            const duplicate = reviewDeduplicationIssue(ensureMission("planning").reviews, candidate.reviewRecord);
            if (duplicate || activeReviewKeys.has(key)) {
              candidate.issue = duplicate ?? "An identical review boundary is already active.";
              return;
            }
          } catch (error) {
            candidate.issue = `Review preflight failed: ${error instanceof Error ? error.message : String(error)}`;
            return;
          }
        }
        const invalidAcceptancePath = invalidVerifiedAcceptancePath(candidate.lane);
        if (invalidAcceptancePath) {
          candidate.issue = `${invalidAcceptancePath}: verified acceptance requires a non-empty runtime verify command array.`;
          return;
        }
        if (candidate.implementation) {
          const ownedPaths = candidate.ownedPaths ?? normalizedOwnedPaths(String(candidate.lane.task ?? ""));
          if (!ownedPaths) {
            candidate.issue = "Implementation lanes need exact repo-relative Owned paths with no globs so their patches can be integrated independently.";
            return;
          }
          try {
            const checkoutTarget = candidate.preparedWorktreePath || candidate.sourceCwd || candidate.lane.cwd;
            candidate.snapshot = await inspectCheckoutSnapshot(pi, checkoutTarget, ctx.cwd);
            recordGitBaseline(candidate.snapshot);
            const commonDir = await pi.exec("git", ["-C", candidate.snapshot.root, "rev-parse", "--git-common-dir"], { cwd: ctx.cwd, timeout: 5_000 });
            if (commonDir.code !== 0 || !commonDir.stdout.trim()) throw new Error("The checkout's shared Git repository could not be verified.");
            const commonDirPath = commonDir.stdout.trim();
            candidate.integrationRoot = realpathSync(commonDirPath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(commonDirPath)
              ? commonDirPath
              : resolve(candidate.snapshot.root, commonDirPath));
            if (candidate.preparedWorktreePath) {
              const sourceTarget = candidate.sourceCwd || ctx.cwd;
              const sourceRoot = await pi.exec("git", ["-C", sourceTarget, "rev-parse", "--show-toplevel"], { cwd: ctx.cwd, timeout: 5_000 });
              if (sourceRoot.code !== 0 || !sourceRoot.stdout.trim()) throw new Error("The prepared worktree source repository could not be verified.");
              const worktrees = await pi.exec("git", ["-C", sourceTarget, "worktree", "list", "--porcelain"], { cwd: ctx.cwd, timeout: 5_000 });
              const canonicalPrepared = realpathSync(candidate.preparedWorktreePath);
              const registered = worktrees.code === 0 && worktrees.stdout.split(/\r?\n/)
                .filter((line) => line.startsWith("worktree "))
                .some((line) => {
                  try { return realpathSync(line.slice("worktree ".length).trim()) === canonicalPrepared; } catch { return false; }
                });
              if (!registered) throw new Error("The prepared worktree is not registered with the source repository.");
              if (candidate.baseRevision) {
                const canonicalBase = await pi.exec("git", ["-C", canonicalPrepared, "rev-parse", `${candidate.baseRevision}^{commit}`], { cwd: ctx.cwd, timeout: 5_000 });
                if (canonicalBase.code !== 0 || !canonicalBase.stdout.trim()) throw new Error(`Prepared worktree base '${candidate.baseRevision}' is not a valid local revision.`);
                candidate.baseRevision = canonicalBase.stdout.trim();
              }
              if (candidate.baseRevision && candidate.snapshot.head !== candidate.baseRevision) {
                throw new Error(`Prepared worktree HEAD ${candidate.snapshot.head} does not match requested base ${candidate.baseRevision}.`);
              }
              candidate.lane.cwd = canonicalPrepared;
              candidate.lane.reusePreparedWorktree = true;
            }
          } catch (error) {
            candidate.issue = error instanceof Error ? error.message : String(error);
            return;
          }
          const ownedDirtyEntries = candidate.generatedContinuationWorktree
            ? []
            : candidate.snapshot.dirtyEntries.filter((entry) => ownedPathsOverlap(candidate.ownedPaths ?? [], [statusEntryPath(entry)]));
          if (ownedDirtyEntries.length > 0) {
            candidate.issue = `The lane would overwrite pre-existing changes inside its owned paths (${ownedDirtyEntries.slice(0, 8).join("; ")}). Unrelated baseline changes remain allowed and untouched.`;
          }
        }
      }));

      for (let leftIndex = 0; leftIndex < prepared.length; leftIndex += 1) {
        const left = prepared[leftIndex]!;
        if (!left.implementation || !left.snapshot || left.issue) continue;
        const leftPaths = left.ownedPaths ?? normalizedOwnedPaths(String(left.lane.task ?? ""))!;
        for (let rightIndex = leftIndex + 1; rightIndex < prepared.length; rightIndex += 1) {
          const right = prepared[rightIndex]!;
          if (!right.implementation || !right.snapshot || right.issue || left.integrationRoot !== right.integrationRoot) continue;
          if (left.preparedWorktreePath && right.preparedWorktreePath
            && realpathSync(left.preparedWorktreePath) === realpathSync(right.preparedWorktreePath)) {
            const reason = "Concurrent implementation lanes cannot share one prepared worktree; give each lane its own registered worktree.";
            left.issue = reason;
            right.issue = reason;
            continue;
          }
          const overlap = ownedPathsOverlap(leftPaths, right.ownedPaths ?? normalizedOwnedPaths(String(right.lane.task ?? ""))!);
          if (!overlap) continue;
          const reason = `Writer ownership overlaps at ${overlap}; redraw these as one coherent lane or give them disjoint ownership.`;
          left.issue = reason;
          right.issue = reason;
        }
      }

      await Promise.all(prepared.filter((candidate) => candidate.issue && candidate.generatedContinuationWorktree && candidate.preparedWorktreePath && candidate.sourceCwd)
        .map(async (candidate) => {
          await pi.exec("git", ["-C", candidate.sourceCwd, "worktree", "remove", "--force", candidate.preparedWorktreePath], { cwd: ctx.cwd, timeout: 30_000 });
          candidate.generatedContinuationWorktree = false;
          candidate.preparedWorktreePath = "";
        }));

      for (const candidate of prepared) {
        if (candidate.issue) continue;
        if (candidate.snapshot) appendCheckoutSnapshot(candidate.lane, candidate.snapshot);
        candidate.lane.acceptance = false;
        applyDelegationSafetyContracts(candidate.lane);
      }

      const launchableCount = prepared.filter((candidate) => !candidate.issue).length;
      if (launchableCount > 0) {
        onUpdate({
          content: [{ type: "text", text: prepared.filter((candidate) => !candidate.issue).map((candidate) => {
            const policy = candidate.budget!;
            return `${candidate.agent}: limits ${policy.enabled ? `enabled by ${policy.source} (${policy.behavior})` : "disabled by default"}; model ${candidate.binding!.model}:${candidate.binding!.thinking}.`;
          }).join("\n") }],
          details: { limitPolicies: prepared.filter((candidate) => !candidate.issue).map((candidate) => ({ agent: candidate.agent, ...candidate.budget })) },
        });
        delegationLaunchesInFlight += launchableCount;
        lastDelegationLaunchAt = Date.now();
        missionWakeGeneration += 1;
      }
      const launched = await Promise.all(prepared.map(async (candidate) => {
        if (candidate.issue) return { ...candidate, result: undefined as unknown, runId: undefined as string | undefined };
        if (candidate.implementation) candidate.lane.subagentOnlyExtensions = [FINALIZATION_GUARD_PATH];
        const spawn = independentSpawnParams(candidate.lane).params;
        const binding = candidate.binding!;
        const budget = candidate.budget!;
        Object.assign(spawn, budget.spawn, { model: `${binding.model}:${binding.thinking}` });
        // Independent slices always start from concise fresh context. Bounded correction
        // continuity belongs exclusively to the guarded resume path below.
        spawn.context = "fresh";
        try {
          persistPendingLaunch({
            launchId: candidate.launchId,
            agent: candidate.agent,
            purpose: candidate.purpose,
            task: String(candidate.lane.task ?? ""),
            executionMode: candidate.executionMode,
            binding,
            startedAt: Date.now(),
          });
          candidate.spawnAttempted = true;
          const result = await requestSubagentSpawn(pi, spawn);
          const runId = delegationRunId(result);
          if (!runId) throw new Error("The subagent runtime acknowledged the lane without returning a run ID.");
          clearPendingLaunch(candidate.launchId);
          return { ...candidate, result, runId };
        } catch (error) {
          clearPendingLaunch(candidate.launchId);
          return {
            ...candidate,
            issue: error instanceof Error ? error.message : String(error),
            result: undefined as unknown,
            runId: undefined as string | undefined,
          };
        }
      }));

      const successes = launched.filter((candidate): candidate is typeof candidate & { runId: string } => Boolean(candidate.runId));
      const failures = launched.filter((candidate) => !candidate.runId);
      await Promise.all(failures.filter((candidate) => candidate.generatedContinuationWorktree && candidate.preparedWorktreePath && candidate.sourceCwd)
        .map(async (candidate) => {
          await pi.exec("git", ["-C", candidate.sourceCwd, "worktree", "remove", "--force", candidate.preparedWorktreePath], { cwd: ctx.cwd, timeout: 30_000 });
          candidate.generatedContinuationWorktree = false;
          candidate.preparedWorktreePath = "";
        }));
      for (const candidate of successes) {
        const runId = candidate.runId;
        independentDispatchRuns.add(runId);
        activeDelegationRuns.add(runId);
        activeDelegationWidths.set(runId, 1);
        if (candidate.implementation) activeWriterRuns.add(runId);
        if (candidate.reviewRecord) {
          activeReviewKeys.add(reviewLedgerKey(candidate.reviewRecord));
          reviewByRun.set(runId, candidate.reviewRecord);
        }
        const todo = candidate.todoId !== undefined ? visiblePlanTasks.find((task) => task.id === candidate.todoId) : undefined;
        ensureOutcome({
          id: candidate.outcomeId,
          subject: todo?.subject ?? candidate.purpose,
          status: "in_progress",
          detail: candidate.implementation ? "Implementation is running." : "Investigation is running.",
          ...(candidate.todoId !== undefined ? { todoId: candidate.todoId } : {}),
          runId,
          repository: candidate.integrationBaseRevision ? candidate.sourceCwd : candidate.snapshot?.root || candidate.sourceCwd || ctx.cwd,
          relevantPaths: candidate.ownedPaths,
        });
        if (candidate.todoId) void publishTodoLifecycle(candidate.todoId, "in_progress");
      }
      if (launchableCount > 0) {
        delegationLaunchesInFlight = Math.max(0, delegationLaunchesInFlight - launchableCount);
        lastDelegationLaunchAt = Date.now();
      }
      if (successes.length > 0) {
        writerOccupied = activeWriterRuns.size > 0;
        activeDelegationHandoffPending = true;
        const currentMission = ensureMission("delegated");
        for (const candidate of successes) {
          if (!currentMission.activeRunIds.includes(candidate.runId)) currentMission.activeRunIds.push(candidate.runId);
          currentMission.attempts.push({
            runId: candidate.runId,
            launchId: candidate.launchId,
            agent: candidate.agent,
            task: String(candidate.lane.task ?? ""),
            originalObjective: candidate.originalObjective,
            originalTask: candidate.originalTask,
            purpose: candidate.purpose,
            status: "running",
            executionMode: candidate.implementation ? "implementation" : "read-only",
            completedOrdinal: 0,
            sliceCount: 1,
            transcriptBytes: 0,
            tokens: 0,
            turns: 0,
            toolCalls: 0,
            startedAt: Date.now(),
            elapsedMs: 0,
            budgetPhase: "work",
            limitPolicy: candidate.budget,
            model: candidate.binding!.model,
            provider: candidate.binding!.provider,
            modelId: candidate.binding!.modelId,
            thinking: candidate.binding!.thinking,
            settingsSource: candidate.binding!.source,
            settingsHash: candidate.binding!.settingsHash,
            ...(candidate.todoId ? { todoId: candidate.todoId } : {}),
            outcomeId: candidate.outcomeId,
            ...(candidate.snapshot ? { repository: candidate.integrationBaseRevision ? candidate.sourceCwd : candidate.snapshot.root, baseRevision: candidate.integrationBaseRevision || candidate.snapshot.head } : {}),
            ...(!candidate.snapshot ? { repository: candidate.sourceCwd || ctx.cwd } : {}),
            ...(candidate.preparedWorktreePath
              ? { worktreePath: candidate.preparedWorktreePath }
              : candidate.implementation && candidate.snapshot
                ? { worktreePath: expectedManagedWorktreePath(candidate.snapshot.root, candidate.runId) }
                : {}),
            ...(candidate.ownedPaths ? { ownedPaths: [...candidate.ownedPaths] } : {}),
            ...(candidate.integrationBaseRevision ? { integrationBaseRevision: candidate.integrationBaseRevision } : {}),
            ...(candidate.checkpointRef ? { checkpointRef: candidate.checkpointRef } : {}),
            ...(candidate.checkpointCommit ? { checkpointCommit: candidate.checkpointCommit } : {}),
            ...(candidate.checkpointPatchDigest ? { checkpointPatchDigest: candidate.checkpointPatchDigest } : {}),
            ...(candidate.integrationBaseRevision ? { checkpointBaseRevision: candidate.integrationBaseRevision } : {}),
            ...(candidate.checkpointChangedPaths.length ? { checkpointChangedPaths: candidate.checkpointChangedPaths } : {}),
            ...(candidate.artifactPath ? { artifactPath: candidate.artifactPath } : {}),
            ...(candidate.implementation ? { integrationStatus: "pending" as const } : {}),
          });
          if (candidate.continuationOf && currentMission.pendingContinuations) {
            currentMission.pendingContinuations = currentMission.pendingContinuations.filter((pending) => pending.priorRunId !== candidate.continuationOf);
            if (currentMission.pendingContinuations.length === 0) delete currentMission.pendingContinuations;
          }
        }
        currentMission.writerActive = writerOccupied;
        currentMission.wakeAttempts = 0;
        persistMission();
      }

      if (successes.length === 0) {
        const launchFailures = failures.filter((candidate) => candidate.spawnAttempted);
        delegationFailurePending = launchFailures.length > 0;
        lastDelegationFailure = launchFailures.length > 0
          ? launchFailures.map((candidate) => `${candidate.agent}: ${candidate.issue ?? "launch failed"}`).join("\n").slice(0, 800)
          : undefined;
      } else {
        delegationFailurePending = false;
        lastDelegationFailure = undefined;
      }
      const summary = [
        successes.length > 0
          ? `Launched ${successes.length} independent async lane${successes.length === 1 ? "" : "s"}: ${successes.map((candidate) => `${candidate.agent} (${candidate.runId})`).join(", ")}.`
          : "No independent lane launched.",
        failures.length > 0
          ? `Deferred ${failures.length} lane${failures.length === 1 ? "" : "s"}: ${failures.map((candidate) => `${candidate.agent}: ${candidate.issue ?? "launch failed"}`).join("; ")}.`
          : "Each completion will be delivered independently.",
      ].join("\n");
      return {
        content: [{ type: "text", text: summary }],
        ...(successes.length === 0 ? { isError: true } : {}),
        details: {
          mode: "independent",
          runs: successes.map((candidate) => ({ runId: candidate.runId, agent: candidate.agent, implementation: candidate.implementation, todoId: candidate.todoId, model: candidate.binding!.model, thinking: candidate.binding!.thinking, settingsSource: candidate.binding!.source, settingsHash: candidate.binding!.settingsHash, budget: candidate.budget, manifest: { repository: candidate.snapshot?.root, worktreePath: candidate.preparedWorktreePath || undefined, baseRevision: candidate.snapshot?.head, ownedPaths: candidate.ownedPaths, artifactPath: candidate.artifactPath } })),
          failures: failures.map((candidate) => ({ agent: candidate.agent, reason: candidate.issue ?? "launch failed" })),
        },
      };
    },
  };
  pi.registerTool(fastPathTool);
  pi.registerTool(gitManagerTool);
  pi.registerTool(validationTool);
  pi.registerTool(ownershipExpansionTool);
  pi.registerTool(independentDispatchTool);

  const settleWriter = (status: WriterLifecycleStatus, runId?: string) => {
    if (status === "paused") return;
    if (runId) {
      terminalWriterRuns.delete(runId);
      activeWriterRuns.delete(runId);
    } else if (activeWriterRuns.size === 1) {
      const onlyRun = activeWriterRuns.values().next().value as string;
      terminalWriterRuns.delete(onlyRun);
      activeWriterRuns.delete(onlyRun);
    }
    writerOccupied = activeWriterRuns.size > 0;
    if (mission) {
      mission.writerActive = writerOccupied;
      if (mission.activeRunIds.length === 0 && mission.phase !== "paused") mission.phase = "integration";
      persistMission();
    }
  };

  pi.events.on("subagent:async-started", (payload) => {
    const runId = delegationRunId(payload);
    if (!runId) return;
    if (automaticTurnMayStart(automaticTurnAuthority)) runsStartedInThisSessionRuntime.add(runId);
    activeDelegationRuns.add(runId);
    if (!activeDelegationWidths.has(runId)) activeDelegationWidths.set(runId, 1);
    activeDelegationHandoffPending = true;
    const currentMission = ensureMission("delegated");
    if (!currentMission.activeRunIds.includes(runId)) currentMission.activeRunIds.push(runId);
    currentMission.wakeAttempts = 0;
    persistMission();
    integratedTerminalRuns.delete(terminalRunKey(delegationSessionId(payload), runId));
  });

  pi.events.on("subagent:async-complete", (payload) => {
    const runId = delegationRunId(payload);
    const liveCompletion = runId ? runsStartedInThisSessionRuntime.delete(runId) : false;
    if (liveCompletion) automaticTurnAuthority = "live-worker-event";
    if (runId) updateAttemptTelemetry(runId, payload);
    const independentlyDispatched = runId ? independentDispatchRuns.delete(runId) : false;
    if (runId) {
      activeDelegationRuns.delete(runId);
      activeDelegationWidths.delete(runId);
    }
    activeStatusChecksThisTurn.clear();
    activeDelegationHandoffPending = false;
    if (mission && runId) {
      mission.activeRunIds = mission.activeRunIds.filter((candidate) => candidate !== runId);
      if (mission.phase !== "paused") mission.phase = "integration";
      mission.wakeAttempts = 0;
      persistMission();
    }
    const status = writerLifecycleStatus(payload);
    if (runId && status) {
      terminalWriterRuns.set(runId, status);
      if (terminalWriterRuns.size > 64) terminalWriterRuns.delete(terminalWriterRuns.keys().next().value!);
      if (activeWriterRuns.has(runId)) settleWriter(status, runId);
      if (status !== "paused") {
        const root = asRecord(payload);
        const sessionId = delegationSessionId(payload);
        const agent = typeof root?.agent === "string" ? root.agent : undefined;
        if (isManuallyStoppedRun(runId)) void wakeForTerminalRun(runId, sessionId, status, agent, false, payload);
        else if (independentlyDispatched && root?.intercomDelivered !== true) queueIndependentCompletion({ runId, sessionId, status, agent, evidence: payload });
        else if (root?.intercomDelivered === true) void wakeForTerminalRun(runId, sessionId, status, agent, false, payload);
        else {
          void recordTerminalAttempt(runId, status, payload);
          rememberTerminalRun(terminalRunKey(sessionId, runId));
        }
      }
    }
    const failure = delegationFailure(payload, false);
    const authoritativeAttempt = runId ? mission?.attempts.find((attempt) => attempt.runId === runId) : undefined;
    if (failure && (!authoritativeAttempt || authoritativeAttempt.status === "failed")) {
      delegationFailurePending = true;
      const classification = classifyFailure(failure);
      lastDelegationFailure = `Classification: ${classification}\nRecovery: ${recoveryAction(classification, 0)}\n${failure}`;
    } else if (authoritativeAttempt && authoritativeAttempt.status !== "failed") {
      delegationFailurePending = false;
      lastDelegationFailure = undefined;
    }
  });

  pi.on("before_agent_start", async (event) => {
    if (!shouldInjectMainPiOperatingManual(process.env)) return;
    mainAgentRunning = true;
    mainTurnSettled = false;
    missionWakeGeneration += 1;
    if (event.prompt.startsWith(MISSION_INTEGRATION) || event.prompt.startsWith(PLAN_CONTINUATION)) {
      missionWakeQueued = false;
    }
    return {
      systemPrompt: buildMainPiSystemPrompt(event.systemPrompt, attentionRecovery),
    };
  });

  pi.on("input", async (event, ctx) => {
    if (event.source !== "rpc") return { action: "continue" };

    const isSteerRequest = event.text.startsWith(SUBAGENT_STEER_PREFIX);
    const isStopRequest = event.text.startsWith(SUBAGENT_STOP_PREFIX);
    const isTerminalRequest = event.text.startsWith(SUBAGENT_TERMINAL_PREFIX);
    const isMainStopRequest = event.text.startsWith(MAIN_AGENT_STOP_PREFIX);
    if (!isSteerRequest && !isStopRequest && !isTerminalRequest && !isMainStopRequest) {
      automaticTurnAuthority = "user-input";
      return { action: "continue" };
    }

    if (isMainStopRequest) {
      restoreReconcileGeneration += 1;
      if (restoreWakeTimer) {
        clearTimeout(restoreWakeTimer);
        restoreWakeTimer = undefined;
      }
      activeStatusChecksThisTurn.clear();
      activeDelegationHandoffPending = false;
      delegationFailurePending = false;
      delegationRepairRequested = false;
      attentionRepairRequested = false;
      closingRepairAttempts = 0;
      planContinuationAttempts = 0;
      activeFastPath = undefined;
      if (mission) {
        mission.phase = "paused";
        mission.wakeAttempts = 0;
        if (remainingPlanTask) mission.remainingTask = { ...remainingPlanTask };
        persistMission();
      }
      return { action: "handled" };
    }

    try {
      const prefix = isSteerRequest ? SUBAGENT_STEER_PREFIX : isStopRequest ? SUBAGENT_STOP_PREFIX : SUBAGENT_TERMINAL_PREFIX;
      const payload = JSON.parse(event.text.slice(prefix.length)) as {
        runId?: unknown;
        index?: unknown;
        message?: unknown;
        sessionId?: unknown;
        status?: unknown;
        agent?: unknown;
        force?: unknown;
      };
      const runId = typeof payload.runId === "string" ? payload.runId.trim() : "";
      if (!/^[A-Za-z0-9-]{4,128}$/.test(runId)) {
        throw new Error(`The subagent ${isSteerRequest ? "steering" : isStopRequest ? "stop" : "completion"} request was malformed.`);
      }

      if (isSteerRequest) {
        const index = typeof payload.index === "number" ? payload.index : -1;
        const message = typeof payload.message === "string" ? payload.message.trim() : "";
        if (!Number.isInteger(index) || index < 0 || !message || message.length > 4_000) {
          throw new Error("The subagent steering request was malformed.");
        }
        await requestSubagentSteer(pi, runId, index, message);
      } else if (isStopRequest) {
        manuallyStoppedRuns.add(runId);
        const stoppedAttempt = mission?.attempts.find((attempt) => attempt.runId === runId);
        const provenance: WorkerStopProvenance = {
          cause: "user",
          initiator: "lemonpi-user-control",
          initiatingRunId: runId,
          reason: "Explicit user stop request.",
          requestedAt: Date.now(),
        };
        if (stoppedAttempt) stoppedAttempt.stopProvenance = provenance;
        if (stoppedAttempt && !stoppedAttempt.runtimeDirectory) {
          try {
            const status = await requestSubagentStatus(pi, runId);
            updateAttemptTelemetry(runId, status);
          } catch { /* Mission provenance and the stop RPC remain authoritative. */ }
        }
        if (stoppedAttempt) writeStopProvenanceArtifact(stoppedAttempt, provenance);
        if (mission) {
          mission.suppressedRunIds = [...new Set([...(mission.suppressedRunIds ?? []), runId])].slice(-64);
          persistMission();
        }
        try {
          await requestSubagentStop(pi, runId, provenance);
          if (stoppedAttempt?.todoId) void publishTodoLifecycle(stoppedAttempt.todoId, "pending");
        } catch (error) {
          manuallyStoppedRuns.delete(runId);
          if (mission) {
            mission.suppressedRunIds = (mission.suppressedRunIds ?? []).filter((candidate) => candidate !== runId);
            persistMission();
          }
          throw error;
        }
      } else {
        const status = payload.status === "complete" || payload.status === "completed"
          ? "completed"
          : payload.status === "failed" || payload.status === "rejected"
            ? "failed"
            : payload.status === "stopped"
              ? "stopped"
              : undefined;
        const sessionId = typeof payload.sessionId === "string" && payload.sessionId.length <= 4_096
          ? payload.sessionId
          : undefined;
        const agent = typeof payload.agent === "string" && payload.agent.length <= 200
          ? payload.agent
          : undefined;
        const force = payload.force === true;
        if (!status) throw new Error("The subagent completion request was malformed.");
        activeDelegationRuns.delete(runId);
        activeDelegationWidths.delete(runId);
        activeStatusChecksThisTurn.clear();
        activeDelegationHandoffPending = false;
        if (mission) {
          mission.activeRunIds = mission.activeRunIds.filter((candidate) => candidate !== runId);
          mission.writerActive = false;
          if (mission.phase !== "paused") mission.phase = "integration";
          mission.wakeAttempts = 0;
          persistMission();
        }
        await wakeForTerminalRun(runId, sessionId, status, agent, force);
      }
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    }
    return { action: "handled" };
  });

  pi.on("tool_call", async (event, ctx) => {
    if (process.env.PI_SUBAGENT_CHILD === "1") return;

    const input = event.input as Record<string, unknown>;
    if (!activeFastPath && likelyFastPathRequest(latestUserRequest)) {
      uiExplorationToolCalls += 1;
      const guardrailReached = Date.now() - requestStartedAt >= 5 * 60_000 || uiExplorationToolCalls > 12;
      const inputPaths = normalizedOwnedPathList(input.paths) ?? [];
      const confirmedPaths = normalizedOwnedPathList(input.confirmedPaths) ?? [];
      const completedGitCwd = typeof input.cwd === "string" && input.cwd ? input.cwd : ctx.cwd;
      const completedGitFinalization = event.toolName === "lemonpi_git" && (
        ((input.action === "commit" || input.action === "checkpoint")
          && completedFastPathMatches(completedGitCwd, inputPaths))
        || (input.action === "resolve_conflicts_to_head"
          && completedFastPathRepositoryMatches(completedGitCwd)
          && inputPaths.length > 0
          && inputPaths.length === confirmedPaths.length
          && inputPaths.every((path) => confirmedPaths.includes(path)))
      );
      const orchestrationDetour = event.toolName === "todo"
        || event.toolName === "subagent"
        || event.toolName === "subagent_wait"
        || event.toolName === "lemonpi_dispatch"
        || (event.toolName === "lemonpi_git" && input.action !== "inspect" && !completedGitFinalization)
        || (event.toolName === "lemonpi_validate" && input.scope !== "focused");
      if (guardrailReached && orchestrationDetour) {
        return {
          block: true,
          reason: "This ordinary UI request has reached LemonPi's implementation guardrail. Stop adding orchestration, workers, worktrees, reviews, or broad validation. Open lemonpi_fast_path for the exact UI files and make the visible edit now; if the files cannot be identified safely, ask one concrete blocking question.",
        };
      }
    }
    if (event.toolName === "todo") {
      const protectedIds = new Set((mission?.attempts ?? []).flatMap((attempt) => attempt.todoId ? [attempt.todoId] : []));
      const action = typeof input.action === "string" ? input.action : "";
      const targetId = typeof input.id === "number" ? input.id : typeof input.todoId === "number" ? input.todoId : undefined;
      const deletesProtected = action === "clear"
        ? protectedIds.size > 0
        : (action === "delete" || (action === "update" && input.status === "deleted")) && targetId !== undefined && protectedIds.has(targetId);
      if (deletesProtected) {
        return {
          block: true,
          reason: "Mission todo history is append-only. Update the original milestone's lifecycle status and append a correction or superseding item; do not delete the worker record.",
        };
      }
    }
    if (event.toolName === "lemonpi_git" && input.action === "integrate_worktree" && !Array.isArray(input.paths) && Array.isArray(input.confirmedPaths)) {
      input.paths = input.confirmedPaths;
    }
    if (["lemonpi_dispatch", "lemonpi_git", "lemonpi_validate", "lemonpi_fast_path"].includes(event.toolName)) {
      const signature = `${event.toolName}:${typeof input.action === "string" ? input.action : "execute"}`;
      const failures = internalContractFailures.get(signature) ?? 0;
      if (internalContractFallback(failures) === "fallback") {
        if (event.toolName === "lemonpi_git" && input.action === "integrate_worker_result" && typeof input.artifactRunId === "string") {
          const attempt = mission?.attempts.find((candidate) => candidate.runId === input.artifactRunId);
          if (attempt?.worktreePath && attempt.ownedPaths?.length) {
            input.action = "integrate_worktree";
            input.worktreePath = attempt.worktreePath;
            input.paths = [...attempt.ownedPaths];
            input.message = `LemonPi: integrate ${attempt.purpose}`.slice(0, 120);
            internalContractCalls.set(event.toolCallId, "lemonpi_git:integrate_worktree");
            return;
          }
        }
        return {
          block: true,
          reason: `${signature} has failed twice for this mission. LemonPi blocked a third negotiation. Preserved work remains authoritative; use the runtime-named bounded fallback or report the infrastructure blocker without repeating completed work.`,
        };
      }
      internalContractCalls.set(event.toolCallId, signature);
    }
    if (event.toolName === "subagent_wait") {
      return {
        block: true,
        reason: "LemonPi keeps Main Pi interruptible while background workers run. Do not wait inside this turn. Give the user a concise status update and end the turn; the worker remains active, completion will wake Main Pi, and any new user message can be answered immediately and used to steer the worker.",
      };
    }
    const isShellTool = ["bash", "shell"].includes(event.toolName);
    const isManagedPatchIntegration = isShellTool && isManagedWorktreePatchCommand(input);
    if (MAIN_MUTATION_TOOLS.has(event.toolName) && activeFastPath) {
      const rawPath = [input.path, input.filePath, input.file_path].find((value) => typeof value === "string") as string | undefined;
      const target = rawPath ? resolve(activeFastPath.root, rawPath) : "";
      const allowed = activeFastPath.paths.some((owned) => target === resolve(activeFastPath!.root, owned));
      if (!allowed) {
        return {
          block: true,
          reason: "The fast path permits Main Pi to edit only its exact declared UI files. Finish this slice or declare a separate scoped path.",
        };
      }
      activeFastPath.firstMutationAt ??= Date.now();
      if (activeFastPath.firstMutationAt - activeFastPath.startedAt > 5 * 60_000) {
        ctx.ui.notify("LemonPi latency guardrail exceeded: first visible implementation took more than five minutes.", "warning");
      }
      return;
    }
    if (MAIN_MUTATION_TOOLS.has(event.toolName) || (isShellTool && shellMutatesProject(input) && !isManagedPatchIntegration)) {
      return {
        block: true,
        reason: "Main Pi may mutate project files only inside an active lemonpi_fast_path slice. Use that for one-repository low-risk UI work; delegate only broader or risk-bearing implementation.",
      };
    }
    if (event.toolName !== "subagent") return;

    const isManagementAction = typeof input.action === "string" && input.action.trim().length > 0;
    if (input.action === "list") rosterToolCalls.add(event.toolCallId);
    if (input.action === "status") {
      const target = typeof input.id === "string" ? input.id : typeof input.runId === "string" ? input.runId : undefined;
      const key = target ?? "__active_runs__";
      if (shouldSuppressStatusPoll(activeDelegationHandoffPending, input.action) || activeStatusChecksThisTurn.has(key)) {
        return {
          block: true,
          reason: "Delegated work is already confirmed active. Do not poll any run again in this user turn. Give one concise progress update and end the turn so the completion or needs-attention event can wake Main Pi.",
        };
      }
      statusToolCalls.set(event.toolCallId, { key, ...(target ? { target } : {}) });
    }
    if (input.action === "resume") {
      const forbiddenOverride = launchOverridePath(input);
      if (forbiddenOverride) {
        return { block: true, reason: `LemonPi rejected ${forbiddenOverride} before resume. A resumed run preserves its original model and thinking binding; no child was launched.` };
      }
      const message = typeof input.message === "string" ? input.message.trimEnd() : "";
      const authoredSummary = workerSummaryFromTask(message);
      const summaryIssue = authoredWorkerSummaryIssue(authoredSummary);
      if (summaryIssue) {
        return {
          block: true,
          reason: `Reviving a worker requires a fresh \"Worker summary: ...\" line that ${summaryIssue}. Retry the same resume with the current purpose in eight words or fewer so Command Center can update the worker card.`,
        };
      }
      const summary = normalizeWorkerSummary(authoredSummary, message);
      const previousRunId = typeof input.id === "string" ? input.id.trim() : typeof input.runId === "string" ? input.runId.trim() : "";
      const previousAttempt = mission?.attempts.find((attempt) => attempt.runId === previousRunId);
      if (!previousAttempt) {
        return {
          block: true,
          reason: "This worker has no current-policy lifecycle record. Launch a fresh bounded lane with a concise handoff instead of reviving a legacy or unrelated session.",
        };
      }
      const originalBinding = immutableResumeBinding(previousAttempt);
      if (!previousAttempt.task || !originalBinding) {
        return { block: true, reason: "This worker predates immutable LemonPi model/thinking metadata. Launch a fresh bounded lane from user settings; no child was launched." };
      }
      const correction = /(?:^|\n)\s*correction for (?:the )?(?:immediately )?previous slice\s*:/i.test(message);
      try {
        const status = await requestSubagentStatus(pi, previousRunId);
        updateAttemptTelemetry(previousRunId, status);
        const disposition = subagentStatusDisposition(status);
        if (disposition === "completed") {
          previousAttempt.status = "completed";
          mission!.lastCompletedRunId = previousRunId;
          persistMission();
        }
      } catch {
        return {
          block: true,
          reason: "LemonPi could not inspect the previous worker's current session metrics. Launch a fresh bounded worker instead of risking another bloated or stale resume.",
        };
      }
      const resumeIssue = resumeWorkerIssue({
        run: previousAttempt,
        lastCompletedRunId: mission?.lastCompletedRunId,
        purpose: summary,
        correction,
        limits: workerContextLimits(process.env),
      });
      if (resumeIssue) {
        return {
          block: true,
          reason: `${resumeIssue} Preserve valid output and launch a fresh worker for unrelated or oversized work.`,
        };
      }
      const canonicalMessage = message.replace(
        /^\s*worker summary\s*:.*$/im,
        `Worker summary: ${summary}`,
      );
      const targetedMessage = SLICE_TARGET.test(canonicalMessage) ? canonicalMessage : `${canonicalMessage}\nSlice target: under 5 minutes`.trimStart();
      const compiledMessage = targetedMessage;
      input.message = compiledMessage;
      const binding = originalBinding;
      const launchId = globalThis.crypto.randomUUID();
      resumeToolCalls.set(event.toolCallId, {
        launchId,
        implementation: declaredExecutionMode(compiledMessage) === "implementation",
        previousRunId,
        purpose: summary,
        sliceCount: previousAttempt.sliceCount + 1,
        binding,
        task: previousAttempt.task,
        agent: binding.agent,
        repository: previousAttempt.repository,
        outcomeId: previousAttempt.outcomeId,
      });
      const currentMission = ensureMission("delegated");
      currentMission.wakeAttempts = 0;
      persistPendingLaunch({ launchId, agent: binding.agent, purpose: summary, task: previousAttempt.task, executionMode: previousAttempt.executionMode, binding, startedAt: Date.now() });
    }
    if (attentionRecovery && ["status", "steer", "stop"].includes(String(input.action ?? ""))) {
      const target = typeof input.id === "string" ? input.id : typeof input.runId === "string" ? input.runId : "";
      if (!target || attentionRecovery.runId.startsWith(target) || target.startsWith(attentionRecovery.runId)) {
        attentionActionObserved = true;
      }
    }
    let specs = delegatedSpecs(input);
    const isDelegation = specs.length > 0;

    if (isDelegation && !isManagementAction) {
      const forbiddenOverride = launchOverridePath(input);
      if (forbiddenOverride) {
        return { block: true, reason: `LemonPi rejected ${forbiddenOverride} before launch. Direct child model and thinking overrides are forbidden; user settings are authoritative and zero children were started.` };
      }
      stripPerDispatchBudgets(input);
      const groupedIssue = groupedDelegationPolicyIssue(input);
      if (groupedIssue) return { block: true, reason: groupedIssue };
      compileDelegationContracts(input);
      specs = delegatedSpecs(input);
      const writers = specs.filter(delegatesImplementation);
      if (writers.length > 0) {
        return {
          block: true,
          reason: "Implementation must be launched through lemonpi_dispatch, even for one lane. It creates a separately completable isolated worktree run so Main Pi can integrate it without blocking or conflicting with other workers.",
        };
      }

      const invalidAcceptancePath = invalidVerifiedAcceptancePath(input);
      if (invalidAcceptancePath) {
        return {
          block: true,
          reason: `LemonPi blocked ${invalidAcceptancePath}: verified acceptance requires at least one runtime command such as { id: "build", command: "pnpm build", timeoutMs: 120000 }. Commands written in the worker task or reported by the worker do not satisfy this gate. Add acceptance.verify commands, or omit acceptance so Main Pi owns validation. No worker was launched.`,
        };
      }

      const parallelWriterIssue = parallelWriterPolicyIssue(input);
      if (parallelWriterIssue) {
        return {
          block: true,
          reason: parallelWriterIssue,
        };
      }
      if (specs.length === 1 && writers.length === 0) {
        const mode = "read-only" as const;
        const routing = runtimeLaunchBinding(specs[0]!.agent, typeof input.cwd === "string" ? input.cwd : ctx.cwd, ctx);
        if (!routing.binding) return { block: true, reason: routing.error ?? "LemonPi settings could not resolve this agent. No child was launched." };
        const binding = routing.binding;
        const budget = workerExecutionBudget(specs[0]!.agent, mode, userLemonPiSettings());
        Object.assign(input, budget.spawn, { model: `${binding.model}:${binding.thinking}` });
        ctx.ui.notify(`${specs[0]!.agent}: limits ${budget.enabled ? `enabled by ${budget.source} (${budget.behavior})` : "disabled by default"}; model ${binding.model}:${binding.thinking}.`, "info");
        const launchId = globalThis.crypto.randomUUID();
        const purpose = normalizeWorkerSummary(workerSummaryFromTask(specs[0]!.task), specs[0]!.task);
        delegationAttemptMetadata.set(event.toolCallId, {
          launchId,
          agent: specs[0]!.agent,
          task: specs[0]!.task,
          purpose,
          executionMode: mode,
          repository: typeof input.cwd === "string" ? input.cwd : ctx.cwd,
          startedAt: Date.now(),
          binding,
          limitPolicy: budget,
        });
      }
      if (writers.length > 0) {
        const directWriterRecords = directImplementationRecords(input);
        const crossRepositoryWave = input.worktree !== true
          && directWriterRecords.length > 1
          && directWriterRecords.every((record) => typeof record.cwd === "string" && record.cwd.trim());
        if (crossRepositoryWave) {
          const inspections = await Promise.allSettled(
            directWriterRecords.map((record) => inspectCheckoutSnapshot(pi, record.cwd, ctx.cwd)),
          );
          const issues: Array<string | undefined> = inspections.map((result) => result.status === "rejected"
            ? `Checkout inspection failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`
            : undefined);

          const indexesByRoot = new Map<string, number[]>();
          inspections.forEach((result, index) => {
            if (result.status !== "fulfilled") return;
            const indexes = indexesByRoot.get(result.value.root) ?? [];
            indexes.push(index);
            indexesByRoot.set(result.value.root, indexes);
          });
          for (const [root, indexes] of indexesByRoot) {
            if (indexes.length < 2) continue;
            indexes.forEach((index) => {
              issues[index] = `Declared cross-repository cwd resolves to the same Git repository (${root}); this lane needs a same-repository worktree wave.`;
            });
          }

          inspections.forEach((result, index) => {
            if (result.status !== "fulfilled" || issues[index]) return;
            issues[index] = checkoutSnapshotPolicyIssue(directWriterRecords[index]!, result.value);
          });
          const selection = workConservingLaneSelection(issues);
          if (selection.launchIndexes.length === 0) {
            return {
              block: true,
              reason: `No implementation lane passed fresh checkout preflight:\n- ${selection.deferred.map(({ index, reason }) => `${conciseTaskSummary(String(directWriterRecords[index]?.task ?? "worker lane"))}: ${reason}`).join("\n- ")}`,
            };
          }

          selection.launchIndexes.forEach((index) => {
            const result = inspections[index]!;
            if (result.status === "fulfilled") appendCheckoutSnapshot(directWriterRecords[index]!, result.value);
          });
          if (selection.deferred.length > 0) {
            retainWorkConservingLanes(input, directWriterRecords, selection);
            const deferred = selection.deferred.map(({ index, reason }) =>
              `${conciseTaskSummary(String(directWriterRecords[index]?.task ?? "worker lane"))}: ${reason}`,
            );
            deferredWriterLanesByToolCall.set(event.toolCallId, deferred);
            ctx.ui.notify(
              `Launching ${selection.launchIndexes.length} ready implementation worker${selection.launchIndexes.length === 1 ? "" : "s"}; deferred ${deferred.length} blocked lane${deferred.length === 1 ? "" : "s"} without suppressing valid work.`,
              "warning",
            );
          }
        } else {
          let checkoutSnapshot: CheckoutSnapshot;
          try {
            checkoutSnapshot = await inspectCheckoutSnapshot(pi, input.cwd, ctx.cwd);
          } catch (error) {
            return {
              block: true,
              reason: `LemonPi could not verify the target checkout immediately before dispatch: ${error instanceof Error ? error.message : String(error)} No implementation worker was launched.`,
            };
          }
          const checkoutIssue = checkoutSnapshotPolicyIssue(input, checkoutSnapshot);
          if (checkoutIssue) return { block: true, reason: checkoutIssue };
          appendCheckoutSnapshot(input, checkoutSnapshot);
        }
      }
      const currentMission = ensureMission("delegated");
      currentMission.wakeAttempts = 0;
      persistMission();
      if (writers.length > 0 && input.clarify !== true) {
        writerToolCalls.set(event.toolCallId, { agent: writers[0]?.agent ?? "writer", async: input.async !== false });
      }

      input.acceptance = false;
      applyDelegationSafetyContracts(input);
      const launchMetadata = delegationAttemptMetadata.get(event.toolCallId);
      if (launchMetadata) persistPendingLaunch({
        launchId: launchMetadata.launchId,
        agent: launchMetadata.agent,
        purpose: launchMetadata.purpose,
        task: launchMetadata.task,
        executionMode: launchMetadata.executionMode,
        binding: launchMetadata.binding,
        startedAt: launchMetadata.startedAt,
      });
    }

    // pi-subagents supports async natively. LemonPi supplies the product-level
    // default while preserving an explicit foreground request for true gates.
    if (isDelegation && !isManagementAction && input.async === undefined && input.clarify !== true) {
      input.async = true;
    }
    if (isDelegation && !isManagementAction) {
      delegationToolCalls.add(event.toolCallId);
      delegationLaunchWidths.set(
        event.toolCallId,
        Math.max(1, directConcurrentDelegationSpecs(input).length),
      );
      delegationFailurePending = false;
      lastDelegationFailure = undefined;
    }
    if ((isDelegation && !isManagementAction) || input.action === "resume") {
      delegationLaunchToolCalls.add(event.toolCallId);
      delegationLaunchesInFlight += 1;
      lastDelegationLaunchAt = Date.now();
      missionWakeGeneration += 1;
    }
  });

  pi.on("message_start", async (event) => {
    const message = event.message as typeof event.message & {
      customType?: string;
      details?: { event?: { runId?: unknown; index?: unknown; to?: unknown } };
    };
    const notification = visibleText(message.content);
    if (event.message.role === "assistant") currentAssistantVisibleText = notification;
    if (event.message.role === "user" && message.customType == null) {
      const continuingMission = Boolean(remainingPlanTask || missionHasOwnedWork() || mission?.outcomes.some((outcome) => outcome.status !== "completed"));
      if (!continuingMission) {
        activeFastPath = undefined;
        if (mission && mission.phase !== "paused") {
          mission.phase = "complete";
          persistMission();
        }
      }
      activeStatusChecksThisTurn.clear();
      activeDelegationHandoffPending = false;
      sawToolActivity = false;
      visibleExplanationAfterLastTool = false;
      lastAssistantStopReason = undefined;
      delegationRepairRequested = false;
      closingRepairAttempts = 0;
      planContinuationAttempts = 0;
      delegationFailurePending = false;
      lastDelegationFailure = undefined;
      internalContractCalls.clear();
      uiExplorationToolCalls = 0;
      latestUserRequest = notification;
      requestStartedAt = Date.now();
      currentAssistantVisibleText = "";
      if (attentionRecovery) attentionRepairRequested = false;
    }
    if (typeof message.customType === "string"
      && message.customType.startsWith("lemonpi-mission-")
      && message.customType !== MISSION_OUTCOME_ENTRY) {
      sawToolActivity = false;
      visibleExplanationAfterLastTool = false;
      lastAssistantStopReason = undefined;
      delegationRepairRequested = false;
      closingRepairAttempts = 0;
    }
    if (message.customType === "subagent_control_notice" && message.details?.event?.to === "needs_attention") {
      const runId = typeof message.details.event.runId === "string" ? message.details.event.runId.trim() : "";
      const index = typeof message.details.event.index === "number" && Number.isInteger(message.details.event.index)
        ? message.details.event.index
        : undefined;
      if (runId) {
        activeStatusChecksThisTurn.clear();
        activeDelegationHandoffPending = false;
        attentionRecovery = { runId, ...(index !== undefined ? { index } : {}) };
        attentionActionObserved = false;
        attentionRepairRequested = false;
      }
    }
    if (message.customType === "subagent-notify") {
      const notifiedRunId = delegationRunId(message);
      if (notifiedRunId) {
        activeDelegationRuns.delete(notifiedRunId);
        activeDelegationWidths.delete(notifiedRunId);
      }
      activeStatusChecksThisTurn.clear();
      activeDelegationHandoffPending = false;
      if (mission) {
        if (notifiedRunId) mission.activeRunIds = mission.activeRunIds.filter((candidate) => candidate !== notifiedRunId);
        if (mission.phase !== "paused") mission.phase = "integration";
        mission.wakeAttempts = 0;
        persistMission();
      }
      const workerStatus = writerNotificationStatus(notification, undefined);
      if (workerStatus) settleWriter(workerStatus, notifiedRunId);
      sawToolActivity = false;
      visibleExplanationAfterLastTool = false;
      lastAssistantStopReason = undefined;
      delegationRepairRequested = false;
      closingRepairAttempts = 0;
      delegationFailurePending = /^(Background task|Detached foreground task) failed:/m.test(notification);
      lastDelegationFailure = delegationFailurePending ? notification.slice(0, 800) : undefined;
    }
  });

  pi.on("message_update", async (event) => {
    if (event.message.role === "assistant") currentAssistantVisibleText = visibleText(event.message.content);
  });

  pi.on("message_end", async (event) => {
    if (event.message.role !== "assistant") return;
    currentAssistantVisibleText = visibleText(event.message.content);
    visibleExplanationAfterLastTool = Boolean(currentAssistantVisibleText);
    lastAssistantStopReason = event.message.stopReason;
  });

  pi.on("tool_execution_start", async () => {
    activeMainToolExecutions += 1;
    mainAgentRunning = true;
    mainTurnSettled = false;
    missionWakeGeneration += 1;
    sawToolActivity = true;
    visibleExplanationAfterLastTool = false;
  });

  pi.on("tool_execution_end", async (event) => {
    activeMainToolExecutions = Math.max(0, activeMainToolExecutions - 1);
    const contractSignature = internalContractCalls.get(event.toolCallId);
    internalContractCalls.delete(event.toolCallId);
    if (contractSignature) {
      if (event.isError) internalContractFailures.set(contractSignature, Math.min(2, (internalContractFailures.get(contractSignature) ?? 0) + 1));
      else internalContractFailures.delete(contractSignature);
      if (mission) {
        mission.contractFailures = Object.fromEntries(internalContractFailures);
        persistMission();
      }
    }
    if (event.toolName === "todo" && !event.isError) {
      const tasks = visibleRoadmapTasksFromTodoResult(event.result);
      if (tasks) {
        visiblePlanTasks = tasks;
        if (mission) {
          for (const outcome of mission.outcomes) {
            const linked = outcome.todoId !== undefined ? tasks.find((task) => task.id === outcome.todoId) : undefined;
            if (linked) outcome.subject = linked.subject.slice(0, 160);
          }
          persistMission();
        }
      }
    }
    if (rosterToolCalls.delete(event.toolCallId) && !event.isError) {
      executableAgents.clear();
      executableAgentNames(event.result).forEach((agent) => executableAgents.add(agent));
    }
    const resumedCall = resumeToolCalls.get(event.toolCallId);
    resumeToolCalls.delete(event.toolCallId);
    if (resumedCall) clearPendingLaunch(resumedCall.launchId);
    if (resumedCall && !event.isError) {
      const runId = delegationRunId(event.result);
      if (runId) {
        activeDelegationRuns.add(runId);
        activeDelegationWidths.set(runId, 1);
        const currentMission = ensureMission("delegated");
        if (!currentMission.activeRunIds.includes(runId)) currentMission.activeRunIds.push(runId);
        currentMission.attempts.push({
          runId,
          launchId: resumedCall.launchId,
          agent: resumedCall.agent,
          task: resumedCall.task,
          ...(resumedCall.repository ? { repository: resumedCall.repository } : {}),
          purpose: resumedCall.purpose,
          status: "running",
          executionMode: resumedCall.implementation ? "implementation" : "read-only",
          completedOrdinal: 0,
          sliceCount: resumedCall.sliceCount,
          transcriptBytes: 0,
          tokens: 0,
          turns: 0,
          toolCalls: 0,
          startedAt: Date.now(),
          elapsedMs: 0,
          budgetPhase: "work",
          model: resumedCall.binding.model,
          thinking: resumedCall.binding.thinking,
          settingsSource: resumedCall.binding.source,
          settingsHash: resumedCall.binding.settingsHash,
          ...(resumedCall.outcomeId ? { outcomeId: resumedCall.outcomeId } : {}),
        });
        if (resumedCall.outcomeId) {
          ensureOutcome({ id: resumedCall.outcomeId, subject: resumedCall.purpose, status: "in_progress", detail: "Correction is running.", runId });
        }
        if (resumedCall.implementation) {
          writerOccupied = true;
          activeWriterRuns.add(runId);
          currentMission.writerActive = true;
        }
        currentMission.wakeAttempts = 0;
        persistMission();
      }
      activeDelegationHandoffPending = true;
    }
    const statusCall = statusToolCalls.get(event.toolCallId);
    const wasStatusCall = statusToolCalls.delete(event.toolCallId);
    if (wasStatusCall) {
      const disposition = event.isError ? "unknown" : subagentStatusDisposition(event.result);
      if (disposition === "active" || disposition === "needs_attention") activeStatusChecksThisTurn.add(statusCall!.key);
      if (disposition === "active") activeDelegationHandoffPending = true;
      if (disposition === "needs_attention") activeDelegationHandoffPending = false;
      const status = disposition === "completed" || disposition === "failed" || disposition === "paused" || disposition === "stopped"
        ? disposition
        : writerLifecycleStatus(event.result) ?? (event.isError ? "failed" : undefined);
      const runId = delegationRunId(event.result) ?? statusCall?.target;
      if (runId && !event.isError) updateAttemptTelemetry(runId, event.result);
      if (status && status !== "paused") {
        if (runId) await recordTerminalAttempt(runId, status, event.result);
        if (runId) {
          activeDelegationRuns.delete(runId);
          activeDelegationWidths.delete(runId);
        }
        activeStatusChecksThisTurn.clear();
        activeDelegationHandoffPending = false;
        if (mission) {
          if (runId) mission.activeRunIds = mission.activeRunIds.filter((candidate) => candidate !== runId && !candidate.startsWith(runId) && !runId.startsWith(candidate));
          if (mission.phase !== "paused") mission.phase = "integration";
          mission.writerActive = false;
          mission.wakeAttempts = 0;
          persistMission();
        }
        if (writerOccupied) settleWriter(status, runId);
      }
    }
    if (event.toolName === "todo" && !event.isError) {
      const plan = remainingPlanFromTodoResult(event.result);
      if (plan) {
        const nextTask = plan.task;
        if (nextTask?.id !== remainingPlanTask?.id || nextTask?.status !== remainingPlanTask?.status) {
          planContinuationAttempts = 0;
        }
        remainingPlanTask = nextTask;
        if (nextTask) {
          const currentMission = ensureMission(missionHasOwnedWork() ? "delegated" : "planning");
          currentMission.remainingTask = { ...nextTask };
          currentMission.wakeAttempts = 0;
        } else if (mission) {
          delete mission.remainingTask;
          if (mission.activeRunIds.length === 0 && mission.phase === "planning" && mission.outcomes.every((outcome) => outcome.status === "completed")) mission.phase = "complete";
        }
        persistMission();
      }
    }
    if (delegationLaunchToolCalls.delete(event.toolCallId)) {
      delegationLaunchesInFlight = Math.max(0, delegationLaunchesInFlight - 1);
      lastDelegationLaunchAt = Date.now();
    }
    const writerCall = writerToolCalls.get(event.toolCallId);
    writerToolCalls.delete(event.toolCallId);
    const deferredWriterLanes = deferredWriterLanesByToolCall.get(event.toolCallId) ?? [];
    deferredWriterLanesByToolCall.delete(event.toolCallId);
    const launchWidth = delegationLaunchWidths.get(event.toolCallId) ?? 1;
    delegationLaunchWidths.delete(event.toolCallId);
    if (!delegationToolCalls.delete(event.toolCallId)) return;
    const attemptMetadata = delegationAttemptMetadata.get(event.toolCallId);
    delegationAttemptMetadata.delete(event.toolCallId);
    if (attemptMetadata) clearPendingLaunch(attemptMetadata.launchId);
    const failure = writerCall && writerCall.async !== false
      ? asyncWriterLaunchFailure(event.result, event.isError)
      : delegationFailure(event.result, event.isError);
    if (!failure) {
      const runId = delegationRunId(event.result);
      if (runId) {
        activeDelegationRuns.add(runId);
        activeDelegationWidths.set(runId, launchWidth);
        if (deferredWriterLanes.length > 0) deferredWriterLanesByRun.set(runId, deferredWriterLanes);
        activeDelegationHandoffPending = true;
        const currentMission = ensureMission("delegated");
        if (!currentMission.activeRunIds.includes(runId)) currentMission.activeRunIds.push(runId);
        if (attemptMetadata && !currentMission.attempts.some((attempt) => attempt.runId === runId)) {
          currentMission.attempts.push({
            runId,
            launchId: attemptMetadata.launchId,
            agent: attemptMetadata.agent,
            task: attemptMetadata.task,
            originalObjective: latestUserRequest,
            originalTask: attemptMetadata.task,
            purpose: attemptMetadata.purpose,
            status: "running",
            executionMode: attemptMetadata.executionMode,
            repository: attemptMetadata.repository,
            completedOrdinal: 0,
            sliceCount: 1,
            transcriptBytes: 0,
            tokens: 0,
            turns: 0,
            toolCalls: 0,
            startedAt: attemptMetadata.startedAt,
            elapsedMs: 0,
            budgetPhase: "work",
            limitPolicy: attemptMetadata.limitPolicy,
            primaryValidation: candidate.primaryValidation,
            checkpoint: candidate.checkpoint,
            ...(candidate.continuationOf ? { continuationOf: candidate.continuationOf, continuationDepth: candidate.continuationDepth, progressFingerprint: candidate.progressFingerprint } : {}),
            model: attemptMetadata.binding.model,
            thinking: attemptMetadata.binding.thinking,
            settingsSource: attemptMetadata.binding.source,
            settingsHash: attemptMetadata.binding.settingsHash,
          });
        }
        currentMission.wakeAttempts = 0;
        persistMission();
      } else if (mission) {
        if (mission.phase !== "paused") mission.phase = "integration";
        mission.wakeAttempts = 0;
        persistMission();
      }
      if (writerCall?.async === false) {
        settleWriter("completed");
      } else if (writerCall && runId) {
        writerOccupied = true;
        activeWriterRuns.add(runId);
        const currentMission = ensureMission("delegated");
        currentMission.writerActive = true;
        currentMission.wakeAttempts = 0;
        persistMission();
        const terminalStatus = terminalWriterRuns.get(runId);
        if (terminalStatus) settleWriter(terminalStatus, runId);
      }
      return;
    }
    if (writerCall) {
      settleWriter("failed");
    }
    if (mission) {
      if (mission.phase !== "paused") mission.phase = "integration";
      mission.wakeAttempts = 0;
      persistMission();
    }
    delegationFailurePending = true;
    const classification = classifyFailure(failure);
    lastDelegationFailure = `Classification: ${classification}\nRecovery: ${recoveryAction(classification, 0)}\n${failure}`;
  });

  pi.on("agent_settled", async (_event, ctx) => {
    mainAgentRunning = false;
    mainTurnSettled = true;
    flushPassiveCustomMessages();
    if (!automaticTurnMayStart(automaticTurnAuthority)) return;
    const intentionallyStopped = lastAssistantStopReason === "aborted" || lastAssistantStopReason === "error";
    const strandedPlanTask = remainingPlanTask;
    const ownedWorkActive = missionHasOwnedWork();
    if (intentionallyStopped && mission) {
      mission.phase = "paused";
      if (remainingPlanTask) mission.remainingTask = { ...remainingPlanTask };
      persistMission();
    }
    const contextUsage = ctx.getContextUsage();
    if (!intentionallyStopped && !proactiveCompactionInFlight && contextUsage?.percent != null && contextUsage.percent >= 72) {
      proactiveCompactionInFlight = true;
      missionWakeGeneration += 1;
      ctx.compact({
        customInstructions: "Preserve the user's decisions, the complete visible todo roadmap and statuses, delegated run IDs and terminal results, exact Git/worktree/artifact state, validation evidence, and the next concrete integration action. Remove repeated status narration and stale polling history.",
        onComplete: () => {
          proactiveCompactionInFlight = false;
          if (ctx.hasPendingMessages() || mainAgentRunning || missionHasOwnedWork()) return;
          if (delegationFailurePending) {
            delegationRepairRequested = true;
            delegationFailurePending = false;
            pi.sendMessage(
              { customType: "lemonpi-post-compaction-recovery", content: `${DELEGATION_RECOVERY}\n\nLast failure:\n${lastDelegationFailure ?? "No structured failure reason was provided."}`, display: false },
              { deliverAs: "followUp", triggerTurn: true },
            );
          } else if (attentionRecovery) {
            pi.sendMessage(
              { customType: "lemonpi-post-compaction-attention", content: `${ATTENTION_RECOVERY}\n\nTarget run: ${attentionRecovery.runId}`, display: false },
              { deliverAs: "followUp", triggerTurn: true },
            );
          } else if (missionNeedsMain()) {
            void requestMissionWake(mission?.phase === "integration" ? "integration" : "plan");
          } else if (sawToolActivity && !visibleExplanationAfterLastTool) {
            pi.sendMessage(
              { customType: "lemonpi-post-compaction-close", content: CLOSING_REPAIR, display: false },
              { deliverAs: "followUp", triggerTurn: true },
            );
          }
        },
        onError: () => {
          proactiveCompactionInFlight = false;
        },
      });
      return;
    }
    if (attentionRecovery && !attentionActionObserved && !attentionRepairRequested && !intentionallyStopped) {
      attentionRepairRequested = true;
      pi.sendMessage(
        {
          customType: "lemonpi-attention-recovery",
          content: `${ATTENTION_RECOVERY}\n\nTarget run: ${attentionRecovery.runId}${attentionRecovery.index !== undefined ? `\nTarget child index: ${attentionRecovery.index}` : ""}`,
          display: false,
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
      return;
    }
    if (attentionRecovery && attentionActionObserved) {
      attentionRecovery = undefined;
      attentionActionObserved = false;
      attentionRepairRequested = false;
    }
    if (delegationFailurePending && !intentionallyStopped && !delegationRepairRequested) {
      delegationRepairRequested = true;
      delegationFailurePending = false;
      pi.sendMessage(
        {
          customType: "lemonpi-delegation-recovery",
          content: `${DELEGATION_RECOVERY}\n\nLast failure:\n${lastDelegationFailure ?? "No structured failure reason was provided."}`,
          display: false,
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
      return;
    }
    if (shouldWakeForPlanContinuation({
      hasRemainingTask: Boolean(strandedPlanTask),
      activeDelegationCount: ownedWorkActive ? 1 : 0,
      writerOccupied: ownedWorkActive,
      intentionallyStopped,
      attempts: planContinuationAttempts,
    }) && strandedPlanTask) {
      const currentMission = ensureMission("planning");
      currentMission.remainingTask = { ...strandedPlanTask };
      if (await requestMissionWake("plan")) {
        planContinuationAttempts += 1;
        return;
      }
    }
    if (mission?.phase === "integration" && !ownedWorkActive && !intentionallyStopped) {
      if (visibleExplanationAfterLastTool && !delegationFailurePending && !attentionRecovery && !remainingPlanTask && mission.outcomes.every((outcome) => outcome.status === "completed")) {
        mission.phase = "complete";
        mission.wakeAttempts = 0;
        persistMission();
      } else if (await requestMissionWake("integration")) {
        return;
      }
    }
    if (!sawToolActivity || visibleExplanationAfterLastTool || intentionallyStopped || closingRepairAttempts >= 2) return;

    closingRepairAttempts += 1;
    pi.sendMessage(
      {
        customType: "lemonpi-narration-repair",
        content: CLOSING_REPAIR,
        display: false,
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  });
}
