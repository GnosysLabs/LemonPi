export const CURRENT_ORCHESTRATION_POLICY_VERSION = 10;

export const ORCHESTRATION_POLICY_NOTICE = `<lemonpi-authoritative-policy version="${CURRENT_ORCHESTRATION_POLICY_VERSION}">
The installed LemonPi orchestration policy is authoritative. Historical summaries preserve product facts and user decisions only. Any older scheduling, review, validation, model-routing, context-reuse, or Git instruction is superseded. Main Pi directly handles low-risk one-repository UI slices; only broader work uses independent delegated lanes. Main Pi owns safe local Git integration and exact validation reuse.
</lemonpi-authoritative-policy>`;

const HISTORICAL_POLICY = /\b(?:one|single) writer(?: at a time| only)?\b|\bserial (?:execution|workflow|workers?)\b|\bnever (?:commit|use worktrees?|run workers? in parallel)\b/i;

export function supersedeHistoricalPolicy(text: string): string {
  if (!HISTORICAL_POLICY.test(text) || text.includes("<lemonpi-authoritative-policy")) return text;
  return `${text.trimEnd()}\n\n[Historical workflow instructions above are non-authoritative and superseded by LemonPi orchestration policy v${CURRENT_ORCHESTRATION_POLICY_VERSION}. Product facts and user decisions remain valid.]`;
}

export type DirtyPathClass = "intentional-source" | "mission-work" | "generated" | "agent-artifact" | "suspicious" | "ambiguous";

export interface DirtyPath {
  status: string;
  path: string;
  classification: DirtyPathClass;
  reason: string;
}

const SUSPICIOUS_PATH = /(?:^|\/)(?:\.env(?:\.|$)|credentials?(?:\.|$)|secrets?(?:\.|$)|id_(?:rsa|ed25519)|.*\.(?:pem|key|p12|pfx|sqlite|sqlite3|db))$/i;
const GENERATED_PATH = /(?:^|\/)(?:target|dist|build|coverage|node_modules|\.turbo|\.vite|DerivedData)(?:\/|$)|\.(?:log|tmp|cache)$/i;
const AGENT_ARTIFACT_PATH = /(?:^|\/)(?:\.pi-subagents|\.lemonpi|artifacts?)(?:\/|$)/i;
const SOURCE_PATH = /\.(?:c|cc|cpp|cs|css|go|h|hpp|html|java|js|jsx|json|kt|kts|md|mjs|py|rb|rs|scss|sh|sql|swift|toml|ts|tsx|vue|xml|yaml|yml)$/i;

export function parseDirtyStatusLine(line: string, missionPaths: string[] = []): DirtyPath {
  const status = line.slice(0, 2).trim() || "??";
  const rawPath = line.slice(3).trim();
  const path = rawPath.includes(" -> ") ? rawPath.split(" -> ").at(-1)! : rawPath;
  const normalizedMissionPaths = missionPaths.map((value) => value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, ""));
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
  if (SUSPICIOUS_PATH.test(normalized)) return { status, path, classification: "suspicious", reason: "may contain credentials or private runtime data" };
  if (AGENT_ARTIFACT_PATH.test(normalized)) return { status, path, classification: "agent-artifact", reason: "agent-generated lifecycle or report artifact" };
  if (GENERATED_PATH.test(normalized)) return { status, path, classification: "generated", reason: "reproducible build or tool output" };
  if (normalizedMissionPaths.some((root) => normalized === root || normalized.startsWith(`${root}/`) || root.startsWith(`${normalized}/`))) {
    return { status, path, classification: "mission-work", reason: "matches an explicitly owned mission path" };
  }
  if (status !== "??" && SOURCE_PATH.test(normalized)) return { status, path, classification: "intentional-source", reason: "tracked source or project configuration" };
  return { status, path, classification: "ambiguous", reason: "cannot be safely classified without user context" };
}

export function classifyDirtyTree(lines: string[], missionPaths: string[] = []): DirtyPath[] {
  return lines.filter((line) => line.trim()).map((line) => parseDirtyStatusLine(line, missionPaths));
}

export function checkpointBlocker(paths: DirtyPath[]): DirtyPath | undefined {
  return paths.find((entry) => entry.classification === "suspicious" || entry.classification === "ambiguous");
}

export function checkpointBlockersForSelection(
  paths: DirtyPath[],
  selectedPaths: string[],
  confirmedPaths: string[] = [],
): DirtyPath[] {
  const normalize = (value: string) => value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
  const selected = selectedPaths.map(normalize);
  const confirmed = new Set(confirmedPaths.map(normalize));
  return paths.filter((entry) => {
    const path = normalize(entry.path);
    if (!selected.some((root) => path === root || path.startsWith(`${root}/`))) return false;
    if (entry.classification === "suspicious") return true;
    return entry.classification === "ambiguous" && !confirmed.has(path);
  });
}

export function trustedWorkerPatchPath(
  patchPath: string,
  artifactRunId: string | undefined,
  missionRunIds: string[],
): boolean {
  const normalized = patchPath.replace(/\\/g, "/");
  if (!normalized.endsWith(".patch")) return false;
  if (normalized.startsWith(".pi-subagents/artifacts/worktree-diffs/")
    || normalized.includes("/.pi-subagents/artifacts/worktree-diffs/")) return true;
  if (!artifactRunId || !missionRunIds.includes(artifactRunId)) return false;
  const escaped = artifactRunId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`/\\.pi/lemonpi/preserved-patches/[^/]*${escaped}[^/]*\\.patch$`).test(normalized)) return true;
  return new RegExp(`/async-subagent-runs/${escaped}/worktree-diffs/step-\\d+/task-\\d+-[^/]+\\.patch$`).test(normalized);
}

export interface OwnedLane {
  id: string;
  paths: string[];
  dependsOn?: string[];
}

function pathOverlap(left: string, right: string): boolean {
  const a = left.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
  const b = right.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export function scheduleOwnedLanes(lanes: OwnedLane[], completed = new Set<string>()): {
  ready: OwnedLane[];
  blocked: Array<{ lane: OwnedLane; reason: string }>;
} {
  const ready: OwnedLane[] = [];
  const blocked: Array<{ lane: OwnedLane; reason: string }> = [];
  for (const lane of lanes) {
    const dependency = lane.dependsOn?.find((id) => !completed.has(id));
    if (dependency) {
      blocked.push({ lane, reason: `depends on ${dependency}` });
      continue;
    }
    const conflict = ready.find((candidate) => candidate.paths.some((left) => lane.paths.some((right) => pathOverlap(left, right))));
    if (conflict) {
      const path = conflict.paths.find((left) => lane.paths.some((right) => pathOverlap(left, right)))!;
      blocked.push({ lane, reason: `ownership conflicts with ${conflict.id} at ${path}` });
      continue;
    }
    ready.push(lane);
  }
  return { ready, blocked };
}

export type ExecutionMode = "read-only" | "implementation";

export const SUBAGENT_RPC_PROTOCOL_VERSION = 1;
export const SUBAGENT_LIFECYCLE_ARTIFACT_VERSION = 3;
export const REQUIRED_SUBAGENT_RPC_METHODS = ["ping", "status", "spawn", "steer", "stop"] as const;

export type WorkerStopCause = "user" | "user_shutdown" | "optional_budget" | "inactivity_watchdog" | "process_crash" | "application_shutdown" | "superseded" | "dependency_failure" | "unknown";

export interface WorkerStopProvenance {
  cause: WorkerStopCause;
  initiator: string;
  initiatingRunId?: string;
  reason: string;
  requestedAt: number;
}

export interface SubagentRpcHandshake {
  protocolVersion: typeof SUBAGENT_RPC_PROTOCOL_VERSION;
  lifecycleArtifactVersion: typeof SUBAGENT_LIFECYCLE_ARTIFACT_VERSION;
  methods: string[];
  capabilities: Record<string, unknown>;
}

export function validateSubagentRpcHandshake(value: unknown): SubagentRpcHandshake {
  const root = objectRecord(value);
  const capabilities = objectRecord(root?.capabilities);
  const terminalProof = objectRecord(capabilities?.processTerminalProof);
  const methods = Array.isArray(root?.methods)
    ? root.methods.filter((method): method is string => typeof method === "string")
    : [];
  if (root?.version !== SUBAGENT_RPC_PROTOCOL_VERSION) {
    throw new Error(`Incompatible pi-subagents RPC protocol: expected ${SUBAGENT_RPC_PROTOCOL_VERSION}, received ${String(root?.version ?? "missing")}.`);
  }
  const missingMethod = REQUIRED_SUBAGENT_RPC_METHODS.find((method) => !methods.includes(method));
  if (missingMethod) throw new Error(`Incompatible pi-subagents RPC implementation: missing '${missingMethod}' capability.`);
  if (terminalProof?.lifecycleArtifactVersion !== SUBAGENT_LIFECYCLE_ARTIFACT_VERSION) {
    throw new Error(`Incompatible pi-subagents lifecycle artifacts: expected ${SUBAGENT_LIFECYCLE_ARTIFACT_VERSION}, received ${String(terminalProof?.lifecycleArtifactVersion ?? "missing")}.`);
  }
  return {
    protocolVersion: SUBAGENT_RPC_PROTOCOL_VERSION,
    lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
    methods,
    capabilities: capabilities ?? {},
  };
}

export const LEMONPI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type LemonPiThinkingLevel = typeof LEMONPI_THINKING_LEVELS[number];

export interface AgentLaunchBinding {
  agent: string;
  provider: string;
  modelId: string;
  model: string;
  thinking: LemonPiThinkingLevel;
  source: "user-agent-override" | "user-agent-override+project-opt-in" | "project-opt-in";
  settingsHash: string;
}

export interface AgentLaunchBindingResolution {
  binding?: AgentLaunchBinding;
  error?: string;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function nonEmptySetting(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, stableValue(entry)]));
}

/**
 * Resolve one immutable launch binding from user-owned LemonPi settings.
 * Conversation/tool-call fields are deliberately absent from this API.
 */
export function resolveAgentLaunchBinding(input: {
  agent: string;
  userSettings: unknown;
  projectSettings?: unknown;
  availableModels: string[];
  configuredFallbackModels?: string[];
}): AgentLaunchBindingResolution {
  const user = objectRecord(input.userSettings) ?? {};
  const userSubagents = objectRecord(user.subagents) ?? {};
  const userOverrides = objectRecord(userSubagents.agentOverrides) ?? {};
  const userEntry = objectRecord(userOverrides[input.agent]) ?? {};
  const allowProject = userSubagents.allowProjectAgentRouting === true;
  const rawProject = objectRecord(input.projectSettings) ?? {};
  const project = allowProject ? rawProject : {};
  const projectSubagents = objectRecord(project.subagents) ?? {};
  const projectOverrides = objectRecord(projectSubagents.agentOverrides) ?? {};
  const projectEntry = objectRecord(projectOverrides[input.agent]) ?? {};
  const rawProjectEntry = objectRecord(objectRecord(objectRecord(rawProject.subagents)?.agentOverrides)?.[input.agent]) ?? {};

  const configuredFallbacks = [
    ...(Array.isArray(userEntry.fallbackModels) ? userEntry.fallbackModels.filter((value): value is string => typeof value === "string" && Boolean(value.trim())) : []),
    ...(Array.isArray(rawProjectEntry.fallbackModels) ? rawProjectEntry.fallbackModels.filter((value): value is string => typeof value === "string" && Boolean(value.trim())) : []),
    ...(input.configuredFallbackModels ?? []).filter((value) => value.trim()),
  ];
  if (configuredFallbacks.length > 0) {
    return { error: `LemonPi settings error for agent '${input.agent}': automatic fallback models are configured (${[...new Set(configuredFallbacks)].join(", ")}). LemonPi requires one exact model; remove fallbackModels from LemonPi settings or the named agent definition before launch. No child was launched.` };
  }

  const userModel = nonEmptySetting(userEntry.model);
  const userThinking = nonEmptySetting(userEntry.thinking);
  const projectModel = allowProject ? nonEmptySetting(projectEntry.model) : undefined;
  const projectThinking = allowProject ? nonEmptySetting(projectEntry.thinking) : undefined;
  const model = userModel ?? projectModel;
  const thinking = userThinking ?? projectThinking;

  if (!model || !thinking) {
    const missing = [!model ? "model" : undefined, !thinking ? "thinking" : undefined].filter(Boolean).join(" and ");
    return {
      error: `LemonPi settings error for agent '${input.agent}': set ${missing} in user subagents.agentOverrides.${input.agent}. Project routing is ${allowProject ? "enabled but did not provide the missing value" : "disabled by default"}. No child was launched.`,
    };
  }
  if (!LEMONPI_THINKING_LEVELS.includes(thinking as LemonPiThinkingLevel)) {
    return { error: `LemonPi settings error for agent '${input.agent}': thinking '${thinking}' is invalid. Use ${LEMONPI_THINKING_LEVELS.join(", ")}. No child was launched.` };
  }
  if (/:(?:off|minimal|low|medium|high|xhigh|max)$/i.test(model)) {
    return { error: `LemonPi settings error for agent '${input.agent}': keep thinking separate from model '${model}'. No child was launched.` };
  }
  const normalizedAvailable = new Set(input.availableModels.map((value) => value.trim().toLowerCase()).filter(Boolean));
  if (normalizedAvailable.size === 0) {
    return { error: `LemonPi could not verify configured model '${model}' for agent '${input.agent}' because the authenticated model registry is empty. No child was launched.` };
  }
  if (!normalizedAvailable.has(model.toLowerCase())) {
    return { error: `LemonPi settings error for agent '${input.agent}': configured model '${model}' is not authenticated and available. No fallback was used and no child was launched.` };
  }

  const source: AgentLaunchBinding["source"] = userModel && userThinking
    ? "user-agent-override"
    : (userModel || userThinking) ? "user-agent-override+project-opt-in" : "project-opt-in";
  const relevantSettings = {
    agent: input.agent,
    user: { model: userModel, thinking: userThinking, allowProjectAgentRouting: allowProject },
    ...(allowProject ? { project: { model: projectModel, thinking: projectThinking } } : {}),
  };
  const separator = model.indexOf("/");
  if (separator <= 0 || separator === model.length - 1) {
    return { error: `LemonPi settings error for agent '${input.agent}': model '${model}' must include an exact provider/model identifier. No child was launched.` };
  }
  return {
    binding: {
      agent: input.agent,
      provider: model.slice(0, separator),
      modelId: model.slice(separator + 1),
      model,
      thinking: thinking as LemonPiThinkingLevel,
      source,
      settingsHash: contentHash(JSON.stringify(stableValue(relevantSettings))),
    },
  };
}

/** Return the first model/thinking field that could alter a child launch. */
export function launchOverridePath(value: unknown, path = "subagent"): string | undefined {
  const record = objectRecord(value);
  if (!record) return undefined;
  for (const field of ["model", "provider", "thinking", "reasoning", "effort", "timeoutMs", "maxRuntimeMs", "turnBudget", "toolBudget", "usageBudget", "limitPolicy", "limits"] as const) {
    if (Object.hasOwn(record, field)) return `${path}.${field}`;
  }
  for (const key of ["lanes", "tasks", "chain", "parallel"] as const) {
    const nested = record[key];
    if (Array.isArray(nested)) {
      for (let index = 0; index < nested.length; index += 1) {
        const issue = launchOverridePath(nested[index], `${path}.${key}[${index}]`);
        if (issue) return issue;
      }
    } else if (nested !== undefined) {
      const issue = launchOverridePath(nested, `${path}.${key}`);
      if (issue) return issue;
    }
  }
  return undefined;
}

export function recommendedReasoning(agent: string, task: string): "low" | "medium" | "high" {
  const role = agent.toLowerCase();
  const materialRisk = /\b(?:authentication|authorization|security|privacy|cryptograph|migration|destructive|concurrency|release|public protocol)\b/i.test(task);
  const unresolvedArchitecture = /\b(?:unresolved architecture|architecture decision|choose architecture)\b/i.test(task);
  if (role === "scout" || role === "researcher") return "low";
  if (role === "planner") return unresolvedArchitecture ? "high" : "medium";
  if (role === "reviewer") return materialRisk ? "high" : "medium";
  if (role === "worker" || role.includes("writer") || role === "designer") return materialRisk ? "high" : "medium";
  return "medium";
}

export interface LaunchPreflightInput {
  agent: string;
  availableAgents: string[];
  mode: ExecutionMode;
  agentTools?: string[];
  model?: string;
  availableModels?: string[];
  repositoryExists: boolean;
  ownedPaths?: string[];
  outputPath: string;
  existingOutputPaths: Set<string>;
}

export function launchPreflightIssue(input: LaunchPreflightInput): string | undefined {
  if (!input.availableAgents.includes(input.agent)) return `Agent '${input.agent}' is not available.`;
  if (input.model && input.availableModels && !input.availableModels.includes(input.model)) return `Model '${input.model}' is not available.`;
  if (!input.repositoryExists) return "The requested repository or managed worktree does not exist.";
  if (input.mode === "implementation") {
    if (!input.ownedPaths?.length) return "Implementation requires at least one exact owned path.";
    if (input.agentTools && !input.agentTools.some((tool) => ["edit", "write", "apply_patch", "patch"].includes(tool))) {
      return `Implementation agent '${input.agent}' has no write or edit tool.`;
    }
  }
  if (!input.outputPath.trim() || input.existingOutputPaths.has(input.outputPath)) return "The slice output path is not unique.";
  return undefined;
}

export interface WorkerAttempt {
  runId: string;
  launchId?: string;
  agent?: string;
  task?: string;
  originalObjective?: string;
  originalTask?: string;
  purpose: string;
  status: "running" | "completed" | "partial" | "budget_exhausted" | "failed" | "stopped";
  executionMode: ExecutionMode;
  model?: string;
  provider?: string;
  modelId?: string;
  thinking?: LemonPiThinkingLevel;
  settingsSource?: AgentLaunchBinding["source"];
  settingsHash?: string;
  completedOrdinal: number;
  sliceCount: number;
  transcriptBytes: number;
  tokens: number;
  turns?: number;
  toolCalls?: number;
  startedAt?: number;
  elapsedMs?: number;
  activityState?: string;
  currentTool?: string;
  currentPath?: string;
  budgetStopReason?: string;
  budgetPhase?: "work" | "warning" | "finalizing";
  budgetWarningSent?: boolean;
  limitPolicy?: WorkerLimitPolicy;
  hardLimitPending?: boolean;
  hardLimitBoundaryToolCount?: number;
  finalizationInstructionSent?: boolean;
  finalizationMarkerPath?: string;
  preservedPatchPath?: string;
  stopProvenance?: WorkerStopProvenance;
  telemetryObservedAt?: number;
  telemetrySequence?: number;
  lastHealthCheckAt?: number;
  healthCheckFailures?: number;
  lastMeaningfulProgressAt?: number;
  lastProgressFingerprint?: string;
  repeatedProgressFingerprint?: number;
  progressNudgeCount?: number;
  continuationOf?: string;
  continuationDepth?: number;
  progressFingerprint?: string;
  primaryValidation?: PrimaryValidationTarget;
  checkpoint?: string;
  checkpointRef?: string;
  checkpointCommit?: string;
  checkpointPatchDigest?: string;
  checkpointBaseRevision?: string;
  checkpointChangedPaths?: string[];
  checkpointCreatedAt?: number;
  checkpointArchivedAt?: number;
  latestDiagnostics?: string[];
  completedConditions?: string[];
  unresolvedConditions?: string[];
  ownershipExpansions?: Array<{ paths: string[]; reason: string; category: OwnershipExpansionCategory; expandedAt: number }>;
  terminalCommittedAt?: number;
  usableOutput?: boolean;
  partialHandoffPath?: string;
  emptyOutput?: boolean;
  corrupted?: boolean;
  todoId?: number;
  outcomeId?: string;
  worktreePath?: string;
  runtimeDirectory?: string;
  repository?: string;
  baseRevision?: string;
  /** Original user-branch base used to integrate a cumulative continuation chain. */
  integrationBaseRevision?: string;
  ownedPaths?: string[];
  artifactPath?: string;
  handoffPath?: string;
  integratedRevision?: string;
  integrationStatus?: "pending" | "integrated" | "no-changes";
  cleanupPending?: boolean;
}

export type WorkerHardLimitBehavior = "warn-only" | "checkpoint-and-pause" | "checkpoint-and-stop";

export interface WorkerLimitPolicy {
  enabled: boolean;
  source: "disabled-default" | "user-settings";
  behavior: WorkerHardLimitBehavior;
  warning: { tokens?: number; turns?: number; toolCalls?: number; runtimeMs?: number };
  hard: { tokens?: number; turns?: number; toolCalls?: number; runtimeMs?: number };
  settingsHash: string;
  /** Native package budgets stay empty. LemonPi supervises optional limits at safe tool boundaries. */
  spawn: Record<string, never>;
}

export interface PrimaryValidationTarget {
  program: string;
  args: string[];
  cwd?: string;
}

export function workerExecutionBudget(
  agent: string,
  _mode: ExecutionMode,
  userSettings: unknown,
): WorkerLimitPolicy {
  const settings = objectRecord(userSettings) ?? {};
  const subagents = objectRecord(settings.subagents) ?? {};
  const limits = objectRecord(subagents.agentLimits) ?? {};
  const configured = objectRecord(limits[agent]) ?? {};
  const positiveInteger = (name: string) => {
    const parsed = configured[name];
    return typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
  };
  const enabled = configured.enabled === true;
  const behavior = configured.hardStopBehavior === "checkpoint-and-pause" || configured.hardStopBehavior === "checkpoint-and-stop"
    ? configured.hardStopBehavior
    : "warn-only";
  const warning = {
    ...(positiveInteger("tokenWarning") !== undefined ? { tokens: positiveInteger("tokenWarning") } : {}),
    ...(positiveInteger("turnWarning") !== undefined ? { turns: positiveInteger("turnWarning") } : {}),
    ...(positiveInteger("toolWarning") !== undefined ? { toolCalls: positiveInteger("toolWarning") } : {}),
    ...(positiveInteger("runtimeWarningMs") !== undefined ? { runtimeMs: positiveInteger("runtimeWarningMs") } : {}),
  };
  const hard = {
    ...(positiveInteger("tokenHardStop") !== undefined ? { tokens: positiveInteger("tokenHardStop") } : {}),
    ...(positiveInteger("turnHardStop") !== undefined ? { turns: positiveInteger("turnHardStop") } : {}),
    ...(positiveInteger("toolHardStop") !== undefined ? { toolCalls: positiveInteger("toolHardStop") } : {}),
    ...(positiveInteger("runtimeHardStopMs") !== undefined ? { runtimeMs: positiveInteger("runtimeHardStopMs") } : {}),
  };
  return {
    enabled,
    source: enabled ? "user-settings" : "disabled-default",
    behavior,
    warning: enabled ? warning : {},
    hard: enabled ? hard : {},
    settingsHash: contentHash(JSON.stringify(stableValue({ agent, enabled, behavior, warning: enabled ? warning : {}, hard: enabled ? hard : {} }))),
    spawn: {},
  };
}

export function workerBudgetPhase(
  metrics: { tokens: number; turns: number; toolCalls: number; elapsedMs: number },
  budget: WorkerLimitPolicy,
): { phase: "work" | "warning" | "finalizing"; hardStopReason?: string } {
  if (!budget.enabled) return { phase: "work" };
  const crossed = (value: number, threshold: number | undefined) => threshold !== undefined && value >= threshold;
  const hardStopReason = crossed(metrics.tokens, budget.hard.tokens)
    ? `optional token hard stop reached (${metrics.tokens}/${budget.hard.tokens})`
    : crossed(metrics.turns, budget.hard.turns)
      ? `optional turn hard stop reached (${metrics.turns}/${budget.hard.turns})`
      : crossed(metrics.toolCalls, budget.hard.toolCalls)
        ? `optional tool hard stop reached (${metrics.toolCalls}/${budget.hard.toolCalls})`
        : crossed(metrics.elapsedMs, budget.hard.runtimeMs)
          ? `optional runtime hard stop reached (${Math.round(metrics.elapsedMs / 1_000)}s/${Math.round(budget.hard.runtimeMs! / 1_000)}s)`
          : undefined;
  const warning = crossed(metrics.tokens, budget.warning.tokens)
    || crossed(metrics.turns, budget.warning.turns)
    || crossed(metrics.toolCalls, budget.warning.toolCalls)
    || crossed(metrics.elapsedMs, budget.warning.runtimeMs)
    || Boolean(hardStopReason);
  if (hardStopReason && budget.behavior !== "warn-only") return { phase: "finalizing", hardStopReason };
  return { phase: warning ? "warning" : "work" };
}

export function hardLimitBoundaryDecision(input: {
  policy: WorkerLimitPolicy;
  hardStopReason?: string;
  checkpointReady: boolean;
  hardLimitPending: boolean;
  currentTool?: string;
}): "continue" | "checkpoint-and-finalize" | "wait-for-tool-boundary" | "stop-at-boundary" {
  if (!input.policy.enabled || input.policy.behavior === "warn-only" || !input.hardStopReason) return "continue";
  if (!input.checkpointReady || !input.hardLimitPending) return "checkpoint-and-finalize";
  if (input.currentTool) return "wait-for-tool-boundary";
  return "stop-at-boundary";
}

export function finalizationInstructionNeeded(
  attempt: Pick<WorkerAttempt, "finalizationInstructionSent">,
  phase: "work" | "warning" | "finalizing",
): boolean {
  return phase === "finalizing" && attempt.finalizationInstructionSent !== true;
}

function normalizedOwnedPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
}

function exactCommand(program: string, args: string[]): string {
  return [program, ...args].join(" ").replace(/\s+/g, " ").trim();
}

export function finalizationToolIssue(input: {
  toolName: string;
  toolInput: unknown;
  ownedPaths: string[];
  root?: string;
  primaryValidation?: PrimaryValidationTarget;
}): string | undefined {
  const toolName = input.toolName.trim().toLowerCase();
  const toolInput = objectRecord(input.toolInput) ?? {};
  const ownedPaths = input.ownedPaths.map(normalizedOwnedPath);
  if (toolName === "read") {
    let path = typeof toolInput.path === "string" ? normalizedOwnedPath(toolInput.path) : "";
    const root = input.root ? normalizedOwnedPath(input.root) : "";
    if (root && (path === root || path.startsWith(`${root}/`))) path = path.slice(root.length).replace(/^\//, "");
    return path && ownedPaths.some((owned) => path === owned || path.startsWith(`${owned}/`))
      ? undefined
      : "Finalization permits reads only inside the lane's exact owned paths.";
  }
  if (toolName === "bash" || toolName === "shell" || toolName === "shell_command") {
    const command = typeof toolInput.command === "string" ? toolInput.command.replace(/\s+/g, " ").trim() : "";
    if (!command || /(?:&&|\|\||;|\n|\r|`|\$\()/.test(command)) {
      return "Finalization permits one bounded command at a time; command chaining and substitution are blocked.";
    }
    if (/^git (?:status(?: --(?:short|porcelain(?:=v1)?))?|diff(?: --(?:cached|check|stat|name-only|binary))*|rev-parse HEAD)(?: |$)/.test(command)) return undefined;
    const validation = input.primaryValidation ? exactCommand(input.primaryValidation.program, input.primaryValidation.args) : "";
    if (validation && command === validation) return undefined;
    if (/^(?:cargo fmt(?: --check)?|(?:pnpm|npm|yarn|bun) (?:run )?(?:format|fmt)(?: -- [A-Za-z0-9_./-]+)*|(?:npx )?prettier --write [A-Za-z0-9_./ -]+)$/.test(command)) return undefined;
    return "Finalization permits only Git status/diff inspection, bounded formatting, or the lane's one declared validation command. LemonPi creates the durable checkpoint outside the child tool stream.";
  }
  return "LemonPi finalization-only mode blocks new exploration, scope expansion, delegation, and edits. Return the preserved result or handoff now.";
}

export function implementationLaneIssue(input: {
  ownedPaths: string[];
  primaryValidation?: PrimaryValidationTarget;
  checkpoint?: string;
}): string | undefined {
  const paths = [...new Set(input.ownedPaths.map(normalizedOwnedPath).filter(Boolean))];
  if (paths.length === 0) return "Implementation lanes require a small explicit owned-path set.";
  if (paths.length > 8) return `Implementation lane owns ${paths.length} paths; split it into independently checkpointable slices of at most 8 paths.`;
  if (paths.some((path) => path === "." || /^(?:src|src-tauri|app|packages|tests?)$/.test(path))) {
    return "Implementation ownership must name exact files or narrow component directories, not a repository-wide root.";
  }
  const boundaries = new Set(paths.map((path) => {
    const parts = path.split("/");
    return parts[0] === "src-tauri" && parts.length > 1 ? `${parts[0]}/${parts[1]}` : parts[0];
  }));
  if (boundaries.size > 2) {
    return `Implementation lane crosses ${boundaries.size} ownership boundaries (${[...boundaries].join(", ")}); split it into dependent slices before launch.`;
  }
  const validation = input.primaryValidation;
  if (!validation || !validation.program.trim() || !Array.isArray(validation.args) || validation.args.some((arg) => typeof arg !== "string")) {
    return "Implementation lanes require one primaryValidation target with an executable and argument array.";
  }
  if (!input.checkpoint?.trim()) return "Implementation lanes require one independently meaningful checkpoint description.";
  return undefined;
}

export type WorkerTerminalStatus = Exclude<WorkerAttempt["status"], "running">;

function substantiveText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text || /^(?:\(no output\)|delegated run failed\.?|subagent exceeded turn budget[^\n]*|turn budget wrap-up[^\n]*)$/i.test(text)) return undefined;
  return text;
}

export function terminalEvidenceSummary(value: unknown): {
  usefulOutput?: string;
  hasStructuredOutput: boolean;
  artifactPaths: string[];
  inspectedResources: string[];
  cleanExit: boolean;
  budgetReached: boolean;
  corrupt: boolean;
} {
  let usefulOutput: string | undefined;
  let hasStructuredOutput = false;
  let cleanExit = false;
  let budgetReached = false;
  let corrupt = false;
  const artifactPaths = new Set<string>();
  const inspectedResources = new Set<string>();
  const seen = new Set<object>();
  const visit = (candidate: unknown, depth: number, key = "") => {
    if (depth > 9 || candidate === null || candidate === undefined) return;
    if (typeof candidate === "string") {
      if (!usefulOutput && /^(?:output|finalOutput|resultPreview|latestOutput|recentOutput)$/i.test(key)) usefulOutput = substantiveText(candidate);
      if (/^(?:artifactPath|handoffPath|outputPath|patchPath)$/i.test(key) && candidate.trim()) artifactPaths.add(candidate.trim());
      if (/^(?:currentPath|path|file|cwd|sessionFile|transcriptPath)$/i.test(key) && candidate.trim()) inspectedResources.add(candidate.trim());
      return;
    }
    if (typeof candidate !== "object" || seen.has(candidate as object)) return;
    seen.add(candidate as object);
    if (Array.isArray(candidate)) {
      candidate.slice(0, 256).forEach((entry) => visit(entry, depth + 1, key));
      return;
    }
    const record = candidate as Record<string, unknown>;
    if (record.exitCode === 0 || record.success === true || record.state === "complete" || record.state === "completed") cleanExit = true;
    if (record.turnBudgetExceeded === true || record.timedOut === true || /budget/i.test(String(record.stopReason ?? record.error ?? ""))) budgetReached = true;
    if (record.corrupted === true || record.outputState === "corrupt") corrupt = true;
    if (record.structuredOutput !== undefined && record.structuredOutput !== null) hasStructuredOutput = true;
    for (const [childKey, entry] of Object.entries(record).slice(0, 256)) visit(entry, depth + 1, childKey);
  };
  visit(value, 0);
  return { ...(usefulOutput ? { usefulOutput } : {}), hasStructuredOutput, artifactPaths: [...artifactPaths], inspectedResources: [...inspectedResources], cleanExit, budgetReached, corrupt };
}

export function terminalOutcome(input: {
  reportedStatus: "completed" | "failed" | "stopped";
  evidence?: unknown;
  budgetStopReason?: string;
  stopCause?: WorkerStopCause;
}): { status: WorkerTerminalStatus; usableOutput: boolean; summary: ReturnType<typeof terminalEvidenceSummary> } {
  const root = objectRecord(input.evidence);
  const isolatedEvidence = root?.protocolVersion === 2 && objectRecord(root.target) ? root.target : input.evidence;
  const summary = terminalEvidenceSummary(isolatedEvidence);
  const usableOutput = !summary.corrupt && Boolean(summary.usefulOutput || summary.hasStructuredOutput || summary.artifactPaths.length > 0);
  const budgetReached = Boolean(input.budgetStopReason) || summary.budgetReached;
  if (usableOutput && (input.reportedStatus === "completed" || summary.cleanExit)) return { status: "completed", usableOutput, summary };
  if (input.stopCause === "user" || input.stopCause === "user_shutdown") return { status: usableOutput ? "partial" : "stopped", usableOutput, summary };
  if (usableOutput) return { status: "partial", usableOutput, summary };
  if (input.stopCause === "optional_budget" || budgetReached) return { status: "budget_exhausted", usableOutput, summary };
  return { status: input.reportedStatus === "completed" ? "failed" : input.reportedStatus, usableOutput, summary };
}

export function preferredTerminalStatus(previous: WorkerAttempt["status"], next: WorkerTerminalStatus): WorkerTerminalStatus {
  if (previous === "running") return next;
  const rank: Record<WorkerTerminalStatus, number> = { failed: 1, stopped: 2, budget_exhausted: 3, partial: 4, completed: 5 };
  return rank[previous] >= rank[next] ? previous : next;
}

export function immutableResumeBinding(attempt: WorkerAttempt): AgentLaunchBinding | undefined {
  if (!attempt.agent || !attempt.model || !attempt.thinking || !attempt.settingsSource || !attempt.settingsHash) return undefined;
  const separator = attempt.model.indexOf("/");
  if (separator <= 0 || separator === attempt.model.length - 1) return undefined;
  return {
    agent: attempt.agent,
    provider: attempt.model.slice(0, separator),
    modelId: attempt.model.slice(separator + 1),
    model: attempt.model,
    thinking: attempt.thinking,
    source: attempt.settingsSource,
    settingsHash: attempt.settingsHash,
  };
}

export interface PartialWorkerHandoff {
  version: 3;
  originalObjective: string;
  originalTask: string;
  agent: string;
  model: string;
  thinking: LemonPiThinkingLevel;
  settingsSource: AgentLaunchBinding["source"];
  settingsHash: string;
  inspectedResources: string[];
  latestUsefulOutput?: string;
  artifacts: string[];
  ownedPaths: string[];
  completedWork: string[];
  unresolvedWork: string[];
  checkpoint?: {
    ref: string;
    commit: string;
    baseRevision: string;
    patchPath: string;
    patchDigest: string;
    changedPaths: string[];
  };
  relevantChangedPaths: string[];
  latestDiagnostics: string[];
  validations: Array<{ program: string; args: string[]; status: "not_run" | "passed" | "failed" }>;
  remainingRisks: string[];
  completedConditions: string[];
  unresolvedConditions: string[];
  stopReason: string;
  stop: WorkerStopProvenance;
  continuationOf: string;
  progressFingerprint: string;
  exactNextAction: string;
  continuation: { priorRunId: string; mode: "fresh"; unresolvedOnly: true };
}

export function buildPartialWorkerHandoff(input: {
  attempt: WorkerAttempt;
  evidence?: unknown;
  stopReason: string;
}): PartialWorkerHandoff | undefined {
  const attempt = input.attempt;
  if (!attempt.task || !attempt.agent || !attempt.model || !attempt.thinking || !attempt.settingsSource || !attempt.settingsHash) return undefined;
  const evidence = terminalEvidenceSummary(input.evidence);
  const originalTask = attempt.originalTask ?? attempt.task;
  const completedConditions = attempt.completedConditions?.length
    ? attempt.completedConditions
    : evidence.usefulOutput ? ["Preserve and verify the useful output captured below."] : [];
  const declaredConditions = (attempt.unresolvedConditions?.length ? attempt.unresolvedConditions : originalTask.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*(?:done when|completion condition|acceptance condition)\s*:\s*(.+)$/i.exec(line);
    return match?.[1]?.trim() ? [match[1].trim()] : [];
  }));
  const unresolvedConditions = declaredConditions.length > 0
    ? declaredConditions
    : [`Complete only the unresolved scope from the original task after '${input.stopReason}'.`];
  const artifacts = [...new Set([...(attempt.artifactPath ? [attempt.artifactPath] : []), ...(attempt.preservedPatchPath ? [attempt.preservedPatchPath] : []), ...evidence.artifactPaths])];
  const completedWork = evidence.usefulOutput ? [evidence.usefulOutput] : artifacts.length > 0 ? ["A durable implementation patch was preserved."] : [];
  const unresolvedWork = [...unresolvedConditions];
  const stop = attempt.stopProvenance ?? {
    cause: attempt.budgetStopReason ? "optional_budget" : "unknown",
    initiator: "lemonpi-runtime",
    initiatingRunId: attempt.runId,
    reason: input.stopReason,
    requestedAt: attempt.terminalCommittedAt ?? Date.now(),
  } satisfies WorkerStopProvenance;
  const progressFingerprint = contentHash(JSON.stringify({
    completedWork,
    checkpoint: attempt.checkpointCommit ?? attempt.checkpointPatchDigest,
    ownedPaths: attempt.ownedPaths ?? [],
    unresolvedWork,
    diagnostics: attempt.latestDiagnostics ?? [],
  }));
  const checkpoint = attempt.checkpointRef
    && attempt.checkpointCommit
    && attempt.checkpointBaseRevision
    && attempt.preservedPatchPath
    && attempt.checkpointPatchDigest
    ? {
      ref: attempt.checkpointRef,
      commit: attempt.checkpointCommit,
      baseRevision: attempt.checkpointBaseRevision,
      patchPath: attempt.preservedPatchPath,
      patchDigest: attempt.checkpointPatchDigest,
      changedPaths: [...(attempt.checkpointChangedPaths ?? attempt.ownedPaths ?? [])],
    }
    : undefined;
  const exactNextAction = unresolvedConditions[0] ?? "Run the declared focused validation and return the final result.";
  return {
    version: 3,
    originalObjective: attempt.originalObjective ?? attempt.purpose,
    originalTask,
    agent: attempt.agent,
    model: attempt.model,
    thinking: attempt.thinking,
    settingsSource: attempt.settingsSource,
    settingsHash: attempt.settingsHash,
    inspectedResources: evidence.inspectedResources,
    ...(evidence.usefulOutput ? { latestUsefulOutput: evidence.usefulOutput } : {}),
    artifacts,
    ownedPaths: [...(attempt.ownedPaths ?? [])],
    completedWork,
    unresolvedWork,
    ...(checkpoint ? { checkpoint } : {}),
    relevantChangedPaths: [...(attempt.checkpointChangedPaths ?? attempt.ownedPaths ?? [])],
    latestDiagnostics: [...(attempt.latestDiagnostics ?? [])].slice(-8),
    validations: attempt.primaryValidation
      ? [{ ...attempt.primaryValidation, status: "not_run" }]
      : [],
    remainingRisks: ["Validate and integrate only the preserved owned-path change before continuing unresolved work."],
    completedConditions,
    unresolvedConditions,
    stopReason: input.stopReason,
    stop,
    continuationOf: attempt.runId,
    progressFingerprint,
    exactNextAction,
    continuation: { priorRunId: attempt.runId, mode: "fresh", unresolvedOnly: true },
  };
}

export function renderContinuationPrompt(handoff: PartialWorkerHandoff): string {
  const bounded = (values: string[], fallback: string) => (values.length ? values : [fallback])
    .slice(-8)
    .map((value) => `- ${value.replace(/\s+/g, " ").trim().slice(0, 500)}`)
    .join("\n");
  const checkpoint = handoff.checkpoint
    ? `Checkpoint already materialized before launch: ${handoff.checkpoint.ref} at ${handoff.checkpoint.commit}.\nOriginal base: ${handoff.checkpoint.baseRevision}.\nChanged paths:\n${bounded(handoff.checkpoint.changedPaths, "No changed paths recorded")}`
    : "No filesystem checkpoint was available; do not recreate completed implementation without escalating.";
  return `Continue run ${handoff.continuationOf} from its verified filesystem checkpoint. Work only on unresolved conditions; do not repeat repository discovery or embed another continuation task.\n\nObjective:\n${handoff.originalObjective.slice(0, 1_000)}\n\nCompleted conditions:\n${bounded(handoff.completedConditions, "No completed condition was claimed")}\n\nUnresolved conditions:\n${bounded(handoff.unresolvedConditions, "Return the validated final result")}\n\n${checkpoint}\n\nLatest diagnostics:\n${bounded(handoff.latestDiagnostics, "No compiler or validation diagnostic recorded")}\n\nValidations already recorded:\n${bounded(handoff.validations.map((validation) => `${validation.program} ${validation.args.join(" ")} — ${validation.status}`), "None")}\n\nExact next action:\n${handoff.exactNextAction.slice(0, 1_000)}`;
}

export function continuationIssue(input: {
  previous: WorkerAttempt;
  handoff: PartialWorkerHandoff;
  priorFingerprints?: string[];
}): string | undefined {
  if (input.previous.status !== "partial" && input.previous.status !== "budget_exhausted") return "Only partial or budget-exhausted work may continue automatically.";
  if (input.previous.stopProvenance?.cause === "user" || input.previous.stopProvenance?.cause === "user_shutdown") return "Explicitly user-stopped work must not continue automatically.";
  if (input.handoff.continuationOf !== input.previous.runId) return "Continuation handoff does not match the exact prior run.";
  if (input.previous.executionMode === "implementation" && !input.handoff.checkpoint) return "Implementation continuation requires a verified filesystem checkpoint.";
  if (input.priorFingerprints?.includes(input.handoff.progressFingerprint)) return "Continuation made no measurable progress; another automatic retry is blocked.";
  return undefined;
}

export interface ResumeRequest {
  run: WorkerAttempt;
  lastCompletedRunId?: string;
  purpose: string;
  correction: boolean;
  limits?: { maxTranscriptBytes?: number };
}

export function workerContextLimits(environment: Record<string, string | undefined> = {}): {
  maxTranscriptBytes: number;
} {
  const positiveInteger = (name: string, fallback: number) => {
    const parsed = Number(environment[name]);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    maxTranscriptBytes: positiveInteger("LEMONPI_WORKER_MAX_TRANSCRIPT_BYTES", 2_000_000),
  };
}

export interface WorkerStatusMetrics {
  runId: string;
  tokens: number;
  turns: number;
  toolCalls: number;
  startedAt?: number;
  elapsedMs: number;
  activityState?: string;
  currentTool?: string;
  currentPath?: string;
  lastActivityAt?: number;
  latestOutput?: string;
  terminal: boolean;
  transcriptPaths: string[];
  observedAt: number;
  sequence?: number;
}

export function typedTargetStatusFromRunStatus(value: unknown, requestedRunId: string, now = Date.now()): Record<string, unknown> {
  const status = objectRecord(value);
  if (!status) throw new Error(`Malformed status artifact for '${requestedRunId}'.`);
  const runId = typeof status.runId === "string" ? status.runId.trim() : "";
  if (!runId || runId !== requestedRunId) throw new Error(`Status artifact mismatch: requested '${requestedRunId}', received '${runId || "missing"}'.`);
  const state = typeof status.state === "string" ? status.state.trim().toLowerCase() : "";
  if (!state) throw new Error(`Status artifact is missing state for '${requestedRunId}'.`);
  const totals = objectRecord(status.totalTokens) ?? {};
  const finite = (candidate: unknown, field: string) => {
    if (candidate === undefined) return 0;
    if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < 0) throw new Error(`Malformed ${field} in status artifact for '${requestedRunId}'.`);
    return candidate;
  };
  const inputTokens = finite(totals.input ?? status.inputTokens, "inputTokens");
  const outputTokens = finite(totals.output ?? status.outputTokens, "outputTokens");
  const totalTokens = finite(totals.total ?? (typeof status.totalTokens === "number" ? status.totalTokens : undefined), "totalTokens");
  const startedAt = status.startedAt === undefined ? undefined : finite(status.startedAt, "startedAt");
  const explicitRuntime = finite(status.durationMs ?? status.runtimeMs, "runtimeMs");
  const runtimeMs = startedAt === undefined ? explicitRuntime : Math.max(explicitRuntime, Math.max(0, now - startedAt));
  const observedAt = finite(status.lastUpdate ?? status.observedAt ?? now, "observedAt");
  return {
    protocolVersion: 2,
    target: {
      runId,
      state,
      metrics: {
        inputTokens,
        outputTokens,
        totalTokens,
        turns: finite(status.turnCount, "turns"),
        toolCalls: finite(status.toolCount, "toolCalls"),
        runtimeMs,
        ...(startedAt !== undefined ? { startedAt } : {}),
      },
      terminal: !/^(?:queued|pending|running)$/.test(state),
      observedAt,
      ...(typeof status.sequence === "number" ? { sequence: finite(status.sequence, "sequence") } : {}),
      ...(typeof status.sessionFile === "string" ? { sessionFile: status.sessionFile } : {}),
      ...(typeof status.activityState === "string" ? { activityState: status.activityState } : {}),
      ...(typeof status.currentTool === "string" ? { currentTool: status.currentTool } : {}),
      ...(typeof status.currentPath === "string" ? { currentPath: status.currentPath } : {}),
      ...(typeof status.lastActivityAt === "number" ? { lastActivityAt: finite(status.lastActivityAt, "lastActivityAt") } : {}),
      ...(Array.isArray(status.recentOutput)
        ? { latestOutput: status.recentOutput.filter((entry): entry is string => typeof entry === "string").at(-1) }
        : {}),
    },
  };
}

export function workerStatusMetrics(value: unknown, requestedRunId: string, now = Date.now()): WorkerStatusMetrics {
  if (!requestedRunId.trim()) throw new Error("Targeted worker status requires an exact requested run ID.");
  const root = objectRecord(value);
  if (!root) throw new Error(`Malformed targeted status for '${requestedRunId}': expected an object.`);
  if (root.protocolVersion !== 2) {
    throw new Error(`Incompatible targeted status protocol for '${requestedRunId}': ${String(root.protocolVersion)}.`);
  }
  if (Array.isArray(root.target) || root.targets !== undefined) {
    throw new Error(`Ambiguous targeted status for '${requestedRunId}': exactly one target object is required.`);
  }
  const versionedTarget = objectRecord(root.target);
  const target = versionedTarget;
  if (!target) throw new Error(`Missing targeted status object for '${requestedRunId}'.`);
  const runId = typeof target.runId === "string"
    ? target.runId.trim()
    : typeof target.id === "string"
      ? target.id.trim()
      : "";
  if (!runId) throw new Error(`Targeted status is missing target.runId for requested run '${requestedRunId}'.`);
  if (runId !== requestedRunId) throw new Error(`Targeted status mismatch: requested '${requestedRunId}', received '${runId}'.`);

  const metrics = versionedTarget ? objectRecord(target.metrics) : target;
  if (!metrics) throw new Error(`Targeted status metrics are missing for '${requestedRunId}'.`);
  const finiteCount = (candidate: unknown, field: string, fallback = 0) => {
    if (candidate === undefined) return fallback;
    if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < 0) {
      throw new Error(`Malformed ${field} in targeted status for '${requestedRunId}'.`);
    }
    return candidate;
  };
  if (metrics.totalTokens !== undefined && typeof metrics.totalTokens !== "number" && !objectRecord(metrics.totalTokens)) {
    throw new Error(`Malformed totalTokens in targeted status for '${requestedRunId}'.`);
  }
  if (metrics.tokens !== undefined && !objectRecord(metrics.tokens)) {
    throw new Error(`Malformed tokens in targeted status for '${requestedRunId}'.`);
  }
  const tokenRecord = objectRecord(metrics.totalTokens) ?? objectRecord(metrics.tokens);
  const tokens = finiteCount(
    typeof metrics.totalTokens === "number"
      ? metrics.totalTokens
      : tokenRecord?.total,
    "totalTokens",
  );
  const turns = finiteCount(metrics.turns ?? metrics.turnCount ?? metrics.totalTurns, "turns");
  const toolCalls = finiteCount(metrics.toolCalls ?? metrics.toolCount ?? metrics.totalToolCalls, "toolCalls");
  const startedAt = metrics.startedAt === undefined ? undefined : finiteCount(metrics.startedAt, "startedAt");
  const explicitElapsed = finiteCount(metrics.runtimeMs ?? metrics.durationMs ?? metrics.elapsedMs, "runtimeMs");
  const elapsedMs = startedAt === undefined ? explicitElapsed : Math.max(explicitElapsed, Math.max(0, now - startedAt));
  const rawState = typeof target.state === "string"
    ? target.state
    : typeof target.status === "string"
      ? target.status
      : typeof metrics.activityState === "string"
        ? metrics.activityState
        : "";
  if (!rawState.trim()) throw new Error(`Targeted status is missing state for '${requestedRunId}'.`);
  const state = rawState.trim().toLowerCase();
  const activityState = typeof target.activityState === "string"
    ? target.activityState.trim().toLowerCase()
    : typeof metrics.activityState === "string"
      ? metrics.activityState.trim().toLowerCase()
      : state;
  const currentTool = typeof target.currentTool === "string" && target.currentTool.trim() ? target.currentTool.trim() : undefined;
  const currentPath = typeof target.currentPath === "string" && target.currentPath.trim() ? target.currentPath.trim() : undefined;
  const lastActivityAt = target.lastActivityAt === undefined ? undefined : finiteCount(target.lastActivityAt, "lastActivityAt");
  const latestOutput = typeof target.latestOutput === "string" && target.latestOutput.trim() ? target.latestOutput.trim().slice(-2_000) : undefined;
  const terminal = typeof target.terminal === "boolean"
    ? target.terminal
    : /^(?:complete|completed|failed|rejected|stopped|cancelled|canceled|partial|budget_exhausted)$/.test(state);
  const transcriptPaths = [target.sessionFile, target.transcriptPath, metrics.sessionFile, metrics.transcriptPath]
    .filter((path): path is string => typeof path === "string" && Boolean(path.trim()))
    .map((path) => path.trim());
  const observedAt = finiteCount(target.observedAt ?? target.lastUpdate, "observedAt", now);
  const sequence = target.sequence === undefined ? undefined : finiteCount(target.sequence, "sequence");
  return {
    runId,
    tokens,
    turns,
    toolCalls,
    ...(startedAt !== undefined ? { startedAt } : {}),
    elapsedMs,
    activityState,
    ...(currentTool ? { currentTool } : {}),
    ...(currentPath ? { currentPath } : {}),
    ...(lastActivityAt !== undefined ? { lastActivityAt } : {}),
    ...(latestOutput ? { latestOutput } : {}),
    terminal,
    transcriptPaths: [...new Set(transcriptPaths)],
    observedAt,
    ...(sequence !== undefined ? { sequence } : {}),
  };
}

export function telemetryUpdateIssue(
  previous: Pick<WorkerAttempt, "telemetryObservedAt" | "telemetrySequence">,
  next: Pick<WorkerStatusMetrics, "observedAt" | "sequence">,
): string | undefined {
  if (next.sequence !== undefined && previous.telemetrySequence !== undefined && next.sequence < previous.telemetrySequence) return "stale telemetry sequence";
  if (next.sequence === undefined && previous.telemetryObservedAt !== undefined && next.observedAt < previous.telemetryObservedAt) return "stale telemetry observation";
  return undefined;
}

export interface WorkerProgressObservation {
  diffFingerprint?: string;
  inspectedEvidence?: string;
  diagnostic?: string;
  validation?: string;
  checkpointCommit?: string;
  currentTool?: string;
  currentPath?: string;
  lastActivityAt?: number;
}

export function workerProgressFingerprint(observation: WorkerProgressObservation): string {
  return contentHash(JSON.stringify(stableValue({
    diffFingerprint: observation.diffFingerprint,
    inspectedEvidence: observation.inspectedEvidence,
    diagnostic: observation.diagnostic,
    validation: observation.validation,
    checkpointCommit: observation.checkpointCommit,
    currentTool: observation.currentTool,
    currentPath: observation.currentPath,
  })));
}

export function progressSupervisionDecision(input: {
  now: number;
  lastMeaningfulProgressAt?: number;
  healthCheckFailures: number;
  progressNudgeCount: number;
  fingerprintChanged: boolean;
}): "continue" | "nudge" | "checkpoint-and-escalate" | "health-check-escalation" {
  if (input.fingerprintChanged || input.lastMeaningfulProgressAt === undefined) return "continue";
  const inactiveMs = Math.max(0, input.now - input.lastMeaningfulProgressAt);
  if (input.healthCheckFailures >= 3 && inactiveMs >= 2 * 60_000) return "health-check-escalation";
  if (inactiveMs >= 20 * 60_000 && input.progressNudgeCount > 0) return "checkpoint-and-escalate";
  if (inactiveMs >= 10 * 60_000 && input.progressNudgeCount === 0) return "nudge";
  return "continue";
}

export type OwnershipExpansionCategory = "compiler-required" | "registration" | "lockfile" | "direct-test" | "formatting";

export function ownershipExpansionIssue(input: {
  runId: string;
  currentPaths: string[];
  requestedPaths: string[];
  reason: string;
  category: OwnershipExpansionCategory;
  activeLanes: Array<{ runId: string; paths: string[] }>;
}): string | undefined {
  const requested = [...new Set(input.requestedPaths.map(normalizedOwnedPath).filter(Boolean))];
  if (!input.reason.trim()) return "Ownership expansion requires a recorded mechanical reason.";
  if (requested.length === 0) return "Ownership expansion requires at least one exact repository-relative path.";
  if (requested.some((path) => path === "." || path.startsWith("../") || /[*?\[\]{}]/.test(path))) return "Ownership expansion accepts exact repository-relative paths only.";
  const newPaths = requested.filter((path) => !input.currentPaths.map(normalizedOwnedPath).includes(path));
  if (newPaths.length === 0) return "Every requested path is already owned by this lane.";
  for (const lane of input.activeLanes) {
    if (lane.runId === input.runId) continue;
    const overlap = newPaths.find((path) => lane.paths.some((owned) => pathOverlap(path, normalizedOwnedPath(owned))));
    if (overlap) return `Ownership expansion conflicts with active run ${lane.runId} at ${overlap}.`;
  }
  return undefined;
}

export function resumeWorkerIssue(input: ResumeRequest): string | undefined {
  const limits = { ...workerContextLimits(), ...input.limits };
  if (!input.correction) return "Completed workers may only resume for a bounded correction to their immediately preceding slice.";
  if (input.run.runId !== input.lastCompletedRunId) return "Only the immediately preceding completed worker may be resumed.";
  if (input.run.status !== "completed") return "Failed, stopped, or still-running workers require recovery or a fresh bounded context, not resume.";
  if (input.run.emptyOutput || input.run.corrupted) return "Empty-output or corrupted sessions require a fresh smaller context.";
  if (input.run.executionMode !== "implementation") return "A wrong-execution-mode implementation attempt cannot be resumed.";
  if (input.run.transcriptBytes >= limits.maxTranscriptBytes) return "The worker transcript is too large; launch a fresh bounded worker.";
  if (!input.purpose.trim()) return "A resumed worker needs a fresh concrete purpose.";
  return undefined;
}

export function uniqueArtifactPath(missionId: string, sliceId: string, ordinal: number): string {
  const safe = (value: string) => value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "slice";
  return `.pi-subagents/artifacts/outputs/${safe(missionId)}/${String(ordinal).padStart(3, "0")}-${safe(sliceId)}.json`;
}

export function contentHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function missionStateContentHash(value: unknown): string {
  const stable = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(stable);
    if (!candidate || typeof candidate !== "object") return candidate;
    return Object.fromEntries(Object.entries(candidate as Record<string, unknown>)
      .filter(([key]) => key !== "updatedAt")
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stable(entry)]));
  };
  return contentHash(JSON.stringify(stable(value)));
}

export interface ReviewRecord {
  repository: string;
  revision: string;
  diffHash: string;
  scope: string[];
  riskBoundary: string;
  accepted: boolean;
}

export function reviewLedgerKey(value: Omit<ReviewRecord, "accepted">): string {
  const { repository, revision, diffHash, scope } = value as ReviewRecord;
  return contentHash(JSON.stringify({ repository, revision, diffHash, scope: [...scope].sort() }));
}

export function reviewDeduplicationIssue(records: ReviewRecord[], candidate: Omit<ReviewRecord, "accepted">): string | undefined {
  const key = reviewLedgerKey(candidate);
  return records.some((record) => record.accepted && reviewLedgerKey(record) === key)
    ? "This exact revision, diff, and scope already has an accepted review. Reuse it instead of commissioning another rationale for the same patch."
    : undefined;
}

export interface ValidationRecord {
  repository: string;
  baseRevision: string;
  diffHash: string;
  executable: string;
  args: string[];
  cwd: string;
  environmentHash: string;
  command: string;
  relevantPaths: string[];
  dependencyState: string;
  scope: "focused" | "wave" | "final";
  passed: boolean;
  elapsedMs: number;
}

export function validationLedgerKey(value: Omit<ValidationRecord, "passed" | "elapsedMs">): string {
  const { repository, baseRevision, diffHash, executable, args, cwd, environmentHash, relevantPaths, dependencyState } = value as ValidationRecord;
  return contentHash(JSON.stringify({ repository, baseRevision, diffHash, executable, args, cwd, environmentHash, relevantPaths: [...relevantPaths].sort(), dependencyState }));
}

export function validationDeduplicationIssue(records: ValidationRecord[], candidate: Omit<ValidationRecord, "passed" | "elapsedMs">): string | undefined {
  const key = validationLedgerKey(candidate);
  return records.some((record) => record.passed && validationLedgerKey(record) === key)
    ? "Identical validation already passed for the same revision, inputs, paths, and dependency state."
    : undefined;
}

export function validationLaunchFailure(code: number, stderr: string): boolean {
  return code < 0 || /(?:\bENOENT\b|not recognized as an internal or external command|cannot find (?:the )?(?:file|executable)|failed to (?:launch|spawn)|no such file or directory)/i.test(stderr);
}

export function validationActivityLabel(command: string, startedAt: number, now: number): string {
  return `Validation active: ${command} · ${Math.max(0, Math.floor((now - startedAt) / 1_000))}s elapsed`;
}

export function invalidatesValidation(record: ValidationRecord, changedPaths: string[], dependencyState: string): boolean {
  if (record.dependencyState !== dependencyState) return true;
  return changedPaths.some((changed) => record.relevantPaths.some((relevant) => pathOverlap(changed, relevant)));
}

export interface FastPathInput {
  request: string;
  paths: string[];
}

const HIGH_RISK_SCOPE = /\b(?:auth(?:entication|orization)?|backend|billing|crypto(?:graphy)?|database|migration|payment|protocol|release|schema|security|server|synchroni[sz](?:e[ds]?|ing|ation)|websocket)\b/i;
const HIGH_RISK_PATH = /(?:^|\/)(?:api|auth|backend|database|migrations?|protocol|server|src-tauri)(?:\/|$)|(?:^|\/)(?:Cargo\.toml|Cargo\.lock|.*\.sql)$/i;
const UI_PATH = /\.(?:css|html|jsx?|scss|svelte|swift|tsx?|vue)$/i;

export function likelyFastPathRequest(request: string): boolean {
  return /\b(?:add|change|display|fix|implement|make|move|remove|show|style|update)\b/i.test(request)
    && /\b(?:badge|button|dot|icon|indicator|label|layout|menu|spacing|style|unread|visual)\b/i.test(request)
    && !HIGH_RISK_SCOPE.test(request);
}

export function fastPathIssue(input: FastPathInput): string | undefined {
  if (input.paths.length < 1 || input.paths.length > 5) return "Fast path requires one to five exact UI paths in one repository.";
  if (HIGH_RISK_SCOPE.test(input.request)) return "This request names synchronization or another material backend/risk boundary; use a separately scoped implementation phase.";
  for (const path of input.paths) {
    if (!path || path.startsWith("/") || path.includes("..") || /[*?{}[\]]/.test(path)) return "Fast-path ownership must use exact repository-relative paths without globs.";
    if (!UI_PATH.test(path) || HIGH_RISK_PATH.test(path.replace(/\\/g, "/"))) return `Fast path is limited to ordinary UI source; ${path} crosses that boundary.`;
  }
  return undefined;
}

export function hiddenScopeExpansionIssue(request: string, laneTasks: string[]): string | undefined {
  const visibleUiRequest = likelyFastPathRequest(request);
  if (!visibleUiRequest) return undefined;
  const expanded = laneTasks.find((task) => HIGH_RISK_SCOPE.test(task));
  return expanded
    ? "This visible UI request expanded into backend, protocol, or synchronization work. Deliver the local visible slice first and list synchronization explicitly as phase two."
    : undefined;
}

export function internalContractFallback(failures: number): "retry" | "fallback" {
  return failures >= 2 ? "fallback" : "retry";
}

export type FailureClass = "process-disappearance" | "stale-run" | "empty-output" | "command-syntax" | "test-failure" | "needs-attention" | "capability-preflight" | "implementation-failure";

export function classifyFailure(message: string): FailureClass {
  if (/process .*?(?:exited|disappeared)|runner process/i.test(message)) return "process-disappearance";
  if (/stale[- ]run|stale history|reconciliation/i.test(message)) return "stale-run";
  if (/no output|empty response|empty model/i.test(message)) return "empty-output";
  if (/syntax error|unknown option|invalid (?:grep|find|rg|command)|\b(?:rg|grep|find):.*invalid option/i.test(message)) return "command-syntax";
  if (/test(?:s| suite)? failed|assertion failed/i.test(message)) return "test-failure";
  if (/needs attention|no observed activity/i.test(message)) return "needs-attention";
  if (/unavailable (?:agent|model|tool)|preflight|no write|read-only/i.test(message)) return "capability-preflight";
  return "implementation-failure";
}

export function recoveryAction(failure: FailureClass, correctionAttempts: number): string {
  if (failure === "command-syntax" && correctionAttempts === 0) return "correct-command-in-context";
  if (failure === "test-failure") return "preserve-work-and-retry-failed-check";
  if (failure === "needs-attention") return "inspect-and-steer-once";
  if (failure === "stale-run") return "reconcile-authoritative-status";
  if (failure === "capability-preflight") return "reject-before-launch";
  return "preserve-partial-work-and-launch-fresh-smaller-context";
}

export interface Milestone {
  id: string;
  status: "pending" | "active" | "accepted" | "failed" | "blocked" | "validating";
}

export function missionProgress(milestones: Milestone[]): { accepted: number; total: number; percentage: number } {
  const accepted = milestones.filter((item) => item.status === "accepted").length;
  return { accepted, total: milestones.length, percentage: milestones.length ? Math.round((accepted / milestones.length) * 100) : 0 };
}

export interface ReplayMetrics {
  criticalPathMinutes: number;
  modelTurns: number;
  workerRuns: number;
  reviewerRuns: number;
  failedLaunches: number;
  duplicateValidations: number;
  contextKilobytes: number;
  workerTranscriptReuses: number;
  testMinutes: number;
  checkpoints: number;
  integrationCommits: number;
}

export function reducedIncidentReplay(policy: "old" | "current"): ReplayMetrics {
  if (policy === "old") {
    return {
      criticalPathMinutes: 116,
      modelTurns: 248,
      workerRuns: 13,
      reviewerRuns: 19,
      failedLaunches: 3,
      duplicateValidations: 9,
      contextKilobytes: 10_240,
      workerTranscriptReuses: 11,
      testMinutes: 48,
      checkpoints: 0,
      integrationCommits: 0,
    };
  }
  const waves = [
    [5, 5, 4],
    [5, 4, 4],
    [5, 5],
    [4, 3],
  ];
  const implementationCriticalPath = waves.reduce((sum, wave) => sum + Math.max(...wave), 0);
  return {
    criticalPathMinutes: implementationCriticalPath + 6 + 8,
    modelTurns: 82,
    workerRuns: 11,
    reviewerRuns: 2,
    failedLaunches: 0,
    duplicateValidations: 0,
    contextKilobytes: 1_280,
    workerTranscriptReuses: 1,
    testMinutes: 18,
    checkpoints: 1,
    integrationCommits: 5,
  };
}
