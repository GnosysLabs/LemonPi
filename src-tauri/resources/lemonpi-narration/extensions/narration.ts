import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SUBAGENT_STEER_PREFIX = "__lemonpi_subagent_steer_v1__:";
const SUBAGENT_STOP_PREFIX = "__lemonpi_subagent_stop_v1__:";
const SUBAGENT_RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
const SUBAGENT_RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:";
const SUBAGENT_RPC_TIMEOUT_MS = 6_000;

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
You are Main Pi, the read-only supervisor and integration owner. You do not implement changes in project files. Optimize for the shortest reliable path to the user's outcome by selecting the best currently available subagent for each necessary phase, giving one writer a clear coherent slice, then inspecting and validating its result. File count alone never makes work large.

Routing policy:

1. Decomposition rule — first decide whether the request is already one small, independently verifiable outcome. If it is broader, divide it into ordered vertical chunks before implementation: each chunk should leave the workspace coherent, be reviewable on its own, and reduce uncertainty for the next chunk. Prefer boundaries such as foundation, one behavior, integration, then polish; do not split into arbitrary file-by-file chores or tiny edits that add handoff overhead.
2. Planning rule — planner is the default preparation role when work needs multiple chunks, changes architecture, crosses subsystems, has important ordering constraints, or remains ambiguous after brief inspection. Give planner the requirements and ask for an ordered implementation plan with boundaries, dependencies, risks, and validation points. For a single bounded and well-understood change, skip planning and dispatch directly. Do not run planner before every trivial edit, and do not ask planner to implement.
3. Live roster and dynamic role rule — at the start of each new user task, call the subagent tool with \`{ action: "list" }\` before selecting or launching any child. Treat its executable-agent output as the authoritative capability registry: it includes built-in, packaged, user, and project agents with their exact runtime names and descriptions. Consider every listed agent, choose autonomously from those descriptions, and invoke the best match by the exact returned name; the user does not need to name or request a custom agent. If a description leaves writing authority or capabilities unclear, inspect that candidate with \`{ action: "get", agent: "<exact-name>" }\`. Never assume an optional or custom role exists, hardcode behavior for a custom agent name, or restrict routing to a fixed allowlist. Built-in roles such as scout, researcher, context-builder, planner, oracle/advisor, worker, and reviewer are examples rather than the complete roster. A listed custom specialist is a first-class candidate for any phase its description matches, including serving as the sole writer. Ignoring a clearly matched listed agent is wrong; invoking every role ceremonially is also wrong. Do not rediscover the roster before every chunk in the same task unless it may have changed.
4. Useful-output rule — every specialist dispatch must name the concrete question it will answer and how that answer changes the next decision or chunk. Prefer one well-matched specialist over a chain of generic handoffs. Read-only specialists may run concurrently only when their outputs are independent and immediately useful.
5. Chunk contract — every implementation task, regardless of which available agent performs it, must state exactly four fields: \`Chunk outcome:\`, \`In scope:\`, \`Done when:\`, and \`Out of scope:\`. Give the writer only the current chunk, plus enough surrounding context to avoid incompatible decisions. Explicitly exclude later chunks. A chunk should normally cover one user-visible behavior or one architectural seam and have a short, observable acceptance condition.
6. Fast path — a bounded, well-understood, low-risk request is one chunk. Give the best matched available executor that complete small outcome, avoid planning and review ceremony, inspect the result, and run one proportionate validation pass.
7. Sequential path — for broader work, consume the planner's output and dispatch only the first implementation chunk. When it completes, inspect the actual diff and evidence before doing anything else. Confirm the chunk's acceptance condition, identify regressions or newly learned constraints, and either steer/resume the same writer for a bounded correction or dispatch the next chunk with updated context. Never hand one writer the entire backlog "for completeness."
8. Checkpoint review — Main Pi reviews every completed chunk directly: inspect what changed, compare it with the stated scope and out-of-scope boundary, and perform the smallest useful check. Report the concrete checkpoint to the user before continuing. Run a final holistic validation once after all chunks are integrated; do not rerun the full suite after every small chunk unless its risk requires that.
9. Review gate — independent review is justified only when the user explicitly requests it or the change crosses a material risk boundary such as authentication, authorization, security, privacy, money, irreversible data changes, migrations, cryptography, public protocols, concurrency, or production release infrastructure. State that boundary in the delegated task as "Review justification: ...". At most one reviewer pass is allowed per user request unless the user explicitly asks for multiple independent reviews. Routine work is reviewed by Main Pi at each chunk checkpoint.
10. Repair rule — only a concrete blocker or major correctness defect warrants a repair pass. Notes, hypothetical edge cases, test-coverage wishes, and low-severity residual risks do not trigger an automatic writer-review loop. For a bounded correction, steer or resume the same writer rather than launching a new implementation owner. After the writer repairs it, Main Pi inspects and validates directly. Do not launch a second reviewer to confirm the first reviewer.
11. Parallelism rule — parallelize only independent work. In a shared checkout keep exactly one writer; concurrent work must be read-only and useful regardless of the writer's result. A new user message never authorizes a second writer while the current writer is running or paused: respond to the user, then steer the existing writer if needed.
12. Progress and responsiveness rule — never invent a short child runtime deadline and never block the interactive supervisor with subagent_wait. Use progress evidence rather than elapsed time alone. End the Main Pi turn while background work continues so new user messages receive a fresh response immediately. A \`needs_attention\` control notice is an intervention request, not passive status: immediately inspect that exact run and transcript through the subagent status controls. If the package reconciles it to a terminal state, integrate the result. If it is alive with no active tool or new output, steer it once to stop exploring and return its result or exact blocker. If that steer cannot be delivered or the same run needs attention again, stop it, preserve useful transcript findings, and launch only a fresh smaller replacement chunk. Never leave a needs-attention run indefinitely, launch a competing agent, or restart the whole workflow.
13. Acceptance rule — package-level \`verified\` acceptance is a runtime gate, not a request for the child to report tests. Use it only with a non-empty \`acceptance.verify\` array of objects containing an \`id\` and executable \`command\`; commands mentioned in the task or child output do not count. If Main Pi will inspect and validate the chunk itself, omit acceptance and LemonPi will disable inferred package acceptance. Never resume a run that failed because its acceptance contract was malformed, because revival can inherit that contract; launch a fresh bounded chunk with corrected acceptance instead.
14. Budget ownership rule — do not set per-dispatch \`timeoutMs\`, \`maxRuntimeMs\`, \`turnBudget\`, \`toolBudget\`, or \`usageBudget\`. LemonPi removes model-generated budget fields before launch because guessed counters create arbitrary failures and package turn budgets can terminate only after wrap-up/grace boundaries. Scope work through small tasks and intervene from live activity evidence instead. Deliberate budgets stored by the user in package settings or an agent profile remain authoritative.
15. Clarification ownership rule — Main Pi alone owns user clarification. When a user decision genuinely blocks scope, safety, or the next useful action and the answer cannot be discovered from available context, use \`ask_user_question\` instead of guessing or asking through unstructured chat. Do not interrupt for discoverable facts or non-blocking preferences, do not delegate user questioning, and do not let independent subagents solicit decisions separately; gather their uncertainty and ask the user once.

Main Pi may use read-only inspection, search, status, test, build, and git-management operations. It must not call file editing/writing tools or use shell commands to mutate project files. Launch implementation asynchronously, do only brief useful read-only work, then return control to the user; completion events provide the integration wake-up. For explanation, diagnosis, review, or other read-only requests, do not launch an implementation worker.
</lemonpi-orchestration>`;

const CLOSING_REPAIR = `The previous response ended after tool activity without a visible closing explanation. Do not call more tools. Give the user a concise, specific closing explanation now: state the outcome, what changed, what was verified, and any blocker or next step. If the task is incomplete, say exactly where it stopped and why.`;
const DELEGATION_RECOVERY = `A delegated run failed and no replacement delegation was launched before the turn settled. Own the failure now: inspect the exact status/error and any partial output, identify whether the cause was a parent-imposed timeout, unavailable model/tool, configuration problem, or task failure, preserve valid partial work, and re-delegate only the next bounded chunk with corrected instructions and the required chunk-contract fields. Shrink the task instead of adding a per-dispatch timeout, turn budget, tool budget, or usage budget. If the error says the model produced no output or returned an empty response, do not resume the bloated failed session: salvage concrete transcript findings and launch a fresh-context replacement with a smaller question and explicit deliverable. If retrying cannot help because the blocker is external, give the user the exact blocker and the evidence instead of claiming recovery.`;
const ATTENTION_RECOVERY = `A delegated run reported needs_attention and the previous response did not inspect or control it. Act now instead of narrating passive waiting. Use the subagent status/transcript controls for the exact run. If it remains alive without an active tool or new output, steer it once to return its result or blocker immediately. If intervention cannot be delivered, stop it and preserve useful transcript findings for one fresh, smaller replacement. Do not leave it marked running indefinitely and do not launch a competing writer.`;

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

function requestSubagentControl(
  pi: ExtensionAPI,
  method: "steer" | "stop",
  params: { id: string; index?: number; message?: string },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const requestId = globalThis.crypto.randomUUID();
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout>;
    const unsubscribe = pi.events.on(`${SUBAGENT_RPC_REPLY_PREFIX}${requestId}`, (payload) => {
      const reply = payload as { requestId?: string; success?: boolean; error?: { message?: string } };
      if (reply.requestId !== requestId || settled) return;
      settled = true;
      clearTimeout(timeoutId);
      unsubscribe();
      if (reply.success === true) resolve();
      else reject(new Error(reply.error?.message ?? `The subagent rejected the ${method} request.`));
    });
    timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      unsubscribe();
      reject(new Error(`The subagent did not acknowledge the ${method} request.`));
    }, SUBAGENT_RPC_TIMEOUT_MS);

    pi.events.emit(SUBAGENT_RPC_REQUEST_EVENT, {
      version: 1,
      requestId,
      method,
      params,
    });
  });
}

function requestSubagentSteer(pi: ExtensionAPI, id: string, index: number, message: string): Promise<void> {
  return requestSubagentControl(pi, "steer", { id, index, message });
}

function requestSubagentStop(pi: ExtensionAPI, id: string): Promise<void> {
  return requestSubagentControl(pi, "stop", { id });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

const MATERIAL_RISK_REQUEST = /\b(?:security|authentication|authorization|permissions?|privacy|credentials?|secrets?|payments?|billing|money|database|schema|migration|data loss|destructive|encryption|cryptograph\w*|public protocol|concurren\w*|race condition|production deploy\w*|release infrastructure|code signing|notari[sz]ation|auto[- ]?update)\b/i;
const EXPLICIT_REVIEW_REQUEST = /\b(?:review|audit|second opinion|independent verification|threat model)\b/i;
const EXPLICIT_MULTI_REVIEW_REQUEST = /\b(?:multiple|several|two|three|parallel|independent)\b.{0,32}\b(?:reviews?|reviewers?|audits?)\b|\b(?:reviews?|reviewers?|audits?)\b.{0,32}\b(?:multiple|several|two|three|parallel|independent)\b/i;
const REVIEW_JUSTIFICATION = /\breview justification:\s*(?!none\b|n\/a\b)[^\n]{8,}/i;
const CHUNK_OUTCOME = /\bchunk outcome\s*:/i;
const CHUNK_IN_SCOPE = /\bin scope\s*:/i;
const CHUNK_DONE_WHEN = /\bdone when\s*:/i;
const CHUNK_OUT_OF_SCOPE = /\bout of scope\s*:/i;
const MAIN_MUTATION_TOOLS = new Set(["edit", "write", "apply_patch", "patch", "write_file", "edit_file", "create_file", "delete_file", "move_file"]);
const IMPLEMENTATION_TASK = /\b(?:implement|edit|modify|fix|add|remove|refactor|wire|style|replace|rename|delete|patch)\b/i;
const EXPLICIT_READ_ONLY_TASK = /\b(?:read[- ]only|no code changes|do not (?:edit|write|modify)|without (?:editing|writing|modifying)|plan only|report only|analysis only)\b/i;

interface DelegatedSpec {
  agent: string;
  task: string;
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

function delegatesImplementation(spec: DelegatedSpec): boolean {
  return hasBoundedChunkContract(spec.task)
    || (IMPLEMENTATION_TASK.test(spec.task) && !EXPLICIT_READ_ONLY_TASK.test(spec.task));
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

function delegationRunId(value: unknown): string | undefined {
  const result = asRecord(value);
  const details = asRecord(result?.details);
  const candidate = details?.runId ?? details?.asyncId ?? result?.runId ?? result?.id;
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : undefined;
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
  const command = typeof input.command === "string"
    ? input.command
    : typeof input.cmd === "string"
      ? input.cmd
      : "";
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

export default function lemonPiNarration(pi: ExtensionAPI) {
  let sawToolActivity = false;
  let visibleExplanationAfterLastTool = false;
  let lastAssistantStopReason: string | undefined;
  let repairRequested = false;
  let delegationFailurePending = false;
  let lastDelegationFailure: string | undefined;
  let latestUserRequest = "";
  let reviewDispatches = 0;
  let writerOccupied = false;
  let activeWriterAgent: string | undefined;
  let activeWriterRunId: string | undefined;
  let consecutiveWriterFailures = 0;
  let rosterInspected = false;
  let rosterGeneration = 0;
  let attentionRecovery: { runId: string; index?: number } | undefined;
  let attentionActionObserved = false;
  let attentionRepairRequested = false;
  const delegationToolCalls = new Set<string>();
  const rosterListToolCalls = new Map<string, number>();
  const writerToolCalls = new Map<string, { agent: string; async: boolean }>();
  const terminalWriterRuns = new Map<string, WriterLifecycleStatus>();

  const settleWriter = (status: WriterLifecycleStatus) => {
    if (status === "paused") return;
    const wasOccupied = writerOccupied;
    if (activeWriterRunId) terminalWriterRuns.delete(activeWriterRunId);
    writerOccupied = false;
    activeWriterAgent = undefined;
    activeWriterRunId = undefined;
    if (status === "completed") consecutiveWriterFailures = 0;
    if (status === "failed" && wasOccupied) consecutiveWriterFailures += 1;
  };

  pi.events.on("subagent:async-complete", (payload) => {
    const runId = delegationRunId(payload);
    const status = writerLifecycleStatus(payload);
    if (runId && status) {
      terminalWriterRuns.set(runId, status);
      if (terminalWriterRuns.size > 64) terminalWriterRuns.delete(terminalWriterRuns.keys().next().value!);
      if (writerOccupied && activeWriterRunId === runId) settleWriter(status);
    }
    const failure = delegationFailure(payload, false);
    if (failure) {
      delegationFailurePending = true;
      lastDelegationFailure = failure;
    }
  });

  pi.on("before_agent_start", async (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${NARRATION_CONTRACT}\n\n${ORCHESTRATION_CONTRACT}${attentionRecovery ? `\n\n<lemonpi-attention-recovery>\nRun ${attentionRecovery.runId}${attentionRecovery.index !== undefined ? ` child ${attentionRecovery.index}` : ""} needs intervention now. Inspect and control that exact run before ending this turn.\n</lemonpi-attention-recovery>` : ""}`,
  }));

  pi.on("input", async (event, ctx) => {
    if (event.source !== "rpc") return { action: "continue" };

    const isSteerRequest = event.text.startsWith(SUBAGENT_STEER_PREFIX);
    const isStopRequest = event.text.startsWith(SUBAGENT_STOP_PREFIX);
    if (!isSteerRequest && !isStopRequest) return { action: "continue" };

    try {
      const prefix = isSteerRequest ? SUBAGENT_STEER_PREFIX : SUBAGENT_STOP_PREFIX;
      const payload = JSON.parse(event.text.slice(prefix.length)) as {
        runId?: unknown;
        index?: unknown;
        message?: unknown;
      };
      const runId = typeof payload.runId === "string" ? payload.runId.trim() : "";
      if (!/^[A-Za-z0-9-]{4,128}$/.test(runId)) {
        throw new Error(`The subagent ${isSteerRequest ? "steering" : "stop"} request was malformed.`);
      }

      if (isSteerRequest) {
        const index = typeof payload.index === "number" ? payload.index : -1;
        const message = typeof payload.message === "string" ? payload.message.trim() : "";
        if (!Number.isInteger(index) || index < 0 || !message || message.length > 4_000) {
          throw new Error("The subagent steering request was malformed.");
        }
        await requestSubagentSteer(pi, runId, index, message);
        ctx.ui.notify("Steer delivered directly to the subagent.", "info");
      } else {
        await requestSubagentStop(pi, runId);
        ctx.ui.notify("Stop requested directly for the subagent.", "info");
      }
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    }
    return { action: "handled" };
  });

  pi.on("tool_call", async (event) => {
    if (process.env.PI_SUBAGENT_CHILD === "1") return;

    const input = event.input as Record<string, unknown>;
    if (event.toolName === "subagent_wait") {
      return {
        block: true,
        reason: "LemonPi keeps Main Pi interruptible while background workers run. Do not wait inside this turn. Give the user a concise status update and end the turn; the worker remains active, completion will wake Main Pi, and any new user message can be answered immediately and used to steer the worker.",
      };
    }
    if (MAIN_MUTATION_TOOLS.has(event.toolName) || (["bash", "shell"].includes(event.toolName) && shellMutatesProject(input))) {
      return {
        block: true,
        reason: "Main Pi is LemonPi's read-only orchestrator and may not mutate project files. Choose the best matching writable agent from the live roster, or steer/resume the existing writer for a correction. Main Pi should inspect and validate the result.",
      };
    }
    if (event.toolName !== "subagent") return;

    const isManagementAction = typeof input.action === "string" && input.action.trim().length > 0;
    if (input.action === "list") rosterListToolCalls.set(event.toolCallId, rosterGeneration);
    if (attentionRecovery && ["status", "steer", "stop"].includes(String(input.action ?? ""))) {
      const target = typeof input.id === "string" ? input.id : typeof input.runId === "string" ? input.runId : "";
      if (!target || attentionRecovery.runId.startsWith(target) || target.startsWith(attentionRecovery.runId)) {
        attentionActionObserved = true;
      }
    }
    const specs = delegatedSpecs(input);
    const isDelegation = specs.length > 0;

    if (isDelegation && !isManagementAction) {
      stripPerDispatchBudgets(input);
      if (!rosterInspected) {
        return {
          block: true,
          reason: "LemonPi requires live agent discovery before delegation. Call the subagent tool with { action: \"list\" }, read every executable agent's exact name and description, then autonomously choose the best match. Custom user and project agents are first-class candidates; do not wait for the user to name one.",
        };
      }
      const reviewers = specs.filter((spec) => spec.agent === "reviewer");
      const writers = specs.filter(delegatesImplementation);
      const taskJustifiesReview = reviewers.some((spec) => REVIEW_JUSTIFICATION.test(spec.task));
      const requestExplicitlyRequestsReview = EXPLICIT_REVIEW_REQUEST.test(latestUserRequest);
      const requestHasMaterialRisk = MATERIAL_RISK_REQUEST.test(latestUserRequest);
      const requestExplicitlyRequestsMultipleReviews = EXPLICIT_MULTI_REVIEW_REQUEST.test(latestUserRequest);
      const hadPriorReview = reviewDispatches > 0;

      const unboundedImplementationTask = writers.find((spec) => !hasBoundedChunkContract(spec.task));
      if (unboundedImplementationTask) {
        return {
          block: true,
          reason: `LemonPi requires a bounded implementation chunk for ${unboundedImplementationTask.agent}. Rewrite the task with \`Chunk outcome:\`, \`In scope:\`, \`Done when:\`, and \`Out of scope:\`. Delegate only the current independently reviewable chunk, not the remaining backlog.`,
        };
      }

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
      if (writers.length > 1 && input.worktree !== true) {
        return {
          block: true,
          reason: "LemonPi dispatch policy allows only one writer in a shared checkout. Use one coherent implementation owner, or explicit isolated worktrees for genuinely independent parallel slices.",
        };
      }
      if (writers.length > 0 && writerOccupied) {
        return {
          block: true,
          reason: "LemonPi already has a running or paused writer in this checkout. Respond to the user and steer that worker if direction changed; do not launch another writer until the current chunk completes, fails, or is stopped.",
        };
      }
      if (writers.length > 0 && consecutiveWriterFailures >= 2) {
        return {
          block: true,
          reason: "LemonPi stopped a third consecutive writer attempt after two failed chunks. Report the exact blocker or ask the user before starting another automatic recovery cycle.",
        };
      }
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
    if (event.message.role === "user" && message.customType == null) {
      sawToolActivity = false;
      visibleExplanationAfterLastTool = false;
      lastAssistantStopReason = undefined;
      repairRequested = false;
      delegationFailurePending = false;
      lastDelegationFailure = undefined;
      latestUserRequest = notification;
      reviewDispatches = 0;
      consecutiveWriterFailures = 0;
      rosterInspected = false;
      rosterGeneration += 1;
      if (attentionRecovery) attentionRepairRequested = false;
    }
    if (message.customType === "subagent_control_notice" && message.details?.event?.to === "needs_attention") {
      const runId = typeof message.details.event.runId === "string" ? message.details.event.runId.trim() : "";
      const index = typeof message.details.event.index === "number" && Number.isInteger(message.details.event.index)
        ? message.details.event.index
        : undefined;
      if (runId) {
        attentionRecovery = { runId, ...(index !== undefined ? { index } : {}) };
        attentionActionObserved = false;
        attentionRepairRequested = false;
      }
    }
    if (message.customType === "subagent-notify") {
      const workerStatus = writerNotificationStatus(notification, activeWriterAgent);
      if (workerStatus) settleWriter(workerStatus);
      sawToolActivity = false;
      visibleExplanationAfterLastTool = false;
      lastAssistantStopReason = undefined;
      repairRequested = false;
      delegationFailurePending = /^(Background task|Detached foreground task) failed:/m.test(notification);
      lastDelegationFailure = delegationFailurePending ? notification.slice(0, 800) : undefined;
    }
  });

  pi.on("message_end", async (event) => {
    if (event.message.role !== "assistant") return;
    visibleExplanationAfterLastTool = Boolean(visibleText(event.message.content));
    lastAssistantStopReason = event.message.stopReason;
  });

  pi.on("tool_execution_start", async () => {
    sawToolActivity = true;
    visibleExplanationAfterLastTool = false;
  });

  pi.on("tool_execution_end", async (event) => {
    const listedRosterGeneration = rosterListToolCalls.get(event.toolCallId);
    rosterListToolCalls.delete(event.toolCallId);
    if (listedRosterGeneration === rosterGeneration) {
      rosterInspected = !event.isError;
    }
    const writerCall = writerToolCalls.get(event.toolCallId);
    writerToolCalls.delete(event.toolCallId);
    if (!delegationToolCalls.delete(event.toolCallId)) return;
    const failure = delegationFailure(event.result, event.isError);
    if (!failure) {
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
    delegationFailurePending = true;
    lastDelegationFailure = failure;
  });

  pi.on("agent_settled", async () => {
    const intentionallyStopped = lastAssistantStopReason === "aborted" || lastAssistantStopReason === "error";
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
    if (delegationFailurePending && !intentionallyStopped && !repairRequested) {
      repairRequested = true;
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
    if (!sawToolActivity || visibleExplanationAfterLastTool || intentionallyStopped || repairRequested) return;

    repairRequested = true;
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
