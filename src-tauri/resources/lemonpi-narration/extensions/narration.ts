import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { statSync } from "node:fs";
import {
  checkpointBlocker,
  classifyFailure,
  classifyDirtyTree,
  contentHash,
  CURRENT_ORCHESTRATION_POLICY_VERSION,
  ORCHESTRATION_POLICY_NOTICE,
  recommendedReasoning,
  recoveryAction,
  reviewDeduplicationIssue,
  reviewLedgerKey,
  resumeWorkerIssue,
  supersedeHistoricalPolicy,
  uniqueArtifactPath,
  validationActivityLabel,
  validationDeduplicationIssue,
  workerContextLimits,
  workerStatusMetrics,
  type ReviewRecord,
  type ValidationRecord,
  type WorkerAttempt,
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
          model: { type: "string", description: "Optional model override for this lane." },
          skill: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }, { type: "boolean" }] },
          acceptance: {},
        },
        required: ["agent", "summary", "task"],
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
    action: { type: "string", enum: ["inspect", "checkpoint", "commit", "create_branch", "switch_branch", "apply_patch", "create_worktree", "remove_worktree", "cherry_pick"] },
    cwd: { type: "string" },
    paths: { type: "array", items: { type: "string" } },
    missionPaths: { type: "array", items: { type: "string" } },
    branch: { type: "string" },
    message: { type: "string" },
    patch: { type: "string" },
    revision: { type: "string" },
    worktreePath: { type: "string" },
  },
  required: ["action", "cwd"],
  additionalProperties: false,
} as const;

const ValidationSchema = {
  type: "object",
  properties: {
    cwd: { type: "string" },
    program: { type: "string" },
    args: { type: "array", items: { type: "string" } },
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

const ORCHESTRATION_CONTRACT = `
<lemonpi-orchestration>
You are Main Pi, the read-only supervisor and integration owner. You do not implement project changes yourself. Optimize for wall-clock delivery time by seeing the complete path to done, dispatching every dependency-ready lane immediately, reacting to each result as it arrives, and keeping useful work flowing until the outcome is verified.

Independent dispatch is the default:

1. Before meaningful execution, spend only a brief pass mapping the whole outcome graph: implementation, investigation, UX, platform, validation preparation, integration, and any material review boundary. Look several steps ahead. A later-step lane may start now whenever its inputs are already stable.
2. Use \`lemonpi_dispatch\` for every implementation lane and whenever two or more read-only lanes are ready, with one lane per independent outcome. Every lane must include a concrete \`summary\` of eight words or fewer describing that worker's purpose for the user; never use runner boilerplate, role names, or generic phrases. Every \`subagent resume\` message must likewise include a fresh \`Worker summary: ...\` line describing the revived worker's current purpose in eight words or fewer; update it even when continuing the same broad task. LemonPi launches every lane as a separate async run, not as a grouped subagent job. Each child completion wakes Main Pi independently, so inspect and integrate that result immediately while siblings continue. Refill newly-ready work without waiting for the original set to finish.
3. A direct single read-only delegation is appropriate only when exactly one useful read-only lane is ready. There is no numerical quota: never manufacture agents, but never serialize independent work for convenience, superficial file overlap, a dirty checkout, or because the first lane is easiest to describe.
4. Grouped \`subagent.tasks\` and chains are exceptional. Use them only when the user needs one atomic aggregate result whose partial child results are not independently actionable. Ordinary parallel research, implementation, review, and validation are independent lanes.
5. Choose agents from the live roster by capability, including custom user agents. Call \`subagent({ action: "list" })\` once when the roster is not already known and role choice matters, then reuse it. Use planners, designers, scouts, context builders, reviewers, or other specialists when their output changes a real decision; do not create ceremonial diversity or default every task to worker/planner/reviewer.
6. Give each lane one coherent checkpoint outcome, its scope, its done condition, and exact \`Owned paths:\` for implementation. LemonPi compiles execution mode, safety, and acceptance. Keep assignments concise; five minutes is a decomposition aspiration, not a timeout or a mechanical prompt-length gate.
7. Main Pi owns local Git through \`lemonpi_git\`. Inspect and classify every dirty path; checkpoint safe intentional work on a local recovery branch; ask one focused question for suspicious or ambiguous paths; never discard user data, force an operation, alter a remote, or push. Once clean and recoverable, use managed worktrees for disjoint writers, apply accepted artifacts, verify exact staged paths, and create logical local integration commits as slices land.
8. Independent review is reserved for explicit review requests or material security, privacy, money, migration, cryptography, concurrency, public-protocol, or release risk. Include one concrete \`Review justification:\` boundary. LemonPi deduplicates accepted reviews by repository, revision, diff, scope, and risk. Routine chunks and post-correction checks are reviewed directly by Main Pi.
9. Run tests through \`lemonpi_validate\`: focused validation per slice, one broader run per integration wave, and one final holistic run. Its persistent ledger prevents identical unchanged commands and emits heartbeat progress for long-running checks. Never set model-authored timeout, turn, tool, or usage budgets and never call \`subagent_wait\`.
10. Resume only the immediately preceding worker for a bounded correction, declared with \`Correction for previous slice:\` and a fresh \`Worker summary:\`. Unrelated, completed, failed-empty, wrong-mode, oversized, or repeatedly reused sessions get a fresh worker and concise structured handoff.
11. Main Pi alone asks the user clarifying questions. For multi-subsystem work, make the visible todo a real epic with distinct outcome milestones, dependencies, every active lane, validation, failures/recovery, and accepted-milestone progress. Update scope expansion immediately; never leave one broad parent item spinning while hidden slices finish.

Main Pi may inspect and search, and it may use only the deterministic \`lemonpi_git\` and \`lemonpi_validate\` tools for project mutation and validation. It may not author project files. For read-only user requests, do not launch implementation.
</lemonpi-orchestration>`;

const CLOSING_REPAIR = `The previous response ended after tool activity without a visible closing explanation. Do not call more tools. Give the user a concise, specific closing explanation now: state the outcome, what changed, what was verified, and any blocker or next step. If the task is incomplete, say exactly where it stopped and why.`;
const DELEGATION_RECOVERY = `A delegated run failed and no replacement delegation was launched before the turn settled. Own the failure now: inspect the exact status/error and any partial output, identify whether the cause was a parent-imposed timeout, unavailable model/tool, configuration problem, or task failure, preserve valid partial work, and re-delegate only the next bounded chunk with a concise corrected outcome. LemonPi will compile the mechanical execution and checklist fields. For a parallel worktree wave, inspect parallelHandoff.path before retrying: integrate independently successful, in-scope patches and retry only failed or conflicting lanes, never the entire wave. If a legacy completion guard says a read-only child made no edits, treat that as a classification error: recover and use its valid artifact instead of rerunning completed work. Shrink genuinely failed tasks instead of adding a per-dispatch timeout, turn budget, tool budget, or usage budget. If the error says the model produced no output or returned an empty response, do not resume the bloated failed session: salvage concrete transcript findings and launch a fresh-context replacement with a smaller question and explicit deliverable. If retrying cannot help because the blocker is external, give the user the exact blocker and the evidence instead of claiming recovery.`;
const ATTENTION_RECOVERY = `A delegated run reported needs_attention and the previous response did not inspect or control it. Act now instead of narrating passive waiting. Use the subagent status/transcript controls for the exact run. If it remains alive without an active tool or new output, steer it once to return its result or blocker immediately. If intervention cannot be delivered, stop it and preserve useful transcript findings for one fresh, smaller replacement. Do not leave it marked running indefinitely and do not launch a competing writer.`;
const PLAN_CONTINUATION = `Your visible task plan still contains unfinished work, but you settled with no delegated agent active. Continue the stranded plan now instead of waiting for another user message. Give the user a concise visible update, then execute or delegate the next bounded action. If the task is genuinely blocked or waiting for the user, move it out of in-progress state and explain the exact blocker; never leave an idle task spinning.`;
const MISSION_INTEGRATION = `A durable LemonPi mission has delegated results waiting for Main Pi, but no child is active. Inspect the exact terminal run and integrate its result now. If more work remains, dispatch the next bounded lane in this turn. If the mission is complete or blocked, give the user a concrete explanation instead of leaving it idle.`;
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

function requestSubagentRpc<T>(
  pi: ExtensionAPI,
  method: "spawn" | "status" | "steer" | "stop",
  params: Record<string, unknown>,
  timeoutMs = SUBAGENT_RPC_TIMEOUT_MS,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const requestId = globalThis.crypto.randomUUID();
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout>;
    const unsubscribe = pi.events.on(`${SUBAGENT_RPC_REPLY_PREFIX}${requestId}`, (payload) => {
      const reply = payload as { requestId?: string; success?: boolean; data?: T; error?: { message?: string } };
      if (reply.requestId !== requestId || settled) return;
      settled = true;
      clearTimeout(timeoutId);
      unsubscribe();
      if (reply.success === true) resolve(reply.data as T);
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

function requestSubagentSteer(pi: ExtensionAPI, id: string, index: number, message: string): Promise<void> {
  return requestSubagentRpc<void>(pi, "steer", { id, index, message });
}

function requestSubagentStop(pi: ExtensionAPI, id: string): Promise<void> {
  return requestSubagentRpc<void>(pi, "stop", { id });
}

function requestSubagentStatus(pi: ExtensionAPI, id?: string): Promise<unknown> {
  return requestSubagentRpc<unknown>(pi, "status", id ? { id } : {}, RESTORE_STATUS_RPC_TIMEOUT_MS);
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
const EXPLICIT_READ_ONLY_TASK = /\b(?:execution mode:\s*read[- ]only|read[- ]only|no code changes|do not (?:edit|write|modify)|without (?:editing|writing|modifying)|plan only|report only|analysis only)\b/i;
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
  dirtyEntries: string[];
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

function inferredExecutionMode(agent: string, task: string): "read-only" | "implementation" {
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
    && inferredExecutionMode(record.agent, typeof record.task === "string" ? record.task : "") === "implementation"
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
      const mode = inferredExecutionMode(record.agent, originalTask);
      if (record.thinking === undefined) record.thinking = recommendedReasoning(record.agent, originalTask);
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

  if (implementation) {
    return {
      implementation: true,
      params: {
        tasks: [prepared],
        concurrency: 1,
        worktree: true,
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
  return {
    root,
    head,
    dirtyEntries: status.stdout.split(/\r?\n/).filter((line) => line.trim().length > 0),
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
  const lifecycle = writerLifecycleStatus(root) ?? writerLifecycleStatus(details);
  if (lifecycle) return lifecycle;
  const rawState = typeof root.state === "string" ? root.state : typeof details?.state === "string" ? details.state : undefined;
  const rawActivity = typeof root.activityState === "string" ? root.activityState : typeof details?.activityState === "string" ? details.activityState : undefined;
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
}): boolean {
  return input.mainAgentRunning || input.activeToolExecutions > 0 || input.wakeQueued;
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

const MISSION_ENTRY = "lemonpi-mission-state";
type MissionPhase = "planning" | "delegated" | "integration" | "complete" | "paused";

interface MissionState {
  version: 2;
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
  lastCompletedRunId?: string;
  validations: ValidationRecord[];
  reviews: ReviewRecord[];
}

export function parsedMissionState(value: unknown): MissionState | undefined {
  const record = asRecord(value);
  if ((record?.version !== 1 && record?.version !== 2)
    || typeof record.id !== "string"
    || !["planning", "delegated", "integration", "complete", "paused"].includes(String(record.phase))
    || typeof record.request !== "string"
    || !Array.isArray(record.activeRunIds)
    || !record.activeRunIds.every((runId) => typeof runId === "string")
    || typeof record.writerActive !== "boolean"
    || !Number.isInteger(record.wakeAttempts)
    || typeof record.updatedAt !== "number") return undefined;
  const remaining = asRecord(record.remainingTask);
  const attempts = Array.isArray(record.attempts)
    ? record.attempts.map(asRecord).filter((attempt): attempt is Record<string, unknown> => Boolean(attempt))
      .filter((attempt) => typeof attempt.runId === "string"
        && typeof attempt.purpose === "string"
        && ["running", "completed", "failed", "stopped"].includes(String(attempt.status)))
      .slice(-64)
      .map((attempt) => ({
        runId: String(attempt.runId).slice(0, 128),
        purpose: String(attempt.purpose).slice(0, 96),
        status: attempt.status as WorkerAttempt["status"],
        executionMode: attempt.executionMode === "implementation" ? "implementation" as const : "read-only" as const,
        completedOrdinal: Number.isInteger(attempt.completedOrdinal) ? Number(attempt.completedOrdinal) : 0,
        sliceCount: Number.isInteger(attempt.sliceCount) ? Math.max(1, Number(attempt.sliceCount)) : 1,
        transcriptBytes: typeof attempt.transcriptBytes === "number" ? Math.max(0, attempt.transcriptBytes) : 0,
        tokens: typeof attempt.tokens === "number" ? Math.max(0, attempt.tokens) : 0,
        ...(attempt.emptyOutput === true ? { emptyOutput: true } : {}),
        ...(attempt.corrupted === true ? { corrupted: true } : {}),
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
  return {
    version: 2,
    policyVersion: CURRENT_ORCHESTRATION_POLICY_VERSION,
    ...((record.policyVersion ?? 0) !== CURRENT_ORCHESTRATION_POLICY_VERSION
      ? { migratedFromPolicyVersion: typeof record.policyVersion === "number" ? record.policyVersion : 0 }
      : {}),
    id: record.id.slice(0, 128),
    phase: record.phase as MissionPhase,
    request: record.request.slice(0, 500),
    activeRunIds: [...new Set(record.activeRunIds.map((runId) => runId.slice(0, 128)))],
    activeRunWidths,
    writerActive: record.writerActive,
    wakeAttempts: Math.max(0, Math.min(3, record.wakeAttempts as number)),
    updatedAt: record.updatedAt,
    attempts,
    validations,
    reviews,
    ...(typeof record.lastCompletedRunId === "string" ? { lastCompletedRunId: record.lastCompletedRunId.slice(0, 128) } : {}),
    ...(remainingTask ? { remainingTask } : {}),
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
  let writerOccupied = false;
  let attentionRecovery: { runId: string; index?: number } | undefined;
  let attentionActionObserved = false;
  let attentionRepairRequested = false;
  let remainingPlanTask: RemainingPlanTask | undefined;
  let planContinuationAttempts = 0;
  let mission: MissionState | undefined;
  let mainAgentRunning = false;
  let activeMainToolExecutions = 0;
  let missionWakeQueued = false;
  let lastMissionWakeAt = 0;
  let missionWakeCheck: Promise<boolean> | undefined;
  let missionWakeGeneration = 0;
  let restoreWakeTimer: ReturnType<typeof setTimeout> | undefined;
  let restoreReconcileGeneration = 0;
  const activeDelegationRuns = new Set<string>();
  const delegationToolCalls = new Set<string>();
  const delegationLaunchWidths = new Map<string, number>();
  const activeDelegationWidths = new Map<string, number>();
  const activeWriterRuns = new Set<string>();
  const independentDispatchRuns = new Set<string>();
  const pendingIndependentCompletions = new Map<string, {
    runId: string;
    sessionId?: string;
    status: Exclude<WriterLifecycleStatus, "paused">;
    agent?: string;
  }>();
  let independentCompletionTimer: ReturnType<typeof setTimeout> | undefined;
  const statusToolCalls = new Map<string, { key: string; target?: string }>();
  const activeStatusChecksThisTurn = new Set<string>();
  const resumeToolCalls = new Map<string, { implementation: boolean; previousRunId: string; purpose: string; sliceCount: number }>();
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
  let visiblePlanTaskCount = 0;
  let acceptedPlanTaskCount = 0;

  const persistMission = () => {
    if (!mission) return;
    mission.updatedAt = Date.now();
    pi.appendEntry<MissionState>(MISSION_ENTRY, {
      ...mission,
      activeRunIds: [...mission.activeRunIds],
      activeRunWidths: Object.fromEntries(
        [...activeDelegationRuns].map((runId) => [runId, activeDelegationWidths.get(runId) ?? 1]),
      ),
      ...(mission.remainingTask ? { remainingTask: { ...mission.remainingTask } } : {}),
    });
  };

  const ensureMission = (phase: MissionPhase): MissionState => {
    if (!mission || mission.phase === "complete" || mission.phase === "paused") {
      mission = {
        version: 2,
        policyVersion: CURRENT_ORCHESTRATION_POLICY_VERSION,
        id: globalThis.crypto.randomUUID(),
        phase,
        request: latestUserRequest.slice(0, 500),
        activeRunIds: [],
        writerActive: false,
        wakeAttempts: 0,
        updatedAt: Date.now(),
        attempts: [],
        validations: [],
        reviews: [],
        ...(remainingPlanTask ? { remainingTask: { ...remainingPlanTask } } : {}),
      };
    } else {
      mission.phase = phase;
      if (latestUserRequest) mission.request = latestUserRequest.slice(0, 500);
    }
    return mission;
  };

  const recordTerminalAttempt = (runId: string, status: Exclude<WriterLifecycleStatus, "paused">) => {
    if (!mission) return;
    const attempt = [...mission.attempts].reverse().find((candidate) => candidate.runId === runId);
    if (!attempt) return;
    attempt.status = status === "completed" ? "completed" : status === "stopped" ? "stopped" : "failed";
    attempt.completedOrdinal = Math.max(0, ...mission.attempts.map((candidate) => candidate.completedOrdinal)) + 1;
    mission.lastCompletedRunId = runId;
    const review = reviewByRun.get(runId);
    if (review) {
      const key = reviewLedgerKey(review);
      activeReviewKeys.delete(key);
      reviewByRun.delete(runId);
      if (status === "completed" && !reviewDeduplicationIssue(mission.reviews, review)) {
        mission.reviews.push({ ...review, accepted: true });
      }
    }
    persistMission();
  };

  const missionNeedsMain = () => Boolean(mission
    && mission.phase !== "complete"
    && mission.phase !== "paused"
    && (mission.phase === "integration" || mission.remainingTask));

  const missionHasOwnedWork = () => missionHasActiveOwnership({
    activeDelegationCount: activeDelegationRuns.size,
    recordedRunCount: mission?.activeRunIds.length ?? 0,
    writerOccupied,
    recordedWriterActive: mission?.writerActive ?? false,
  });

  const requestMissionWake = (reason: "plan" | "integration"): Promise<boolean> => {
    if (missionWakeCheck) return Promise.resolve(false);
    if (!mission || missionWakeIsBlocked({ mainAgentRunning, activeToolExecutions: activeMainToolExecutions, wakeQueued: missionWakeQueued })) return Promise.resolve(false);
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
      if (missionWakeIsBlocked({ mainAgentRunning, activeToolExecutions: activeMainToolExecutions, wakeQueued: missionWakeQueued })) return false;
      if (missionHasOwnedWork() || !missionNeedsMain()) return false;
      if (lastAssistantStopReason === "aborted" || lastAssistantStopReason === "error") return false;
      if (mission.wakeAttempts >= 3) {
        mission.phase = "paused";
        persistMission();
        return false;
      }
      const now = Date.now();
      if (now - lastMissionWakeAt < 4_000) return false;
      mission.wakeAttempts += 1;
      persistMission();
      lastMissionWakeAt = now;
      const resolvedReason = mission.phase === "integration" ? "integration" : reason;
      const task = mission.remainingTask;
      const content = resolvedReason === "integration"
        ? MISSION_INTEGRATION
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

    for (const item of terminal) wakeForTerminalRun(item.runId, undefined, item.status);
    if (intervention?.needsAttention && intervention.runId) {
      attentionRecovery = { runId: intervention.runId };
      attentionActionObserved = false;
      attentionRepairRequested = false;
      pi.sendMessage(
        { customType: "lemonpi-attention-recovery", content: `${ATTENTION_RECOVERY}\n\nTarget run: ${intervention.runId}`, display: false },
        { deliverAs: "followUp", triggerTurn: true },
      );
    } else if (intervention) {
      sendRestoreIntervention(missionId, intervention.runId, intervention.reason);
    } else if (terminal.length === 0 && mission.activeRunIds.length === 0) {
      await requestMissionWake("integration");
    }
  };

  const restoreMission = (ctx: { sessionManager: { getBranch(): Iterable<unknown> } }) => {
    missionWakeGeneration += 1;
    missionWakeCheck = undefined;
    missionWakeQueued = false;
    const restored = replayMissionState(ctx.sessionManager.getBranch());
    restoreReconcileGeneration += 1;
    const generation = restoreReconcileGeneration;
    mission = restored;
    activeDelegationRuns.clear();
    activeDelegationWidths.clear();
    activeWriterRuns.clear();
    independentDispatchRuns.clear();
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

  pi.on("session_start", async (_event, ctx) => restoreMission(ctx));
  pi.on("session_compact", async (_event, ctx) => restoreMission(ctx));
  pi.on("session_tree", async (_event, ctx) => restoreMission(ctx));

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
    if (!missionNeedsMain()
      || missionWakeIsBlocked({ mainAgentRunning, activeToolExecutions: activeMainToolExecutions, wakeQueued: missionWakeQueued })
      || missionHasOwnedWork()) return;
    void requestMissionWake(mission?.phase === "integration" ? "integration" : "plan");
  }, 5_000);

  pi.on("session_shutdown", async () => {
    missionWakeGeneration += 1;
    missionWakeCheck = undefined;
    missionWakeQueued = false;
    if (restoreWakeTimer) clearTimeout(restoreWakeTimer);
    if (independentCompletionTimer) clearTimeout(independentCompletionTimer);
    pendingIndependentCompletions.clear();
    clearInterval(missionScheduler);
  });

  const rememberTerminalRun = (key: string) => {
    integratedTerminalRuns.add(key);
    if (integratedTerminalRuns.size > 128) integratedTerminalRuns.delete(integratedTerminalRuns.values().next().value!);
  };

  const wakeForTerminalRun = (
    runId: string,
    sessionId: string | undefined,
    status: Exclude<WriterLifecycleStatus, "paused">,
    agent?: string,
    force = false,
  ) => {
    recordTerminalAttempt(runId, status);
    const key = terminalRunKey(sessionId, runId);
    if (integratedTerminalRuns.has(key) && !force) return;
    if (mission?.phase === "paused") return;
    rememberTerminalRun(key);
    const deferred = deferredWriterLanesByRun.get(runId) ?? [];
    deferredWriterLanesByRun.delete(runId);
    pi.sendMessage(
      {
        customType: "lemonpi-subagent-integration",
        content: `Delegated run ${runId}${agent ? ` (${agent})` : ""} reached terminal state ${status}. Inspect that exact run's status and result, integrate its findings or changes, perform the appropriate validation, and give the user a concrete progress or completion explanation. Do not launch a duplicate worker for the same completed chunk.${deferred.length > 0 ? `\n\nThe original wave was work-conservingly degraded instead of rejected. These lanes were deferred while valid workers launched:\n- ${deferred.join("\n- ")}\nCorrect only those concrete preflight issues, then dispatch the remaining ready lanes; do not rerun successful work.` : ""}`,
        display: false,
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  };

  const flushIndependentCompletions = () => {
    independentCompletionTimer = undefined;
    if (mission?.phase === "paused") {
      pendingIndependentCompletions.clear();
      return;
    }
    const completed = [...pendingIndependentCompletions.values()]
      .filter(({ runId, sessionId }) => !integratedTerminalRuns.has(terminalRunKey(sessionId, runId)));
    pendingIndependentCompletions.clear();
    if (completed.length === 0) return;
    completed.forEach(({ runId, sessionId }) => rememberTerminalRun(terminalRunKey(sessionId, runId)));
    const lines = completed.map(({ runId, status, agent }) => `- ${runId}${agent ? ` (${agent})` : ""}: ${status}`);
    pi.sendMessage(
      {
        customType: "lemonpi-independent-integration",
        content: `These independently dispatched lanes reached a terminal state:\n${lines.join("\n")}\n\nInspect each exact result now. Integrate every safe completed patch or finding immediately while unrelated delegated runs continue; do not wait for siblings or relaunch completed work. Then dispatch any newly dependency-ready lane before ending the turn.`,
        display: false,
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  };

  const queueIndependentCompletion = (completion: {
    runId: string;
    sessionId?: string;
    status: Exclude<WriterLifecycleStatus, "paused">;
    agent?: string;
  }) => {
    recordTerminalAttempt(completion.runId, completion.status);
    const key = terminalRunKey(completion.sessionId, completion.runId);
    if (integratedTerminalRuns.has(key)) return;
    pendingIndependentCompletions.set(key, completion);
    if (independentCompletionTimer) return;
    // Coalesce only completions that arrive together; do not recreate a group barrier.
    independentCompletionTimer = setTimeout(flushIndependentCompletions, 300);
  };

  const gitManagerTool: ToolDefinition<any, Record<string, unknown>> = {
    name: "lemonpi_git",
    label: "Manage mission Git state",
    description: "Auditable local-only Git lifecycle operations for Main Pi. Inspects and checkpoints exact paths, integrates accepted patches or commits, and manages clean worktrees. It cannot discard changes, force operations, alter remotes, or push.",
    parameters: GitManagerSchema,
    async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
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
      const classified = classifyDirtyTree(statusLines, Array.isArray(params.missionPaths) ? params.missionPaths.map(String) : []);
      const safePath = (value: string) => value.length > 0
        && !value.startsWith("/")
        && !/^[A-Za-z]:[\\/]/.test(value)
        && !value.split(/[\\/]/).some((segment) => segment === "" || segment === "." || segment === "..");
      const paths = Array.isArray(params.paths) ? params.paths.map(String) : [];
      const branchName = typeof params.branch === "string" ? params.branch.trim() : "";
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
      if (["create_branch", "switch_branch"].includes(action)) {
        if (statusLines.length) return { content: [{ type: "text", text: "Mission branch changes require a clean recoverable checkout." }], isError: true };
        if (!/^codex\/mission-[a-z0-9][a-z0-9._/-]{0,100}$/i.test(branchName)) return { content: [{ type: "text", text: "Mission branches must use codex/mission-* naming." }], isError: true };
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
        const selected = classified.filter((entry) => paths.some((path) => entry.path === path || entry.path.startsWith(`${path}/`)));
        const blocker = checkpointBlocker(classified);
        if (blocker) {
          return {
            content: [{ type: "text", text: `Clarification required before Git mutation: ${blocker.path} is ${blocker.classification} (${blocker.reason}). It was neither staged nor deleted.` }],
            isError: true,
            details: { action, requiresClarification: true, blocker },
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
          if (!/^codex\/(?:recovery|mission)-[a-z0-9][a-z0-9._/-]{0,100}$/i.test(branchName)) return { content: [{ type: "text", text: "Recovery branches must use codex/recovery-* or codex/mission-* naming." }], isError: true };
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
        const clean = await git(["status", "--porcelain=v1", "--untracked-files=all"], root);
        return { content: [{ type: "text", text: `${action === "checkpoint" ? "Recovery checkpoint" : "Logical integration commit"} created locally.\n${committed.stdout.trim()}\nRemaining dirty paths: ${clean.stdout.split(/\r?\n/).filter(Boolean).length}` }], details: { action, root, paths: stagedPaths, clean: !clean.stdout.trim() } };
      }

      if (action === "apply_patch") {
        const patch = typeof params.patch === "string" ? params.patch : "";
        const normalized = patch.replace(/\\/g, "/");
        if (!normalized.endsWith(".patch") || !normalized.includes("/.pi-subagents/artifacts/worktree-diffs/") && !normalized.startsWith(".pi-subagents/artifacts/worktree-diffs/")) {
          return { content: [{ type: "text", text: "Only package-generated worktree patch artifacts may be applied." }], isError: true };
        }
        const checked = await git(["apply", "--check", patch], root);
        if (checked.code !== 0) return { content: [{ type: "text", text: checked.stderr || "Patch preflight failed; no changes were applied." }], isError: true };
        const applied = await git(["apply", "--3way", patch], root);
        return applied.code === 0
          ? { content: [{ type: "text", text: "Accepted worker patch applied after a clean preflight. Review and commit its exact paths next." }], details: { action, root, patch } }
          : { content: [{ type: "text", text: applied.stderr || "Patch integration failed." }], isError: true };
      }

      if (action === "create_worktree") {
        if (statusLines.length) return { content: [{ type: "text", text: "Create a recoverable checkpoint before adding managed worktrees; the primary checkout is still dirty." }], isError: true };
        const worktreePath = typeof params.worktreePath === "string" ? params.worktreePath : "";
        if (!worktreePath.replace(/\\/g, "/").includes("/lemonpi-worktrees/") || !/^codex\/mission-[a-z0-9][a-z0-9._/-]{0,100}$/i.test(branchName)) {
          return { content: [{ type: "text", text: "Managed worktrees require a dedicated lemonpi-worktrees path and codex/mission-* branch." }], isError: true };
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

  const validationTool: ToolDefinition<any, Record<string, unknown>> = {
    name: "lemonpi_validate",
    label: "Run deduplicated validation",
    description: "Runs a focused, integration-wave, or final validation command only when its revision, relevant inputs, and dependency state have changed. Long commands emit visible heartbeat updates.",
    parameters: ValidationSchema,
    async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
      const params = rawParams as { cwd: string; program: string; args?: string[]; relevantPaths: string[]; scope: "focused" | "wave" | "final" };
      const cwd = params.cwd || ctx.cwd;
      const revision = await pi.exec("git", ["rev-parse", "--show-toplevel", "HEAD"], { cwd, timeout: 10_000 });
      if (revision.code !== 0) return { content: [{ type: "text", text: revision.stderr || "Validation target is not a Git repository." }], isError: true };
      const [repository, baseRevision] = revision.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const diff = await pi.exec("git", ["diff", "HEAD", "--", ...params.relevantPaths], { cwd: repository, timeout: 10_000 });
      const dependencies = await pi.exec("git", ["diff", "HEAD", "--", "Cargo.lock", "pnpm-lock.yaml", "package-lock.json", "yarn.lock", "Package.resolved"], { cwd: repository, timeout: 10_000 });
      const candidate = {
        repository,
        baseRevision,
        diffHash: contentHash(diff.stdout),
        command: [params.program, ...(params.args ?? [])].join(" "),
        relevantPaths: [...new Set(params.relevantPaths)],
        dependencyState: contentHash(dependencies.stdout),
        scope: params.scope,
      } satisfies Omit<ValidationRecord, "passed" | "elapsedMs">;
      const currentMission = ensureMission("integration");
      const duplicate = validationDeduplicationIssue(currentMission.validations, candidate);
      if (duplicate) return { content: [{ type: "text", text: `${duplicate} Reusing the recorded passing evidence.` }], details: { deduplicated: true, candidate } };
      const startedAt = Date.now();
      const heartbeat = setInterval(() => {
        onUpdate?.({ content: [{ type: "text", text: validationActivityLabel(candidate.command, startedAt, Date.now()) }] });
      }, 5_000);
      try {
        const result = await pi.exec(params.program, params.args ?? [], { cwd: repository, timeout: 30 * 60_000, signal });
        const elapsedMs = Date.now() - startedAt;
        if (result.code === 0) {
          currentMission.validations.push({ ...candidate, passed: true, elapsedMs });
          persistMission();
        }
        return {
          content: [{ type: "text", text: `${result.code === 0 ? "Validation passed" : "Validation failed"}: ${candidate.command} (${Math.round(elapsedMs / 100) / 10}s)\n${(result.stdout || result.stderr).trim().slice(-4_000)}` }],
          ...(result.code === 0 ? {} : { isError: true }),
          details: { deduplicated: false, active: false, elapsedMs, exitCode: result.code, candidate },
        };
      } finally {
        clearInterval(heartbeat);
      }
    },
  };

  const independentDispatchTool: ToolDefinition<any, Record<string, unknown>> = {
    name: "lemonpi_dispatch",
    label: "Dispatch independent lanes",
    description: "Launch dependency-ready lanes as separate async subagent runs. Use this instead of grouped subagent tasks whenever two or more results can be acted on independently. Each lane completes and wakes Main Pi on its own; implementation lanes are isolated in separate package-managed Git worktrees.",
    parameters: IndependentDispatchSchema,
    async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
      const params = rawParams as { lanes: Array<Record<string, unknown>>; context?: "fresh" | "fork" };
      const broadDispatch = params.lanes.length > 1
        || params.lanes.some((lane) => String(lane.task ?? "").length > 1_500);
      if (broadDispatch && visiblePlanTaskCount < Math.min(2, params.lanes.length)) {
        return {
          content: [{ type: "text", text: "This is a multi-outcome mission, but the visible plan does not expose its milestones. Create or restore a real epic in todo with separate implementation, integration, and validation outcomes before dispatching hidden slices." }],
          isError: true,
          details: { mode: "independent", runs: [], failures: [{ reason: "visible epic missing" }] },
        };
      }
      const availableAgents = [...executableAgents];
      if (availableAgents.length === 0) {
        return {
          content: [{ type: "text", text: "Preflight has no current executable agent roster. Call subagent({ action: \"list\" }) once, then retry this dispatch." }],
          isError: true,
          details: { mode: "independent", runs: [], failures: [{ reason: "agent roster unavailable" }] },
        };
      }
      const prepared = params.lanes.map((lane, index) => ({
        index,
        agent: String(lane.agent ?? "").trim(),
        purpose: String(lane.summary ?? "").trim(),
        lane: { ...lane },
        implementation: false,
        snapshot: undefined as CheckoutSnapshot | undefined,
        reviewRecord: undefined as Omit<ReviewRecord, "accepted"> | undefined,
        issue: undefined as string | undefined,
      }));

      await Promise.all(prepared.map(async (candidate) => {
        stripPerDispatchBudgets(candidate.lane);
        if (!availableAgents.includes(candidate.agent)) {
          candidate.issue = `Agent '${candidate.agent}' is not in the live executable roster.`;
          return;
        }
        const rawTask = typeof candidate.lane.task === "string" ? candidate.lane.task : "";
        if (READ_ONLY_ROLE_NAMES.has(candidate.agent.toLowerCase()) && IMPLEMENTATION_TASK.test(rawTask) && ownedPathFieldValues(rawTask)?.length) {
          candidate.issue = `Agent '${candidate.agent}' is read-only but this lane requires implementation. Choose a write-enabled agent before spending model tokens.`;
          return;
        }
        const summaryIssue = authoredWorkerSummaryIssue(candidate.lane.summary);
        if (summaryIssue) {
          candidate.issue = `Worker summary ${summaryIssue}. Add a user-facing purpose such as \"Repair remote settings layout\".`;
          return;
        }
        compileDelegationContracts(candidate.lane);
        const currentMission = ensureMission("planning");
        const artifactPath = uniqueArtifactPath(currentMission.id, candidate.purpose || candidate.agent, currentMission.attempts.length + candidate.index + 1);
        candidate.lane.task = `${String(candidate.lane.task ?? "").trimEnd()}\nArtifact path: ${artifactPath}`;
        candidate.implementation = delegatesImplementation({
          agent: candidate.agent,
          task: typeof candidate.lane.task === "string" ? candidate.lane.task : "",
        });
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
          const ownedPaths = normalizedOwnedPaths(String(candidate.lane.task ?? ""));
          if (!ownedPaths) {
            candidate.issue = "Implementation lanes need exact repo-relative Owned paths with no globs so their patches can be integrated independently.";
            return;
          }
          try {
            candidate.snapshot = await inspectCheckoutSnapshot(pi, candidate.lane.cwd, ctx.cwd);
          } catch (error) {
            candidate.issue = error instanceof Error ? error.message : String(error);
            return;
          }
          if (candidate.snapshot.dirtyEntries.length > 0) {
            candidate.issue = `The source checkout is not clean (${candidate.snapshot.dirtyEntries.slice(0, 8).join("; ")}). Use lemonpi_git inspect to classify every path, then checkpoint safe intentional work locally or ask one focused question for an ambiguous path. Do not serialize the mission or discard anything.`;
          }
        }
      }));

      for (let leftIndex = 0; leftIndex < prepared.length; leftIndex += 1) {
        const left = prepared[leftIndex]!;
        if (!left.implementation || !left.snapshot || left.issue) continue;
        const leftPaths = normalizedOwnedPaths(String(left.lane.task ?? ""))!;
        for (let rightIndex = leftIndex + 1; rightIndex < prepared.length; rightIndex += 1) {
          const right = prepared[rightIndex]!;
          if (!right.implementation || !right.snapshot || right.issue || left.snapshot.root !== right.snapshot.root) continue;
          const overlap = ownedPathsOverlap(leftPaths, normalizedOwnedPaths(String(right.lane.task ?? ""))!);
          if (!overlap) continue;
          const reason = `Writer ownership overlaps at ${overlap}; redraw these as one coherent lane or give them disjoint ownership.`;
          left.issue = reason;
          right.issue = reason;
        }
      }

      for (const candidate of prepared) {
        if (candidate.issue) continue;
        if (candidate.snapshot) appendCheckoutSnapshot(candidate.lane, candidate.snapshot);
        if (candidate.lane.acceptance === undefined) {
          candidate.lane.acceptance = {
            level: "none",
            reason: "Main Pi owns per-result integration and validation.",
          };
        }
        applyDelegationSafetyContracts(candidate.lane);
      }

      const launched = await Promise.all(prepared.map(async (candidate) => {
        if (candidate.issue) return { ...candidate, result: undefined as unknown, runId: undefined as string | undefined };
        const spawn = independentSpawnParams(candidate.lane).params;
        // Independent slices always start from concise fresh context. Bounded correction
        // continuity belongs exclusively to the guarded resume path below.
        spawn.context = "fresh";
        try {
          const result = await requestSubagentSpawn(pi, spawn);
          const runId = delegationRunId(result);
          if (!runId) throw new Error("The subagent runtime acknowledged the lane without returning a run ID.");
          return { ...candidate, result, runId };
        } catch (error) {
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
      }
      if (successes.length > 0) {
        writerOccupied = activeWriterRuns.size > 0;
        activeDelegationHandoffPending = true;
        const currentMission = ensureMission("delegated");
        for (const candidate of successes) {
          if (!currentMission.activeRunIds.includes(candidate.runId)) currentMission.activeRunIds.push(candidate.runId);
          currentMission.attempts.push({
            runId: candidate.runId,
            purpose: candidate.purpose,
            status: "running",
            executionMode: candidate.implementation ? "implementation" : "read-only",
            completedOrdinal: 0,
            sliceCount: 1,
            transcriptBytes: 0,
            tokens: 0,
          });
        }
        currentMission.writerActive = writerOccupied;
        currentMission.wakeAttempts = 0;
        persistMission();
      }

      if (successes.length === 0) {
        delegationFailurePending = true;
        lastDelegationFailure = failures.map((candidate) => `${candidate.agent}: ${candidate.issue ?? "launch failed"}`).join("\n").slice(0, 800);
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
          runs: successes.map((candidate) => ({ runId: candidate.runId, agent: candidate.agent, implementation: candidate.implementation })),
          failures: failures.map((candidate) => ({ agent: candidate.agent, reason: candidate.issue ?? "launch failed" })),
        },
      };
    },
  };
  pi.registerTool(gitManagerTool);
  pi.registerTool(validationTool);
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
      if (status !== "paused" && mission.activeRunIds.length === 0 && mission.phase !== "paused") mission.phase = "integration";
      persistMission();
    }
  };

  pi.events.on("subagent:async-started", (payload) => {
    const runId = delegationRunId(payload);
    if (!runId) return;
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
        if (independentlyDispatched && root?.intercomDelivered !== true) queueIndependentCompletion({ runId, sessionId, status, agent });
        else if (independentlyDispatched) rememberTerminalRun(terminalRunKey(sessionId, runId));
        else if (root?.intercomDelivered === true) wakeForTerminalRun(runId, sessionId, status, agent);
        else rememberTerminalRun(terminalRunKey(sessionId, runId));
      }
    }
    const failure = delegationFailure(payload, false);
    if (failure) {
      delegationFailurePending = true;
      const classification = classifyFailure(failure);
      lastDelegationFailure = `Classification: ${classification}\nRecovery: ${recoveryAction(classification, 0)}\n${failure}`;
    }
  });

  pi.on("before_agent_start", async (event) => {
    mainAgentRunning = true;
    if (event.prompt === MISSION_INTEGRATION || event.prompt.startsWith(PLAN_CONTINUATION)) {
      missionWakeQueued = false;
    }
    return {
      systemPrompt: `${event.systemPrompt}\n\n${ORCHESTRATION_POLICY_NOTICE}\n\n${NARRATION_CONTRACT}\n\n${ORCHESTRATION_CONTRACT}${attentionRecovery ? `\n\n<lemonpi-attention-recovery>\nRun ${attentionRecovery.runId}${attentionRecovery.index !== undefined ? ` child ${attentionRecovery.index}` : ""} needs intervention now. Inspect and control that exact run before ending this turn.\n</lemonpi-attention-recovery>` : ""}`,
    };
  });

  pi.on("input", async (event, ctx) => {
    if (event.source !== "rpc") return { action: "continue" };

    const isSteerRequest = event.text.startsWith(SUBAGENT_STEER_PREFIX);
    const isStopRequest = event.text.startsWith(SUBAGENT_STOP_PREFIX);
    const isTerminalRequest = event.text.startsWith(SUBAGENT_TERMINAL_PREFIX);
    const isMainStopRequest = event.text.startsWith(MAIN_AGENT_STOP_PREFIX);
    if (!isSteerRequest && !isStopRequest && !isTerminalRequest && !isMainStopRequest) return { action: "continue" };

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
      remainingPlanTask = undefined;
      if (mission) {
        mission.phase = "paused";
        mission.wakeAttempts = 0;
        delete mission.remainingTask;
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
        await requestSubagentStop(pi, runId);
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
        wakeForTerminalRun(runId, sessionId, status, agent, force);
      }
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    }
    return { action: "handled" };
  });

  pi.on("tool_call", async (event, ctx) => {
    if (process.env.PI_SUBAGENT_CHILD === "1") return;

    const input = event.input as Record<string, unknown>;
    if (event.toolName === "subagent_wait") {
      return {
        block: true,
        reason: "LemonPi keeps Main Pi interruptible while background workers run. Do not wait inside this turn. Give the user a concise status update and end the turn; the worker remains active, completion will wake Main Pi, and any new user message can be answered immediately and used to steer the worker.",
      };
    }
    const isShellTool = ["bash", "shell"].includes(event.toolName);
    const isManagedPatchIntegration = isShellTool && isManagedWorktreePatchCommand(input);
    if (MAIN_MUTATION_TOOLS.has(event.toolName) || (isShellTool && shellMutatesProject(input) && !isManagedPatchIntegration)) {
      return {
        block: true,
        reason: "Main Pi is LemonPi's read-only orchestrator and may not mutate project files. Choose the best matching writable agent from the live roster, or steer/resume the existing writer for a correction. Main Pi should inspect and validate the result.",
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
      const correction = /(?:^|\n)\s*correction for (?:the )?(?:immediately )?previous slice\s*:/i.test(message);
      try {
        const status = await requestSubagentStatus(pi, previousRunId);
        const metrics = workerStatusMetrics(status);
        previousAttempt.tokens = Math.max(previousAttempt.tokens, metrics.tokens);
        previousAttempt.transcriptBytes = Math.max(
          previousAttempt.transcriptBytes,
          ...metrics.transcriptPaths.map((filePath) => {
            try {
              return statSync(filePath).size;
            } catch {
              return 0;
            }
          }),
        );
        persistMission();
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
      resumeToolCalls.set(event.toolCallId, {
        implementation: declaredExecutionMode(compiledMessage) === "implementation",
        previousRunId,
        purpose: summary,
        sliceCount: previousAttempt.sliceCount + 1,
      });
      const currentMission = ensureMission("delegated");
      currentMission.wakeAttempts = 0;
      persistMission();
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

      if (input.acceptance === undefined) {
        input.acceptance = {
          level: "none",
          reason: "LemonPi makes Main Pi the integration owner unless explicit runtime verify commands are supplied.",
        };
      }
      applyDelegationSafetyContracts(input);
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
  });

  pi.on("message_start", async (event) => {
    const message = event.message as typeof event.message & {
      customType?: string;
      details?: { event?: { runId?: unknown; index?: unknown; to?: unknown } };
    };
    const notification = visibleText(message.content);
    if (event.message.role === "assistant") currentAssistantVisibleText = notification;
    if (event.message.role === "user" && message.customType == null) {
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
      latestUserRequest = notification;
      currentAssistantVisibleText = "";
      if (attentionRecovery) attentionRepairRequested = false;
    }
    if (typeof message.customType === "string" && message.customType.startsWith("lemonpi-mission-")) {
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
    sawToolActivity = true;
    visibleExplanationAfterLastTool = false;
  });

  pi.on("tool_execution_end", async (event) => {
    activeMainToolExecutions = Math.max(0, activeMainToolExecutions - 1);
    if (event.toolName === "todo" && !event.isError) {
      const root = asRecord(event.result);
      const details = asRecord(root?.details) ?? root;
      if (Array.isArray(details?.tasks)) {
        const tasks = details.tasks.map(asRecord).filter((task) => task?.status !== "deleted");
        visiblePlanTaskCount = tasks.length;
        acceptedPlanTaskCount = tasks.filter((task) => task?.status === "completed").length;
        if (mission && visiblePlanTaskCount > 0 && acceptedPlanTaskCount === visiblePlanTaskCount) {
          mission.phase = "integration";
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
    if (resumedCall && !event.isError) {
      const runId = delegationRunId(event.result);
      if (runId) {
        activeDelegationRuns.add(runId);
        activeDelegationWidths.set(runId, 1);
        const currentMission = ensureMission("delegated");
        if (!currentMission.activeRunIds.includes(runId)) currentMission.activeRunIds.push(runId);
        currentMission.attempts.push({
          runId,
          purpose: resumedCall.purpose,
          status: "running",
          executionMode: resumedCall.implementation ? "implementation" : "read-only",
          completedOrdinal: 0,
          sliceCount: resumedCall.sliceCount,
          transcriptBytes: 0,
          tokens: 0,
        });
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
      if (status && status !== "paused") {
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
          if (mission.activeRunIds.length === 0 && mission.phase === "planning") mission.phase = "complete";
        }
        persistMission();
      }
    }
    const writerCall = writerToolCalls.get(event.toolCallId);
    writerToolCalls.delete(event.toolCallId);
    const deferredWriterLanes = deferredWriterLanesByToolCall.get(event.toolCallId) ?? [];
    deferredWriterLanesByToolCall.delete(event.toolCallId);
    const launchWidth = delegationLaunchWidths.get(event.toolCallId) ?? 1;
    delegationLaunchWidths.delete(event.toolCallId);
    if (!delegationToolCalls.delete(event.toolCallId)) return;
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

  pi.on("agent_settled", async () => {
    mainAgentRunning = false;
    const intentionallyStopped = lastAssistantStopReason === "aborted" || lastAssistantStopReason === "error";
    const strandedPlanTask = remainingPlanTask;
    const ownedWorkActive = missionHasOwnedWork();
    if (intentionallyStopped && mission) {
      mission.phase = "paused";
      persistMission();
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
      if (visibleExplanationAfterLastTool && !delegationFailurePending && !attentionRecovery && !remainingPlanTask) {
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
