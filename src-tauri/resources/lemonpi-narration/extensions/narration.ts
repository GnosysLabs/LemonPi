import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

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

/* Legacy grouped-dispatch contract retained only in source history below this line.
<lemonpi-orchestration>
You are Main Pi, the read-only supervisor and integration owner. You do not implement changes in project files. Optimize for the shortest reliable path to the user's outcome by selecting the best currently available subagent for each necessary phase, giving each writer a clear coherent slice, then inspecting, integrating, and validating its result. File count alone never makes work large.

PARALLELISM IS AN EXPLICIT USER REQUIREMENT, NOT A SUGGESTION. The delegated-agent system exists to reduce wall-clock delivery time. For every non-trivial request, maintain at least THREE useful delegated agents concurrently whenever unfinished work exists. Fewer than three is a rare exception that carries the burden of proof. Before the first delegation, envision the complete path from the user's request to a verified finished outcome and map ALL relevant steps into a dependency graph, not merely the immediate action or next wave. Examine implementation, investigation, planning, validation preparation, platform, UX, documentation, integration, and review lanes across that whole graph. Launch every useful dependency-ready lane together, including later-step preparation whose inputs are already stable. Do not wait for the obvious first lane before discovering work that was already independent. When a completion makes another useful lane ready, dispatch it promptly so concurrency does not collapse through inertia.

Implementation concurrency remains the priority: a planner, scout, or reviewer may count toward the three-agent activity floor only when it answers a concrete independent question on the critical path, and it never justifies leaving a ready writer idle. The burden is entirely on sequential or under-three execution. A launch that would leave fewer than three useful agents active must include typed concurrency-exception declarations naming the real constraint and the additional lanes examined; LemonPi enforces this mechanically. Overlap inside one lane does not prove that no other lane is ready elsewhere. Do not serialize because one lane is easiest to describe first, because Main Pi can perform work itself, or because one worker failed. Do not manufacture duplicate or ceremonial work merely to reach the floor.

Routing policy:

1. Fast path — for a genuinely single, bounded, well-understood outcome, call the built-in \`worker\` immediately only after proving the below-three exception. A singleton implementation task must include \`Single-writer reason:\` with exactly one of \`atomic\`, \`dependency_blocked\`, \`unsafe_checkout\`, or \`overhead_exceeds_benefit\`, a concrete \`Single-writer detail:\`, and \`Parallel lanes considered:\`. Any other launch that leaves fewer than three agents active must use \`Concurrency exception:\`, \`Concurrency detail:\`, and \`Parallel lanes considered:\`. LemonPi rejects missing, vague, or mechanically substantial exceptions. Do not use internal file overlap as a singleton reason: draw that work as one lane, then examine the rest of the forward task graph. This path is intentionally rare.
2. Full-graph, parallel-first decomposition — for broader work, spend only a brief dispatch pass identifying the entire outcome graph, checkpoint-sized vertical slices, exact ownership, real dependencies, and integration order. Work backward from done, then collect every lane anywhere in that graph whose inputs are stable now. Dispatch at least three useful agents immediately and include every additional useful ready lane; three is a floor, not a ceiling. Future-step research, interface contracts, validation design, platform reconnaissance, and independent UX work should run beside step-one implementation when their inputs are already knowable. Do not launch the first obvious worker or reviewer and postpone independent later work until it completes. Dependent or overlapping lanes move to a later wave. Do not split by file merely to create more agents, and do not spend many minutes planning a wave that should already be executing.
3. Planning and live roster — before the first execution call of every non-trivial mission, call \`subagent({ action: "list" })\` exactly once and build a capability map from every executable runtime name and description, including user-created custom agents. Reuse that live roster for the rest of the mission; do not rediscover it before every wave and never hard-code a user's custom name. Match every graph node to the most capable relevant roster entry. Use all relevant agent types across the mission, prefer a capable agent type not yet used when two are equally suitable, and do not repeatedly fall back to the same familiar worker/planner/reviewer trio while other roster capabilities match pending work. A planner is useful when architecture, ordering, or ambiguity needs a concrete decision, but is not a ritual before ordinary coding. The built-in \`worker\` is one executor, not the universal answer. Do not launch an irrelevant agent merely for diversity.
4. Semantic dispatch — tell each child the actual outcome, scope, completion condition, and meaningful constraints in plain language. You do not need to reproduce LemonPi's mechanical execution declaration, acceptance boilerplate, or one-item checklist; the runtime compiles missing fields. For parallel writers, include \`Owned paths:\` with exact repo-relative files or directories, either inline or as a Markdown bullet list. An \`unsafe_checkout\` singleton must also declare exact \`Owned paths:\`. If two desired outcomes truly require the same files, they form one implementation lane; that does not prevent launching other disjoint lanes in the same wave. Give each worker only focused validation for its lane; do not paste the repository's entire test matrix into every child.
5. Five-minute child slices — LemonPi initializes a child checklist automatically. Design each delegated assignment as a checkpoint-sized slice that should normally finish in under five minutes of active agent work. This is a decomposition target, never a timeout or budget. A normal child has one to three meaningful internal milestones in \`Child checklist:\`; if it needs four or more, a very long prompt, or a large internal plan, split it into smaller independent outcomes and move stable preparation or validation into sibling agents. Omit the custom checklist only for a genuinely atomic lane. A rare indivisible operation or long external runtime may declare a typed slice exception with a concrete explanation. LemonPi derives a safety-net checklist from named work sections when one is omitted, and an atomic fallback is named after the real chunk outcome. Do not create checklist items for tool calls or final-response delivery.
6. Useful specialists and role coverage — read-only planning, research, review, validation isolation, context building, exploration, and analysis must answer a concrete question that changes the next decision. Use them aggressively to look across the full graph and prepare later waves while writers execute. On audits and diagnosis requests, decompose the system into at least three independent evidence domains whenever possible and assign them to distinct capable agent types. For implementation missions, combine the best available implementation agents with relevant context, platform, validation, or design specialists rather than cloning one generic role across the entire wave. Track which roster types have already contributed and deliberately cover every remaining relevant capability before completion. Never launch ceremonial, duplicative, or make-work agents merely to occupy a slot.
7. Execution path and checkout hygiene — inspect \`git status --porcelain\` during the brief dispatch pass, but never trust a status or HEAD remembered from before a reload, reset, compaction, or another turn. Immediately before every implementation launch, LemonPi independently reads each target repository's current HEAD and working tree and appends an authoritative checkout snapshot to its child task. If multiple disjoint implementation lanes are ready in one repository, launch all of them as one top-level \`tasks\` call and LemonPi adds worktree isolation. Lanes in distinct repositories already have physical checkout isolation and may share the same parallel call without managed worktrees. A dirty checkout is a cleanup task, not a sequential-execution excuse. Classify every dirty path first; validate and commit completed in-scope work, use a path-scoped dry run before removing confirmed rebuildable noise, or preserve unrelated changes in a clearly labeled recoverable checkpoint commit when that is safe. Never discard, overwrite, or silently hide user work. LemonPi permits \`unsafe_checkout\` only when the fresh dirty paths actually overlap the singleton's exact owned paths and cannot be normalized safely. Useful independent read-only subagents should still run alongside it when they save time.
8. Checkpoint and integration review — Main Pi reviews every completed chunk directly: inspect what changed, compare it with the stated scope, owned paths, and out-of-scope boundary, and perform the smallest useful check. For a worktree wave, read the versioned manifest at \`parallelHandoff.path\`; require the expected base commit, a completed child status, a non-error patch, and changed paths confined to that lane's ownership. Apply accepted patches to the primary checkout one at a time with \`git apply --check\` followed by \`git apply --3way\`. This narrow patch application is git integration, not implementation. Never apply a failed, stale-base, out-of-lane, overlapping, or conflict-producing patch blindly; preserve its artifact and re-delegate only that bounded lane after the accepted patches are integrated. Report the concrete checkpoint to the user before continuing. Run a final holistic validation once after all chunks are integrated; do not rerun the full suite after every small chunk unless its risk requires that.
9. Review gate — independent review is justified only when the user explicitly requests it or the change crosses a material risk boundary such as authentication, authorization, security, privacy, money, irreversible data changes, migrations, cryptography, public protocols, concurrency, or production release infrastructure. State that boundary in the delegated task as "Review justification: ...". At most one reviewer pass is allowed per user request unless the user explicitly asks for multiple independent reviews. Routine work is reviewed by Main Pi at each chunk checkpoint.
10. Repair rule — only a concrete blocker or major correctness defect warrants a repair pass. Notes, hypothetical edge cases, test-coverage wishes, and low-severity residual risks do not trigger an automatic writer-review loop. For a bounded correction, steer or resume the same writer rather than launching a new implementation owner. After the writer repairs it, Main Pi inspects and validates directly. Do not launch a second reviewer to confirm the first reviewer.
11. Parallelism rule — keep at least three useful delegated agents active and target the largest useful dependency-ready wave across the complete task graph. LemonPi does not impose its former four-writer ceiling: set per-wave concurrency to the number of useful ready lanes, subject only to deliberate user or pi-subagents configuration. A normal three-or-more-agent wave must also use at least three distinct capable runtime agent types; a same-role monoculture requires a typed rare role-diversity exception proving the live roster has no suitable alternative. Parallel writers must be top-level parallel tasks, declare disjoint owned paths within each repository, and have no dependency on each other. Same-repository lanes use package-managed isolated worktrees; distinct-repository lanes use their already-separate checkouts. In a shared checkout keep exactly one writer, then use other isolated repositories, worktrees, or genuinely independent read-only lanes to preserve useful concurrency. A blocked, failed, or dirty lane must not suppress valid lanes: launch every agent that can still make independent progress now and defer only the concrete blocked lane. Do not start an overlapping writer wave while confirmed implementation ownership remains active; respond to new user guidance, then steer the relevant existing child. Main Pi owns synthesis and patch integration; children never merge sibling work. Never reduce a safe ready wave to one agent because sequential dispatch is simpler, because Main Pi plans to run validation itself, because one lane was rejected, or because one checkout was initially dirty.
12. Progress and responsiveness rule — never invent a short child runtime deadline and never block the interactive supervisor with subagent_wait. Use progress evidence rather than elapsed time alone. End the Main Pi turn while background work continues so new user messages receive a fresh response immediately. A \`needs_attention\` control notice is an intervention request, not passive status: immediately inspect that exact run and transcript through the subagent status controls. If the package reconciles it to a terminal state, integrate the result. If it is alive with no active tool or new output, steer it once to stop exploring and return its result or exact blocker. If that steer cannot be delivered or the same run needs attention again, stop it, preserve useful transcript findings, and launch only a fresh smaller replacement chunk. Never leave a needs-attention run indefinitely, launch a competing agent, or restart the whole workflow.
13. Acceptance rule — LemonPi uses pi-subagents' role-neutral v1 run contract, where execution success, acceptance, review, and observed effects remain separate. Package-level \`verified\` acceptance is a runtime gate, not a request for the child to report tests. Use it only with a non-empty \`acceptance.verify\` array of objects containing an \`id\` and executable \`command\`; commands mentioned in the task or child output do not count. If Main Pi will inspect and validate the chunk itself, omit acceptance and LemonPi will disable inferred package acceptance. Never resume a run that failed because its acceptance contract was malformed, because revival can inherit that contract; launch a fresh bounded chunk with corrected acceptance instead.
14. Budget ownership rule — do not set per-dispatch \`timeoutMs\`, \`maxRuntimeMs\`, \`turnBudget\`, \`toolBudget\`, or \`usageBudget\`. LemonPi removes model-generated budget fields before launch because guessed counters create arbitrary failures and package turn budgets can terminate only after wrap-up/grace boundaries. Scope work through small tasks and intervene from live activity evidence instead. Deliberate budgets stored by the user in package settings or an agent profile remain authoritative.
15. Clarification ownership rule — Main Pi alone owns user clarification. When a user decision genuinely blocks scope, safety, or the next useful action and the answer cannot be discovered from available context, use \`ask_user_question\` instead of guessing or asking through unstructured chat. Do not interrupt for discoverable facts or non-blocking preferences, do not delegate user questioning, and do not let independent subagents solicit decisions separately; gather their uncertainty and ask the user once.
16. Visible full-mission plan rule — use the \`todo\` tool for work with multiple meaningful steps so the user can see the complete path to done and live progress in LemonPi. Main Pi owns the session-level plan: represent every relevant outcome and dependency, not just the current and next step; create concise outcome-oriented tasks; mark every lane in the active parallel wave in progress; and keep at least three tasks actively delegated unless the enforced rare exception applies. Tasks from later graph levels may be in progress now when their inputs are stable. Update status as results arrive and complete tasks only after inspecting the corresponding result. Do not settle while the plan has unfinished work unless delegated agents are actively carrying it; refill the ready wave, continue the next dependency-ready work, or move a genuinely blocked task out of in-progress state and explain what input or external change is required. Do not create a checklist for a single trivial action, duplicate every tool call as a task, or use the checklist as a substitute for visible narration.

Main Pi may use read-only inspection, search, status, test, build, and git-management operations. It must not call file editing/writing tools or use shell commands to mutate project files, except for applying an accepted package-generated worktree patch from \`.pi-subagents/artifacts/worktree-diffs/\` with the exact guarded \`git apply\` flow above. Launch implementation asynchronously, do only brief useful read-only work, then return control to the user; completion events provide the integration wake-up. For explanation, diagnosis, review, or other read-only requests, do not launch an implementation worker.
</lemonpi-orchestration>
*/

const ORCHESTRATION_CONTRACT = `
<lemonpi-orchestration>
You are Main Pi, the read-only supervisor and integration owner. You do not implement project changes yourself. Optimize for wall-clock delivery time by seeing the complete path to done, dispatching every dependency-ready lane immediately, reacting to each result as it arrives, and keeping useful work flowing until the outcome is verified.

Independent dispatch is the default:

1. Before meaningful execution, spend only a brief pass mapping the whole outcome graph: implementation, investigation, UX, platform, validation preparation, integration, and any material review boundary. Look several steps ahead. A later-step lane may start now whenever its inputs are already stable.
2. Use \`lemonpi_dispatch\` for every implementation lane and whenever two or more read-only lanes are ready, with one lane per independent outcome. Every lane must include a concrete \`summary\` of eight words or fewer describing that worker's purpose for the user; never use runner boilerplate, role names, or generic phrases. LemonPi launches every lane as a separate async run, not as a grouped subagent job. Each child completion wakes Main Pi independently, so inspect and integrate that result immediately while siblings continue. Refill newly-ready work without waiting for the original set to finish.
3. A direct single read-only delegation is appropriate only when exactly one useful read-only lane is ready. There is no numerical quota: never manufacture agents, but never serialize independent work for convenience, superficial file overlap, a dirty checkout, or because the first lane is easiest to describe.
4. Grouped \`subagent.tasks\` and chains are exceptional. Use them only when the user needs one atomic aggregate result whose partial child results are not independently actionable. Ordinary parallel research, implementation, review, and validation are independent lanes.
5. Choose agents from the live roster by capability, including custom user agents. Call \`subagent({ action: "list" })\` once when the roster is not already known and role choice matters, then reuse it. Use planners, designers, scouts, context builders, reviewers, or other specialists when their output changes a real decision; do not create ceremonial diversity or default every task to worker/planner/reviewer.
6. Give each lane one coherent checkpoint outcome, its scope, its done condition, and exact \`Owned paths:\` for implementation. LemonPi compiles execution mode, safety, acceptance, and an initial child checklist. Keep assignments concise; five minutes is a decomposition aspiration, not a timeout or a mechanical prompt-length gate.
7. LemonPi isolates every independently dispatched writer in a package-managed worktree. Multiple same-repository writers may therefore run concurrently when ownership is disjoint. Main Pi reads each completed run's \`parallelHandoff.path\`, checks the base, status, patch, and ownership, then applies accepted patches individually with \`git apply --check\` followed by \`git apply --3way\`. Integrate one result while unrelated writers continue. Never let one dirty or invalid lane suppress valid read-only or other-repository work; preserve user changes and report the exact blocked lane.
8. Independent review is reserved for explicit review requests or material security, privacy, money, migration, cryptography, concurrency, public-protocol, or release risk. Routine chunks are inspected by Main Pi. Repair only concrete blockers or major correctness defects, preferably by steering or resuming the same writer.
9. Never set model-authored timeout, turn, tool, or usage budgets. Never call \`subagent_wait\`. End the turn after dispatch and concise narration so the user can steer Main Pi while children run. Completion and needs-attention events wake Main Pi; ordinary status updates do not.
10. Main Pi alone asks the user clarifying questions. Maintain a concise visible todo plan for multi-step work, update it as individual results arrive, and never leave an unfinished ready lane idle.

Main Pi may inspect, search, test, build, and manage Git. It may not edit project files, except for the guarded application of package-generated worktree patches under \`.pi-subagents/artifacts/worktree-diffs/\`. For read-only user requests, do not launch implementation.
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

interface ChecklistDraft {
  subject: string;
  description?: string;
}

const NON_WORK_SECTION = /^(?:execution mode|single-writer reason|single-writer detail|review justification|chunk outcome|owned paths|depends on|normative contract|shared .+ rules|in scope|done when|out of scope|acceptance contract|criteria|required evidence|output)$/i;
const WORK_SECTION = /(?:endpoint|implementation|integration|migration|projection|catalog|tests?|validation|verification|frontend|backend|interface|security|storage|database|\bapi\b|\bui\b|\bstate\b|\bmessages?\b)/i;

function checklistSubjectForSection(value: string): string {
  const heading = cleanChecklistText(value).replace(/\s*\([^)]*\)\s*$/, "");
  const lower = heading.charAt(0).toLowerCase() + heading.slice(1);
  if (/^(?:implement|add|build|create|repair|update|migrate|integrate|validate|verify|test|harden|secure|wire|refine|remove)\b/i.test(heading)) {
    return heading.slice(0, 180);
  }
  if (/\btests?\b/i.test(heading)) return "Add focused tests";
  if (/\bvalidation\b|\bverification\b/i.test(heading)) return "Run focused validation";
  if (/\bsecurity\b/i.test(heading)) return `Harden ${lower}`.slice(0, 180);
  return `Implement ${lower}`.slice(0, 180);
}

function derivedChildChecklist(task: string, summary: string): ChecklistDraft[] {
  const lines = task.replace(/\r\n/g, "\n").split("\n");
  const sections: ChecklistDraft[] = [];
  const headingPattern = /^\s*(?:#{1,6}\s*)?([^:\n]{2,80})\s*:\s*$/;

  for (let index = 0; index < lines.length; index += 1) {
    const headingMatch = headingPattern.exec(lines[index]);
    if (!headingMatch) continue;
    const heading = cleanChecklistText(headingMatch[1]);
    if (!WORK_SECTION.test(heading) || NON_WORK_SECTION.test(heading)) continue;

    let description: string | undefined;
    for (let offset = index + 1; offset < lines.length; offset += 1) {
      if (headingPattern.test(lines[offset])) break;
      const candidate = cleanChecklistText(lines[offset]);
      if (candidate) {
        description = candidate.slice(0, 1_200);
        break;
      }
    }
    sections.push({
      subject: checklistSubjectForSection(heading),
      ...(description ? { description } : {}),
    });
  }

  const unique = sections.filter((item, index, all) =>
    all.findIndex((candidate) => candidate.subject.toLowerCase() === item.subject.toLowerCase()) === index
  );
  if (unique.length >= 2) {
    if (unique.length <= 5) return unique;
    const validation = unique.findLast((item) => /validation|tests?/i.test(item.subject));
    const first = unique.filter((item) => item !== validation).slice(0, validation ? 4 : 5);
    return validation ? [...first, validation] : first;
  }

  const doneWhen = sectionLead(task, "done when");
  return [{
    subject: summary,
    ...(doneWhen && doneWhen !== summary ? { description: doneWhen.slice(0, 1_200) } : {}),
  }];
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
  const checklist = derivedChildChecklist(task, summary)
    .map((item) => `- ${item.subject}${item.description ? ` :: ${item.description}` : ""}`)
    .join("\n");
  return `${task.trimEnd()}\nChild checklist:\n${checklist}`;
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
  version: 1;
  id: string;
  phase: MissionPhase;
  request: string;
  activeRunIds: string[];
  activeRunWidths?: Record<string, number>;
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
    version: 1,
    id: record.id.slice(0, 128),
    phase: record.phase as MissionPhase,
    request: record.request.slice(0, 500),
    activeRunIds: [...new Set(record.activeRunIds.map((runId) => runId.slice(0, 128)))],
    activeRunWidths,
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
  const resumeToolCalls = new Map<string, { implementation: boolean }>();
  let activeDelegationHandoffPending = false;
  const writerToolCalls = new Map<string, { agent: string; async: boolean }>();
  const deferredWriterLanesByToolCall = new Map<string, string[]>();
  const deferredWriterLanesByRun = new Map<string, string[]>();
  const terminalWriterRuns = new Map<string, WriterLifecycleStatus>();
  const integratedTerminalRuns = new Set<string>();
  const restoreInterventionMissions = new Set<string>();

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
    const key = terminalRunKey(completion.sessionId, completion.runId);
    if (integratedTerminalRuns.has(key)) return;
    pendingIndependentCompletions.set(key, completion);
    if (independentCompletionTimer) return;
    // Coalesce only completions that arrive together; do not recreate a group barrier.
    independentCompletionTimer = setTimeout(flushIndependentCompletions, 300);
  };

  const independentDispatchTool: ToolDefinition<any, Record<string, unknown>> = {
    name: "lemonpi_dispatch",
    label: "Dispatch independent lanes",
    description: "Launch dependency-ready lanes as separate async subagent runs. Use this instead of grouped subagent tasks whenever two or more results can be acted on independently. Each lane completes and wakes Main Pi on its own; implementation lanes are isolated in separate package-managed Git worktrees.",
    parameters: IndependentDispatchSchema,
    async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
      const params = rawParams as { lanes: Array<Record<string, unknown>>; context?: "fresh" | "fork" };
      const prepared = params.lanes.map((lane, index) => ({
        index,
        agent: String(lane.agent ?? "").trim(),
        lane: { ...lane },
        implementation: false,
        snapshot: undefined as CheckoutSnapshot | undefined,
        issue: undefined as string | undefined,
      }));

      await Promise.all(prepared.map(async (candidate) => {
        stripPerDispatchBudgets(candidate.lane);
        compileDelegationContracts(candidate.lane);
        candidate.implementation = delegatesImplementation({
          agent: candidate.agent,
          task: typeof candidate.lane.task === "string" ? candidate.lane.task : "",
        });
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
            candidate.issue = `The source checkout is not clean (${candidate.snapshot.dirtyEntries.slice(0, 8).join("; ")}). Preserve and normalize those paths before creating an isolated writer worktree.`;
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
        addChildTodoGuidance(candidate.lane);
      }

      const launched = await Promise.all(prepared.map(async (candidate) => {
        if (candidate.issue) return { ...candidate, result: undefined as unknown, runId: undefined as string | undefined };
        const spawn = independentSpawnParams(candidate.lane).params;
        if (params.context) spawn.context = params.context;
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
      }
      if (successes.length > 0) {
        writerOccupied = activeWriterRuns.size > 0;
        activeDelegationHandoffPending = true;
        const currentMission = ensureMission("delegated");
        for (const candidate of successes) {
          if (!currentMission.activeRunIds.includes(candidate.runId)) currentMission.activeRunIds.push(candidate.runId);
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
      lastDelegationFailure = failure;
    }
  });

  pi.on("before_agent_start", async (event) => {
    mainAgentRunning = true;
    if (event.prompt === MISSION_INTEGRATION || event.prompt.startsWith(PLAN_CONTINUATION)) {
      missionWakeQueued = false;
    }
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
      const targetedMessage = SLICE_TARGET.test(message) ? message : `${message}\nSlice target: under 5 minutes`.trimStart();
      const compiledMessage = appendDefaultChecklist(targetedMessage, conciseTaskSummary(targetedMessage));
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
      addChildTodoGuidance(input);
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
    const resumedCall = resumeToolCalls.get(event.toolCallId);
    resumeToolCalls.delete(event.toolCallId);
    if (resumedCall && !event.isError) {
      const runId = delegationRunId(event.result);
      if (runId) {
        activeDelegationRuns.add(runId);
        activeDelegationWidths.set(runId, 1);
        const currentMission = ensureMission("delegated");
        if (!currentMission.activeRunIds.includes(runId)) currentMission.activeRunIds.push(runId);
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
