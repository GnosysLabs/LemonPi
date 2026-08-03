import { ArrowUp, CircleNotch, FileText, ImageSquare, Paperclip, Queue, Signpost, Stop, X } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import {
  MAX_ATTACHMENTS,
  MAX_TOTAL_ATTACHMENT_BYTES,
  readComposerAttachment,
  type ComposerAttachment,
} from "../lib/attachments";
import type { PiModel, PiSessionState, PiSessionStats, ThinkingLevel } from "../lib/pi-types";
import { SessionControls } from "./SessionControls";

export type ComposerBehavior = "prompt" | "steer" | "follow_up";

export function Composer({
  connected,
  streaming,
  stopping,
  steeringCount,
  followUpCount,
  state,
  stats,
  models,
  thinkingLevels,
  injectedText,
  onInjectedTextConsumed,
  onSubmit,
  onAbort,
  onSelectModel,
  onSelectThinking,
}: {
  connected: boolean;
  streaming: boolean;
  stopping: boolean;
  steeringCount: number;
  followUpCount: number;
  state?: PiSessionState;
  stats?: PiSessionStats;
  models: PiModel[];
  thinkingLevels: ThinkingLevel[];
  injectedText?: string;
  onInjectedTextConsumed: () => void;
  onSubmit: (text: string, behavior: ComposerBehavior, attachments: ComposerAttachment[]) => void;
  onAbort: () => void;
  onSelectModel: (model: PiModel) => void;
  onSelectThinking: (level: ThinkingLevel) => void;
}) {
  const [text, setText] = useState("");
  const [behavior, setBehavior] = useState<ComposerBehavior>("prompt");
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string>();
  const [readingAttachments, setReadingAttachments] = useState(false);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setBehavior(streaming ? "steer" : "prompt");
  }, [streaming]);

  useEffect(() => {
    if (injectedText == null) return;
    setText(injectedText);
    onInjectedTextConsumed();
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [injectedText, onInjectedTextConsumed]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
  }, [text]);

  function submit(override?: ComposerBehavior) {
    const value = text.trim();
    if ((!value && attachments.length === 0) || !connected || readingAttachments) return;
    onSubmit(value, override ?? behavior, attachments);
    setText("");
    setAttachments([]);
    setAttachmentError(undefined);
  }

  async function addFiles(files: File[]) {
    if (files.length === 0 || readingAttachments) return;
    setAttachmentError(undefined);
    setReadingAttachments(true);
    try {
      const available = Math.max(0, MAX_ATTACHMENTS - attachments.length);
      if (files.length > available) throw new Error(`You can attach up to ${MAX_ATTACHMENTS} files to one message.`);
      const next = await Promise.all(files.map(readComposerAttachment));
      if (next.some((attachment) => attachment.kind === "image") && state?.model?.input && !state.model.input.includes("image")) {
        throw new Error(`${state.model.name ?? state.model.id} does not accept image attachments. Attach a text/code file or switch models.`);
      }
      const totalBytes = [...attachments, ...next].reduce((sum, attachment) => sum + attachment.size, 0);
      if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) throw new Error("Attachments must be under 5.5 MB total so Pi can receive the message safely.");
      setAttachments((current) => [...current, ...next]);
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : String(error));
    } finally {
      setReadingAttachments(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = [...event.clipboardData.files];
    if (files.length === 0) return;
    event.preventDefault();
    void addFiles(files);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDraggingFiles(false);
    if (!connected) return;
    void addFiles([...event.dataTransfer.files]);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing || event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    if (event.altKey && streaming) submit("follow_up");
    else submit();
  }

  return (
    <div className="composer-shell">
      {state?.isCompacting && (
        <div className="composer-compaction" role="status" aria-live="polite">
          <CircleNotch className="spin" size={14} />
          <span><strong>Compacting context</strong><small>You can keep typing. Sent messages are queued safely and shown in the chat immediately.</small></span>
        </div>
      )}
      {streaming && (
        <div className="composer-modes" role="radiogroup" aria-label="Message delivery">
          <button className={behavior === "steer" ? "active" : ""} type="button" onClick={() => setBehavior("steer")} role="radio" aria-checked={behavior === "steer"}>
            <Signpost size={12} weight="light" /> Steer now
          </button>
          <button className={behavior === "follow_up" ? "active" : ""} type="button" onClick={() => setBehavior("follow_up")} role="radio" aria-checked={behavior === "follow_up"}>
            <Queue size={12} weight="light" /> Queue next
          </button>
          {(steeringCount > 0 || followUpCount > 0) && (
            <div className="composer-modes__counts" aria-live="polite">
              {steeringCount > 0 && <span className="composer-modes__count composer-modes__count--steer">{steeringCount} steer{steeringCount === 1 ? "" : "s"} pending</span>}
              {followUpCount > 0 && <span className="composer-modes__count">{followUpCount} follow-up{followUpCount === 1 ? "" : "s"} queued</span>}
            </div>
          )}
        </div>
      )}
      <div
        className={`composer ${draggingFiles ? "composer--dragging" : ""}`}
        onDragEnter={(event) => { if (event.dataTransfer.types.includes("Files")) setDraggingFiles(true); }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDraggingFiles(false); }}
        onDrop={handleDrop}
      >
        {attachments.length > 0 && (
          <div className="composer-attachments" aria-label="Message attachments">
            {attachments.map((attachment) => (
              <div className={`composer-attachment composer-attachment--${attachment.kind}`} key={attachment.id}>
                {attachment.kind === "image" && attachment.data ? (
                  <img src={`data:${attachment.mimeType};base64,${attachment.data}`} alt="" />
                ) : (
                  <span className="composer-attachment__icon"><FileText size={15} weight="light" /></span>
                )}
                <span className="composer-attachment__copy">
                  <strong>{attachment.name}</strong>
                  <small>{attachment.kind === "image" ? "Image" : "Text file"} · {attachment.size < 1024 ? `${attachment.size} B` : `${Math.ceil(attachment.size / 1024)} KB`}</small>
                </span>
                <button type="button" onClick={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))} aria-label={`Remove ${attachment.name}`}>
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        {draggingFiles && <div className="composer-drop-target"><Paperclip size={17} /> Drop to attach</div>}
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={connected ? (state?.isCompacting ? "Send now — Pi will read it after compaction…" : streaming ? "Guide the work in progress…" : "Ask Pi to work on this project…") : "Open a project to begin…"}
          disabled={!connected}
          rows={1}
          aria-label="Message Pi"
        />
        {attachmentError && <div className="composer-attachment-error" role="alert">{attachmentError}</div>}
        <div className="composer__footer">
          <SessionControls
            state={state}
            stats={stats}
            connected={connected}
            models={models}
            thinkingLevels={thinkingLevels}
            onSelectModel={onSelectModel}
            onSelectThinking={onSelectThinking}
          />
          <div className="composer__actions">
            <input
              ref={fileInputRef}
              className="composer-file-input"
              type="file"
              multiple
              accept="image/png,image/jpeg,image/webp,image/gif,text/*,.json,.js,.jsx,.ts,.tsx,.md,.css,.html,.xml,.yaml,.yml,.toml,.rs,.go,.py,.swift,.kt,.java,.c,.cc,.cpp,.h,.hpp,.sh,.sql"
              onChange={(event) => void addFiles(Array.from(event.currentTarget.files ?? []))}
            />
            <button className="attach-button" type="button" onClick={() => fileInputRef.current?.click()} disabled={!connected || readingAttachments || attachments.length >= MAX_ATTACHMENTS} title="Attach images or text files" aria-label="Attach images or text files">
              {readingAttachments ? <CircleNotch className="spin" size={15} /> : attachments.some((attachment) => attachment.kind === "image") ? <ImageSquare size={15} weight="light" /> : <Paperclip size={15} weight="light" />}
            </button>
            {streaming && (
              <button className="stop-button" type="button" onClick={onAbort} disabled={stopping} title={stopping ? "Stopping Main Pi" : "Stop Main Pi"} aria-label={stopping ? "Stopping Main Pi" : "Stop Main Pi"}>
                {stopping ? <CircleNotch className="spin" size={13} /> : <Stop size={12} weight="fill" />}
              </button>
            )}
            {(text.trim() || attachments.length > 0) && (
              <button className="send-button" type="button" onClick={() => submit()} disabled={!connected || readingAttachments} title="Send message">
                <ArrowUp size={15} weight="bold" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
