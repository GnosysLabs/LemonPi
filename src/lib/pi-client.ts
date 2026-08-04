import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { KnownProjectSyncInput, PiEvent, PiPackageInfo, PiPackagesSnapshot, PiProcessEvent, PiProcessInfo, PiSessionSummary, PiSettingsScope, PiSettingsSnapshot, RemoteProjectSummary, RpcCommand, SubagentActivityTarget, SubagentLiveActivity, SubagentRunStatus, SubagentSettingsScope, SubagentSettingsSnapshot, UnreadReceiptSnapshot } from "./pi-types";

export function isTauriRuntime(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

export async function detectPi(): Promise<PiProcessInfo> {
  return invoke<PiProcessInfo>("detect_pi");
}

export async function startPi(cwd: string, trusted: boolean): Promise<PiProcessInfo> {
  return invoke<PiProcessInfo>("start_pi", { cwd, trusted });
}

export async function stopPi(): Promise<void> {
  return invoke("stop_pi");
}

export async function listPiSessions(cwd: string): Promise<PiSessionSummary[]> {
  return invoke<PiSessionSummary[]>("list_pi_sessions", { cwd });
}

export async function markPiSessionRead(
  project: string,
  sessionPath: string,
  readReplyId: string,
): Promise<UnreadReceiptSnapshot> {
  return invoke<UnreadReceiptSnapshot>("mark_pi_session_read", { project, sessionPath, readReplyId });
}

/** Best-effort desktop refresh of opaque remote project mappings; this never enables remote access. */
export async function syncKnownProjects(projects: KnownProjectSyncInput[]): Promise<RemoteProjectSummary[]> {
  return invoke<RemoteProjectSummary[]>("sync_known_projects", { projects });
}

export async function getGitBranch(project: string): Promise<string | null> {
  return invoke<string | null>("get_git_branch", { project });
}

export async function getSubagentRuns(sessionFile: string): Promise<SubagentRunStatus[]> {
  return invoke<SubagentRunStatus[]>("get_subagent_runs", { sessionFile });
}

export async function getSubagentActivity(project: string, targets: SubagentActivityTarget[]): Promise<SubagentLiveActivity[]> {
  return invoke<SubagentLiveActivity[]>("get_subagent_activity", { project, targets });
}

export async function getSubagentSettings(scope: SubagentSettingsScope): Promise<SubagentSettingsSnapshot> {
  return invoke<SubagentSettingsSnapshot>("get_subagent_settings", { scope });
}

export async function setSubagentOverride(
  scope: SubagentSettingsScope,
  agent: string,
  field: "model" | "thinking",
  value?: string,
): Promise<SubagentSettingsSnapshot> {
  return invoke<SubagentSettingsSnapshot>("set_subagent_override", { scope, agent, field, value });
}

export async function getPiSettings(scope: PiSettingsScope): Promise<PiSettingsSnapshot> {
  return invoke<PiSettingsSnapshot>("get_pi_settings", { scope });
}

export async function setPiSetting(
  scope: PiSettingsScope,
  path: string,
  value?: unknown,
): Promise<PiSettingsSnapshot> {
  return invoke<PiSettingsSnapshot>("set_pi_setting", { scope, path, value });
}

export async function replacePiSettings(
  scope: PiSettingsScope,
  settings: Record<string, unknown>,
): Promise<PiSettingsSnapshot> {
  return invoke<PiSettingsSnapshot>("replace_pi_settings", { scope, settings });
}

export async function getPiPackages(): Promise<PiPackagesSnapshot> {
  return invoke<PiPackagesSnapshot>("get_pi_packages");
}

export async function runPiPackageAction(
  action: "install" | "remove" | "update",
  source: PiPackageInfo["source"] | undefined,
  scope: PiSettingsScope,
): Promise<PiPackagesSnapshot> {
  return invoke<PiPackagesSnapshot>("run_pi_package_action", { action, source, scope });
}

export async function sendPi(command: RpcCommand | object, project?: string | null): Promise<void> {
  return invoke("send_pi", { command, project: project ?? null });
}

export async function onPiEvent(handler: (event: PiEvent) => void): Promise<UnlistenFn> {
  return listen<PiEvent>("pi-event", ({ payload }) => handler(payload));
}

export async function onPiProcessEvent(handler: (event: PiProcessEvent) => void): Promise<UnlistenFn> {
  return listen<PiProcessEvent>("pi-process-event", ({ payload }) => handler(payload));
}

export async function onPiStderr(handler: (line: string) => void): Promise<UnlistenFn> {
  return listen<string>("pi-stderr", ({ payload }) => handler(payload));
}
