import {
  Brain,
  Check,
  CircleNotch,
  Clock,
  Pause,
  Robot,
  Signpost,
  Stop,
  TerminalWindow,
  Warning,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import { describeToolActivity } from "../lib/activity-narration";
import type { PiSessionState, SubagentLiveActivity, SubagentRunStatus, SubagentStepStatus } from "../lib/pi-types";
import type { TranscriptItem } from "../lib/transcript";

function isActive(status: string): boolean {
  return status === "running" || status === "queued" || status === "pending";
}

function formatElapsed(start?: number, end?: number, now = Date.now()): string {
  if (!start) return "—";
  const seconds = Math.max(0, Math.floor(((end ?? now) - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${remainder}s`;
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
  state,
  now,
}: {
  items: TranscriptItem[];
  isStreaming: boolean;
  activeSubagentCount: number;
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
  let latest = activeSubagentCount > 0
    ? `${activeSubagentCount} delegated agent${activeSubagentCount === 1 ? " is" : "s are"} working in the background`
    : "Ready for your next instruction";
  let mode: "tool" | "reasoning" | "monitoring" | "idle" = activeSubagentCount > 0 ? "monitoring" : "idle";
  let mainState: "working" | "waiting" | "monitoring" | "idle" = activeSubagentCount > 0 ? "monitoring" : "idle";
  if (isStreaming && activeTool) {
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
        {mode === "tool" ? <TerminalWindow size={14} /> : mode === "reasoning" ? <Brain size={14} /> : mode === "monitoring" ? <CircleNotch className="spin" size={14} /> : <Robot size={14} />}
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

function StatusIcon({ status }: { status: string }) {
  if (status === "running" || status === "queued" || status === "pending") return <CircleNotch className="spin" size={12} />;
  if (status === "paused") return <Pause size={12} weight="fill" />;
  if (status === "failed" || status === "stopped" || status === "rejected") return <Warning size={12} />;
  return <Check size={12} />;
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
  const output = step.recentOutput?.filter(Boolean).slice(-8) ?? [];
  const model = shortModel(step.model);
  const activityEvents = activity?.events ?? [];
  const newestActivityEvents = [...activityEvents].reverse();
  const latestEvent = activityEvents.at(-1);
  const latestReasoning = [...activityEvents].reverse().find((event) => event.kind === "reasoning");
  const healthState = step.activityState ?? run.activityState;
  let currentActivity = activity?.headline ?? step.status;

  if (active && step.currentTool) {
    currentActivity = `Running ${step.currentTool}${step.currentToolArgs ? ` · ${step.currentToolArgs}` : ""}`;
  } else if (active && healthState === "needs_attention") {
    currentActivity = "Needs attention — the worker has stopped producing visible activity";
  } else if (active) {
    currentActivity = latestEvent?.kind === "reasoning" && latestEvent.text
      ? `Reasoning · ${latestEvent.text}`
      : "Reasoning or waiting for the model's next action";
  }
  const collapsedStatus = active ? compactLine(currentActivity, 110) : (step.description ?? `${run.mode} child ${index + 1}`);

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
    <article className={`agent-card agent-card--${step.status}`}>
      <div className="agent-card__header">
        <button className="agent-card__summary" type="button" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
          <span className="agent-card__status"><StatusIcon status={step.status} /></span>
          <span className="agent-card__identity">
            <strong>{step.label ?? step.agent}</strong>
            <small title={step.description}>{collapsedStatus}</small>
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

          {latestReasoning && (
            <section className="agent-reasoning-preview" aria-live="polite">
              <div className="agent-reasoning-preview__header">
                <span>Latest reasoning</span>
                <time>{formatElapsed(latestReasoning.at, undefined, now)} ago</time>
              </div>
              <div className="agent-reasoning-preview__content">
                <ReactMarkdown>{latestReasoning.text}</ReactMarkdown>
              </div>
            </section>
          )}

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

          {activityEvents.length > 0 ? (
            <div className="agent-output">
              <div className="agent-output__label">Activity stream</div>
              <div className="agent-activity-stream" aria-live="polite">
                {newestActivityEvents.map((event) => (
                  <div className={`agent-activity-event agent-activity-event--${event.kind}`} key={`${event.at}-${event.kind}-${event.text}`}>
                    <span className="agent-activity-event__icon">
                      {event.kind === "tool" || event.kind === "result" ? <TerminalWindow size={11} /> : event.kind === "error" ? <Warning size={11} /> : <Brain size={11} />}
                    </span>
                    <span className="agent-activity-event__text">{event.text}</span>
                    <time>{formatElapsed(event.at, undefined, now)} ago</time>
                  </div>
                ))}
              </div>
            </div>
          ) : output.length > 0 && (
            <div className="agent-output">
              <div className="agent-output__label">Live output</div>
              <div className="agent-output__content">{output.join("\n")}</div>
            </div>
          )}

          {step.error && <div className="agent-error">{step.error}</div>}
        </div>
      )}
    </article>
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
    () => runs.filter((run) => {
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

  return (
    <aside className="agent-activity-panel" aria-label="Command center">
      <header className="agent-activity-panel__header">
        <h2>Command center</h2>
        <div className="agent-activity-panel__actions">
          {(activeCount > 0 || isStreaming) && <span className="live-count"><i />{activeCount + (isStreaming ? 1 : 0)} live</span>}
        </div>
      </header>

      <div className="agent-activity-panel__body">
        <MainAgentCard items={transcriptItems} isStreaming={isStreaming} activeSubagentCount={activeCount} state={state} now={now} />
        <div className="command-section-title">
          <span>Delegated agents</span>
          {activeCount > 0 && <small>{activeCount} active</small>}
        </div>
        {visibleRuns.length === 0 ? (
          <div className="agent-activity-empty">
            <Robot size={20} weight="light" />
            <strong>No delegated work yet</strong>
            <span>Subagents will appear here as soon as Pi launches them.</span>
          </div>
        ) : (
          visibleRuns.map((run) => (
            <section className="agent-run" key={run.runId}>
              <div className="agent-run__header">
                <span>{run.mode}</span>
                <code>{run.runId.slice(0, 8)}</code>
                <span className={`run-state run-state--${run.state}`}>{run.state}</span>
              </div>
              {(run.steps?.length ? run.steps : [{ agent: "subagent", status: run.state, startedAt: run.startedAt, error: run.error } as SubagentStepStatus]).map((step, index) => {
                const childIndex = step.index ?? index;
                return <AgentCard key={`${run.runId}-${childIndex}`} run={run} step={step} index={childIndex} now={now} activity={activity[`${run.runId}:${childIndex}`]} onSteer={onSteerSubagent} onStop={onStopSubagent} />;
              })}
            </section>
          ))
        )}
      </div>
      <footer className="agent-activity-panel__footer">
        Main Pi RPC · pi-subagents lifecycle data
      </footer>
    </aside>
  );
}
