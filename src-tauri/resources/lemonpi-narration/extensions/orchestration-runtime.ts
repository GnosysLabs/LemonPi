export const CURRENT_ORCHESTRATION_POLICY_VERSION = 7;

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

export const LEMONPI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type LemonPiThinkingLevel = typeof LEMONPI_THINKING_LEVELS[number];

export interface AgentLaunchBinding {
  agent: string;
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
  return {
    binding: {
      agent: input.agent,
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
  if (Object.hasOwn(record, "model")) return `${path}.model`;
  if (Object.hasOwn(record, "thinking")) return `${path}.thinking`;
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
  purpose: string;
  status: "running" | "completed" | "partial" | "budget_exhausted" | "failed" | "stopped";
  executionMode: ExecutionMode;
  model?: string;
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
  budgetStopReason?: string;
  budgetPhase?: "work" | "warning" | "finalizing";
  budgetWarningSent?: boolean;
  terminalCommittedAt?: number;
  usableOutput?: boolean;
  partialHandoffPath?: string;
  emptyOutput?: boolean;
  corrupted?: boolean;
  todoId?: number;
  outcomeId?: string;
  worktreePath?: string;
  repository?: string;
  baseRevision?: string;
  ownedPaths?: string[];
  artifactPath?: string;
  handoffPath?: string;
  integratedRevision?: string;
  integrationStatus?: "pending" | "integrated" | "no-changes";
  cleanupPending?: boolean;
}

export interface WorkerExecutionBudget {
  warning: { tokens: number; turns: number; toolCalls: number; runtimeMs: number };
  work: { tokens: number; turns: number; toolCalls: number; runtimeMs: number };
  finalization: { tokens: number; turns: number; runtimeMs: number };
  hard: { tokens: number; turns: number; toolCalls: number; runtimeMs: number };
  spawn: {
    timeoutMs: number;
    turnBudget: { maxTurns: number; graceTurns: number };
    toolBudget: { soft: number; hard: number; block: "*" };
    usageBudget: { tokens: { soft: number; hard: number } };
  };
}

export function workerExecutionBudget(
  agent: string,
  mode: ExecutionMode,
  userSettings: unknown,
): WorkerExecutionBudget {
  const defaults = mode === "implementation"
    ? { tokens: 120_000, turns: 12, tools: 45, runtime: 15 * 60_000, finalTokens: 8_000, finalTurns: 2, finalRuntime: 2 * 60_000 }
    : { tokens: 60_000, turns: 10, tools: 30, runtime: 10 * 60_000, finalTokens: 6_000, finalTurns: 2, finalRuntime: 2 * 60_000 };
  const settings = objectRecord(userSettings) ?? {};
  const subagents = objectRecord(settings.subagents) ?? {};
  const budgets = objectRecord(subagents.agentBudgets) ?? {};
  const configured = objectRecord(budgets[agent]) ?? {};
  const positiveInteger = (name: string, fallback: number) => {
    const parsed = configured[name];
    return typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
  };
  const work = {
    tokens: positiveInteger("workMaxTokens", defaults.tokens),
    turns: positiveInteger("workMaxTurns", defaults.turns),
    toolCalls: positiveInteger("workMaxToolCalls", defaults.tools),
    runtimeMs: positiveInteger("workMaxRuntimeMs", defaults.runtime),
  };
  const finalization = {
    tokens: positiveInteger("finalizationTokens", defaults.finalTokens),
    turns: positiveInteger("finalizationTurns", defaults.finalTurns),
    runtimeMs: positiveInteger("finalizationRuntimeMs", defaults.finalRuntime),
  };
  const warning = {
    tokens: Math.min(work.tokens, positiveInteger("warningTokens", Math.floor(work.tokens * 0.8))),
    turns: Math.min(work.turns, positiveInteger("warningTurns", Math.max(1, work.turns - 2))),
    toolCalls: Math.min(work.toolCalls, positiveInteger("warningToolCalls", Math.max(1, work.toolCalls - 5))),
    runtimeMs: Math.min(work.runtimeMs, positiveInteger("warningRuntimeMs", Math.floor(work.runtimeMs * 0.8))),
  };
  const hard = {
    tokens: work.tokens + finalization.tokens,
    turns: work.turns + finalization.turns,
    toolCalls: work.toolCalls,
    runtimeMs: work.runtimeMs + finalization.runtimeMs,
  };
  return {
    warning,
    work,
    finalization,
    hard,
    spawn: {
      timeoutMs: hard.runtimeMs,
      turnBudget: { maxTurns: work.turns, graceTurns: finalization.turns },
      toolBudget: { soft: warning.toolCalls, hard: work.toolCalls, block: "*" },
      usageBudget: { tokens: { soft: warning.tokens, hard: hard.tokens } },
    },
  };
}

export function workerBudgetPhase(
  metrics: { tokens: number; turns: number; toolCalls: number; elapsedMs: number },
  budget: WorkerExecutionBudget,
): { phase: "work" | "warning" | "finalizing"; hardStopReason?: string } {
  const hardStopReason = metrics.tokens >= budget.hard.tokens
    ? `token budget exhausted (${metrics.tokens}/${budget.hard.tokens})`
    : metrics.turns > budget.hard.turns
      ? `turn budget exhausted (${metrics.turns}/${budget.work.turns}+${budget.finalization.turns} finalization)`
      : metrics.elapsedMs >= budget.hard.runtimeMs
        ? `wall-clock budget exhausted (${Math.round(metrics.elapsedMs / 1_000)}s/${Math.round(budget.hard.runtimeMs / 1_000)}s)`
        : undefined;
  const finalizing = metrics.tokens >= budget.work.tokens
    || metrics.turns >= budget.work.turns
    || metrics.toolCalls >= budget.work.toolCalls
    || metrics.elapsedMs >= budget.work.runtimeMs;
  const warning = metrics.tokens >= budget.warning.tokens
    || metrics.turns >= budget.warning.turns
    || metrics.toolCalls >= budget.warning.toolCalls
    || metrics.elapsedMs >= budget.warning.runtimeMs;
  return { phase: finalizing ? "finalizing" : warning ? "warning" : "work", ...(hardStopReason ? { hardStopReason } : {}) };
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
  manuallyStopped?: boolean;
}): { status: WorkerTerminalStatus; usableOutput: boolean; summary: ReturnType<typeof terminalEvidenceSummary> } {
  const summary = terminalEvidenceSummary(input.evidence);
  const usableOutput = !summary.corrupt && Boolean(summary.usefulOutput || summary.hasStructuredOutput || summary.artifactPaths.length > 0);
  const budgetReached = Boolean(input.budgetStopReason) || summary.budgetReached;
  if (input.manuallyStopped) return { status: usableOutput ? "partial" : "stopped", usableOutput, summary };
  if (usableOutput && (input.reportedStatus === "completed" || summary.cleanExit)) return { status: "completed", usableOutput, summary };
  if (usableOutput) return { status: "partial", usableOutput, summary };
  if (budgetReached) return { status: "budget_exhausted", usableOutput, summary };
  return { status: input.reportedStatus === "completed" ? "failed" : input.reportedStatus, usableOutput, summary };
}

export function preferredTerminalStatus(previous: WorkerAttempt["status"], next: WorkerTerminalStatus): WorkerTerminalStatus {
  if (previous === "running") return next;
  const rank: Record<WorkerTerminalStatus, number> = { failed: 1, stopped: 2, budget_exhausted: 3, partial: 4, completed: 5 };
  return rank[previous] >= rank[next] ? previous : next;
}

export function immutableResumeBinding(attempt: WorkerAttempt): AgentLaunchBinding | undefined {
  if (!attempt.agent || !attempt.model || !attempt.thinking || !attempt.settingsSource || !attempt.settingsHash) return undefined;
  return {
    agent: attempt.agent,
    model: attempt.model,
    thinking: attempt.thinking,
    source: attempt.settingsSource,
    settingsHash: attempt.settingsHash,
  };
}

export interface PartialWorkerHandoff {
  version: 1;
  originalTask: string;
  agent: string;
  model: string;
  thinking: LemonPiThinkingLevel;
  settingsSource: AgentLaunchBinding["source"];
  settingsHash: string;
  inspectedResources: string[];
  latestUsefulOutput?: string;
  artifacts: string[];
  completedConditions: string[];
  unresolvedConditions: string[];
  stopReason: string;
  continuationTask: string;
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
  const completedConditions = evidence.usefulOutput ? ["Preserve and verify the useful output captured below."] : [];
  const declaredConditions = attempt.task.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*(?:done when|completion condition|acceptance condition)\s*:\s*(.+)$/i.exec(line);
    return match?.[1]?.trim() ? [match[1].trim()] : [];
  });
  const unresolvedConditions = declaredConditions.length > 0
    ? declaredConditions
    : [`Complete only the unresolved scope from the original task after '${input.stopReason}'.`];
  return {
    version: 1,
    originalTask: attempt.task,
    agent: attempt.agent,
    model: attempt.model,
    thinking: attempt.thinking,
    settingsSource: attempt.settingsSource,
    settingsHash: attempt.settingsHash,
    inspectedResources: evidence.inspectedResources,
    ...(evidence.usefulOutput ? { latestUsefulOutput: evidence.usefulOutput } : {}),
    artifacts: [...new Set([...(attempt.artifactPath ? [attempt.artifactPath] : []), ...evidence.artifactPaths])],
    completedConditions,
    unresolvedConditions,
    stopReason: input.stopReason,
    continuationTask: `Continue only the unresolved portion of this task. Do not repeat completed investigation or overwrite preserved artifacts.\n\nOriginal task:\n${attempt.task}\n\nPreserved findings:\n${evidence.usefulOutput ?? "No reliable final output was returned before the limit."}\n\nUnresolved condition:\n${unresolvedConditions[0]}`,
    continuation: { priorRunId: attempt.runId, mode: "fresh", unresolvedOnly: true },
  };
}

export interface ResumeRequest {
  run: WorkerAttempt;
  lastCompletedRunId?: string;
  purpose: string;
  correction: boolean;
  limits?: { maxTranscriptBytes?: number; maxTokens?: number; maxSlices?: number };
}

export function workerContextLimits(environment: Record<string, string | undefined> = {}): {
  maxTranscriptBytes: number;
  maxTokens: number;
  maxSlices: number;
} {
  const positiveInteger = (name: string, fallback: number) => {
    const parsed = Number(environment[name]);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    maxTranscriptBytes: positiveInteger("LEMONPI_WORKER_MAX_TRANSCRIPT_BYTES", 2_000_000),
    maxTokens: positiveInteger("LEMONPI_WORKER_MAX_TOKENS", 120_000),
    maxSlices: positiveInteger("LEMONPI_WORKER_MAX_SLICES", 2),
  };
}

export interface WorkerStatusMetrics {
  tokens: number;
  turns: number;
  toolCalls: number;
  startedAt?: number;
  elapsedMs: number;
  activityState?: string;
  terminal: boolean;
  transcriptPaths: string[];
}

export function workerStatusMetrics(value: unknown, now = Date.now()): WorkerStatusMetrics {
  let tokens = 0;
  let turns = 0;
  let toolCalls = 0;
  let startedAt: number | undefined;
  let elapsedMs = 0;
  let activityState: string | undefined;
  let terminal = false;
  const transcriptPaths = new Set<string>();
  const seen = new Set<object>();
  const visit = (candidate: unknown, depth: number, parentKey = "") => {
    if (depth > 8 || !candidate || typeof candidate !== "object") return;
    if (seen.has(candidate as object)) return;
    seen.add(candidate as object);
    if (Array.isArray(candidate)) {
      candidate.slice(0, 256).forEach((entry) => visit(entry, depth + 1, parentKey));
      return;
    }
    for (const [key, entry] of Object.entries(candidate as Record<string, unknown>).slice(0, 256)) {
      if ((key === "sessionFile" || key === "transcriptPath") && typeof entry === "string" && entry.trim()) {
        transcriptPaths.add(entry.trim());
      }
      if ((key === "totalTokens" || key === "tokens" || (key === "total" && /tokens?|usage/i.test(parentKey)))
        && typeof entry === "number" && Number.isFinite(entry)) {
        tokens = Math.max(tokens, Math.floor(entry));
      }
      if ((key === "turnCount" || key === "totalTurns" || key === "turns") && typeof entry === "number" && Number.isFinite(entry)) {
        turns = Math.max(turns, Math.floor(entry));
      }
      if ((key === "toolCount" || key === "toolCalls" || key === "totalToolCalls") && typeof entry === "number" && Number.isFinite(entry)) {
        toolCalls = Math.max(toolCalls, Math.floor(entry));
      }
      if (key === "startedAt" && typeof entry === "number" && Number.isFinite(entry)) {
        startedAt = startedAt === undefined ? entry : Math.min(startedAt, entry);
      }
      if ((key === "durationMs" || key === "elapsedMs") && typeof entry === "number" && Number.isFinite(entry)) {
        elapsedMs = Math.max(elapsedMs, Math.floor(entry));
      }
      if ((key === "activityState" || key === "status") && typeof entry === "string") {
        const normalized = entry.toLowerCase();
        if (key === "activityState" || !activityState) activityState = normalized;
        if (/^(?:complete|completed|failed|rejected|stopped|cancelled|canceled)$/.test(normalized)) terminal = true;
      }
      visit(entry, depth + 1, key);
    }
  };
  visit(value, 0);
  let text = typeof value === "string" ? value : "";
  if (!text) {
    try {
      text = JSON.stringify(value) ?? "";
    } catch {
      text = "";
    }
  }
  for (const match of text.matchAll(/([\d,.]+)\s*(?:tok|tokens?)\b/gi)) {
    const parsed = Number(match[1]!.replace(/,/g, ""));
    if (Number.isFinite(parsed)) tokens = Math.max(tokens, Math.floor(parsed));
  }
  if (startedAt !== undefined) elapsedMs = Math.max(elapsedMs, Math.max(0, now - startedAt));
  return { tokens, turns, toolCalls, ...(startedAt !== undefined ? { startedAt } : {}), elapsedMs, ...(activityState ? { activityState } : {}), terminal, transcriptPaths: [...transcriptPaths] };
}

export function resumeWorkerIssue(input: ResumeRequest): string | undefined {
  const limits = { ...workerContextLimits(), ...input.limits };
  if (!input.correction) return "Completed workers may only resume for a bounded correction to their immediately preceding slice.";
  if (input.run.runId !== input.lastCompletedRunId) return "Only the immediately preceding completed worker may be resumed.";
  if (input.run.status !== "completed") return "Failed, stopped, or still-running workers require recovery or a fresh bounded context, not resume.";
  if (input.run.emptyOutput || input.run.corrupted) return "Empty-output or corrupted sessions require a fresh smaller context.";
  if (input.run.executionMode !== "implementation") return "A wrong-execution-mode implementation attempt cannot be resumed.";
  if (input.run.transcriptBytes >= limits.maxTranscriptBytes) return "The worker transcript is too large; launch a fresh bounded worker.";
  if (input.run.tokens >= limits.maxTokens) return "The worker token history is too large; launch a fresh bounded worker.";
  if (input.run.sliceCount >= limits.maxSlices) return "The worker has reached its correction-slice limit; launch a fresh bounded worker.";
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
  command: string;
  relevantPaths: string[];
  dependencyState: string;
  scope: "focused" | "wave" | "final";
  passed: boolean;
  elapsedMs: number;
}

export function validationLedgerKey(value: Omit<ValidationRecord, "passed" | "elapsedMs">): string {
  const { repository, baseRevision, diffHash, command, relevantPaths, dependencyState } = value as ValidationRecord;
  return contentHash(JSON.stringify({ repository, baseRevision, diffHash, command, relevantPaths: [...relevantPaths].sort(), dependencyState }));
}

export function validationDeduplicationIssue(records: ValidationRecord[], candidate: Omit<ValidationRecord, "passed" | "elapsedMs">): string | undefined {
  const key = validationLedgerKey(candidate);
  return records.some((record) => record.passed && validationLedgerKey(record) === key)
    ? "Identical validation already passed for the same revision, inputs, paths, and dependency state."
    : undefined;
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
