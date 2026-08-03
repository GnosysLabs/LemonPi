import type { PairingHostCandidate, PairingMaterial, RemoteAccessMode, RemoteConfig, RemoteDevice, RemoteStatus } from "./remote-client";

export const ACCESS_MODE_LABELS: Record<RemoteAccessMode, string> = {
  lanAndTailscale: "LAN & Tailscale",
  lanOnly: "LAN only",
  tailscaleOnly: "Tailscale only",
};

export interface RemoteConfigDraft {
  enabled: boolean;
  port: string | number;
  accessMode: RemoteAccessMode;
}

export function parseRemotePort(value: string | number): number | undefined {
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return undefined;
  const port = Number(text);
  return Number.isSafeInteger(port) && port >= 1 && port <= 65_535 ? port : undefined;
}

export function remotePortError(value: string | number): string | undefined {
  return parseRemotePort(value) === undefined ? "Enter a whole port number from 1 to 65535." : undefined;
}

/** Builds the full versioned payload instead of dropping storage-version fields. */
export function completeRemoteConfig(config: RemoteConfig, draft: RemoteConfigDraft): RemoteConfig {
  const port = parseRemotePort(draft.port);
  if (port === undefined) throw new Error("Enter a whole port number from 1 to 65535.");
  return { ...config, enabled: draft.enabled, port, accessMode: draft.accessMode };
}

export interface RemoteStatusPresentation {
  label: "Disabled" | "Starting or unavailable" | "Running";
  tone: "neutral" | "warning" | "success";
  detail: string;
}

export function describeRemoteStatus(status: RemoteStatus): RemoteStatusPresentation {
  if (!status.enabled) return { label: "Disabled", tone: "neutral", detail: "Remote access is off." };
  if (!status.running) return { label: "Starting or unavailable", tone: "warning", detail: "The listener is not available yet." };
  return { label: "Running", tone: "success", detail: "The TLS listener is accepting paired devices." };
}

export function abbreviateHostId(hostId: string): string {
  return hostId.length <= 12 ? hostId : `${hostId.slice(0, 8)}…${hostId.slice(-4)}`;
}

export interface PairingExpiry {
  expired: boolean;
  secondsRemaining: number;
  label: string;
}

export function pairingExpiry(expiresAt: string, now = Date.now()): PairingExpiry {
  const expires = Date.parse(expiresAt);
  const secondsRemaining = Number.isFinite(expires) ? Math.max(0, Math.ceil((expires - now) / 1000)) : 0;
  const minutes = Math.floor(secondsRemaining / 60);
  const seconds = secondsRemaining % 60;
  return {
    expired: secondsRemaining === 0,
    secondsRemaining,
    label: `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`,
  };
}

/** Redacts display-only pairing material immediately at or after expiry. */
export function redactExpiredPairing(material: PairingMaterial | undefined, now = Date.now()): PairingMaterial | undefined {
  return material && !pairingExpiry(material.expiresAt, now).expired ? material : undefined;
}

export function formatPairingExpiry(expiresAt: string): string {
  const parsed = new Date(expiresAt);
  if (Number.isNaN(parsed.getTime())) return "Unknown expiry";
  return parsed.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });
}

export function formatPairedAt(pairedAt: string): string {
  const parsed = new Date(pairedAt);
  if (Number.isNaN(parsed.getTime())) return "Unknown pairing time";
  return parsed.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** The exact versioned payload understood by LemonPi Go's scanner and manual paste flow. */
export function pairingPayload(material: PairingMaterial): string {
  return JSON.stringify({
    version: material.version,
    host: material.host,
    port: material.port,
    hostId: material.hostId,
    code: material.code,
    certificatePin: material.certificatePin,
  });
}

export function compatiblePairingHosts(
  candidates: PairingHostCandidate[],
  mode: RemoteAccessMode,
): PairingHostCandidate[] {
  return candidates.filter((candidate) => (
    mode === "lanAndTailscale"
    || (mode === "tailscaleOnly" && candidate.network === "tailscale")
    || (mode === "lanOnly" && candidate.network === "lan")
  ));
}

export function pairingHostLabel(candidate: PairingHostCandidate): string {
  const network = candidate.network === "tailscale" ? "Tailscale" : "Local network";
  return `${candidate.host} — ${network} (${candidate.interfaceName})`;
}

function isIpv4Segment(value: string): boolean {
  return /^\d+$/.test(value) && Number(value) >= 0 && Number(value) <= 255;
}

/** Accepts the plain IPv6 text accepted by Rust's IpAddr parser, never bracketed URL syntax. */
function isPlainIpv6(host: string): boolean {
  if (!host.includes(":")) return false;
  const halves = host.split("::");
  if (halves.length > 2) return false;
  const compressed = halves.length === 2;
  const groups = host.split(":");
  let units = 0;

  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index];
    if (!group) continue;
    const finalGroup = index === groups.length - 1;
    if (finalGroup && group.includes(".")) {
      const octets = group.split(".");
      if (octets.length !== 4 || !octets.every(isIpv4Segment)) return false;
      units += 2;
    } else if (/^[0-9a-fA-F]{1,4}$/.test(group)) {
      units += 1;
    } else {
      return false;
    }
  }
  return compressed ? units < 8 : units === 8;
}

/**
 * Mirrors the server's deliberately small pairing-host grammar for early feedback.
 * Callers should pass the trimmed value to the backend; the backend remains authoritative.
 */
export function pairingHostError(value: string): string | undefined {
  const host = value.trim();
  if (!host) return "Enter the address this device will use.";
  if (host.length > 253) return "Addresses must be 253 characters or fewer.";
  if (/[/?#@\[\]]/.test(host)) return "Enter a hostname or plain IP address, not a URL.";
  if (isPlainIpv6(host)) return undefined;
  if (host.includes(":")) return "Use a plain IPv6 address without brackets.";

  const validDns = !host.startsWith(".") && !host.endsWith(".") && host.split(".").every((label) => (
    label.length > 0
    && label.length <= 63
    && !label.startsWith("-")
    && !label.endsWith("-")
    && /^[a-zA-Z0-9-]+$/.test(label)
  ));
  return validDns ? undefined : "Enter a valid hostname or plain IP address.";
}

export interface RemoteUiState {
  requestGeneration: number;
  disposed: boolean;
  config?: RemoteConfig;
  status?: RemoteStatus;
  devices: RemoteDevice[];
  pairing?: PairingMaterial;
}

export const initialRemoteUiState: RemoteUiState = {
  requestGeneration: 0,
  disposed: false,
  devices: [],
};

/** Each operation supersedes older responses, preventing stale async writes. */
export function beginRemoteRequest(state: RemoteUiState): RemoteUiState {
  return { ...state, requestGeneration: state.requestGeneration + 1 };
}

export function applyRemoteResponse(
  state: RemoteUiState,
  generation: number,
  patch: Partial<Omit<RemoteUiState, "requestGeneration" | "disposed">>,
): RemoteUiState {
  if (state.disposed || generation !== state.requestGeneration) return state;
  return { ...state, ...patch };
}

export function disposeRemoteUi(state: RemoteUiState): RemoteUiState {
  return { ...state, disposed: true, requestGeneration: state.requestGeneration + 1, pairing: undefined };
}

/** Listener changes invalidate the single-use material, even when it remains running. */
export function applyRemoteConfiguration(state: RemoteUiState, config: RemoteConfig, status: RemoteStatus): RemoteUiState {
  return { ...state, config, status, pairing: undefined };
}

export function clearRemotePairing(state: RemoteUiState): RemoteUiState {
  return { ...state, pairing: undefined };
}

export function shouldRefreshDevicesAfterRevoke(_wasRevoked: boolean): true {
  return true;
}

export function staleDeviceNotice(wasRevoked: boolean): string | undefined {
  return wasRevoked ? undefined : "That device was already removed. The list has been refreshed.";
}
