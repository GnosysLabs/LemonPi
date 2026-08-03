import { CircleNotch, Coins, GitBranch, Pulse } from "@phosphor-icons/react";
import type { PiSessionState, PiSessionStats } from "../lib/pi-types";

function compactNumber(value: number): string {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

export function StatusStrip({
  state,
  stats,
  project,
  branch,
  connected,
}: {
  state?: PiSessionState;
  stats?: PiSessionStats;
  project?: string;
  branch?: string | null;
  connected: boolean;
}) {
  const projectName = project?.split(/[\\/]/).filter(Boolean).at(-1) ?? "No project";

  return (
    <header className="status-strip">
      <div className="status-strip__identity">
        <div className="status-strip__project" title={project}>
          <GitBranch size={14} weight="light" />
          <span>{projectName}</span>
          <span className="status-strip__branch">{branch === undefined ? "…" : branch ?? "not a Git repo"}</span>
        </div>

        <div className="status-strip__session">
          <span className={`connection-pill connection-pill--${connected ? "online" : "offline"}`}>
            {state?.isCompacting || state?.isStreaming ? <CircleNotch className="spin" size={12} /> : <Pulse size={12} weight="light" />}
            {state?.isCompacting ? "Compacting context" : state?.isStreaming ? "Pi working" : connected ? "Pi ready" : project ? "Offline" : "No project"}
          </span>
          <span className="status-strip__cost" title="Session cost">
            <Coins size={12} weight="light" />
            {stats ? `$${stats.cost.toFixed(3)}` : "$—"}
          </span>
          <span className="status-strip__tokens">{stats ? compactNumber(stats.tokens.total) : "—"} tokens</span>
        </div>
      </div>

    </header>
  );
}
