import { FolderOpen, ShieldCheck, ShieldWarning, X } from "@phosphor-icons/react";
import { useEffect, useRef } from "react";

export function ProjectTrustDialog({
  path,
  busy,
  onCancel,
  onOpenSafely,
  onTrust,
}: {
  path: string;
  busy: boolean;
  onCancel: () => void;
  onOpenSafely: () => void;
  onTrust: () => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const safeButtonRef = useRef<HTMLButtonElement>(null);
  const name = path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const frame = window.requestAnimationFrame(() => safeButtonRef.current?.focus());
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>("button:not([disabled])")];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleKeyDown);
      previous?.focus();
    };
  }, [busy, onCancel]);

  return (
    <div className="project-trust-backdrop">
      <section
        className="project-trust-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="project-trust-title"
        aria-describedby="project-trust-description"
        aria-busy={busy || undefined}
        ref={dialogRef}
      >
        <header className="project-trust-dialog__header">
          <span className="project-trust-dialog__mark"><ShieldWarning size={24} weight="fill" /></span>
          <div>
            <p className="eyebrow">Workspace security</p>
            <h2 id="project-trust-title">Trust this workspace?</h2>
          </div>
          <button type="button" className="project-trust-dialog__close" onClick={onCancel} disabled={busy} aria-label="Cancel opening workspace"><X size={16} /></button>
        </header>

        <div className="project-trust-dialog__body">
          <p id="project-trust-description">This decision controls whether Pi can load and execute configuration supplied by this folder.</p>
          <div className="project-trust-dialog__path" title={path}>
            <FolderOpen size={17} weight="fill" />
            <span><strong>{name}</strong><small>{path}</small></span>
          </div>

          <div className="project-trust-choices">
            <button ref={safeButtonRef} type="button" className="project-trust-choice project-trust-choice--safe" onClick={onOpenSafely} disabled={busy}>
              <span className="project-trust-choice__icon"><ShieldCheck size={22} weight="fill" /></span>
              <span className="project-trust-choice__copy">
                <span><strong>{busy ? "Opening…" : "Open safely"}</strong><i>Recommended</i></span>
                <small>Ignore project-local Pi settings, extensions, skills, and packages. Agent tools can still read and change files in this folder.</small>
              </span>
            </button>

            <button type="button" className="project-trust-choice project-trust-choice--trusted" onClick={onTrust} disabled={busy}>
              <span className="project-trust-choice__icon"><ShieldWarning size={22} weight="fill" /></span>
              <span className="project-trust-choice__copy">
                <span><strong>{busy ? "Opening…" : "Trust and open"}</strong><i>Full access</i></span>
                <small>Load this folder’s Pi configuration and packages. Project extensions execute code with your operating-system permissions.</small>
              </span>
            </button>
          </div>
        </div>

        <footer className="project-trust-dialog__footer">
          <span>Choose Trust only for code you recognize.</span>
          <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>
        </footer>
      </section>
    </div>
  );
}
