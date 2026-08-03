import {
  CaretRight,
  Check,
  CircleNotch,
  Code,
  FileText,
  FileMagnifyingGlass,
  FolderOpen,
  PencilSimple,
  TerminalWindow,
  Warning,
} from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { describeToolActivity, summarizeSurfacedThinking } from "../lib/activity-narration";
import type { TranscriptItem } from "../lib/transcript";

function ToolIcon({ name }: { name: string }) {
  const props = { size: 14, weight: "light" as const };
  if (name === "bash") return <TerminalWindow {...props} />;
  if (name === "read" || name === "grep" || name === "find" || name === "ls") return <FileMagnifyingGlass {...props} />;
  if (name === "edit" || name === "write") return <PencilSimple {...props} />;
  return <Code {...props} />;
}

function toolSummary(item: Extract<TranscriptItem, { kind: "tool" }>): string {
  const path = typeof item.args.path === "string" ? item.args.path : undefined;
  const command = typeof item.args.command === "string" ? item.args.command : undefined;
  if (path) return path;
  if (command) return command.replace(/\s+/g, " ").slice(0, 100);
  const first = Object.values(item.args).find((value) => typeof value === "string");
  return typeof first === "string" ? first.slice(0, 100) : "Running tool";
}

function ToolCard({ item }: { item: Extract<TranscriptItem, { kind: "tool" }> }) {
  const isRunning = item.status === "running";
  const isQueued = item.status === "queued";
  const isActive = isRunning || isQueued;
  const [expanded, setExpanded] = useState(false);

  return (
    <article className={`tool-card tool-card--${item.status}`}>
      <button
        className="tool-card__header"
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        <span className="tool-card__icon">
          <ToolIcon name={item.name} />
        </span>
        <span className="tool-card__name">{item.name}</span>
        <span className="tool-card__summary">{toolSummary(item)}</span>
        <span className="tool-card__status" aria-label={item.status}>
          {isActive ? <CircleNotch className="spin" size={13} /> : item.status === "error" ? <Warning size={13} /> : <Check size={13} />}
        </span>
        <CaretRight className={expanded ? "rotate-90" : ""} size={12} weight="bold" />
      </button>
      {expanded && (
        <div className="tool-card__body">
          <div className="tool-card__label">Input</div>
          <pre>{JSON.stringify(item.args, null, 2)}</pre>
          {(item.output || isActive) && (
            <>
              <div className="tool-card__label">{isQueued ? "Status" : isRunning ? "Live output" : "Result"}</div>
              <pre>{item.output || (isQueued ? "Preparing command…" : "Waiting for output…")}</pre>
            </>
          )}
        </div>
      )}
    </article>
  );
}

function assistantTurnSummary(items: TranscriptItem[], index: number): string | undefined {
  const item = items[index];
  if (!item || item.kind !== "assistant" || item.text.trim() || item.status === "streaming") return undefined;
  const thinkingSummary = summarizeSurfacedThinking(item.thinking);
  if (thinkingSummary) return thinkingSummary;

  for (let nextIndex = index + 1; nextIndex < items.length; nextIndex += 1) {
    const next = items[nextIndex];
    if (next.kind === "user" || next.kind === "assistant") break;
    if (next.kind === "tool") return describeToolActivity(next, true);
  }
  return undefined;
}

function AssistantMessage({ item, summary }: { item: Extract<TranscriptItem, { kind: "assistant" }>; summary?: string }) {
  if (!item.text && !summary && (item.status === "streaming" || item.status === "complete")) return null;

  return (
    <article className="assistant-message">
      <div className="assistant-message__rail" aria-hidden="true">
        <span />
      </div>
      <div className="assistant-message__content">
        {summary && !item.text && <div className="assistant-message__summary">{summary}</div>}
        {item.text ? (
          <div className="markdown">
            <ReactMarkdown>{item.text}</ReactMarkdown>
          </div>
        ) : item.status === "streaming" ? (
          <div className="assistant-message__waiting"><i /><i /><i /></div>
        ) : null}
        {item.status === "aborted" && <div className="message-state">Response stopped</div>}
        {item.status === "error" && <div className="message-state message-state--error">Response failed</div>}
      </div>
    </article>
  );
}

export function Transcript({
  items,
  isStreaming,
  isCompacting,
  hasProject,
  onChooseProject,
}: {
  items: TranscriptItem[];
  isStreaming: boolean;
  isCompacting: boolean;
  hasProject: boolean;
  onChooseProject: () => void;
}) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: isStreaming ? "auto" : "smooth", block: "end" });
  }, [items, isStreaming]);

  if (items.length === 0) {
    if (!hasProject) {
      return (
        <div className="empty-workspace">
          <p className="eyebrow">LemonPi · No project</p>
          <h1>Start a new task</h1>
          <p>Open a working directory to give Pi access to its files, sessions, skills, and extensions.</p>
          <button className="workspace-action" type="button" onClick={onChooseProject}>
            <FolderOpen size={17} weight="light" />
            <span><strong>Open project folder</strong><small>Choose a local working directory</small></span>
            <kbd>⌘ O</kbd>
          </button>
        </div>
      );
    }

    return (
      <div className="empty-transcript">
        <p className="eyebrow">Workspace ready</p>
        <h1>What should we make?</h1>
        <p>Describe the outcome. Pi can inspect the project, run tools, edit files, and coordinate specialists while you watch the work unfold.</p>
      </div>
    );
  }

  return (
    <div className="transcript" aria-live="polite">
      {items.map((item, index) => {
        if (item.kind === "user") {
          return (
            <article className="user-message" key={item.id}>
              <span className="user-message__label">You</span>
              {item.text && <p>{item.text}</p>}
              {item.attachments.length > 0 && (
                <div className="user-message__attachments">
                  {item.attachments.map((attachment, attachmentIndex) => attachment.kind === "image" && attachment.data ? (
                    <figure className="user-message__image" key={`${attachment.name}-${attachmentIndex}`}>
                      <img src={`data:${attachment.mimeType};base64,${attachment.data}`} alt={attachment.name} loading="lazy" />
                      <figcaption>{attachment.name}</figcaption>
                    </figure>
                  ) : (
                    <div className="user-message__file" key={`${attachment.name}-${attachmentIndex}`}>
                      <FileText size={15} weight="light" />
                      <span><strong>{attachment.name}</strong><small>Text attachment</small></span>
                    </div>
                  ))}
                </div>
              )}
              {item.delivery && (
                <div className={`user-message__delivery user-message__delivery--${item.delivery}`} role="status">
                  {item.delivery === "failed" ? (
                    <><Warning size={13} /><span><strong>Message was not sent</strong>{item.deliveryError && <small>{item.deliveryError}</small>}</span></>
                  ) : (
                    <><CircleNotch className="spin" size={13} /><span><strong>{isCompacting ? "Queued during context compaction" : item.deliveryBehavior === "steer" ? "Steering Pi…" : item.deliveryBehavior === "follow_up" ? "Queued for the next turn" : "Sending to Pi…"}</strong>{isCompacting && <small>It will be delivered automatically as soon as compaction finishes.</small>}</span></>
                  )}
                </div>
              )}
            </article>
          );
        }
        if (item.kind === "assistant") return <AssistantMessage item={item} summary={assistantTurnSummary(items, index)} key={item.id} />;
        return <ToolCard item={item} key={item.id} />;
      })}
      <div ref={endRef} />
    </div>
  );
}
