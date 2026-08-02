import { Check, X } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
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
  const [value, setValue] = useState(request.prefill ?? "");

  useEffect(() => setValue(request.prefill ?? ""), [request]);

  useEffect(() => {
    if (!request.timeout) return;
    const timeoutId = window.setTimeout(
      () => onRespond({ type: "extension_ui_response", id: request.id, cancelled: true }),
      Math.max(0, request.timeout - 50),
    );
    return () => window.clearTimeout(timeoutId);
  }, [onRespond, request.id, request.timeout]);

  const cancel = () => onRespond({ type: "extension_ui_response", id: request.id, cancelled: true });

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && cancel()}>
      <section className="extension-dialog" role="dialog" aria-modal="true" aria-labelledby="extension-dialog-title">
        <div className="extension-dialog__header">
          <div>
            <p className="eyebrow">Pi extension</p>
            <h2 id="extension-dialog-title">{request.title ?? "Input requested"}</h2>
          </div>
          <button type="button" onClick={cancel} aria-label="Close"><X size={15} /></button>
        </div>

        {request.method === "confirm" && (
          <>
            <p className="extension-dialog__message">{request.message}</p>
            <div className="extension-dialog__actions">
              <button className="secondary-action" type="button" onClick={() => onRespond({ type: "extension_ui_response", id: request.id, confirmed: false })}>Not now</button>
              <button className="primary-action primary-action--compact" type="button" onClick={() => onRespond({ type: "extension_ui_response", id: request.id, confirmed: true })}>
                <span>Confirm</span><i><Check size={13} weight="bold" /></i>
              </button>
            </div>
          </>
        )}

        {request.method === "select" && (
          <div className="extension-dialog__options">
            {(request.options ?? []).map((option) => (
              <button key={option} type="button" onClick={() => onRespond({ type: "extension_ui_response", id: request.id, value: option })}>
                <span>{option}</span><Check size={13} />
              </button>
            ))}
          </div>
        )}

        {(request.method === "input" || request.method === "editor") && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              onRespond({ type: "extension_ui_response", id: request.id, value });
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
      </section>
    </div>
  );
}
