import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SUBAGENT_STEER_PREFIX = "__lemonpi_subagent_steer_v1__:";
const SUBAGENT_STOP_PREFIX = "__lemonpi_subagent_stop_v1__:";
const SUBAGENT_TERMINAL_PREFIX = "__lemonpi_subagent_terminal_v1__:";
const MAIN_AGENT_STOP_PREFIX = "__lemonpi_main_agent_stop_v1__:";
const SUBAGENT_RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
const SUBAGENT_RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:";
const SUBAGENT_RPC_TIMEOUT_MS = 6_000;
const RESTORE_STATUS_RPC_TIMEOUT_MS = 2_000;
const RESTORE_RECONCILE_DELAYS_MS = [500, 1_500, 3_000] as const;
const CHILD_TODO_SEED_TAG = "lemonpi-child-todo-seed";
const CURRENT_CHILD_OWNER = "__lemonpi_current_child__";

interface InitialChildTodo {
  id: number;
  subject: string;
  description?: string;
  activeForm: string;
  status: "in_progress" | "pending";
  blockedBy: number[];
  owner: string;
}

function parseChildChecklist(task: string, agent: string): InitialChildTodo[] {
  const heading = /(?:^|\n)\s*Child checklist:\s*\n/i.exec(task);
  if (!heading) return [];
  const lines = task.slice((heading.index ?? 0) + heading[0].length).split("\n");
  const parsed: Array<{ subject: string; description?: string }> = [];
  for (const line of lines) {
    const item = /^\s*(?:[-*]|\d+[.)])\s+(?:\[[ xX]\]\s*)?(.+?)\s*$/.exec(line);
    if (!item) {
      if (parsed.length > 0 && line.trim()) break;
      continue;
    }
    const [subjectPart, ...descriptionParts] = item[1].split(/\s+::\s+/);
    const subject = subjectPart.trim().slice(0, 180);
    const description = descriptionParts.join(" :: ").trim().slice(0, 1_200);
    if (!subject) continue;
    parsed.push({ subject, ...(description ? { description } : {}) });
    if (parsed.length === 5) break;
  }
  return parsed.map((item, index) => ({
    id: index + 1,
    subject: item.subject,
    ...(item.description ? { description: item.description } : {}),
    activeForm: item.description ?? item.subject,
    status: index === 0 ? "in_progress" : "pending",
    blockedBy: index === 0 ? [] : [index],
    owner: agent,
  }));
}

function childTodoGuidance(agent: string, tasks: InitialChildTodo[]): string {
  const owner = agent === CURRENT_CHILD_OWNER ? "your current agent identity" : JSON.stringify(agent);
  const seed = JSON.stringify({
    version: 1,
    seedId: globalThis.crypto.randomUUID(),
    seededAt: Date.now(),
    owner: agent,
    tasks,
    nextId: tasks.length + 1,
  });
  return `

<lemonpi-child-checklist>
Main Pi authored your checklist and LemonPi initialized it in this child session before your first model request. The seeded tasks are owned by ${owner}; do not clear or recreate them. Begin with the existing in-progress item. Complete each item immediately when its concrete outcome is actually verified, then move the next item into progress; never save several status changes to submit together near the end. Do not mark an item complete because you intend to produce its result later. The closing response itself is not a checklist item. Use \`child_todo({ action: "list" })\` only if you need to inspect the initialized details, then update the existing task ids through \`child_todo\` as work progresses. You may add or revise a task only when execution reveals genuinely new work within the delegated scope.
</lemonpi-child-checklist>
<${CHILD_TODO_SEED_TAG}>${seed}</${CHILD_TODO_SEED_TAG}>`;
}

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
You are Main Pi, the read-only supervisor and integration owner. You do not implement changes in project files. Optimize for the shortest reliable path to the user's outcome by selecting the best currently available subagent for each necessary phase, giving each writer a clear coherent slice, then inspecting, integrating, and validating its result. File count alone never makes work large.

Parallel execution is the normal operating mode, not a rare optimization. Keep two to four subagents doing useful independent work whenever the current task graph exposes that much dependency-ready work. The burden is on sequential execution: use one worker only when the request is genuinely one small coherent outcome, write ownership overlaps, a real dependency blocks later lanes, the checkout cannot be normalized safely without risking unowned work, or dispatch and integration overhead would erase the wall-time benefit. Do not serialize merely because one lane is easiest to describe first. Do not manufacture duplicate or ceremonial work to fill slots.

Routing policy:

1. Fast path — for a genuinely single, bounded, well-understood implementation outcome, call the built-in \`worker\` immediately with a concise outcome and completion condition. A singleton implementation task must include \`Single-writer reason:\` with exactly one of \`atomic\`, \`overlapping_ownership\`, \`dependency_blocked\`, \`unsafe_checkout\`, or \`overhead_exceeds_benefit\`, plus a concrete \`Single-writer detail:\`. Before the tool call, visibly tell the user \`I’m using a single writer because ...\` with the same real constraint. LemonPi rejects an unexplained singleton. Do not create a plan, inspect the roster, or launch a planner first for truly atomic work. LemonPi compiles execution mode, chunk fields, acceptance defaults, async behavior, and the initial child checklist automatically. Aim to launch in the first Main turn. This singleton path is an exception for work too small or indivisible to benefit from parallelism, not the default for a broader request.
2. Parallel-first decomposition — for broader work, spend only a brief inspection identifying outcome-sized vertical lanes, their exact ownership, and real dependencies. Collect every lane that is ready now. When two to four ready lanes have disjoint write ownership, dispatch them together in one wave immediately. Do not launch the first obvious lane and postpone other independent lanes until it completes. Dependent or overlapping lanes move to a later wave. Do not split by file merely to create more agents.
3. Planning and roster — use a planner only when architecture, ordering, or ambiguity cannot be resolved by brief direct inspection. The planner must answer a concrete decision and must never be a ritual before ordinary coding. The built-in \`worker\` is the default executor. Call \`subagent({ action: "list" })\` only when a specialist or custom agent may materially improve the result, then reuse that roster for the task instead of rediscovering it.
4. Semantic dispatch — tell each child the actual outcome, scope, completion condition, and meaningful constraints in plain language. You do not need to reproduce LemonPi's mechanical execution declaration, acceptance boilerplate, or one-item checklist; the runtime compiles missing fields. For parallel writers, include \`Owned paths:\` with exact repo-relative files or directories. An \`unsafe_checkout\` singleton must also declare exact \`Owned paths:\`. If ownership cannot be assigned confidently, use \`overlapping_ownership\` only when the overlap is real and explain it specifically. Give each worker only focused validation for its lane; do not paste the repository's entire test matrix into every child.
5. Child progress — LemonPi initializes a child checklist automatically. Supply a custom \`Child checklist:\` only when a delegated lane genuinely has two to five meaningful internal milestones. Do not create checklist items for tool calls or final-response delivery.
6. Useful specialists — read-only planning, research, review, and analysis must answer a concrete question that changes the next decision. Run useful independent read-only work concurrently with writers when it shortens the critical path, such as preparing the next dependency-ready wave while implementation proceeds. Never launch ceremonial, duplicative, or make-work agents merely to occupy a slot.
7. Execution path and checkout hygiene — inspect \`git status --porcelain\` during the brief dispatch pass, but never trust a status or HEAD remembered from before a reload, reset, compaction, or another turn. Immediately before every implementation launch, LemonPi independently reads the target repository's current HEAD and working tree and appends an authoritative checkout snapshot to each child task. If two to four disjoint implementation lanes are ready, make a clean worktree base and launch all of them as one top-level \`tasks\` call; LemonPi adds worktree isolation and caps concurrency automatically. A dirty checkout is a cleanup task, not a sequential-execution excuse. Classify every dirty path first; validate and commit completed in-scope work, use a path-scoped dry run before removing confirmed rebuildable noise, or preserve unrelated changes in a clearly labeled recoverable checkpoint commit when that is safe. Never discard, overwrite, or silently hide user work. LemonPi permits \`unsafe_checkout\` only when the fresh dirty paths actually overlap the singleton's exact owned paths and cannot be normalized safely. Useful independent read-only subagents should still run alongside it when they save time.
8. Checkpoint and integration review — Main Pi reviews every completed chunk directly: inspect what changed, compare it with the stated scope, owned paths, and out-of-scope boundary, and perform the smallest useful check. For a worktree wave, read the versioned manifest at \`parallelHandoff.path\`; require the expected base commit, a completed child status, a non-error patch, and changed paths confined to that lane's ownership. Apply accepted patches to the primary checkout one at a time with \`git apply --check\` followed by \`git apply --3way\`. This narrow patch application is git integration, not implementation. Never apply a failed, stale-base, out-of-lane, overlapping, or conflict-producing patch blindly; preserve its artifact and re-delegate only that bounded lane after the accepted patches are integrated. Report the concrete checkpoint to the user before continuing. Run a final holistic validation once after all chunks are integrated; do not rerun the full suite after every small chunk unless its risk requires that.
9. Review gate — independent review is justified only when the user explicitly requests it or the change crosses a material risk boundary such as authentication, authorization, security, privacy, money, irreversible data changes, migrations, cryptography, public protocols, concurrency, or production release infrastructure. State that boundary in the delegated task as "Review justification: ...". At most one reviewer pass is allowed per user request unless the user explicitly asks for multiple independent reviews. Routine work is reviewed by Main Pi at each chunk checkpoint.
10. Repair rule — only a concrete blocker or major correctness defect warrants a repair pass. Notes, hypothetical edge cases, test-coverage wishes, and low-severity residual risks do not trigger an automatic writer-review loop. For a bounded correction, steer or resume the same writer rather than launching a new implementation owner. After the writer repairs it, Main Pi inspects and validates directly. Do not launch a second reviewer to confirm the first reviewer.
11. Parallelism rule — target the largest useful dependency-ready wave, up to four implementation writers. Parallel writers must be top-level parallel tasks, run in package-managed isolated worktrees, declare disjoint owned paths, and have no dependency on each other. In a shared checkout keep exactly one writer. Do not start a second writer wave while any current writer wave is running or paused: respond to new user guidance, then steer the relevant existing child. Read-only specialists may run alongside writers when their results are independent and useful. Main Pi owns synthesis and patch integration; children never merge sibling work. Never reduce a safe ready wave to one worker out of habit, because sequential dispatch is simpler, or merely because the checkout was initially dirty.
12. Progress and responsiveness rule — never invent a short child runtime deadline and never block the interactive supervisor with subagent_wait. Use progress evidence rather than elapsed time alone. End the Main Pi turn while background work continues so new user messages receive a fresh response immediately. A \`needs_attention\` control notice is an intervention request, not passive status: immediately inspect that exact run and transcript through the subagent status controls. If the package reconciles it to a terminal state, integrate the result. If it is alive with no active tool or new output, steer it once to stop exploring and return its result or exact blocker. If that steer cannot be delivered or the same run needs attention again, stop it, preserve useful transcript findings, and launch only a fresh smaller replacement chunk. Never leave a needs-attention run indefinitely, launch a competing agent, or restart the whole workflow.
13. Acceptance rule — LemonPi uses pi-subagents' role-neutral v1 run contract, where execution success, acceptance, review, and observed effects remain separate. Package-level \`verified\` acceptance is a runtime gate, not a request for the child to report tests. Use it only with a non-empty \`acceptance.verify\` array of objects containing an \`id\` and executable \`command\`; commands mentioned in the task or child output do not count. If Main Pi will inspect and validate the chunk itself, omit acceptance and LemonPi will disable inferred package acceptance. Never resume a run that failed because its acceptance contract was malformed, because revival can inherit that contract; launch a fresh bounded chunk with corrected acceptance instead.
14. Budget ownership rule — do not set per-dispatch \`timeoutMs\`, \`maxRuntimeMs\`, \`turnBudget\`, \`toolBudget\`, or \`usageBudget\`. LemonPi removes model-generated budget fields before launch because guessed counters create arbitrary failures and package turn budgets can terminate only after wrap-up/grace boundaries. Scope work through small tasks and intervene from live activity evidence instead. Deliberate budgets stored by the user in package settings or an agent profile remain authoritative.
15. Clarification ownership rule — Main Pi alone owns user clarification. When a user decision genuinely blocks scope, safety, or the next useful action and the answer cannot be discovered from available context, use \`ask_user_question\` instead of guessing or asking through unstructured chat. Do not interrupt for discoverable facts or non-blocking preferences, do not delegate user questioning, and do not let independent subagents solicit decisions separately; gather their uncertainty and ask the user once.
16. Visible task-plan rule — use the \`todo\` tool for work with multiple meaningful steps so the user can see the current plan and live progress in LemonPi. Main Pi owns the session-level plan: create concise outcome-oriented tasks, mark every lane in the active parallel wave in progress, update status as results arrive, and complete tasks only after inspecting the corresponding result. Keep only one ordinary task in progress when concrete constraints require sequential execution. Do not settle while the plan has unfinished work unless delegated agents are actively carrying it; continue the next dependency-ready wave, or move a genuinely blocked task out of in-progress state and explain what input or external change is required. Do not create a checklist for a single trivial action, duplicate every tool call as a task, or use the checklist as a substitute for visible narration.

Main Pi may use read-only inspection, search, status, test, build, and git-management operations. It must not call file editing/writing tools or use shell commands to mutate project files, except for applying an accepted package-generated worktree patch from \`.pi-subagents/artifacts/worktree-diffs/\` with the exact guarded \`git apply\` flow above. Launch implementation asynchronously, do only brief useful read-only work, then return control to the user; completion events provide the integration wake-up. For explanation, diagnosis, review, or other read-only requests, do not launch an implementation worker.
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
  method: "status" | "steer" | "stop",
  params: { id?: string; index?: number; message?: string },
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

const MATERIAL_RISK_REQUEST = /\b(?:security|authentication|authorization|permissions?|privacy|credentials?|secrets?|payments?|billing|money|database|schema|migration|data loss|destructive|encryption|cryptograph\w*|public protocol|concurren\w*|race condition|production deploy\w*|release infrastructure|code signing|notari[sz]ation|auto[- ]?update)\b/i;
const EXPLICIT_REVIEW_REQUEST = /\b(?:review|audit|second opinion|independent verification|threat model)\b/i;
const EXPLICIT_MULTI_REVIEW_REQUEST = /\b(?:multiple|several|two|three|parallel|independent)\b.{0,32}\b(?:reviews?|reviewers?|audits?)\b|\b(?:reviews?|reviewers?|audits?)\b.{0,32}\b(?:multiple|several|two|three|parallel|independent)\b/i;
const REVIEW_JUSTIFICATION = /\breview justification:\s*(?!none\b|n\/a\b)[^\n]{8,}/i;
const CHUNK_OUTCOME = /(?:^|\n)\s*chunk outcome\s*:\s*\S/i;
const CHUNK_IN_SCOPE = /(?:^|\n)\s*in scope\s*:\s*\S/i;
const CHUNK_DONE_WHEN = /(?:^|\n)\s*done when\s*:\s*\S/i;
const CHUNK_OUT_OF_SCOPE = /(?:^|\n)\s*out of scope\s*:\s*\S/i;
const OWNED_PATHS = /(?:^|\n)\s*owned paths\s*:\s*([^\n]+)/i;
const NO_DEPENDENCIES = /(?:^|\n)\s*depends on\s*:\s*none\s*(?:\n|$)/i;
const SINGLE_WRITER_REASON = /(?:^|\n)\s*single-writer reason\s*:\s*([^\n]+)/i;
const SINGLE_WRITER_DETAIL = /(?:^|\n)\s*single-writer detail\s*:\s*([^\n]+)/i;
const SINGLE_WRITER_VISIBLE_NARRATION = /\b(?:i(?:['’]m| am)|we(?:['’]re| are))\s+(?:using|launching|keeping|choosing)\s+(?:a\s+)?single\s+writer\s+because\b/i;
const CHECKOUT_SNAPSHOT_START = "<lemonpi-checkout-snapshot>";
const CHECKOUT_SNAPSHOT_END = "</lemonpi-checkout-snapshot>";
const CHECKOUT_SNAPSHOT_BLOCK = /\n*<lemonpi-checkout-snapshot>[\s\S]*?<\/lemonpi-checkout-snapshot>\s*/gi;
const MAX_PARALLEL_WRITERS = 4;
const MAIN_MUTATION_TOOLS = new Set(["edit", "write", "apply_patch", "patch", "write_file", "edit_file", "create_file", "delete_file", "move_file"]);
const IMPLEMENTATION_TASK = /\b(?:implement|build|create|edit|modify|update|change|fix|add|remove|refactor|wire|style|replace|rename|delete|patch)\b/i;
const EXPLICIT_READ_ONLY_TASK = /\b(?:execution mode:\s*read[- ]only|read[- ]only|no code changes|do not (?:edit|write|modify)|without (?:editing|writing|modifying)|plan only|report only|analysis only)\b/i;
const EXECUTION_MODE = /^\s*execution mode\s*:\s*(read[- ]only|implementation)\s*(?:\n|$)/i;
const PACKAGE_READ_ONLY_GUARD = "Do not modify any project files. Return only the requested read-only artifact.";

interface DelegatedSpec {
  agent: string;
  task: string;
}

export type SingleWriterReason = "atomic" | "overlapping_ownership" | "dependency_blocked" | "unsafe_checkout" | "overhead_exceeds_benefit";

export interface CheckoutSnapshot {
  root: string;
  head: string;
  dirtyEntries: string[];
}

const SINGLE_WRITER_REASONS = new Set<SingleWriterReason>([
  "atomic",
  "overlapping_ownership",
  "dependency_blocked",
  "unsafe_checkout",
  "overhead_exceeds_benefit",
]);

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

function addChildTodoGuidance(value: unknown): void {
  const visit = (candidate: unknown) => {
    const record = asRecord(candidate);
    if (!record) return;
    if (typeof record.agent === "string") {
      const task = typeof record.task === "string" ? record.task.trimEnd() : "";
      if (!task.includes("<lemonpi-child-checklist>")) {
        record.task = `${task}${childTodoGuidance(record.agent, parseChildChecklist(task, record.agent))}`.trimStart();
      }
    }
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
  const line = task
    .split("\n")
    .map((value) => value.trim())
    .find((value) => value && !/^(?:execution mode|chunk outcome|in scope|done when|out of scope|owned paths|depends on|single-writer reason|single-writer detail|child checklist)\s*:/i.test(value));
  return (line ?? "Complete the delegated outcome").replace(/^[-*]\s+/, "").slice(0, 180);
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

function appendDefaultChecklist(task: string, summary: string): string {
  if (parseChildChecklist(task, "worker").length > 0) return task;
  return `${task.trimEnd()}\nChild checklist:\n- Complete delegated outcome :: ${summary}`;
}

export function compileDelegationContracts(input: Record<string, unknown>): void {
  const directTasks = Array.isArray(input.tasks) ? input.tasks.map(asRecord).filter(Boolean) : [];
  const directWriterCount = directTasks.filter((record) =>
    typeof record?.agent === "string"
    && inferredExecutionMode(record.agent, typeof record.task === "string" ? record.task : "") === "implementation"
  ).length;

  const visit = (candidate: unknown) => {
    const record = asRecord(candidate);
    if (!record) return;
    if (typeof record.agent === "string") {
      const originalTask = typeof record.task === "string" ? record.task.trim() : "";
      const summary = conciseTaskSummary(originalTask);
      const mode = inferredExecutionMode(record.agent, originalTask);
      let task = originalTask;
      if (!declaredExecutionMode(task)) task = `Execution mode: ${mode}\n${task}`.trimEnd();
      if (mode === "implementation") task = appendMissingImplementationContract(task, summary);
      if (directWriterCount > 1 && mode === "implementation" && !NO_DEPENDENCIES.test(task)) {
        task = `${task.trimEnd()}\nDepends on: none`;
      }
      record.task = appendDefaultChecklist(task, summary);
    }
    for (const key of ["tasks", "chain", "parallel"] as const) {
      const nested = record[key];
      if (Array.isArray(nested)) nested.forEach(visit);
      else if (nested !== undefined) visit(nested);
    }
  };
  visit(input);

  if (directWriterCount > 1) {
    input.worktree = true;
    const requestedConcurrency = typeof input.concurrency === "number" && Number.isFinite(input.concurrency)
      ? Math.max(1, Math.floor(input.concurrency))
      : MAX_PARALLEL_WRITERS;
    input.concurrency = Math.min(MAX_PARALLEL_WRITERS, requestedConcurrency);
    input.artifacts = true;
  }
}

function normalizedOwnedPaths(task: string): string[] | undefined {
  const match = OWNED_PATHS.exec(task);
  if (!match) return undefined;
  const paths = match[1]
    .split(",")
    .map((value) => value.trim().normalize("NFC").replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, ""))
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
  if (writers.length > MAX_PARALLEL_WRITERS) {
    return `LemonPi allows at most ${MAX_PARALLEL_WRITERS} implementation writers in one wave.`;
  }
  if (input.worktree !== true) {
    return "Parallel implementation requires worktree: true so every writer receives an isolated checkout.";
  }
  const lanes: Array<{ agent: string; paths: string[] }> = [];
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
    for (const lane of lanes) {
      const overlap = ownedPathsOverlap(lane.paths, paths);
      if (overlap) return `Parallel writer ownership overlaps at ${overlap}; serialize or redraw the lane boundaries.`;
    }
    lanes.push({ agent, paths });
  }
  return undefined;
}

function implementationSpecs(input: Record<string, unknown>): DelegatedSpec[] {
  return delegatedSpecs(input).filter(delegatesImplementation);
}

export function singleWriterDispatch(input: Record<string, unknown>): { reason?: SingleWriterReason; detail?: string; rawReason?: string } | undefined {
  const writers = implementationSpecs(input);
  if (writers.length !== 1) return undefined;
  const rawReason = SINGLE_WRITER_REASON.exec(writers[0].task)?.[1]?.trim().toLowerCase();
  const detail = SINGLE_WRITER_DETAIL.exec(writers[0].task)?.[1]?.trim();
  const reason = rawReason && SINGLE_WRITER_REASONS.has(rawReason as SingleWriterReason)
    ? rawReason as SingleWriterReason
    : undefined;
  return {
    ...(rawReason ? { rawReason } : {}),
    ...(reason ? { reason } : {}),
    ...(detail ? { detail } : {}),
  };
}

export function singletonWriterPolicyIssue(input: Record<string, unknown>, visibleNarration = ""): string | undefined {
  const dispatch = singleWriterDispatch(input);
  if (!dispatch) return undefined;
  if (!dispatch.rawReason) {
    return "A singleton implementation launch needs `Single-writer reason:` set to atomic, overlapping_ownership, dependency_blocked, unsafe_checkout, or overhead_exceeds_benefit. Parallel implementation is the default; otherwise redraw the task as a top-level worktree wave.";
  }
  if (!dispatch.reason) {
    return `Unknown Single-writer reason: ${dispatch.rawReason}. Use atomic, overlapping_ownership, dependency_blocked, unsafe_checkout, or overhead_exceeds_benefit.`;
  }
  if (!dispatch.detail || dispatch.detail.length < 16) {
    return "A singleton implementation launch needs a concrete `Single-writer detail:` explaining the actual constraint in at least one specific sentence.";
  }
  if (!SINGLE_WRITER_VISIBLE_NARRATION.test(visibleNarration)) {
    return "Before launching one implementation writer, tell the user why in visible narration using the form `I’m using a single writer because ...`, matching the structured Single-writer reason and detail. Then retry the same bounded launch.";
  }
  return undefined;
}

function normalizedDirtyPaths(entry: string): string[] {
  const body = entry.length > 3 ? entry.slice(3) : entry;
  return body
    .split(/\s+->\s+/)
    .map((value) => value.trim().replace(/^"|"$/g, "").normalize("NFC").replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "").toLowerCase())
    .filter(Boolean);
}

export function checkoutSnapshotPolicyIssue(input: Record<string, unknown>, snapshot: CheckoutSnapshot): string | undefined {
  const writers = implementationSpecs(input);
  if (writers.length === 0) return undefined;
  const dispatch = writers.length === 1 ? singleWriterDispatch(input) : undefined;
  const dirtyPaths = snapshot.dirtyEntries.flatMap(normalizedDirtyPaths);

  if (dirtyPaths.length === 0) {
    if (dispatch?.reason === "unsafe_checkout") {
      return "The fresh checkout preflight is clean, so unsafe_checkout is not a valid singleton reason. Launch the dependency-ready parallel wave or use the actual remaining constraint.";
    }
    return undefined;
  }

  const summary = snapshot.dirtyEntries.slice(0, 8).join("; ");
  if (writers.length > 1) {
    return `The fresh checkout preflight found uncommitted changes (${summary}). Normalize them safely before launching a worktree wave; a dirty checkout is a hygiene task, not a reason to silently serialize.`;
  }
  if (dispatch?.reason !== "unsafe_checkout") {
    return `The fresh checkout preflight found uncommitted changes (${summary}). Classify and safely commit, checkpoint, or clean them before dispatch. Use unsafe_checkout only when incomplete overlapping work genuinely cannot be normalized without risk.`;
  }
  const ownedPaths = normalizedOwnedPaths(writers[0].task);
  if (!ownedPaths) {
    return "unsafe_checkout requires exact repo-relative `Owned paths:` so LemonPi can prove that the unavoidable dirty work overlaps this singleton lane.";
  }
  if (!ownedPathsOverlap(ownedPaths, dirtyPaths)) {
    return `The dirty paths do not overlap this singleton lane's Owned paths (${summary}). Preserve them in a recoverable checkpoint, return to a clean base, and dispatch the largest useful parallel wave.`;
  }
  return undefined;
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
  if (!agent) return undefined;
  const escapedAgent = escapedRegExp(agent);
  const single = content.match(new RegExp(`^(?:Background task|Detached foreground task) (completed|failed|paused|stopped): \\*\\*${escapedAgent}\\*\\*`, "mi"));
  if (single) return single[1] as "completed" | "failed" | "paused" | "stopped";
  if (new RegExp(`^Background tasks completed \\(\\d+\\):.*\\*\\*${escapedAgent}\\*\\*`, "mi").test(content)) return "completed";
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

interface RemainingPlanTask {
  id: number;
  subject: string;
  status: "in_progress" | "pending";
}

const MISSION_ENTRY = "lemonpi-mission-state";
type MissionPhase = "planning" | "delegated" | "integration" | "complete" | "paused";

interface MissionState {
  version: 1;
  id: string;
  phase: MissionPhase;
  request: string;
  activeRunIds: string[];
  writerActive: boolean;
  wakeAttempts: number;
  updatedAt: number;
  remainingTask?: RemainingPlanTask;
}

function parsedMissionState(value: unknown): MissionState | undefined {
  const record = asRecord(value);
  if (record?.version !== 1
    || typeof record.id !== "string"
    || !["planning", "delegated", "integration", "complete", "paused"].includes(String(record.phase))
    || typeof record.request !== "string"
    || !Array.isArray(record.activeRunIds)
    || !record.activeRunIds.every((runId) => typeof runId === "string")
    || typeof record.writerActive !== "boolean"
    || !Number.isInteger(record.wakeAttempts)
    || typeof record.updatedAt !== "number") return undefined;
  const remaining = asRecord(record.remainingTask);
  const remainingTask = remaining
    && typeof remaining.id === "number"
    && typeof remaining.subject === "string"
    && (remaining.status === "in_progress" || remaining.status === "pending")
    ? { id: remaining.id, subject: remaining.subject, status: remaining.status } as RemainingPlanTask
    : undefined;
  return {
    version: 1,
    id: record.id.slice(0, 128),
    phase: record.phase as MissionPhase,
    request: record.request.slice(0, 500),
    activeRunIds: [...new Set(record.activeRunIds.map((runId) => runId.slice(0, 128)))],
    writerActive: record.writerActive,
    wakeAttempts: Math.max(0, Math.min(3, record.wakeAttempts as number)),
    updatedAt: record.updatedAt,
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
  let reviewDispatches = 0;
  let writerOccupied = false;
  let activeWriterAgent: string | undefined;
  let activeWriterRunId: string | undefined;
  let consecutiveWriterFailures = 0;
  let attentionRecovery: { runId: string; index?: number } | undefined;
  let attentionActionObserved = false;
  let attentionRepairRequested = false;
  let remainingPlanTask: RemainingPlanTask | undefined;
  let planContinuationAttempts = 0;
  let mission: MissionState | undefined;
  let mainAgentRunning = false;
  let lastMissionWakeAt = 0;
  let restoreWakeTimer: ReturnType<typeof setTimeout> | undefined;
  let restoreReconcileGeneration = 0;
  const activeDelegationRuns = new Set<string>();
  const delegationToolCalls = new Set<string>();
  const statusToolCalls = new Map<string, { key: string; target?: string }>();
  const activeStatusChecksThisTurn = new Set<string>();
  const resumeToolCalls = new Map<string, { implementation: boolean }>();
  let activeDelegationHandoffPending = false;
  const writerToolCalls = new Map<string, { agent: string; async: boolean }>();
  const terminalWriterRuns = new Map<string, WriterLifecycleStatus>();
  const integratedTerminalRuns = new Set<string>();
  const restoreInterventionMissions = new Set<string>();

  const persistMission = () => {
    if (!mission) return;
    mission.updatedAt = Date.now();
    pi.appendEntry<MissionState>(MISSION_ENTRY, {
      ...mission,
      activeRunIds: [...mission.activeRunIds],
      ...(mission.remainingTask ? { remainingTask: { ...mission.remainingTask } } : {}),
    });
  };

  const ensureMission = (phase: MissionPhase): MissionState => {
    if (!mission || mission.phase === "complete" || mission.phase === "paused") {
      mission = {
        version: 1,
        id: globalThis.crypto.randomUUID(),
        phase,
        request: latestUserRequest.slice(0, 500),
        activeRunIds: [],
        writerActive: false,
        wakeAttempts: 0,
        updatedAt: Date.now(),
        ...(remainingPlanTask ? { remainingTask: { ...remainingPlanTask } } : {}),
      };
    } else {
      mission.phase = phase;
      if (latestUserRequest) mission.request = latestUserRequest.slice(0, 500);
    }
    return mission;
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

  const requestMissionWake = (reason: "plan" | "integration"): boolean => {
    if (!mission || mainAgentRunning) return false;
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
    const task = mission.remainingTask;
    const content = reason === "integration"
      ? MISSION_INTEGRATION
      : `${PLAN_CONTINUATION}${task ? `\n\nStranded task #${task.id}: ${task.subject} (${task.status})` : ""}`;
    pi.sendMessage(
      { customType: `lemonpi-mission-${reason}`, content, display: false },
      { deliverAs: "followUp", triggerTurn: true },
    );
    return true;
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
      requestMissionWake(mission.phase === "integration" ? "integration" : "plan");
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
      if (runId) activeDelegationRuns.delete(runId);
      else activeDelegationRuns.clear();
      if (runId && (disposition === "completed" || disposition === "failed" || disposition === "stopped")) {
        terminal.push({ runId, status: disposition });
      }
    });

    mission.activeRunIds = mission.activeRunIds.filter((runId) => activeDelegationRuns.has(runId));
    const untargetedWriterActive = targets.some((runId, index) => runId === undefined
      && ["active", "needs_attention", "paused"].includes(dispositions[index]!));
    writerOccupied = (mission.activeRunIds.length > 0 || untargetedWriterActive) && mission.writerActive;
    mission.writerActive = writerOccupied;
    activeWriterRunId = mission.activeRunIds.length === 1 && writerOccupied ? mission.activeRunIds[0] : undefined;
    if (!writerOccupied) activeWriterAgent = undefined;
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
      requestMissionWake("integration");
    }
  };

  const restoreMission = (ctx: { sessionManager: { getBranch(): Iterable<unknown> } }) => {
    const restored = replayMissionState(ctx.sessionManager.getBranch());
    restoreReconcileGeneration += 1;
    const generation = restoreReconcileGeneration;
    mission = restored;
    activeDelegationRuns.clear();
    remainingPlanTask = restored?.remainingTask ? { ...restored.remainingTask } : undefined;
    planContinuationAttempts = restored?.wakeAttempts ?? 0;
    writerOccupied = restored?.writerActive ?? false;
    if (restored) restored.activeRunIds.forEach((runId) => activeDelegationRuns.add(runId));
    activeWriterRunId = restored?.writerActive && restored.activeRunIds.length === 1 ? restored.activeRunIds[0] : undefined;
    if (!restored?.writerActive) activeWriterAgent = undefined;
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
    if (!activeDelegationHandoffPending) return;
    return {
      messages: [
        ...event.messages,
        { role: "user", content: ACTIVE_DELEGATION_HANDOFF, timestamp: Date.now() },
      ],
    };
  });

  const missionScheduler = setInterval(() => {
    if (!missionNeedsMain() || mainAgentRunning || missionHasOwnedWork()) return;
    requestMissionWake(mission?.phase === "integration" ? "integration" : "plan");
  }, 5_000);

  pi.on("session_shutdown", async () => {
    if (restoreWakeTimer) clearTimeout(restoreWakeTimer);
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
    const key = terminalRunKey(sessionId, runId);
    if (integratedTerminalRuns.has(key) && !force) return;
    if (mission?.phase === "paused") return;
    rememberTerminalRun(key);
    pi.sendMessage(
      {
        customType: "lemonpi-subagent-integration",
        content: `Delegated run ${runId}${agent ? ` (${agent})` : ""} reached terminal state ${status}. Inspect that exact run's status and result, integrate its findings or changes, perform the appropriate validation, and give the user a concrete progress or completion explanation. Do not launch a duplicate worker for the same completed chunk.`,
        display: false,
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  };

  const settleWriter = (status: WriterLifecycleStatus) => {
    if (status === "paused") return;
    const wasOccupied = writerOccupied;
    if (activeWriterRunId) terminalWriterRuns.delete(activeWriterRunId);
    writerOccupied = false;
    activeWriterAgent = undefined;
    activeWriterRunId = undefined;
    if (mission) {
      mission.writerActive = false;
      if (status !== "paused" && mission.activeRunIds.length === 0 && mission.phase !== "paused") mission.phase = "integration";
      persistMission();
    }
    if (status === "completed") consecutiveWriterFailures = 0;
    if (status === "failed" && wasOccupied) consecutiveWriterFailures += 1;
  };

  pi.events.on("subagent:async-started", (payload) => {
    const runId = delegationRunId(payload);
    if (!runId) return;
    activeDelegationRuns.add(runId);
    activeDelegationHandoffPending = true;
    const currentMission = ensureMission("delegated");
    if (!currentMission.activeRunIds.includes(runId)) currentMission.activeRunIds.push(runId);
    currentMission.wakeAttempts = 0;
    persistMission();
    integratedTerminalRuns.delete(terminalRunKey(delegationSessionId(payload), runId));
  });

  pi.events.on("subagent:async-complete", (payload) => {
    const runId = delegationRunId(payload);
    if (runId) activeDelegationRuns.delete(runId);
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
      if (writerOccupied && activeWriterRunId === runId) settleWriter(status);
      if (status !== "paused") {
        const root = asRecord(payload);
        const sessionId = delegationSessionId(payload);
        const agent = typeof root?.agent === "string" ? root.agent : undefined;
        if (root?.intercomDelivered === true) wakeForTerminalRun(runId, sessionId, status, agent);
        else rememberTerminalRun(terminalRunKey(sessionId, runId));
      }
    }
    const failure = delegationFailure(payload, false);
    if (failure) {
      delegationFailurePending = true;
      lastDelegationFailure = failure;
    }
  });

  pi.on("before_agent_start", async (event) => {
    mainAgentRunning = true;
    return {
      systemPrompt: `${event.systemPrompt}\n\n${NARRATION_CONTRACT}\n\n${ORCHESTRATION_CONTRACT}${attentionRecovery ? `\n\n<lemonpi-attention-recovery>\nRun ${attentionRecovery.runId}${attentionRecovery.index !== undefined ? ` child ${attentionRecovery.index}` : ""} needs intervention now. Inspect and control that exact run before ending this turn.\n</lemonpi-attention-recovery>` : ""}`,
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
      const compiledMessage = appendDefaultChecklist(message, conciseTaskSummary(message));
      const resumedTasks = parseChildChecklist(compiledMessage, CURRENT_CHILD_OWNER);
      if (!message.includes("<lemonpi-child-checklist>")) {
        input.message = `${compiledMessage}${childTodoGuidance(CURRENT_CHILD_OWNER, resumedTasks)}`;
      }
      resumeToolCalls.set(event.toolCallId, {
        implementation: declaredExecutionMode(compiledMessage) === "implementation",
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
      compileDelegationContracts(input);
      specs = delegatedSpecs(input);
      const reviewers = specs.filter((spec) => spec.agent === "reviewer");
      const writers = specs.filter(delegatesImplementation);
      const taskJustifiesReview = reviewers.some((spec) => REVIEW_JUSTIFICATION.test(spec.task));
      const requestExplicitlyRequestsReview = EXPLICIT_REVIEW_REQUEST.test(latestUserRequest);
      const requestHasMaterialRisk = MATERIAL_RISK_REQUEST.test(latestUserRequest);
      const requestExplicitlyRequestsMultipleReviews = EXPLICIT_MULTI_REVIEW_REQUEST.test(latestUserRequest);
      const hadPriorReview = reviewDispatches > 0;

      const invalidAcceptancePath = invalidVerifiedAcceptancePath(input);
      if (invalidAcceptancePath) {
        return {
          block: true,
          reason: `LemonPi blocked ${invalidAcceptancePath}: verified acceptance requires at least one runtime command such as { id: "build", command: "pnpm build", timeoutMs: 120000 }. Commands written in the worker task or reported by the worker do not satisfy this gate. Add acceptance.verify commands, or omit acceptance so Main Pi owns validation. No worker was launched.`,
        };
      }

      if (reviewers.length > 0 && !requestExplicitlyRequestsReview && !requestHasMaterialRisk && !taskJustifiesReview) {
        return {
          block: true,
          reason: "LemonPi dispatch policy blocked a ceremonial reviewer. Main Pi must inspect and validate routine work directly. A reviewer requires an explicit user request, a material risk boundary, or a concrete `Review justification: ...` in the task.",
        };
      }
      if (reviewers.length > 0 && !requestExplicitlyRequestsMultipleReviews && (hadPriorReview || reviewers.length > 1)) {
        return {
          block: true,
          reason: "LemonPi dispatch policy allows at most one reviewer pass per user request. Integrate any blocker, then inspect and validate the repair directly instead of launching a review-repair-review loop.",
        };
      }
      const parallelWriterIssue = parallelWriterPolicyIssue(input);
      if (parallelWriterIssue) {
        return {
          block: true,
          reason: parallelWriterIssue,
        };
      }
      const singletonWriterIssue = singletonWriterPolicyIssue(input, currentAssistantVisibleText);
      if (singletonWriterIssue) {
        return {
          block: true,
          reason: singletonWriterIssue,
        };
      }
      if (writers.length > 0 && writerOccupied) {
        return {
          block: true,
          reason: "LemonPi already has a running or paused writer wave. Respond to the user and steer the relevant existing child if direction changed; do not launch another writer wave until the current one completes, fails, or is stopped.",
        };
      }
      if (writers.length > 0 && consecutiveWriterFailures >= 2) {
        return {
          block: true,
          reason: "LemonPi stopped a third consecutive writer attempt after two failed chunks or waves. Report the exact blocker or ask the user before starting another automatic recovery cycle.",
        };
      }
      if (writers.length > 0) {
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
        if (checkoutIssue) {
          return {
            block: true,
            reason: checkoutIssue,
          };
        }
        appendCheckoutSnapshot(input, checkoutSnapshot);
      }
      const currentMission = ensureMission("delegated");
      currentMission.writerActive = writers.length > 0;
      currentMission.wakeAttempts = 0;
      persistMission();
      if (reviewers.length > 0) reviewDispatches += reviewers.length;
      if (writers.length > 0 && input.clarify !== true) {
        writerOccupied = true;
        activeWriterAgent = writers[0]?.agent;
        activeWriterRunId = undefined;
        writerToolCalls.set(event.toolCallId, { agent: activeWriterAgent ?? "writer", async: input.async !== false });
      }

      if (input.acceptance === undefined) {
        input.acceptance = {
          level: "none",
          reason: "LemonPi makes Main Pi the integration owner unless explicit runtime verify commands are supplied.",
        };
      }
      applyDelegationSafetyContracts(input);
      addChildTodoGuidance(input);
    }

    // pi-subagents supports async natively. LemonPi supplies the product-level
    // default while preserving an explicit foreground request for true gates.
    if (isDelegation && !isManagementAction && input.async === undefined && input.clarify !== true) {
      input.async = true;
    }
    if (isDelegation && !isManagementAction) {
      delegationToolCalls.add(event.toolCallId);
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
      reviewDispatches = 0;
      consecutiveWriterFailures = 0;
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
      if (notifiedRunId) activeDelegationRuns.delete(notifiedRunId);
      activeStatusChecksThisTurn.clear();
      activeDelegationHandoffPending = false;
      if (mission) {
        if (notifiedRunId) mission.activeRunIds = mission.activeRunIds.filter((candidate) => candidate !== notifiedRunId);
        if (mission.phase !== "paused") mission.phase = "integration";
        mission.wakeAttempts = 0;
        persistMission();
      }
      const workerStatus = writerNotificationStatus(notification, activeWriterAgent);
      if (workerStatus) settleWriter(workerStatus);
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
    sawToolActivity = true;
    visibleExplanationAfterLastTool = false;
  });

  pi.on("tool_execution_end", async (event) => {
    const resumedCall = resumeToolCalls.get(event.toolCallId);
    resumeToolCalls.delete(event.toolCallId);
    if (resumedCall && !event.isError) {
      const runId = delegationRunId(event.result);
      if (runId) {
        activeDelegationRuns.add(runId);
        const currentMission = ensureMission("delegated");
        if (!currentMission.activeRunIds.includes(runId)) currentMission.activeRunIds.push(runId);
        if (resumedCall.implementation) {
          writerOccupied = true;
          activeWriterRunId = runId;
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
        if (runId) activeDelegationRuns.delete(runId);
        activeStatusChecksThisTurn.clear();
        activeDelegationHandoffPending = false;
        if (mission) {
          if (runId) mission.activeRunIds = mission.activeRunIds.filter((candidate) => candidate !== runId && !candidate.startsWith(runId) && !runId.startsWith(candidate));
          if (mission.phase !== "paused") mission.phase = "integration";
          mission.writerActive = false;
          mission.wakeAttempts = 0;
          persistMission();
        }
        if (writerOccupied) settleWriter(status);
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
    if (!delegationToolCalls.delete(event.toolCallId)) return;
    const failure = delegationFailure(event.result, event.isError);
    if (!failure) {
      const runId = delegationRunId(event.result);
      if (runId) {
        activeDelegationRuns.add(runId);
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
      } else if (writerCall && writerOccupied) {
        activeWriterRunId = delegationRunId(event.result);
        const terminalStatus = activeWriterRunId ? terminalWriterRuns.get(activeWriterRunId) : undefined;
        if (terminalStatus) settleWriter(terminalStatus);
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
    lastDelegationFailure = failure;
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
      if (requestMissionWake("plan")) {
        planContinuationAttempts += 1;
        return;
      }
    }
    if (mission?.phase === "integration" && !ownedWorkActive && !intentionallyStopped) {
      if (visibleExplanationAfterLastTool && !delegationFailurePending && !attentionRecovery && !remainingPlanTask) {
        mission.phase = "complete";
        mission.wakeAttempts = 0;
        persistMission();
      } else if (requestMissionWake("integration")) {
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
