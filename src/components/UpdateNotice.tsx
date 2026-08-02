import type { AppUpdaterPhase } from "../lib/app-updater";

type UpdateNoticeProps = {
  phase: AppUpdaterPhase;
  version?: string;
  error?: string;
  downloadedBytes?: number;
  totalBytes?: number;
  onInstall: () => void;
  onRetry: () => void;
  onDismiss: () => void;
};

function progressLabel(downloadedBytes?: number, totalBytes?: number): string {
  if (!totalBytes || totalBytes <= 0) return "Downloading the signed update…";
  return `Downloading the signed update… ${Math.min(100, Math.round(((downloadedBytes ?? 0) / totalBytes) * 100))}%`;
}

export function UpdateNotice({
  phase,
  version,
  error,
  downloadedBytes,
  totalBytes,
  onInstall,
  onRetry,
  onDismiss,
}: UpdateNoticeProps) {
  if (phase === "idle") return null;
  const progressing = phase === "downloading" || phase === "installing";
  const title = phase === "error"
    ? "LemonPi couldn’t update"
    : phase === "installing"
      ? "Installing LemonPi update…"
      : phase === "downloading"
        ? "Downloading LemonPi update…"
        : `LemonPi ${version ?? "update"} is ready`;
  const detail = phase === "error"
    ? error ?? "The update could not be installed."
    : phase === "installing"
      ? "Restarting LemonPi when installation is complete."
      : phase === "downloading"
        ? progressLabel(downloadedBytes, totalBytes)
        : "The signed update will download, then LemonPi will restart.";

  return (
    <aside className={`update-notice update-notice--${phase}`} role={phase === "error" ? "alert" : "status"} aria-live={phase === "error" ? "assertive" : "polite"}>
      <div className="update-notice__copy">
        <strong>{title}</strong>
        <span>{detail}</span>
      </div>
      {!progressing && phase === "available" && (
        <button className="update-notice__primary" type="button" onClick={onInstall}>Restart and update</button>
      )}
      {!progressing && phase === "error" && (
        <button className="update-notice__primary" type="button" onClick={onRetry}>Try again</button>
      )}
      {!progressing && (
        <button className="update-notice__dismiss" type="button" onClick={onDismiss} aria-label="Dismiss update notice">Dismiss</button>
      )}
    </aside>
  );
}
