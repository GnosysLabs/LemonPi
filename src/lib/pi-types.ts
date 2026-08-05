export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface PiModel {
  id: string;
  name?: string;
  provider: string;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
  contextWindow?: number;
}

export interface PiSessionState {
  model?: PiModel;
  thinkingLevel: ThinkingLevel;
  isStreaming: boolean;
  isCompacting: boolean;
  steeringMode: "all" | "one-at-a-time";
  followUpMode: "all" | "one-at-a-time";
  sessionFile?: string;
  sessionId: string;
  sessionName?: string;
  autoCompactionEnabled: boolean;
  messageCount: number;
  pendingMessageCount: number;
  pendingSteeringCount?: number;
  pendingFollowUpCount?: number;
}

export interface PiSessionFinalReply {
  /** Pi's record timestamp when available; internal receipt markers never cross the host boundary. */
  timestamp?: string;
}

export interface PiSessionSummary {
  path: string;
  id: string;
  name?: string;
  parentSessionPath?: string;
  modified: number;
  messageCount: number;
  firstMessage: string;
  lastFinalReply?: PiSessionFinalReply;
  /** Host-authoritative unread projection, present when the desktop unread domain is available. */
  hasUnreadFinalReply?: boolean;
  /** Opaque token derived by the host from its private stable reply marker. */
  lastFinalReplyId?: string;
}

export interface PiSessionStats {
  sessionFile?: string;
  sessionId?: string;
  totalMessages: number;
  toolCalls: number;
  cost: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  contextUsage?: {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  };
}

export type RpcCommand = Record<string, unknown> & {
  id?: string;
  type: string;
};

export interface RpcResponse {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface RpcExtensionUiRequest {
  type: "extension_ui_request";
  id: string;
  method: "select" | "confirm" | "input" | "editor" | "notify" | "setStatus" | "setWidget" | "setTitle" | "set_editor_text";
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  timeout?: number;
  notifyType?: "info" | "warning" | "error";
  statusKey?: string;
  statusText?: string;
  widgetKey?: string;
  widgetLines?: string[];
  widgetPlacement?: "aboveEditor" | "belowEditor";
  text?: string;
}

export interface PiProcessInfo {
  executable: string;
  version: string;
  pid?: number;
  cwd?: string;
  controllerBuildId?: string;
  orchestrationPolicyVersion?: number;
}

/** Desktop-owned recent-project input used only to refresh the private remote catalog. */
export interface KnownProjectSyncInput {
  path: string;
  trusted: boolean;
  lastOpened: number;
  pinned?: boolean;
}

/** Safe remote-facing project metadata; it intentionally contains no filesystem path. */
export interface RemoteProjectSummary {
  projectId: string;
  displayName: string;
  trustState: "trusted" | "untrusted";
  isActive: boolean;
  unreadSessionCount?: number;
}

export interface UnreadReceiptSnapshot {
  projectId: string;
  sessionId: string;
  hasUnreadFinalReply: boolean;
  lastFinalReplyId?: string;
  unreadSessionCount: number;
}

export interface PiProcessEvent {
  state: "started" | "exited" | "stopped" | "error";
  pid?: number;
  code?: number;
  message?: string;
  project?: string;
}

export interface SubagentToolActivity {
  tool: string;
  args: string;
  endMs: number;
}

export interface SubagentStepStatus {
  index?: number;
  agent: string;
  context?: "fresh" | "fork";
  description?: string;
  summary?: string;
  prompt?: string;
  phase?: string;
  label?: string;
  status: "pending" | "running" | "complete" | "completed" | "partial" | "budget_exhausted" | "failed" | "paused" | "stopped" | "rejected";
  sessionFile?: string;
  transcriptPath?: string;
  activityState?: "active_long_running" | "needs_attention";
  lastActivityAt?: number;
  currentTool?: string;
  currentToolArgs?: string;
  currentToolStartedAt?: number;
  currentPath?: string;
  recentTools?: SubagentToolActivity[];
  recentOutput?: string[];
  turnCount?: number;
  toolCount?: number;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  timedOut?: boolean;
  stopped?: boolean;
  tokens?: { input: number; output: number; total: number };
  model?: string;
  thinking?: string;
  budgetPhase?: "work" | "warning" | "finalizing";
  error?: string;
}

export interface SubagentRunStatus {
  lifecycleArtifactVersion?: number;
  runId: string;
  sessionId?: string;
  mode: "single" | "parallel" | "chain";
  state: "queued" | "running" | "complete" | "partial" | "budget_exhausted" | "failed" | "paused" | "stopped" | "rejected";
  error?: string;
  activityState?: "active_long_running" | "needs_attention";
  lastActivityAt?: number;
  currentTool?: string;
  currentToolStartedAt?: number;
  currentPath?: string;
  turnCount?: number;
  toolCount?: number;
  startedAt: number;
  endedAt?: number;
  lastUpdate?: number;
  currentStep?: number;
  steps?: SubagentStepStatus[];
  outputFile?: string;
  totalTokens?: { input: number; output: number; total: number };
  totalCost?: { inputTokens: number; outputTokens: number; costUsd: number };
  statusPath?: string;
  model?: string;
  thinking?: string;
  settingsSource?: string;
  settingsHash?: string;
  budgetPhase?: "work" | "warning" | "finalizing";
  budgetStopReason?: string;
  limitPolicy?: {
    enabled: boolean;
    source: "disabled-default" | "user-settings";
    behavior: "warn-only" | "checkpoint-and-pause" | "checkpoint-and-stop";
    warning: { tokens?: number; turns?: number; toolCalls?: number; runtimeMs?: number };
    hard: { tokens?: number; turns?: number; toolCalls?: number; runtimeMs?: number };
    settingsHash: string;
  };
  partialHandoffPath?: string;
  checkpointRef?: string;
  checkpointCommit?: string;
  checkpointPatchDigest?: string;
  checkpointChangedPaths?: string[];
  stopProvenance?: {
    cause: "user" | "user_shutdown" | "optional_budget" | "inactivity_watchdog" | "process_crash" | "application_shutdown" | "superseded" | "dependency_failure" | "unknown";
    initiator: string;
    initiatingRunId?: string;
    reason: string;
    requestedAt: number;
  };
  provider?: string;
  modelId?: string;
}

export type SubagentActivityKind = "reasoning" | "message" | "tool" | "result" | "error";

export interface SubagentActivityEvent {
  kind: SubagentActivityKind;
  text: string;
  at: number;
}

export interface SubagentLiveActivity {
  key: string;
  headline?: string;
  headlineKind?: SubagentActivityKind;
  lastActivityAt?: number;
  events: SubagentActivityEvent[];
}

export interface SubagentActivityTarget {
  key: string;
  runId: string;
  agent: string;
  index: number;
  transcriptPath?: string;
  sessionFile?: string;
}

export type SubagentSettingsScope = "user" | "project";
export type SubagentSettingSource = "project" | "user" | "agent-file" | "project-default" | "user-default" | "session";

export interface SubagentSettingInfo {
  name: string;
  description: string;
  source: "builtin" | "user" | "project" | "configured";
  effectiveModel?: string;
  effectiveThinking?: string;
  modelOverride?: string;
  thinkingOverride?: string;
  modelSource: SubagentSettingSource;
  thinkingSource: SubagentSettingSource;
  modelLocked: boolean;
  thinkingLocked: boolean;
  shadowedByProject: boolean;
}

export interface SubagentSettingsSnapshot {
  agents: SubagentSettingInfo[];
  scope: SubagentSettingsScope;
  userSettingsPath: string;
  projectSettingsPath?: string;
  projectRoutingEnabled: boolean;
}

export type PiSettingsScope = "user" | "project";

export interface PiSettingsSnapshot {
  scope: PiSettingsScope;
  path: string;
  settings: Record<string, unknown>;
  effectiveSettings: Record<string, unknown>;
}

export interface PiPackageInfo {
  source: string;
  scope: PiSettingsScope;
  location?: string;
  installed: boolean;
  required: boolean;
}

export interface PiPackagesSnapshot {
  packages: PiPackageInfo[];
  coreReady: boolean;
}

export interface ContentPart {
  type: string;
  text?: string;
  thinking?: string;
  data?: string;
  mimeType?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}

export interface AgentMessage {
  role: "user" | "assistant" | "toolResult" | "bashExecution" | string;
  content?: string | ContentPart[];
  timestamp?: number;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  details?: unknown;
  customType?: string;
}

export type PiEvent = Record<string, unknown> & {
  type: string;
};

export function isRpcResponse(event: PiEvent): event is PiEvent & RpcResponse {
  return event.type === "response" && typeof event.command === "string" && typeof event.success === "boolean";
}

export function isExtensionUiRequest(event: PiEvent): event is PiEvent & RpcExtensionUiRequest {
  return event.type === "extension_ui_request" && typeof event.id === "string" && typeof event.method === "string";
}
