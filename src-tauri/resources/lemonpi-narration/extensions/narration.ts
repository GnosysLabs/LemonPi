import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SUBAGENT_STEER_PREFIX = "__lemonpi_subagent_steer_v1__:";
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

Delegated work is asynchronous by default in LemonPi. After launching subagents, continue any independent investigation, implementation, or verification you can safely perform. Use subagent_wait only at a real integration barrier where the next step depends on delegated results. Before waiting, visibly explain what is blocked on those results. A completed background delegation is input to your work, not a substitute for your own closing response.
</lemonpi-visible-narration>`;

const ORCHESTRATION_CONTRACT = `
<lemonpi-orchestration>
You are Main Pi, the read-only supervisor and integration owner. You do not implement changes in project files. Optimize for the shortest reliable path to the user's outcome by giving one capable coding worker a clear, coherent slice, then inspecting and validating its result. File count alone never makes work large.

Routing policy:

1. Fast worker path — use exactly one configured worker for a bounded, well-understood, low-risk implementation. Examples include UI polish across markup/styles/state, labels and icons, a startup splash, localized interaction fixes, small configuration changes, and straightforward bugs with an established cause. Give the worker the complete small outcome, avoid specialists and reviewers, inspect the result, and run one proportionate validation pass. Efficiency comes from one clean handoff, not from Main Pi coding.
2. Standard worker path — delegate exactly one coherent implementation slice when work is broad, uncertain, specialized, or long-running. The worker role resolves its coding model through the user's Pi configuration; do not override it unless the user asks. Main Pi owns requirements, architecture, narration, integration judgment, and the final explanation, but never edits project/source files itself.
3. Specialist path — use a scout, researcher, designer, planner, oracle, or reviewer only for a concrete unknown or specialized risk Main Pi cannot resolve efficiently. Specialists are not mandatory pipeline stages. Never relay a small task serially through designer, worker, reviewer, repair worker, and reviewer.
4. Review gate — independent review is justified only when the user explicitly requests it or the change crosses a material risk boundary such as authentication, authorization, security, privacy, money, irreversible data changes, migrations, cryptography, public protocols, concurrency, or production release infrastructure. State that boundary in the delegated task as "Review justification: ...". At most one reviewer pass is allowed per user request unless the user explicitly asks for multiple independent reviews. Routine work is reviewed by Main Pi while inspecting the diff.
5. Repair rule — only a concrete blocker or major correctness defect warrants a repair pass. Notes, hypothetical edge cases, test-coverage wishes, and low-severity residual risks do not trigger an automatic worker-review loop. For a bounded correction, steer or resume the same worker rather than launching a new implementation owner. After the worker repairs it, Main Pi inspects and validates directly. Do not launch a second reviewer to confirm the first reviewer.
6. Parallelism rule — parallelize only independent work. In a shared checkout keep exactly one writer; concurrent work must be read-only and useful regardless of the writer's result. Do not wait while independent work remains, and do not create serial handoffs that add no information.
7. Validation rule — validate in proportion to blast radius and run each relevant check once after the workspace is stable. Do not make every participant rerun the same tests or demand structured acceptance reports for routine local changes. Main Pi owns final acceptance.
8. Progress rule — never invent a short child runtime deadline. Use progress evidence rather than elapsed time alone. If a child appears stuck, inspect its live activity, steer it once with concrete guidance, and reassess. Do not respond to slowness by launching more agents or restarting the whole workflow.

Main Pi may use read-only inspection, search, status, test, build, and git-management operations. It must not call file editing/writing tools or use shell commands to mutate project files. Launch implementation asynchronously, continue safe independent read-only work, and wait only at the real integration barrier. For explanation, diagnosis, review, or other read-only requests, do not launch an implementation worker.
</lemonpi-orchestration>`;

const CLOSING_REPAIR = `The previous response ended after tool activity without a visible closing explanation. Do not call more tools. Give the user a concise, specific closing explanation now: state the outcome, what changed, what was verified, and any blocker or next step. If the task is incomplete, say exactly where it stopped and why.`;
const DELEGATION_RECOVERY = `A delegated run failed and no replacement delegation was launched before the turn settled. Own the failure now: inspect the exact status/error and any partial output, identify whether the cause was a parent-imposed timeout, unavailable model/tool, configuration problem, or task failure, preserve valid partial work, and re-delegate the remaining coherent slice with corrected instructions and realistic limits. Do not set a tight timeout. If retrying cannot help because the blocker is external, give the user the exact blocker and the evidence instead of claiming recovery.`;

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

function requestSubagentSteer(pi: ExtensionAPI, id: string, index: number, message: string): Promise<void> {
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
      else reject(new Error(reply.error?.message ?? "The subagent rejected the steering message."));
    });
    timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      unsubscribe();
      reject(new Error("The subagent did not acknowledge the steering message."));
    }, SUBAGENT_RPC_TIMEOUT_MS);

    pi.events.emit(SUBAGENT_RPC_REQUEST_EVENT, {
      version: 1,
      requestId,
      method: "steer",
      params: { id, index, message },
    });
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

const MATERIAL_RISK_REQUEST = /\b(?:security|authentication|authorization|permissions?|privacy|credentials?|secrets?|payments?|billing|money|database|schema|migration|data loss|destructive|encryption|cryptograph\w*|public protocol|concurren\w*|race condition|production deploy\w*|release infrastructure|code signing|notari[sz]ation|auto[- ]?update)\b/i;
const EXPLICIT_REVIEW_REQUEST = /\b(?:review|audit|second opinion|independent verification|threat model)\b/i;
const EXPLICIT_MULTI_REVIEW_REQUEST = /\b(?:multiple|several|two|three|parallel|independent)\b.{0,32}\b(?:reviews?|reviewers?|audits?)\b|\b(?:reviews?|reviewers?|audits?)\b.{0,32}\b(?:multiple|several|two|three|parallel|independent)\b/i;
const REVIEW_JUSTIFICATION = /\breview justification:\s*(?!none\b|n\/a\b)[^\n]{8,}/i;
const REPAIR_TASK = /\b(?:repair|fix(?:ing)?|address(?:ing)?|resolve|blocker|major defect)\b/i;
const IMPLEMENTATION_AGENTS = new Set(["worker", "designer", "delegate"]);
const MAIN_MUTATION_TOOLS = new Set(["edit", "write", "apply_patch", "patch", "write_file", "edit_file", "create_file", "delete_file", "move_file"]);
const IMPLEMENTATION_TASK = /\b(?:implement|code|edit|write|change|fix|add|remove|refactor|create|update|modify|wire|style|replace|rename)\b/i;

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
  let writerDispatches = 0;
  const delegationToolCalls = new Set<string>();

  pi.on("before_agent_start", async (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${NARRATION_CONTRACT}\n\n${ORCHESTRATION_CONTRACT}`,
  }));

  pi.on("input", async (event, ctx) => {
    if (event.source !== "rpc" || !event.text.startsWith(SUBAGENT_STEER_PREFIX)) return { action: "continue" };

    try {
      const payload = JSON.parse(event.text.slice(SUBAGENT_STEER_PREFIX.length)) as {
        runId?: unknown;
        index?: unknown;
        message?: unknown;
      };
      const runId = typeof payload.runId === "string" ? payload.runId.trim() : "";
      const index = typeof payload.index === "number" ? payload.index : -1;
      const message = typeof payload.message === "string" ? payload.message.trim() : "";
      if (!/^[A-Za-z0-9-]{4,128}$/.test(runId) || !Number.isInteger(index) || index < 0 || !message || message.length > 4_000) {
        throw new Error("The subagent steering request was malformed.");
      }

      await requestSubagentSteer(pi, runId, index, message);
      ctx.ui.notify("Steer delivered directly to the subagent.", "info");
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    }
    return { action: "handled" };
  });

  pi.events.on("subagent:async-complete", (payload) => {
    const failure = delegationFailure(payload, false);
    if (!failure) return;
    delegationFailurePending = true;
    lastDelegationFailure = failure;
  });

  pi.on("tool_call", async (event) => {
    if (process.env.PI_SUBAGENT_CHILD === "1") return;

    const input = event.input as Record<string, unknown>;
    if (MAIN_MUTATION_TOOLS.has(event.toolName) || (["bash", "shell"].includes(event.toolName) && shellMutatesProject(input))) {
      return {
        block: true,
        reason: "Main Pi is LemonPi's read-only orchestrator and may not mutate project files. Delegate the implementation to the configured `worker`, or steer/resume the existing worker for a correction. Main Pi should inspect and validate the result.",
      };
    }
    if (event.toolName !== "subagent") return;

    const isManagementAction = typeof input.action === "string" && input.action.trim().length > 0;
    const specs = delegatedSpecs(input);
    const isDelegation = specs.length > 0;

    if (isDelegation && !isManagementAction) {
      const reviewers = specs.filter((spec) => spec.agent === "reviewer");
      const writers = specs.filter((spec) => IMPLEMENTATION_AGENTS.has(spec.agent));
      const misroutedImplementation = writers.find((spec) => spec.agent !== "worker" && IMPLEMENTATION_TASK.test(spec.task));
      const taskJustifiesReview = reviewers.some((spec) => REVIEW_JUSTIFICATION.test(spec.task));
      const requestExplicitlyRequestsReview = EXPLICIT_REVIEW_REQUEST.test(latestUserRequest);
      const requestHasMaterialRisk = MATERIAL_RISK_REQUEST.test(latestUserRequest);
      const requestExplicitlyRequestsMultipleReviews = EXPLICIT_MULTI_REVIEW_REQUEST.test(latestUserRequest);
      const hadPriorReview = reviewDispatches > 0;

      if (misroutedImplementation) {
        return {
          block: true,
          reason: `LemonPi routes project implementation through the configured worker coding role, not ${misroutedImplementation.agent}. Use specialists read-only for concrete unknowns, then give the coherent coding slice to \`worker\`.`,
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
      const justifiedRepair = hadPriorReview && writers.some((spec) => REPAIR_TASK.test(spec.task));
      const replacingFailedWriter = delegationFailurePending;
      if (writers.length > 0 && writerDispatches > 0 && !justifiedRepair && !replacingFailedWriter) {
        return {
          block: true,
          reason: "LemonPi dispatch policy already launched an implementation owner for this request. Main Pi must steer or resume that worker for the bounded remainder instead of coding directly or creating a serial writer handoff.",
        };
      }
      if (writers.length > 0 && writerDispatches >= 2) {
        return {
          block: true,
          reason: "LemonPi dispatch policy stopped a third implementation launch. Two writer attempts already occurred; report the exact blocker or ask the user before starting another automatic recovery cycle.",
        };
      }
      if (reviewers.length > 0) reviewDispatches += reviewers.length;
      if (writers.length > 0) writerDispatches += writers.length;

      const routineDelegation = !requestExplicitlyRequestsReview && !requestHasMaterialRisk && !taskJustifiesReview;
      if (routineDelegation && input.acceptance === undefined) {
        input.acceptance = {
          level: "none",
          reason: "Routine LemonPi delegation; Main Pi owns proportionate integration and validation.",
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
    const message = event.message as typeof event.message & { customType?: string };
    const notification = visibleText(message.content);
    if (event.message.role === "user") {
      sawToolActivity = false;
      visibleExplanationAfterLastTool = false;
      lastAssistantStopReason = undefined;
      repairRequested = false;
      delegationFailurePending = false;
      lastDelegationFailure = undefined;
      latestUserRequest = notification;
      reviewDispatches = 0;
      writerDispatches = 0;
    }
    if (message.customType === "subagent-notify") {
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
    if (!delegationToolCalls.delete(event.toolCallId)) return;
    const failure = delegationFailure(event.result, event.isError);
    if (!failure) return;
    delegationFailurePending = true;
    lastDelegationFailure = failure;
  });

  pi.on("agent_settled", async () => {
    const intentionallyStopped = lastAssistantStopReason === "aborted" || lastAssistantStopReason === "error";
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
