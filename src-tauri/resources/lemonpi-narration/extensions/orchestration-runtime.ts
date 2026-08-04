export const CURRENT_ORCHESTRATION_POLICY_VERSION = 5;

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
  purpose: string;
  status: "running" | "completed" | "failed" | "stopped";
  executionMode: ExecutionMode;
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
  emptyOutput?: boolean;
  corrupted?: boolean;
  todoId?: number;
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
  maxTokens: number;
  maxTurns: number;
  maxToolCalls: number;
  maxRuntimeMs: number;
  spawn: {
    timeoutMs: number;
    turnBudget: { maxTurns: number; graceTurns: number };
    toolBudget: { hard: number };
    usageBudget: { tokens: { hard: number } };
  };
}

export function workerExecutionBudget(
  mode: ExecutionMode,
  environment: Record<string, string | undefined> = {},
): WorkerExecutionBudget {
  const prefix = mode === "implementation" ? "LEMONPI_IMPLEMENTATION" : "LEMONPI_READONLY";
  const positiveInteger = (suffix: string, fallback: number) => {
    const parsed = Number(environment[`${prefix}_${suffix}`]);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
  };
  const maxTokens = positiveInteger("MAX_TOKENS", mode === "implementation" ? 120_000 : 60_000);
  const maxTurns = positiveInteger("MAX_TURNS", mode === "implementation" ? 12 : 8);
  const maxToolCalls = positiveInteger("MAX_TOOL_CALLS", mode === "implementation" ? 45 : 25);
  const maxRuntimeMs = positiveInteger("MAX_RUNTIME_MS", mode === "implementation" ? 15 * 60_000 : 10 * 60_000);
  return {
    maxTokens,
    maxTurns,
    maxToolCalls,
    maxRuntimeMs,
    spawn: {
      timeoutMs: maxRuntimeMs,
      turnBudget: { maxTurns, graceTurns: 2 },
      toolBudget: { hard: maxToolCalls },
      usageBudget: { tokens: { hard: maxTokens } },
    },
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
  const visibleUiRequest = /\b(?:badge|button|dot|icon|indicator|label|layout|menu|spacing|style|unread|visual)\b/i.test(request)
    && !HIGH_RISK_SCOPE.test(request);
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
