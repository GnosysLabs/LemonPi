import {
  Brain,
  Check,
  Circle,
  CircleNotch,
  Clock,
  ListChecks,
  LockSimple,
  Pause,
  Robot,
  Signpost,
  Stop,
  TerminalWindow,
  Warning,
  X,
} from "@phosphor-icons/react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import { describeToolActivity } from "../lib/activity-narration";
import type { PiSessionState, SubagentLiveActivity, SubagentRunStatus, SubagentStepStatus } from "../lib/pi-types";
import { subagentPromptSummary } from "../lib/subagent-prompt";
import type { TranscriptItem } from "../lib/transcript";

function isActive(status: string): boolean {
  return status === "running" || status === "queued" || status === "pending";
}

function isDismissedTerminal(status: string): boolean {
  return status === "failed" || status === "stopped" || status === "rejected";
}

/** Removes unsuccessful children immediately while preserving useful completed siblings. */
function withoutDismissedAgents(run: SubagentRunStatus): SubagentRunStatus | undefined {
  if (!run.steps?.length) return isDismissedTerminal(run.state) ? undefined : run;
  const steps = run.steps.filter((step) => !isDismissedTerminal(step.status));
  if (steps.length === 0) return undefined;
  if (steps.length === run.steps.length && !isDismissedTerminal(run.state)) return run;

  const state = isDismissedTerminal(run.state)
    ? steps.some((step) => isActive(step.status))
      ? "running"
      : steps.some((step) => step.status === "paused")
        ? "paused"
        : "complete"
    : run.state;
  return { ...run, state, steps, error: undefined };
}

function stepNeedsAttention(run: SubagentRunStatus, step: SubagentStepStatus): boolean {
  if (!isActive(step.status)) return false;
  if (step.activityState !== undefined) return step.activityState === "needs_attention";
  return (run.steps?.length ?? 0) <= 1 && run.activityState === "needs_attention";
}

function runNeedsAttention(run: SubagentRunStatus): boolean {
  if (!isActive(run.state)) return false;
  return run.activityState === "needs_attention" || (run.steps?.some((step) => stepNeedsAttention(run, step)) ?? false);
}

function formatElapsed(start?: number, end?: number, now = Date.now()): string {
  if (!start) return "—";
  const seconds = Math.max(0, Math.floor(((end ?? now) - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${remainder}s`;
}

const clockTimeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function formatClockTime(timestamp: number): string {
  return clockTimeFormatter.format(new Date(timestamp));
}

function shortModel(model?: string): string | undefined {
  if (!model) return undefined;
  return model.split("/").at(-1)?.replace(/:([a-z]+)$/i, "");
}

function compactLine(value: string, limit = 150): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact;
}

function latestReasoningItem(thinking: string): string | undefined {
  const boldItems = [...thinking.matchAll(/\*\*(.+?)\*\*/g)].map((match) => match[1]?.trim()).filter(Boolean);
  if (boldItems.length > 0) return boldItems.at(-1);
  const line = thinking.split("\n").map((item) => item.trim()).filter(Boolean).at(-1);
  if (!line) return undefined;
  const cleaned = line.replace(/^[-#*\s]+/, "").replace(/[*#]+$/, "").trim();
  return cleaned.length > 180 ? `…${cleaned.slice(-179)}` : cleaned;
}

function MainAgentCard({
  items,
  isStreaming,
  activeSubagentCount,
  attentionSubagentCount,
  state,
  now,
}: {
  items: TranscriptItem[];
  isStreaming: boolean;
  activeSubagentCount: number;
  attentionSubagentCount: number;
  state?: PiSessionState;
  now: number;
}) {
  const latestUserIndex = items.map((item) => item.kind).lastIndexOf("user");
  const latestUser = latestUserIndex >= 0 ? items[latestUserIndex] : undefined;
  const currentTurn = latestUserIndex >= 0 ? items.slice(latestUserIndex + 1) : items;
  const activeTool = [...currentTurn].reverse().find(
    (item): item is Extract<TranscriptItem, { kind: "tool" }> => item.kind === "tool" && (item.status === "queued" || item.status === "running"),
  );
  const activeAssistant = [...currentTurn].reverse().find(
    (item): item is Extract<TranscriptItem, { kind: "assistant" }> => item.kind === "assistant" && item.status === "streaming",
  );

  const waitingOnDelegation = activeTool?.name === "subagent_wait"
    || (activeTool?.name === "subagent" && activeTool.args.async !== true);
  let latest = attentionSubagentCount > 0
    ? `${attentionSubagentCount} delegated agent${attentionSubagentCount === 1 ? " needs" : "s need"} intervention`
    : activeSubagentCount > 0
      ? `${activeSubagentCount} delegated agent${activeSubagentCount === 1 ? " is" : "s are"} working in the background`
      : "Ready for your next instruction";
  let mode: "tool" | "reasoning" | "compacting" | "monitoring" | "attention" | "idle" = attentionSubagentCount > 0 ? "attention" : activeSubagentCount > 0 ? "monitoring" : "idle";
  let mainState: "working" | "waiting" | "compacting" | "monitoring" | "idle" = activeSubagentCount > 0 ? "monitoring" : "idle";
  if (state?.isCompacting) {
    latest = "Compressing older conversation context so work can continue";
    mode = "compacting";
    mainState = "compacting";
  } else if (isStreaming && activeTool) {
    latest = describeToolActivity(activeTool);
    mode = "tool";
    mainState = waitingOnDelegation ? "waiting" : "working";
  } else if (isStreaming && activeAssistant?.thinking) {
    latest = latestReasoningItem(activeAssistant.thinking) ?? "Reasoning through the next step";
    mode = "reasoning";
    mainState = "working";
  } else if (isStreaming && activeAssistant?.text) {
    latest = "Writing the response";
    mode = "reasoning";
    mainState = "working";
  } else if (isStreaming && activeSubagentCount > 0) {
    latest = `I'm continuing while ${activeSubagentCount} delegated agent${activeSubagentCount === 1 ? " works" : "s work"} in the background`;
    mode = "reasoning";
    mainState = "working";
  } else if (isStreaming) {
    latest = state?.thinkingLevel === "off" ? "Waiting for the model's next action" : "Starting the next step";
    mode = "reasoning";
    mainState = "working";
  }

  const startedAt = latestUser?.createdAt;
  const model = state?.model?.name ?? state?.model?.id;
  return (
    <section className={`command-main command-main--${mainState}`} aria-label="Main agent activity">
      <div className="command-main__header">
        <span>Main Pi</span>
        <span className="command-main__state">{mainState !== "idle" ? <><i />{mainState}</> : "idle"}</span>
      </div>
      <div className="command-main__latest" role="status" aria-live="polite">
        {mode === "tool" ? <TerminalWindow size={14} /> : mode === "reasoning" ? <Brain size={14} /> : mode === "compacting" || mode === "monitoring" ? <CircleNotch className="spin" size={14} /> : mode === "attention" ? <Warning size={14} /> : <Robot size={14} />}
        <span>{latest}</span>
      </div>
      <div className="command-main__meta">
        {model && <span>{shortModel(model)}</span>}
        {state?.thinkingLevel && <span>{state.thinkingLevel} thinking</span>}
        {isStreaming && startedAt && <span><Clock size={10} />{formatElapsed(startedAt, undefined, now)}</span>}
      </div>
    </section>
  );
}

function StatusIcon({ status, needsAttention = false }: { status: string; needsAttention?: boolean }) {
  if (needsAttention) return <Warning size={12} />;
  if (status === "running" || status === "queued" || status === "pending") return <CircleNotch className="spin" size={12} />;
  if (status === "paused") return <Pause size={12} weight="fill" />;
  if (status === "failed" || status === "stopped" || status === "rejected") return <Warning size={12} />;
  return <Check size={12} />;
}

function AgentPromptModal({ agent, prompt, onClose }: { agent: string; prompt: string; onClose: () => void }) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return createPortal(
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="agent-prompt-dialog" role="dialog" aria-modal="true" aria-labelledby="agent-prompt-title">
        <header className="agent-prompt-dialog__header">
          <div>
            <span>Delegated task</span>
            <h2 id="agent-prompt-title">Prompt sent to {agent}</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Close prompt" autoFocus><X size={15} /></button>
        </header>
        <div className="agent-prompt-dialog__content"><ReactMarkdown>{prompt}</ReactMarkdown></div>
      </section>
    </div>,
    document.body,
  );
}

type AgentTodoItem = NonNullable<SubagentLiveActivity["todos"]>[number];

function AgentTaskPreview({
  id,
  task,
  anchor,
  blocked,
  terminalLabel,
  onMouseEnter,
  onMouseLeave,
}: {
  id: string;
  task: AgentTodoItem;
  anchor: DOMRect;
  blocked: boolean;
  terminalLabel?: string;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const width = Math.min(380, viewportWidth - 24);
  const placeLeft = anchor.left >= width + 22;
  const left = placeLeft
    ? Math.max(12, anchor.left - width - 10)
    : Math.max(12, Math.min(anchor.left, viewportWidth - width - 12));
  const top = Math.max(12, Math.min(anchor.top, viewportHeight - Math.min(360, viewportHeight - 24) - 12));
  const status = terminalLabel && task.status === "in_progress"
    ? terminalLabel
    : blocked
      ? "Blocked"
      : task.status.replace("_", " ");
  const description = task.description?.trim();

  return createPortal(
    <aside
      id={id}
      className={`agent-task-preview agent-task-preview--${blocked ? "blocked" : task.status}`}
      role="tooltip"
      style={{ left, top, width, maxHeight: Math.max(180, Math.min(360, viewportHeight - 24)) }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <header className="agent-task-preview__header">
        <span>Delegated task</span>
        <em>{status}</em>
      </header>
      <h4>{task.subject}</h4>
      {description && <p>{description}</p>}
    </aside>,
    document.body,
  );
}

function AgentTodos({
  todos,
  active,
  terminalStatus,
  emptyLabel = "Waiting for this agent to outline its work…",
}: {
  todos: NonNullable<SubagentLiveActivity["todos"]>;
  active: boolean;
  terminalStatus?: SubagentStepStatus["status"];
  emptyLabel?: string;
}) {
  const tooltipPrefix = useId();
  const hideTimer = useRef<number | undefined>(undefined);
  const [preview, setPreview] = useState<{ task: AgentTodoItem; anchor: DOMRect; blocked: boolean } | null>(null);
  useEffect(() => () => {
    if (hideTimer.current !== undefined) window.clearTimeout(hideTimer.current);
  }, []);
  const visible = todos.filter((task) => task.status !== "deleted");
  if (visible.length === 0 && !active) return null;
  const completed = new Set(visible.filter((task) => task.status === "completed").map((task) => task.id));
  const ordered = [...visible].sort((left, right) => {
    const rank = { in_progress: 0, pending: 1, completed: 2, deleted: 3 };
    return rank[left.status] - rank[right.status] || left.id - right.id;
  });
  const completedCount = completed.size;
  const interrupted = !active && visible.some((task) => task.status === "in_progress");
  const terminalLabel = terminalStatus === "failed" || terminalStatus === "rejected"
    ? "Failed"
    : terminalStatus === "stopped"
      ? "Stopped"
      : interrupted
        ? "Interrupted"
        : undefined;
  const progress = visible.length > 0 ? Math.round((completedCount / visible.length) * 100) : 0;
  const cancelHide = () => {
    if (hideTimer.current !== undefined) window.clearTimeout(hideTimer.current);
    hideTimer.current = undefined;
  };
  const hidePreview = () => {
    cancelHide();
    hideTimer.current = window.setTimeout(() => setPreview(null), 100);
  };
  const showPreview = (task: AgentTodoItem, target: HTMLElement, blocked: boolean) => {
    cancelHide();
    setPreview({ task, anchor: target.getBoundingClientRect(), blocked });
  };
  return (
    <section className={`agent-todos${visible.length === 0 ? " agent-todos--empty" : ""}${interrupted ? " agent-todos--interrupted" : ""}`} aria-label="Agent tasks">
      <header>
        <span><ListChecks size={15} />Tasks</span>
        {visible.length > 0 && <small>{terminalLabel ? `${terminalLabel} · ` : ""}{completedCount} of {visible.length}</small>}
      </header>
      {visible.length > 0 && <div className="agent-todos__progress" aria-hidden="true"><i style={{ width: `${progress}%` }} /></div>}
      {visible.length === 0 ? (
        <div className="agent-todos__empty"><CircleNotch className="spin" size={13} /><span>{emptyLabel}</span></div>
      ) : <div className="agent-todos__list">
        {ordered.map((task) => {
          const blocked = task.status === "pending" && task.blockedBy.some((id) => !completed.has(id));
          const detailId = `${tooltipPrefix}-task-${task.id}`;
          return (
            <div
              className={`agent-todo agent-todo--${task.status}${blocked ? " agent-todo--blocked" : ""}${interrupted && task.status === "in_progress" ? " agent-todo--interrupted" : ""}`}
              key={task.id}
              tabIndex={0}
              aria-describedby={preview?.task.id === task.id ? detailId : undefined}
              onMouseEnter={(event) => showPreview(task, event.currentTarget, blocked)}
              onMouseLeave={hidePreview}
              onFocus={(event) => showPreview(task, event.currentTarget, blocked)}
              onBlur={hidePreview}
            >
              <span className="agent-todo__status">
                {task.status === "completed" ? <Check size={11} weight="bold" /> : task.status === "in_progress" ? interrupted ? terminalStatus === "failed" || terminalStatus === "rejected" ? <Warning size={11} /> : <Stop size={10} weight="fill" /> : <CircleNotch className="spin" size={12} /> : blocked ? <LockSimple size={10} /> : <Circle size={10} />}
              </span>
              <span><strong>{task.subject}</strong>{(task.activeForm || task.description || (interrupted && task.status === "in_progress")) && <small>{interrupted && task.status === "in_progress" ? `${terminalLabel ?? "Interrupted"} before this task completed` : task.status === "in_progress" ? task.activeForm ?? task.description : task.description}</small>}</span>
            </div>
          );
        })}
      </div>}
      {preview && (
        <AgentTaskPreview
          id={`${tooltipPrefix}-task-${preview.task.id}`}
          task={preview.task}
          anchor={preview.anchor}
          blocked={preview.blocked}
          terminalLabel={interrupted ? terminalLabel : undefined}
          onMouseEnter={cancelHide}
          onMouseLeave={hidePreview}
        />
      )}
    </section>
  );
}

function AgentCard({
  run,
  step,
  index,
  now,
  activity,
  onSteer,
  onStop,
}: {
  run: SubagentRunStatus;
  step: SubagentStepStatus;
  index: number;
  now: number;
  activity?: SubagentLiveActivity;
  onSteer: (runId: string, index: number, message: string) => Promise<void>;
  onStop: (runId: string) => Promise<void>;
}) {
  const active = isActive(step.status);
  const groupedRun = (run.steps?.length ?? 0) > 1;
  const [expanded, setExpanded] = useState(false);
  const [steerText, setSteerText] = useState("");
  const [steering, setSteering] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [steerError, setSteerError] = useState<string>();
  const [promptOpen, setPromptOpen] = useState(false);
  const model = shortModel(step.model);
  const activityEvents = activity?.events ?? [];
  const newestActivityEvents = [...activityEvents].reverse();
  const latestEvent = activityEvents.at(-1);
  const healthState = step.activityState ?? ((run.steps?.length ?? 0) <= 1 ? run.activityState : undefined);
  const visibleTodos = activity?.todos?.filter((task) => task.status !== "deleted") ?? [];
  const attemptStartedAt = step.startedAt ?? run.startedAt;
  const todoSnapshotFresh = activity?.todosUpdatedAt != null && activity.todosUpdatedAt >= attemptStartedAt;
  const restoringTodos = active && visibleTodos.length > 0 && !todoSnapshotFresh;
  const finalizing = active && todoSnapshotFresh && visibleTodos.length > 0 && visibleTodos.every((task) => task.status === "completed");
  const promptText = step.prompt?.trim() || step.description?.trim();
  const promptSummary = step.summary?.trim() || (promptText ? subagentPromptSummary(promptText) : undefined);
  let showingPrompt = false;
  let currentActivity = activity?.headline ?? step.status;

  if (active && step.currentTool) {
    currentActivity = `Running ${step.currentTool}${step.currentToolArgs ? ` · ${step.currentToolArgs}` : ""}`;
  } else if (active && healthState === "needs_attention") {
    currentActivity = "Needs attention — the worker has stopped producing visible activity";
  } else if (restoringTodos) {
    currentActivity = "Resuming agent and refreshing its tasks";
  } else if (finalizing) {
    currentActivity = "Finalizing response — work checklist complete";
  } else if (active) {
    if (latestEvent?.kind === "reasoning" && latestEvent.text) {
      currentActivity = `Reasoning · ${latestEvent.text}`;
    } else if (promptSummary) {
      currentActivity = promptSummary;
      showingPrompt = true;
    } else {
      currentActivity = "Waiting for the model's next action";
    }
  }
  if (!active && promptText) showingPrompt = true;
  const collapsedStatus = active ? compactLine(currentActivity, 110) : (promptSummary ? compactLine(promptSummary, 110) : `${run.mode} child ${index + 1}`);

  async function submitSteer() {
    const message = steerText.trim();
    if (!message || steering) return;
    setSteering(true);
    setSteerError(undefined);
    try {
      await onSteer(run.runId, index, message);
      setSteerText("");
    } catch (error) {
      setSteerError(error instanceof Error ? error.message : String(error));
    } finally {
      setSteering(false);
    }
  }

  async function stopAgent() {
    if (stopping) return;
    setStopping(true);
    setSteerError(undefined);
    try {
      await onStop(run.runId);
      window.setTimeout(() => setStopping(false), 8_000);
    } catch (error) {
      setSteerError(error instanceof Error ? error.message : String(error));
      setStopping(false);
    }
  }

  return (
    <>
    <article className={`agent-card agent-card--${step.status}${finalizing ? " agent-card--finalizing" : ""}${healthState === "needs_attention" ? " agent-card--needs-attention" : ""}`}>
      <div className="agent-card__header">
        <button
          className="agent-card__summary"
          type="button"
          onClick={(event) => {
            if (showingPrompt && (event.target as HTMLElement).closest("[data-agent-prompt]")) setPromptOpen(true);
            else setExpanded((value) => !value);
          }}
          aria-expanded={expanded}
        >
          <span className="agent-card__status"><StatusIcon status={step.status} needsAttention={active && healthState === "needs_attention"} /></span>
          <span className="agent-card__identity">
            <strong>{step.label ?? step.agent}</strong>
            <small data-agent-prompt={showingPrompt ? "true" : undefined} title={showingPrompt ? "View the full delegated prompt" : step.description}>{collapsedStatus}</small>
          </span>
          <span className="agent-card__elapsed"><Clock size={10} />{formatElapsed(step.startedAt ?? run.startedAt, step.endedAt, now)}</span>
        </button>
        {active && run.statusPath && (
          <div className="agent-card__actions">
            <button
              className="agent-card__stop"
              type="button"
              onClick={() => void stopAgent()}
              disabled={stopping}
              title={groupedRun ? "End this entire delegated run" : "End this agent"}
              aria-label={groupedRun ? `End the run containing ${step.label ?? step.agent}` : `End ${step.label ?? step.agent}`}
            >
              {stopping ? <CircleNotch className="spin" size={11} /> : <Stop size={11} weight="fill" />}
            </button>
          </div>
        )}
      </div>

      {expanded && (
        <div className="agent-card__detail">
          <div className="agent-card__meta">
            {model && <span><Robot size={11} />{model}</span>}
            {step.thinking && <span><Brain size={11} />{step.thinking}</span>}
            {step.tokens && <span>{step.tokens.total.toLocaleString()} tok</span>}
            {step.turnCount != null && <span>{step.turnCount} turn{step.turnCount === 1 ? "" : "s"}</span>}
          </div>

          {active && run.statusPath && (
            <form className="agent-steer" onSubmit={(event) => { event.preventDefault(); void submitSteer(); }}>
              <label htmlFor={`agent-steer-${run.runId}-${index}`}>Steer this agent</label>
              <div>
                <input
                  id={`agent-steer-${run.runId}-${index}`}
                  value={steerText}
                  onChange={(event) => setSteerText(event.target.value)}
                  placeholder="Correct direction or add context…"
                  disabled={steering || stopping}
                />
                <button type="submit" disabled={!steerText.trim() || steering || stopping}>
                  {steering ? <CircleNotch className="spin" size={11} /> : <Signpost size={11} />}
                  {steering ? "Sending" : "Steer"}
                </button>
              </div>
              {steerError && <span className="agent-steer__error" role="alert">{steerError}</span>}
            </form>
          )}

          {(active || (activity?.todos?.length ?? 0) > 0) && (
            <AgentTodos
              todos={restoringTodos ? [] : activity?.todos ?? []}
              active={active}
              terminalStatus={step.status}
              emptyLabel={restoringTodos ? "Restoring this agent’s task list…" : undefined}
            />
          )}

          {activityEvents.length > 0 && (
            <div className="agent-output">
              <div className="agent-output__label">Activity stream</div>
              <ol className="agent-activity-stream" aria-live="polite">
                {newestActivityEvents.map((event, eventIndex) => {
                  const label = event.kind === "reasoning"
                    ? "Reasoning"
                    : event.kind === "tool"
                      ? "Tool call"
                      : event.kind === "result"
                        ? "Completed"
                        : event.kind === "error"
                          ? "Needs attention"
                          : "Update";
                  return (
                    <li
                      className={`agent-activity-event agent-activity-event--${event.kind}${eventIndex === 0 ? " agent-activity-event--latest" : ""}`}
                      key={`${event.at}-${event.kind}-${event.text}`}
                    >
                      <span className="agent-activity-event__icon" aria-hidden="true">
                        {event.kind === "tool"
                          ? <TerminalWindow size={12} />
                          : event.kind === "result"
                            ? <Check size={12} weight="bold" />
                            : event.kind === "error"
                              ? <Warning size={12} />
                              : event.kind === "message"
                                ? <Circle size={7} weight="fill" />
                                : <Brain size={12} />}
                      </span>
                      <div className="agent-activity-event__body">
                        <div className="agent-activity-event__meta">
                          <span>{label}</span>
                          <time dateTime={new Date(event.at).toISOString()} title={new Date(event.at).toLocaleString()}>
                            {formatClockTime(event.at)}
                          </time>
                        </div>
                        <div className="agent-activity-event__text">
                          <ReactMarkdown>{event.text}</ReactMarkdown>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ol>
            </div>
          )}

          {step.error && <div className="agent-error">{step.error}</div>}
        </div>
      )}
    </article>
    {promptOpen && promptText && <AgentPromptModal agent={step.label ?? step.agent} prompt={promptText} onClose={() => setPromptOpen(false)} />}
    </>
  );
}

export function AgentActivityPanel({
  runs,
  activity,
  transcriptItems,
  isStreaming,
  state,
  onSteerSubagent,
  onStopSubagent,
}: {
  runs: SubagentRunStatus[];
  activity: Record<string, SubagentLiveActivity>;
  transcriptItems: TranscriptItem[];
  isStreaming: boolean;
  state?: PiSessionState;
  onSteerSubagent: (runId: string, index: number, message: string) => Promise<void>;
  onStopSubagent: (runId: string) => Promise<void>;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const visibleRuns = useMemo(
    () => runs.flatMap((run) => {
      const visibleRun = withoutDismissedAgents(run);
      return visibleRun ? [visibleRun] : [];
    }).filter((run) => {
      if (isActive(run.state)) return true;
      const historyAt = run.endedAt ?? run.lastUpdate ?? run.startedAt;
      return now - historyAt < 15 * 60_000;
    }).slice(0, 8),
    [now, runs],
  );
  const activeCount = visibleRuns.reduce(
    (count, run) => count + (run.steps?.filter((step) => isActive(step.status)).length ?? (isActive(run.state) ? 1 : 0)),
    0,
  );
  const attentionCount = visibleRuns.reduce(
    (count, run) => {
      const flaggedSteps = run.steps?.filter((step) => stepNeedsAttention(run, step)).length ?? 0;
      return count + (flaggedSteps > 0 ? flaggedSteps : runNeedsAttention(run) ? 1 : 0);
    },
    0,
  );
  const progressingCount = Math.max(0, activeCount - attentionCount);

  return (
    <aside className="agent-activity-panel" aria-label="Command center">
      <header className="agent-activity-panel__header">
        <h2>Command center</h2>
        <div className="agent-activity-panel__actions">
          {attentionCount > 0 && <span className="live-count live-count--attention"><Warning size={11} />{attentionCount} needs attention</span>}
          {(progressingCount > 0 || isStreaming) && <span className="live-count"><i />{progressingCount + (isStreaming ? 1 : 0)} live</span>}
        </div>
      </header>

      <div className="agent-activity-panel__body">
        <MainAgentCard items={transcriptItems} isStreaming={isStreaming} activeSubagentCount={activeCount} attentionSubagentCount={attentionCount} state={state} now={now} />
        <div className="command-section-title">
          <span>Delegated agents</span>
          {attentionCount > 0 ? <small>{attentionCount} needs attention</small> : activeCount > 0 && <small>{activeCount} active</small>}
        </div>
        {visibleRuns.length === 0 ? (
          <div className="agent-activity-empty">
            <Robot size={20} weight="light" />
            <strong>No delegated work yet</strong>
            <span>Subagents will appear here as soon as Pi launches them.</span>
          </div>
        ) : (
          visibleRuns.map((run) => {
            const needsAttention = runNeedsAttention(run);
            const orderedSteps = (run.steps ?? [])
              .map((step, index) => ({ step, index: step.index ?? index }))
              .sort((left, right) => left.index - right.index);
            const activeSteps = orderedSteps
              .filter(({ step }) => isActive(step.status));
            const finalizing = activeSteps.length > 0 && activeSteps.every(({ step, index }) => {
              const snapshot = activity[`${run.runId}:${index}`];
              const attemptStartedAt = step.startedAt ?? run.startedAt;
              const tasks = snapshot?.todos?.filter((task) => task.status !== "deleted") ?? [];
              return snapshot?.todosUpdatedAt != null
                && snapshot.todosUpdatedAt >= attemptStartedAt
                && tasks.length > 0
                && tasks.every((task) => task.status === "completed");
            });
            const stateLabel = needsAttention ? "needs attention" : finalizing ? "finalizing" : run.state;
            const stateClass = needsAttention ? "needs-attention" : finalizing ? "finalizing" : run.state;
            const displayMode = (run.steps?.length ?? 0) <= 1 ? "single" : run.mode;
            return <section className="agent-run" key={run.runId}>
              <div className="agent-run__header">
                <span>{displayMode}</span>
                <code>{run.runId.slice(0, 8)}</code>
                <span className={`run-state run-state--${stateClass}`}>{stateLabel}</span>
              </div>
              {(orderedSteps.length > 0
                ? orderedSteps
                : [{ step: { agent: "subagent", status: run.state, startedAt: run.startedAt, error: run.error } as SubagentStepStatus, index: 0 }]
              ).map(({ step, index }) => (
                <AgentCard key={`${run.runId}-${index}`} run={run} step={step} index={index} now={now} activity={activity[`${run.runId}:${index}`]} onSteer={onSteerSubagent} onStop={onStopSubagent} />
              ))}
            </section>;
          })
        )}
      </div>
      <footer className="agent-activity-panel__footer">
        Main Pi RPC · pi-subagents lifecycle data
      </footer>
    </aside>
  );
}
