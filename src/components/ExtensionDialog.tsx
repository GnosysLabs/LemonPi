import { Check, ChatCircleDots, PencilSimple, X } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { parseQuestionnairePrompt } from "../lib/extension-questionnaire";
import type { RpcExtensionUiRequest } from "../lib/pi-types";

export type ExtensionUiResponse =
  | { type: "extension_ui_response"; id: string; value: string }
  | { type: "extension_ui_response"; id: string; confirmed: boolean }
  | { type: "extension_ui_response"; id: string; cancelled: true };

export function ExtensionDialog({
  request,
  onRespond,
}: {
  request: RpcExtensionUiRequest;
  onRespond: (response: ExtensionUiResponse) => void;
}) {
  const questionnaire = useMemo(() => parseQuestionnairePrompt(request), [request]);
  const [value, setValue] = useState(request.prefill ?? "");
  const [selected, setSelected] = useState<number[]>([]);
  const [previewNumber, setPreviewNumber] = useState<number>();
  const respondedRef = useRef(false);

  useEffect(() => {
    setValue(request.prefill ?? "");
    setSelected([]);
    setPreviewNumber(questionnaire?.options.find((option) => option.preview)?.number);
    respondedRef.current = false;
  }, [questionnaire, request.id, request.prefill]);

  const respond = (response: ExtensionUiResponse) => {
    if (respondedRef.current) return;
    respondedRef.current = true;
    onRespond(response);
  };
  const cancel = () => respond({ type: "extension_ui_response", id: request.id, cancelled: true });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      cancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  useEffect(() => {
    if (!request.timeout) return;
    const timeoutId = window.setTimeout(cancel, Math.max(0, request.timeout - 50));
    return () => window.clearTimeout(timeoutId);
  }, [request.id, request.timeout]);

  const preview = questionnaire?.options.find((option) => option.number === previewNumber)?.preview;
  const hasPreview = questionnaire?.options.some((option) => Boolean(option.preview)) ?? false;
  const isQuestionnaire = Boolean(questionnaire);
  const title = questionnaire?.question ?? request.title ?? "Input requested";

  const submitValue = (nextValue: string) => respond({
    type: "extension_ui_response",
    id: request.id,
    value: nextValue,
  });

  return (
    <div className="modal-backdrop" role="presentation">
      <section
        className={`extension-dialog${isQuestionnaire ? " extension-dialog--questionnaire" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="extension-dialog-title"
      >
        <header className="extension-dialog__header">
          <div className="extension-dialog__heading">
            <div className="extension-dialog__context">
              <ChatCircleDots size={17} weight="duotone" />
              <span>{isQuestionnaire ? "Pi needs your input" : "Pi extension"}</span>
              {questionnaire?.header && <strong>{questionnaire.header}</strong>}
            </div>
            <h2 id="extension-dialog-title">{title}</h2>
          </div>
          <button type="button" onClick={cancel} aria-label="Dismiss question"><X size={17} /></button>
        </header>

        {request.method === "confirm" && (
          <div className="extension-dialog__body">
            <p className="extension-dialog__message">{request.message}</p>
            <div className="extension-dialog__actions">
              <button className="secondary-action" type="button" onClick={() => respond({ type: "extension_ui_response", id: request.id, confirmed: false })}>Not now</button>
              <button className="primary-action primary-action--compact" type="button" onClick={() => respond({ type: "extension_ui_response", id: request.id, confirmed: true })}>
                <span>Confirm</span><i><Check size={13} weight="bold" /></i>
              </button>
            </div>
          </div>
        )}

        {questionnaire?.kind === "single" && (
          <div className={`questionnaire-layout${hasPreview ? " questionnaire-layout--preview" : ""}`}>
            <div className="questionnaire-options" role="listbox" aria-label="Answer choices">
              {questionnaire.options.map((option, index) => (
                <button
                  key={option.responseValue}
                  type="button"
                  role="option"
                  aria-selected="false"
                  autoFocus={index === 0}
                  className={`questionnaire-option${option.custom ? " questionnaire-option--custom" : ""}`}
                  onMouseEnter={() => setPreviewNumber(option.preview ? option.number : undefined)}
                  onFocus={() => setPreviewNumber(option.preview ? option.number : undefined)}
                  onClick={() => submitValue(option.responseValue)}
                >
                  <span className="questionnaire-option__marker">{option.custom ? <PencilSimple size={15} /> : option.number}</span>
                  <span className="questionnaire-option__copy">
                    <strong>{option.custom ? "Write my own answer" : option.label}</strong>
                    {option.description && <small>{option.description}</small>}
                  </span>
                  <span className="questionnaire-option__arrow"><Check size={14} weight="bold" /></span>
                </button>
              ))}
            </div>
            {hasPreview && (
              <aside className="questionnaire-preview" aria-label="Choice preview">
                <span>Preview</span>
                {preview
                  ? <div className="markdown"><ReactMarkdown>{preview}</ReactMarkdown></div>
                  : <p className="questionnaire-preview__empty">This choice does not need a preview.</p>}
              </aside>
            )}
          </div>
        )}

        {questionnaire?.kind === "multi" && (
          <form
            className="extension-dialog__body questionnaire-multi"
            onSubmit={(event) => {
              event.preventDefault();
              submitValue(value.trim() || [...selected].sort((left, right) => left - right).join(","));
            }}
          >
            <p className="questionnaire-help">Choose every option that applies, or write a different answer.</p>
            <div className="questionnaire-options questionnaire-options--multi">
              {questionnaire.options.map((option, index) => {
                const checked = selected.includes(option.number);
                return (
                  <button
                    key={option.number}
                    type="button"
                    autoFocus={index === 0}
                    className={`questionnaire-option${checked ? " questionnaire-option--selected" : ""}`}
                    aria-pressed={checked}
                    onClick={() => {
                      setValue("");
                      setSelected((current) => checked
                        ? current.filter((number) => number !== option.number)
                        : [...current, option.number]);
                    }}
                  >
                    <span className="questionnaire-option__check">{checked && <Check size={13} weight="bold" />}</span>
                    <span className="questionnaire-option__copy"><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
                  </button>
                );
              })}
            </div>
            <label className="questionnaire-custom-field">
              <span>Something else</span>
              <textarea
                value={value}
                rows={3}
                placeholder="Write your own answer…"
                onChange={(event) => {
                  setSelected([]);
                  setValue(event.target.value);
                }}
              />
            </label>
            <div className="extension-dialog__actions extension-dialog__actions--split">
              <button className="secondary-action" type="button" onClick={() => submitValue("")}>Skip this question</button>
              <button className="primary-action primary-action--compact" type="submit" disabled={!value.trim() && selected.length === 0}>
                <span>Continue</span><i><Check size={13} weight="bold" /></i>
              </button>
            </div>
          </form>
        )}

        {questionnaire?.kind === "custom" && (
          <form
            className="extension-dialog__body questionnaire-custom-answer"
            onSubmit={(event) => {
              event.preventDefault();
              submitValue(value.trim());
            }}
          >
            <textarea autoFocus value={value} onChange={(event) => setValue(event.target.value)} rows={5} placeholder="Write your answer…" />
            <div className="extension-dialog__actions">
              <button className="secondary-action" type="button" onClick={cancel}>Cancel</button>
              <button className="primary-action primary-action--compact" type="submit" disabled={!value.trim()}><span>Answer</span><i><Check size={13} weight="bold" /></i></button>
            </div>
          </form>
        )}

        {!questionnaire && request.method === "select" && (
          <div className="extension-dialog__options">
            {(request.options ?? []).map((option, index) => (
              <button key={option} autoFocus={index === 0} type="button" onClick={() => submitValue(option)}>
                <span>{option}</span><Check size={13} />
              </button>
            ))}
          </div>
        )}

        {!questionnaire && (request.method === "input" || request.method === "editor") && (
          <form
            className="extension-dialog__body"
            onSubmit={(event) => {
              event.preventDefault();
              submitValue(value);
            }}
          >
            {request.method === "editor" ? (
              <textarea autoFocus value={value} onChange={(event) => setValue(event.target.value)} rows={9} />
            ) : (
              <input autoFocus value={value} onChange={(event) => setValue(event.target.value)} placeholder={request.placeholder} />
            )}
            <div className="extension-dialog__actions">
              <button className="secondary-action" type="button" onClick={cancel}>Cancel</button>
              <button className="primary-action primary-action--compact" type="submit" disabled={!value.trim()}><span>Submit</span><i><Check size={13} weight="bold" /></i></button>
            </div>
          </form>
        )}

        <footer className="extension-dialog__footer"><span>Esc to dismiss</span><span>Your answer goes directly back to Pi</span></footer>
      </section>
    </div>
  );
}
