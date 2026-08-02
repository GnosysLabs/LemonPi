import { FolderOpen, SlidersHorizontal, ToggleLeft, ToggleRight, X } from "@phosphor-icons/react";
import { useEffect, useRef } from "react";

export function ProjectTrustDialog({
  path,
  busy,
  onCancel,
  onOpenWithoutConfig,
  onOpenWithConfig,
}: {
  path: string;
  busy: boolean;
  onCancel: () => void;
  onOpenWithoutConfig: () => void;
  onOpenWithConfig: () => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const name = path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const frame = window.requestAnimationFrame(() => dialogRef.current?.focus());
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
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
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
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-trust-title"
        aria-describedby="project-trust-description"
        aria-busy={busy || undefined}
        ref={dialogRef}
        tabIndex={-1}
      >
        <header className="project-trust-dialog__header">
          <span className="project-trust-dialog__mark"><SlidersHorizontal size={24} weight="bold" /></span>
          <div>
            <p className="eyebrow">Workspace setup</p>
            <h2 id="project-trust-title">Open workspace</h2>
          </div>
          <button type="button" className="project-trust-dialog__close" onClick={onCancel} disabled={busy} aria-label="Cancel opening workspace"><X size={16} /></button>
        </header>

        <div className="project-trust-dialog__body">
          <p id="project-trust-description">Choose whether Pi loads project-specific configuration from this folder.</p>
          <div className="project-trust-dialog__path" title={path}>
            <FolderOpen size={17} weight="fill" />
            <span><strong>{name}</strong><small>{path}</small></span>
          </div>

          <div className="project-trust-choices">
            <button type="button" className="project-trust-choice" onClick={onOpenWithoutConfig} disabled={busy}>
              <span className="project-trust-choice__icon"><ToggleLeft size={22} weight="bold" /></span>
              <span className="project-trust-choice__copy">
                <strong>{busy ? "Opening…" : "Open without project config"}</strong>
                <small>Pi ignores this folder’s settings, extensions, skills, and packages. Agent tools can still access workspace files.</small>
              </span>
            </button>

            <button type="button" className="project-trust-choice" onClick={onOpenWithConfig} disabled={busy}>
              <span className="project-trust-choice__icon"><ToggleRight size={22} weight="bold" /></span>
              <span className="project-trust-choice__copy">
                <strong>{busy ? "Opening…" : "Open with project config"}</strong>
                <small>Pi loads this folder’s settings, extensions, skills, and packages. Project extensions can run with your user permissions.</small>
              </span>
            </button>
          </div>
        </div>

        <footer className="project-trust-dialog__footer">
          <span>Select how Pi should handle this folder’s project configuration.</span>
          <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>
        </footer>
      </section>
    </div>
  );
}
