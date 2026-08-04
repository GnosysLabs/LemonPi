import { open } from "@tauri-apps/plugin-dialog";
import { Warning, X } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { AgentActivityPanel } from "./components/AgentActivityPanel";
import { Composer, type ComposerBehavior } from "./components/Composer";
import { ExtensionDialog, type ExtensionUiResponse } from "./components/ExtensionDialog";
import { SettingsSurface } from "./components/SettingsSurface";
import { ProjectTrustDialog } from "./components/ProjectTrustDialog";
import { StartupSplash } from "./components/StartupSplash";
import { StatusStrip } from "./components/StatusStrip";
import { TodoPanel } from "./components/TodoPanel";
import { Transcript } from "./components/Transcript";
import { WorkspaceRail } from "./components/WorkspaceRail";
import { UpdateNotice } from "./components/UpdateNotice";
import {
  detectPi,
  getGitBranch,
  getSubagentActivity,
  getSubagentRuns,
  isTauriRuntime,
  listPiSessions,
  onPiEvent,
  onPiProcessEvent,
  onPiStderr,
  sendPi,
  startPi,
  syncKnownProjects,
} from "./lib/pi-client";
import {
  isExtensionUiRequest,
  isRpcResponse,
  type PiEvent,
  type PiProcessInfo,
  type PiModel,
  type PiSessionState,
  type PiSessionStats,
  type PiSessionSummary,
  type RpcExtensionUiRequest,
  type SubagentRunStatus,
  type SubagentActivityTarget,
  type SubagentLiveActivity,
  type SubagentStepStatus,
  type ThinkingLevel,
} from "./lib/pi-types";
import {
  forgetProject,
  loadRecentProjects,
  RECENT_PROJECTS_KEY,
  rememberProject,
  toggleProjectPinned,
  type RecentProject,
} from "./lib/projects";
import { initialTranscriptState, reduceTranscript } from "./lib/transcript";
import { decideStartupGate } from "./lib/startup-gate";
import { buildPromptWithAttachments, promptImages, type ComposerAttachment } from "./lib/attachments";
import { useAppUpdater } from "./lib/app-updater";
import { todoSnapshotFromEvent, todoSnapshotFromMessages, type TodoSnapshot } from "./lib/extension-todos";
import { subagentWorkerSummary } from "./lib/subagent-prompt";
import {
  baselineProjectFinalReplies,
  countUnreadFinalReplies,
  markSessionFinalReplyRead,
  parseUnreadFinalReplyState,
  serializeUnreadFinalReplyState,
  UNREAD_FINAL_REPLIES_STORAGE_KEY,
} from "./lib/unread-sessions";

type ConnectionState = "offline" | "launching" | "online" | "error";
type Toast = { id: string; message: string; tone: "info" | "warning" | "error" };
type PendingRequest = {
  onSuccess?: (data: unknown) => void;
  onError?: (error: string) => void;
  timeoutId?: number;
  timeoutMs?: number | false;
};

type SessionsStatus = "loading" | "ready" | "error";
type UiPreferences = { sidebarCollapsed: boolean; sidebarWidth: number };

const UI_PREFERENCES_KEY = "lemonpi.ui.v1";
const MAIN_AGENT_STOP_PREFIX = "__lemonpi_main_agent_stop_v1__:";
const INITIAL_STARTUP_TIMEOUT_MS = 90_000;
const SPLASH_EXIT_MS = 180;

function settleWithin<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => reject(new Error(message)), timeoutMs);
    operation.then(
      (value) => {
        window.clearTimeout(timeoutId);
        resolve(value);
      },
      (error: unknown) => {
        window.clearTimeout(timeoutId);
        reject(error);
      },
    );
  });
}

function loadUiPreferences(): UiPreferences {
  try {
    const value = JSON.parse(window.localStorage.getItem(UI_PREFERENCES_KEY) ?? "{}") as Partial<UiPreferences>;
    return {
      sidebarCollapsed: typeof value.sidebarCollapsed === "boolean" ? value.sidebarCollapsed : false,
      sidebarWidth: typeof value.sidebarWidth === "number" ? Math.min(420, Math.max(228, value.sidebarWidth)) : 272,
    };
  } catch {
    return { sidebarCollapsed: false, sidebarWidth: 272 };
  }
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : undefined;
}

function lastAgentTurnWasInterrupted(messages: unknown[]): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = asRecord(messages[index]);
    if (message?.role !== "assistant") continue;
    return message.stopReason === "aborted" || message.stopReason === "error";
  }
  return false;
}

function isActiveSubagentRun(run: SubagentRunStatus): boolean {
  if (["running", "queued"].includes(run.state)) return true;
  return run.steps?.some((step) => ["running", "queued", "pending"].includes(step.status)) ?? false;
}

type TerminalSubagentState = "complete" | "failed" | "stopped" | "rejected";

function terminalSubagentState(run: SubagentRunStatus): TerminalSubagentState | undefined {
  const state = String(run.state);
  if (state === "complete" || state === "completed") return "complete";
  if (state === "failed" || state === "stopped" || state === "rejected") return state;
  return undefined;
}

function foregroundRunFromDetails(value: unknown, final: boolean): SubagentRunStatus | undefined {
  const details = asRecord(value);
  if (!details || typeof details.runId !== "string" || details.asyncId) return undefined;
  const mode = details.mode === "parallel" || details.mode === "chain" ? details.mode : "single";
  const progress = Array.isArray(details.progress) ? details.progress : [];
  const results = Array.isArray(details.results) ? details.results : [];
  const source = progress.length > 0 ? progress : results;
  const steps = source.map((raw): SubagentStepStatus | undefined => {
    const step = asRecord(raw);
    if (!step || typeof step.agent !== "string") return undefined;
    const rawStatus = typeof step.status === "string" ? step.status : final ? "complete" : "running";
    const status = rawStatus === "completed" ? "complete" : rawStatus as "pending" | "running" | "complete" | "failed" | "paused" | "stopped" | "rejected";
    const total = typeof step.tokens === "number" ? step.tokens : 0;
    const task = typeof step.task === "string" ? step.task : undefined;
    return {
      index: typeof step.index === "number" ? step.index : undefined,
      agent: step.agent,
      description: task,
      summary: task ? subagentWorkerSummary(task) : undefined,
      prompt: task,
      status,
      sessionFile: typeof step.sessionFile === "string" ? step.sessionFile : undefined,
      transcriptPath: typeof step.transcriptPath === "string" ? step.transcriptPath : undefined,
      lastActivityAt: typeof step.lastActivityAt === "number" ? step.lastActivityAt : undefined,
      currentTool: typeof step.currentTool === "string" ? step.currentTool : undefined,
      currentToolArgs: typeof step.currentToolArgs === "string" ? step.currentToolArgs : undefined,
      currentToolStartedAt: typeof step.currentToolStartedAt === "number" ? step.currentToolStartedAt : undefined,
      currentPath: typeof step.currentPath === "string" ? step.currentPath : undefined,
      recentTools: Array.isArray(step.recentTools) ? step.recentTools as SubagentStepStatus["recentTools"] : undefined,
      recentOutput: Array.isArray(step.recentOutput) ? step.recentOutput.filter((line): line is string => typeof line === "string") : undefined,
      turnCount: typeof step.turnCount === "number" ? step.turnCount : undefined,
      toolCount: typeof step.toolCount === "number" ? step.toolCount : undefined,
      startedAt: typeof step.durationMs === "number" ? Date.now() - step.durationMs : Date.now(),
      endedAt: typeof step.endedAt === "number" ? step.endedAt : undefined,
      tokens: {
        input: typeof step.inputTokens === "number" ? step.inputTokens : 0,
        output: typeof step.outputTokens === "number" ? step.outputTokens : 0,
        total,
      },
      model: typeof step.model === "string" ? step.model : undefined,
      thinking: typeof step.thinking === "string" ? step.thinking : undefined,
      error: typeof step.error === "string" ? step.error : undefined,
    };
  }).filter((step): step is NonNullable<typeof step> => Boolean(step));

  const failed = steps.some((step) => step.status === "failed");
  const stopped = steps.some((step) => step.status === "stopped");
  const paused = steps.some((step) => step.status === "paused");
  return {
    runId: details.runId,
    mode,
    state: final ? failed ? "failed" : stopped ? "stopped" : paused ? "paused" : "complete" : "running",
    startedAt: Math.min(...steps.map((step) => step.startedAt ?? Date.now()), Date.now()),
    endedAt: final ? Date.now() : undefined,
    steps,
  };
}

export default function App() {
  const [pi, setPi] = useState<PiProcessInfo>();
  const [detectionError, setDetectionError] = useState<string>();
  const [detectionSettled, setDetectionSettled] = useState(false);
  const [startupReady, setStartupReady] = useState(false);
  const [splashVisible, setSplashVisible] = useState(true);
  const [splashExiting, setSplashExiting] = useState(false);
  const [candidatePath, setCandidatePath] = useState<string>();
  const [project, setProject] = useState<string>();
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>(loadRecentProjects);
  const [projectTrusted, setProjectTrusted] = useState(false);
  const [gitBranch, setGitBranch] = useState<string | null>();
  const [connection, setConnection] = useState<ConnectionState>("offline");
  const [sessionState, setSessionState] = useState<PiSessionState>();
  const [sessions, setSessions] = useState<PiSessionSummary[]>([]);
  const [sessionsStatus, setSessionsStatus] = useState<SessionsStatus>("ready");
  const [unreadFinalReplyState, setUnreadFinalReplyState] = useState(() => {
    try {
      return parseUnreadFinalReplyState(window.localStorage.getItem(UNREAD_FINAL_REPLIES_STORAGE_KEY));
    } catch {
      return parseUnreadFinalReplyState(null);
    }
  });
  const [conversationViewed, setConversationViewed] = useState(() => (
    document.visibilityState !== "hidden" && document.hasFocus()
  ));
  const [sessionSwitching, setSessionSwitching] = useState(false);
  const [stats, setStats] = useState<PiSessionStats>();
  const [availableModels, setAvailableModels] = useState<PiModel[]>([]);
  const [availableThinkingLevels, setAvailableThinkingLevels] = useState<ThinkingLevel[]>([]);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => loadUiPreferences().sidebarCollapsed);
  const [sidebarWidth, setSidebarWidth] = useState(() => loadUiPreferences().sidebarWidth);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [subagentRuns, setSubagentRuns] = useState<SubagentRunStatus[]>([]);
  const [foregroundRuns, setForegroundRuns] = useState<SubagentRunStatus[]>([]);
  const [subagentActivity, setSubagentActivity] = useState<Record<string, SubagentLiveActivity>>({});
  const [dialogQueue, setDialogQueue] = useState<RpcExtensionUiRequest[]>([]);
  const [injectedComposerText, setInjectedComposerText] = useState<string>();
  const [extensionStatuses, setExtensionStatuses] = useState<Record<string, string>>({});
  const [todoSnapshot, setTodoSnapshot] = useState<TodoSnapshot>();
  const [mainTodoInterrupted, setMainTodoInterrupted] = useState(false);
  const [mainStopping, setMainStopping] = useState(false);
  const [hiddenCompletedTodoIds, setHiddenCompletedTodoIds] = useState<Set<number>>(() => new Set());
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [stderrTail, setStderrTail] = useState<string[]>([]);
  const [transcript, dispatchTranscript] = useReducer(reduceTranscript, initialTranscriptState);
  const sequenceRef = useRef(0);
  const activePidRef = useRef<number | undefined>(undefined);
  const detectionStartedRef = useRef(false);
  const restoredProjectRef = useRef(false);
  const pendingRef = useRef(new Map<string, PendingRequest>());
  const projectRef = useRef<string | undefined>(undefined);
  const sessionRefreshRequestRef = useRef(0);
  const todoSnapshotRef = useRef<TodoSnapshot | undefined>(undefined);
  const mainStreamingRef = useRef(false);
  const mainStopPendingRef = useRef(false);
  const mainPlanInterruptedRef = useRef(false);
  const todoResumeEligibleRef = useRef(false);
  const manuallyStoppedSubagentRunsRef = useRef(new Set<string>());

  const appUpdater = useAppUpdater();
  const finishStartup = useCallback(() => setStartupReady(true), []);
  const addToast = useCallback((message: string, tone: Toast["tone"] = "info") => {
    const id = crypto.randomUUID();
    setToasts((current) => [...current.slice(-3), { id, message, tone }]);
    window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 5000);
  }, []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  const applyTodoSnapshot = useCallback((snapshot: TodoSnapshot | undefined, restored = false) => {
    todoSnapshotRef.current = snapshot;
    setTodoSnapshot(snapshot);
    setHiddenCompletedTodoIds((current) => {
      if (!snapshot) return new Set();
      if (restored) return new Set(snapshot.tasks.filter((task) => task.status === "completed").map((task) => task.id));
      const retained = new Set<number>();
      for (const task of snapshot.tasks) {
        if (task.status === "completed" && current.has(task.id)) retained.add(task.id);
      }
      return retained;
    });
  }, []);

  const rpc = useCallback(async (command: Record<string, unknown>, pending?: PendingRequest) => {
    const id = crypto.randomUUID();
    if (pending) {
      const timeoutMs = pending.timeoutMs === false ? undefined : pending.timeoutMs ?? 60_000;
      const timeoutId = timeoutMs === undefined ? undefined : window.setTimeout(() => {
          const waiting = pendingRef.current.get(id);
          if (!waiting) return;
          pendingRef.current.delete(id);
          const timeoutSeconds = Math.round(timeoutMs / 1000);
          const message = `Pi did not answer this request within ${timeoutSeconds} seconds.`;
          waiting.onError?.(message);
          addToast(message, "error");
        }, timeoutMs);
      pendingRef.current.set(id, { ...pending, timeoutId });
    }
    try {
      await sendPi({ ...command, id, type: String(command.type) });
    } catch (error) {
      const waiting = pendingRef.current.get(id);
      if (waiting?.timeoutId) window.clearTimeout(waiting.timeoutId);
      pendingRef.current.delete(id);
      const message = error instanceof Error ? error.message : String(error);
      pending?.onError?.(message);
      addToast(message, "error");
    }
  }, [addToast]);

  const refreshSessions = useCallback(async (cwd?: string) => {
    const targetProject = cwd ?? projectRef.current;
    const request = ++sessionRefreshRequestRef.current;
    if (!targetProject) {
      setSessions([]);
      setSessionsStatus("ready");
      return;
    }
    setSessionsStatus("loading");
    try {
      const nextSessions = await listPiSessions(targetProject);
      if (request !== sessionRefreshRequestRef.current || targetProject !== projectRef.current) return;
      setSessions(nextSessions);
      setUnreadFinalReplyState((current) => baselineProjectFinalReplies(current, targetProject, nextSessions));
      setSessionsStatus("ready");
    } catch (error) {
      if (request !== sessionRefreshRequestRef.current || targetProject !== projectRef.current) return;
      console.warn("Could not refresh Pi sessions", error);
      setSessionsStatus("error");
    }
  }, []);

  const refreshState = useCallback(() => {
    void rpc(
      { type: "get_state" },
      { onSuccess: (data) => setSessionState(data as PiSessionState) },
    );
    void rpc(
      { type: "get_session_stats" },
      { onSuccess: (data) => setStats(data as PiSessionStats) },
    );
  }, [rpc]);

  const refreshModelOptions = useCallback(() => {
    void rpc(
      { type: "get_available_models" },
      { onSuccess: (data) => setAvailableModels(asRecord(data)?.models as PiModel[] ?? []) },
    );
    void rpc(
      { type: "get_available_thinking_levels" },
      { onSuccess: (data) => setAvailableThinkingLevels(asRecord(data)?.levels as ThinkingLevel[] ?? []) },
    );
  }, [rpc]);

  useEffect(() => {
    if (connection === "online") refreshModelOptions();
    else {
      setAvailableModels([]);
      setAvailableThinkingLevels([]);
    }
  }, [connection, refreshModelOptions]);

  const handlePiEvent = useCallback((rawEvent: PiEvent) => {
    const eventPid = typeof rawEvent.__piPid === "number" ? rawEvent.__piPid : undefined;
    if (eventPid && activePidRef.current && eventPid !== activePidRef.current) return;
    const event: PiEvent = { ...rawEvent, __lemonId: String(++sequenceRef.current) };
    dispatchTranscript(event);

    if (event.type === "compaction_start") {
      setSessionState((current) => current ? { ...current, isCompacting: true } : current);
    } else if (event.type === "compaction_end") {
      setSessionState((current) => current ? { ...current, isCompacting: false } : current);
      if (typeof event.errorMessage === "string" && event.errorMessage) addToast(event.errorMessage, "error");
      refreshState();
    }

    const nextTodos = todoSnapshotFromEvent(event);
    if (nextTodos) {
      applyTodoSnapshot(nextTodos);
      if (mainPlanInterruptedRef.current && todoResumeEligibleRef.current) {
        mainPlanInterruptedRef.current = false;
        todoResumeEligibleRef.current = false;
        setMainTodoInterrupted(false);
      }
    }

    if (event.type === "message_end") {
      const message = asRecord(event.message);
      if (message?.role === "assistant" && (message.stopReason === "aborted" || message.stopReason === "error")) {
        mainPlanInterruptedRef.current = true;
        todoResumeEligibleRef.current = false;
        setMainTodoInterrupted(true);
      }
    }

    if ((event.type === "tool_execution_update" || event.type === "tool_execution_end") && event.toolName === "subagent") {
      const result = asRecord(event.type === "tool_execution_update" ? event.partialResult : event.result);
      const run = foregroundRunFromDetails(result?.details, event.type === "tool_execution_end");
      if (run) {
        setForegroundRuns((current) => {
          const existingIndex = current.findIndex((candidate) => candidate.runId === run.runId);
          if (existingIndex < 0) return [...current, run].slice(0, 8);
          const next = [...current];
          next[existingIndex] = run;
          return next;
        });
      }
    }

    if (isRpcResponse(event)) {
      if (event.id) {
        const pending = pendingRef.current.get(event.id);
        if (pending?.timeoutId) window.clearTimeout(pending.timeoutId);
        pendingRef.current.delete(event.id);
        if (event.success) pending?.onSuccess?.(event.data);
        else pending?.onError?.(event.error ?? "Pi rejected the request");
      }
      if (!event.success) addToast(event.error ?? `${event.command} failed`, "error");
      return;
    }

    if (isExtensionUiRequest(event)) {
      if (["select", "confirm", "input", "editor"].includes(event.method)) {
        setDialogQueue((current) => [...current, event]);
        return;
      }
      if (event.method === "notify" && event.message) {
        addToast(event.message, event.notifyType ?? "info");
      } else if (event.method === "setStatus" && event.statusKey) {
        setExtensionStatuses((current) => {
          const next = { ...current };
          if (event.statusText) next[event.statusKey!] = event.statusText;
          else delete next[event.statusKey!];
          return next;
        });
      } else if (event.method === "setTitle" && event.title) {
        document.title = event.title;
      } else if (event.method === "set_editor_text") {
        setInjectedComposerText(event.text ?? "");
      } else if (event.method === "setWidget" && event.widgetKey === "rpiv-todos") {
        // rpiv-todo's terminal widget has a dedicated native surface in LemonPi.
      } else if (event.method === "setWidget" && event.widgetLines?.length) {
        addToast(event.widgetLines.join(" · "), "info");
      }
      return;
    }

    if (event.type === "queue_update") {
      const steering = Array.isArray(event.steering) ? event.steering.length : 0;
      const followUp = Array.isArray(event.followUp) ? event.followUp.length : 0;
      setSessionState((current) => current ? {
        ...current,
        pendingMessageCount: steering + followUp,
        pendingSteeringCount: steering,
        pendingFollowUpCount: followUp,
      } : current);
    }

    if (event.type === "agent_start") {
      mainStreamingRef.current = true;
      if (mainPlanInterruptedRef.current) todoResumeEligibleRef.current = true;
      else setMainTodoInterrupted(false);
      setMainStopping(false);
      mainStopPendingRef.current = false;
      const currentTodos = todoSnapshotRef.current;
      if (currentTodos) {
        setHiddenCompletedTodoIds((current) => new Set([
          ...current,
          ...currentTodos.tasks.filter((task) => task.status === "completed").map((task) => task.id),
        ]));
      }
      setSessionState((current) => current ? { ...current, isStreaming: true } : current);
      // A newly logged user turn makes any previous final reply ineligible.
      void refreshSessions();
    }

    if (event.type === "agent_settled") {
      mainStreamingRef.current = false;
      setMainStopping(false);
      mainStopPendingRef.current = false;
      setSessionState((current) => current ? { ...current, isStreaming: false } : current);
      refreshState();
      void refreshSessions();
    }
  }, [addToast, applyTodoSnapshot, refreshSessions, refreshState]);

  useEffect(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];

    if (!isTauriRuntime()) {
      setDetectionError("LemonPi must be opened through its Tauri desktop shell.");
      return;
    }

    void Promise.all([
      onPiEvent(handlePiEvent),
      onPiProcessEvent((event) => {
        if (event.state === "started") {
          // `openProject` applies the matching PID and online state after startPi resolves.
          // Ignoring this uncorrelated event prevents a timed-out initial restore from
          // revealing an online, no-project UI if its backend command completes late.
          return;
        }
        if (event.state === "exited" || event.state === "stopped") {
          if (event.pid && activePidRef.current && event.pid !== activePidRef.current) return;
          activePidRef.current = undefined;
          mainStreamingRef.current = false;
          setConnection("offline");
          setSessionSwitching(false);
          setSessionState((current) => current ? { ...current, isStreaming: false } : current);
          for (const pending of pendingRef.current.values()) {
            if (pending.timeoutId) window.clearTimeout(pending.timeoutId);
            pending.onError?.("Pi exited before the request completed.");
          }
          pendingRef.current.clear();
          if (event.state === "exited" && event.code !== 0) addToast(event.message ?? `Pi exited with code ${event.code ?? "unknown"}`, "error");
        }
        if (event.state === "error") {
          setConnection("error");
          addToast(event.message ?? "The Pi process failed", "error");
        }
      }),
      onPiStderr((line) => setStderrTail((current) => [...current.slice(-49), line])),
    ]).then((listeners) => {
      if (disposed) listeners.forEach((unlisten) => unlisten());
      else unlisteners.push(...listeners);
    });

    return () => {
      disposed = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [addToast, handlePiEvent]);

  const runDetection = useCallback(async () => {
    setDetectionError(undefined);
    setDetectionSettled(false);
    try {
      setPi(await settleWithin(
        detectPi(),
        INITIAL_STARTUP_TIMEOUT_MS,
        "Pi detection timed out. Check your Pi installation and try again.",
      ));
    } catch (error) {
      setPi(undefined);
      setDetectionError(error instanceof Error ? error.message : String(error));
    } finally {
      setDetectionSettled(true);
    }
  }, []);

  useEffect(() => {
    if (detectionStartedRef.current) return;
    detectionStartedRef.current = true;
    if (!isTauriRuntime()) {
      setDetectionError("LemonPi must be opened through its Tauri desktop shell.");
      setDetectionSettled(true);
      return;
    }
    void runDetection();
  }, [runDetection]);

  useEffect(() => {
    if (!startupReady) return;
    setSplashExiting(true);
    const timeoutId = window.setTimeout(() => setSplashVisible(false), SPLASH_EXIT_MS);
    return () => window.clearTimeout(timeoutId);
  }, [startupReady]);

  useEffect(() => {
    try {
      window.localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(recentProjects));
    } catch {
      // The app remains usable if OS webview storage is unavailable.
    }
    if (!isTauriRuntime()) return;
    void syncKnownProjects(recentProjects).catch((error) => {
      // Remote catalog synchronization is advisory; it must never interrupt desktop work.
      console.warn("Could not synchronize LemonPi's remote project catalog", error);
    });
  }, [recentProjects]);

  useEffect(() => {
    try {
      window.localStorage.setItem(UI_PREFERENCES_KEY, JSON.stringify({ sidebarCollapsed, sidebarWidth }));
    } catch {
      // UI preferences are best-effort.
    }
  }, [sidebarCollapsed, sidebarWidth]);

  useEffect(() => {
    try {
      window.localStorage.setItem(UNREAD_FINAL_REPLIES_STORAGE_KEY, serializeUnreadFinalReplyState(unreadFinalReplyState));
    } catch {
      // Read receipts are best-effort when webview storage is unavailable.
    }
  }, [unreadFinalReplyState]);

  useEffect(() => {
    projectRef.current = project;
  }, [project]);

  useEffect(() => {
    const updateConversationViewed = () => {
      setConversationViewed(document.visibilityState !== "hidden" && document.hasFocus());
    };
    updateConversationViewed();
    document.addEventListener("visibilitychange", updateConversationViewed);
    window.addEventListener("focus", updateConversationViewed);
    window.addEventListener("blur", updateConversationViewed);
    return () => {
      document.removeEventListener("visibilitychange", updateConversationViewed);
      window.removeEventListener("focus", updateConversationViewed);
      window.removeEventListener("blur", updateConversationViewed);
    };
  }, []);

  useEffect(() => {
    if (!conversationViewed || !sessionState?.sessionFile) return;
    const activeSession = sessions.find((session) => session.path === sessionState.sessionFile);
    if (!activeSession) return;
    setUnreadFinalReplyState((current) => markSessionFinalReplyRead(current, activeSession));
  }, [conversationViewed, sessionState?.sessionFile, sessions]);

  useEffect(() => {
    const recent = recentProjects.reduce<RecentProject | undefined>(
      (latest, entry) => !latest || entry.lastOpened > latest.lastOpened ? entry : latest,
      undefined,
    );
    const decision = decideStartupGate({
      detectionSettled,
      hasPi: Boolean(pi),
      hasRecentProject: Boolean(recent),
      restorationInFlight: restoredProjectRef.current,
      hasProject: Boolean(project),
      hasCandidatePath: Boolean(candidatePath),
    });
    if (decision === "wait") return;
    if (decision === "finish") {
      finishStartup();
      return;
    }
    restoredProjectRef.current = true;
    void openProject(recent!.trusted, recent!.path, { initialRestore: true });
  }, [candidatePath, detectionSettled, finishStartup, pi, project, recentProjects]);

  useEffect(() => {
    if (!project) {
      setGitBranch(undefined);
      return;
    }
    let disposed = false;
    const refreshBranch = async () => {
      try {
        const branch = await getGitBranch(project);
        if (!disposed) setGitBranch(branch);
      } catch {
        if (!disposed) setGitBranch(null);
      }
    };
    void refreshBranch();
    const interval = window.setInterval(refreshBranch, 5000);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [project]);

  useEffect(() => {
    mainStreamingRef.current = sessionState?.isStreaming ?? transcript.isStreaming;
  }, [sessionState?.isStreaming, transcript.isStreaming]);

  useEffect(() => {
    const sessionFile = sessionState?.sessionFile;
    if (!sessionFile || connection !== "online") {
      setSubagentRuns([]);
      return;
    }

    let disposed = false;
    let timeoutId: number | undefined;
    let initialized = false;
    const lifecycleByRun = new Map<string, "active" | "terminal" | "other">();
    const notifiedTerminalRuns = new Set<string>();
    const pendingWakeTimers = new Map<string, number>();

    const cancelWake = (runId: string) => {
      const wakeTimer = pendingWakeTimers.get(runId);
      if (wakeTimer !== undefined) window.clearTimeout(wakeTimer);
      pendingWakeTimers.delete(runId);
    };

    const scheduleTerminalWake = (run: SubagentRunStatus, status: TerminalSubagentState) => {
      if (manuallyStoppedSubagentRunsRef.current.has(run.runId)) return;
      if (pendingWakeTimers.has(run.runId) || notifiedTerminalRuns.has(run.runId)) return;
      const wakeTimer = window.setTimeout(() => {
        pendingWakeTimers.delete(run.runId);
        if (manuallyStoppedSubagentRunsRef.current.has(run.runId)) return;
        if (disposed || lifecycleByRun.get(run.runId) !== "terminal" || notifiedTerminalRuns.has(run.runId)) return;
        const controlMessage = `__lemonpi_subagent_terminal_v1__:${JSON.stringify({
          runId: run.runId,
          sessionId: sessionFile,
          status,
          agent: run.steps?.[0]?.agent,
          force: !mainStreamingRef.current,
        })}`;
        void rpc(
          { type: "prompt", message: controlMessage, streamingBehavior: "followUp" },
          {
            onSuccess: () => notifiedTerminalRuns.add(run.runId),
            onError: () => notifiedTerminalRuns.delete(run.runId),
          },
        );
      }, 2_000);
      pendingWakeTimers.set(run.runId, wakeTimer);
    };

    const poll = async () => {
      let nextDelay = 2500;
      try {
        const runs = await getSubagentRuns(sessionFile);
        if (disposed) return;
        setSubagentRuns(runs);
        if (!initialized) {
          for (const run of runs) {
            lifecycleByRun.set(run.runId, isActiveSubagentRun(run) ? "active" : terminalSubagentState(run) ? "terminal" : "other");
          }
          initialized = true;
        } else {
          for (const run of runs) {
            const previous = lifecycleByRun.get(run.runId);
            const status = terminalSubagentState(run);
            const current = isActiveSubagentRun(run) ? "active" : status ? "terminal" : "other";
            if (current === "active") {
              cancelWake(run.runId);
              notifiedTerminalRuns.delete(run.runId);
            } else if (current === "terminal" && status && previous !== "terminal") {
              scheduleTerminalWake(run, status);
            }
            lifecycleByRun.set(run.runId, current);
          }
        }
        const activeCount = runs.reduce(
          (count, run) => count + (run.steps?.filter((step) => ["running", "queued", "pending"].includes(step.status)).length ?? (["running", "queued"].includes(run.state) ? 1 : 0)),
          0,
        );
        nextDelay = activeCount > 0 ? 700 : 2500;
      } catch (error) {
        console.warn("Could not refresh subagent activity", error);
      } finally {
        if (!disposed) timeoutId = window.setTimeout(poll, nextDelay);
      }
    };

    void poll();
    return () => {
      disposed = true;
      if (timeoutId) window.clearTimeout(timeoutId);
      for (const wakeTimer of pendingWakeTimers.values()) window.clearTimeout(wakeTimer);
    };
  }, [connection, rpc, sessionState?.sessionFile]);

  const chooseProject = useCallback(async () => {
    const selected = await open({ directory: true, multiple: false, title: "Open a project in LemonPi" });
    if (typeof selected === "string") setCandidatePath(selected);
  }, []);

  async function openProject(
    trusted: boolean,
    explicitPath?: string,
    { initialRestore = false }: { initialRestore?: boolean } = {},
  ) {
    const path = explicitPath ?? candidatePath ?? project;
    if (!path) return;
    for (const pending of pendingRef.current.values()) {
      if (pending.timeoutId) window.clearTimeout(pending.timeoutId);
    }
    pendingRef.current.clear();
    mainPlanInterruptedRef.current = false;
    todoResumeEligibleRef.current = false;
    manuallyStoppedSubagentRunsRef.current.clear();
    setMainTodoInterrupted(false);
    setConnection("launching");
    setDetectionError(undefined);
    setSessions([]);
    setSessionsStatus("loading");
    try {
      const info = await (initialRestore
        ? settleWithin(
          startPi(path, trusted),
          INITIAL_STARTUP_TIMEOUT_MS,
          "Restoring the saved project timed out. Open the project again to retry.",
        )
        : startPi(path, trusted));
      const openedPath = info.cwd ?? path;
      activePidRef.current = info.pid;
      setPi(info);
      projectRef.current = openedPath;
      setProject(openedPath);
      setProjectTrusted(trusted);
      setRecentProjects((current) => {
        const existing = current.find((entry) => entry.path === path || entry.path === openedPath);
        const withoutAlias = current.filter((entry) => entry.path !== path && entry.path !== openedPath);
        return rememberProject(withoutAlias, {
          path: openedPath,
          trusted,
          lastOpened: Date.now(),
          pinned: existing?.pinned,
        });
      });
      setCandidatePath(undefined);
      setConnection("online");
      setSessionState(undefined);
      setStats(undefined);
      setExtensionStatuses({});
      applyTodoSnapshot(undefined);
      setForegroundRuns([]);
      setSubagentRuns([]);
      setSubagentActivity({});
      dispatchTranscript({ type: "lemonpi_reset" });
      void rpc(
        { type: "get_messages" },
        {
          onSuccess: (data) => {
            const messages = asRecord(data)?.messages;
            const sessionMessages = Array.isArray(messages) ? messages : [];
            dispatchTranscript({ type: "lemonpi_hydrate", messages: sessionMessages });
            const interrupted = lastAgentTurnWasInterrupted(sessionMessages);
            mainPlanInterruptedRef.current = interrupted;
            todoResumeEligibleRef.current = false;
            setMainTodoInterrupted(interrupted);
            applyTodoSnapshot(todoSnapshotFromMessages(sessionMessages), true);
            refreshState();
            if (initialRestore) finishStartup();
          },
          onError: () => {
            refreshState();
            if (initialRestore) finishStartup();
          },
        },
      );
      void refreshSessions(openedPath);
    } catch (error) {
      setConnection("error");
      setDetectionError(error instanceof Error ? error.message : String(error));
      if (initialRestore) finishStartup();
    }
  }

  function submitMessage(text: string, behavior: ComposerBehavior, attachments: ComposerAttachment[]) {
    // A stopped plan remains visibly paused until Pi actually mutates its todo state.
    // Merely accepting a new prompt is not evidence that the prior in-progress item resumed.
    todoResumeEligibleRef.current = mainPlanInterruptedRef.current;
    if (!mainPlanInterruptedRef.current) setMainTodoInterrupted(false);
    const pendingId = `pending-user-${crypto.randomUUID()}`;
    dispatchTranscript({
      type: "lemonpi_queue_user",
      id: pendingId,
      text,
      behavior,
      createdAt: Date.now(),
      attachments: attachments.map(({ name, mimeType, size, kind, data }) => ({ name, mimeType, size, kind, data })),
    });
    const images = promptImages(attachments);
    void rpc(
      {
        type: behavior === "prompt" ? "prompt" : behavior === "steer" ? "steer" : "follow_up",
        message: buildPromptWithAttachments(text, attachments),
        ...(images.length > 0 ? { images } : {}),
      },
      {
        onError: (error) => dispatchTranscript({ type: "lemonpi_queue_user_failed", id: pendingId, error }),
        // A prompt submitted during compaction is intentionally acknowledged only
        // after the compacted context is ready. Process exit still rejects it.
        timeoutMs: false,
      },
    );
  }

  const subagentSteerWhileStreaming = sessionState?.isStreaming ?? transcript.isStreaming;
  const steerSubagent = useCallback((runId: string, index: number, message: string) => new Promise<void>((resolve, reject) => {
    const controlMessage = `__lemonpi_subagent_steer_v1__:${JSON.stringify({ runId, index, message })}`;
    void rpc(
      {
        type: "prompt",
        message: controlMessage,
        ...(subagentSteerWhileStreaming ? { streamingBehavior: "steer" } : {}),
      },
      {
        onSuccess: () => resolve(),
        onError: (error) => reject(new Error(error)),
      },
    );
  }), [rpc, subagentSteerWhileStreaming]);

  const stopSubagent = useCallback((runId: string) => new Promise<void>((resolve, reject) => {
    const controlMessage = `__lemonpi_subagent_stop_v1__:${JSON.stringify({ runId })}`;
    manuallyStoppedSubagentRunsRef.current.add(runId);
    if (manuallyStoppedSubagentRunsRef.current.size > 256) {
      manuallyStoppedSubagentRunsRef.current.delete(manuallyStoppedSubagentRunsRef.current.values().next().value!);
    }
    void rpc(
      {
        type: "prompt",
        message: controlMessage,
        ...(subagentSteerWhileStreaming ? { streamingBehavior: "steer" } : {}),
      },
      {
        onSuccess: () => resolve(),
        onError: (error) => {
          manuallyStoppedSubagentRunsRef.current.delete(runId);
          reject(new Error(error));
        },
      },
    );
  }), [rpc, subagentSteerWhileStreaming]);

  const stopMainAgent = useCallback(() => {
    if (mainStopPendingRef.current) return;
    mainStopPendingRef.current = true;
    mainPlanInterruptedRef.current = true;
    todoResumeEligibleRef.current = false;
    setMainStopping(true);
    setMainTodoInterrupted(true);
    void (async () => {
      try {
        await sendPi({
          type: "prompt",
          id: crypto.randomUUID(),
          message: `${MAIN_AGENT_STOP_PREFIX}${JSON.stringify({ stoppedAt: Date.now() })}`,
          streamingBehavior: "steer",
        });
        await sendPi({ type: "abort", id: crypto.randomUUID() });
      } catch (error) {
        mainStopPendingRef.current = false;
        mainPlanInterruptedRef.current = false;
        setMainStopping(false);
        setMainTodoInterrupted(false);
        addToast(error instanceof Error ? error.message : String(error), "error");
      }
    })();
  }, [addToast]);

  const respondToExtension = useCallback((response: ExtensionUiResponse) => {
    setDialogQueue((current) => current.slice(1));
    void sendPi(response);
  }, []);

  function newSession() {
    if (!project || sessionState?.isStreaming || sessionSwitching) return;
    setSessionSwitching(true);
    void rpc(
      { type: "new_session" },
      {
        onSuccess: (data) => {
          setSessionSwitching(false);
          if (!(data as { cancelled?: boolean })?.cancelled) {
            dispatchTranscript({ type: "lemonpi_reset" });
            setStats(undefined);
            setForegroundRuns([]);
            setSubagentRuns([]);
            mainPlanInterruptedRef.current = false;
            todoResumeEligibleRef.current = false;
            setMainTodoInterrupted(false);
            applyTodoSnapshot(undefined);
            refreshState();
            void refreshSessions();
          }
        },
        onError: () => setSessionSwitching(false),
      },
    );
  }

  function selectSession(path: string) {
    if (sessionState?.isStreaming || sessionSwitching || path === sessionState?.sessionFile) return;
    setSessionSwitching(true);
    void rpc(
      { type: "switch_session", sessionPath: path },
      {
        onSuccess: (data) => {
          if ((data as { cancelled?: boolean })?.cancelled) {
            setSessionSwitching(false);
            return;
          }
          dispatchTranscript({ type: "lemonpi_reset" });
          setStats(undefined);
          setForegroundRuns([]);
          setSubagentRuns([]);
          mainPlanInterruptedRef.current = false;
          todoResumeEligibleRef.current = false;
          setMainTodoInterrupted(false);
          applyTodoSnapshot(undefined);
          refreshState();
          void rpc(
            { type: "get_messages" },
            {
              onSuccess: (messagesData) => {
                const messages = asRecord(messagesData)?.messages;
                const sessionMessages = Array.isArray(messages) ? messages : [];
                dispatchTranscript({ type: "lemonpi_hydrate", messages: sessionMessages });
                const interrupted = lastAgentTurnWasInterrupted(sessionMessages);
                mainPlanInterruptedRef.current = interrupted;
                todoResumeEligibleRef.current = false;
                setMainTodoInterrupted(interrupted);
                applyTodoSnapshot(todoSnapshotFromMessages(sessionMessages), true);
                setSessionSwitching(false);
                refreshState();
                void refreshSessions();
              },
              onError: () => setSessionSwitching(false),
            },
          );
        },
        onError: () => setSessionSwitching(false),
      },
    );
  }

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.repeat || dialogQueue.length > 0) return;
      if (event.code === "Comma") {
        event.preventDefault();
        setSettingsOpen(true);
      } else if (settingsOpen) {
        return;
      } else if (event.code === "KeyO") {
        event.preventDefault();
        void chooseProject();
      } else if (event.code === "KeyB") {
        event.preventDefault();
        setSidebarCollapsed((value) => !value);
      } else if (event.code === "KeyN") {
        event.preventDefault();
        newSession();
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [chooseProject, dialogQueue.length, project, sessionState?.isStreaming, sessionSwitching, settingsOpen]);

  const online = connection === "online";
  const streaming = sessionState?.isStreaming ?? transcript.isStreaming;
  const unreadConversationCount = useMemo(
    () => countUnreadFinalReplies(sessions, unreadFinalReplyState),
    [sessions, unreadFinalReplyState],
  );
  const activeDialog = dialogQueue[0];
  const visibleSubagentRuns = useMemo(() => {
    const seen = new Set<string>();
    return [...foregroundRuns, ...subagentRuns].filter((run) => {
      if (seen.has(run.runId)) return false;
      seen.add(run.runId);
      return true;
    });
  }, [foregroundRuns, subagentRuns]);
  const activityTargets = useMemo(() => visibleSubagentRuns.flatMap((run) => (
    run.steps?.map((step, index): SubagentActivityTarget => ({
      key: `${run.runId}:${step.index ?? index}`,
      runId: run.runId,
      agent: step.agent,
      index: step.index ?? index,
      transcriptPath: step.transcriptPath,
      sessionFile: step.sessionFile,
    })) ?? []
  )), [visibleSubagentRuns]);
  const activityTargetSignature = JSON.stringify(activityTargets);
  const hasActiveSubagents = visibleSubagentRuns.some((run) => isActiveSubagentRun(run));
  const activeWorkerCount = visibleSubagentRuns.reduce((count, run) => count + (
    run.steps?.filter((step) => ["pending", "running", "queued"].includes(step.status)).length
      ?? (isActiveSubagentRun(run) ? 1 : 0)
  ), 0);
  const failedWorkerCount = visibleSubagentRuns.reduce((count, run) => count + (
    run.steps?.filter((step) => ["failed", "rejected", "stopped"].includes(step.status)).length
      ?? (["failed", "rejected", "stopped"].includes(run.state) ? 1 : 0)
  ), 0);
  const validationActive = transcript.items.some((item) => item.kind === "tool"
    && item.name === "lemonpi_validate"
    && (item.status === "queued" || item.status === "running"));
  const activeAgentNames = useMemo(() => new Set(visibleSubagentRuns.flatMap((run) => (
    isActiveSubagentRun(run)
      ? run.steps?.filter((step) => ["pending", "running", "queued"].includes(step.status)).map((step) => step.agent) ?? []
      : []
  ))), [visibleSubagentRuns]);

  useEffect(() => {
    if (!project || activityTargets.length === 0) {
      setSubagentActivity({});
      return;
    }
    let disposed = false;
    let timeoutId: number | undefined;
    const poll = async () => {
      try {
        const snapshots = await getSubagentActivity(project, activityTargets);
        if (disposed) return;
        setSubagentActivity(Object.fromEntries(snapshots.map((snapshot) => [snapshot.key, snapshot])));
      } catch (error) {
        console.warn("Could not refresh subagent transcripts", error);
      } finally {
        if (!disposed && hasActiveSubagents) timeoutId = window.setTimeout(poll, 650);
      }
    };
    void poll();
    return () => {
      disposed = true;
      if (timeoutId) window.clearTimeout(timeoutId);
    };
  }, [activityTargetSignature, hasActiveSubagents, project]);

  return (
    <div className="app-shell">
      <WorkspaceRail
        project={project}
        projectTrusted={projectTrusted}
        projects={recentProjects}
        state={sessionState}
        sessions={sessions}
        sessionsStatus={sessionsStatus}
        unreadConversationCount={unreadConversationCount}
        piVersion={pi?.version}
        connection={connection}
        collapsed={sidebarCollapsed}
        width={sidebarWidth}
        isStreaming={streaming}
        sessionSwitching={sessionSwitching}
        settingsOpen={settingsOpen}
        onToggle={() => setSidebarCollapsed((value) => !value)}
        onWidthChange={setSidebarWidth}
        onChooseProject={() => void chooseProject()}
        onOpenProject={(path) => {
          const recent = recentProjects.find((entry) => entry.path === path);
          void openProject(recent?.trusted ?? false, path);
        }}
        onPinProject={(path) => setRecentProjects((current) => toggleProjectPinned(current, path))}
        onForgetProject={(path) => setRecentProjects((current) => forgetProject(current, path))}
        onNewSession={newSession}
        onSelectSession={selectSession}
        onRetrySessions={() => void refreshSessions()}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <main className="workbench">
        <StatusStrip
          state={sessionState}
          stats={stats}
          project={project}
          branch={gitBranch}
          connected={online}
        />
        <section className="conversation-stage">
          <div className="conversation-scroll">
            <Transcript
              items={transcript.items}
              isStreaming={streaming}
              isCompacting={sessionState?.isCompacting ?? false}
              hasProject={Boolean(project)}
              onChooseProject={() => void chooseProject()}
            />
          </div>
          <div className="conversation-dock">
            <TodoPanel
              snapshot={todoSnapshot}
              hiddenCompletedIds={hiddenCompletedTodoIds}
              interrupted={mainTodoInterrupted}
              pauseReason={sessionState?.isCompacting ? "compacting" : !streaming && !hasActiveSubagents ? "idle" : undefined}
              activeWorkers={activeWorkerCount}
              failedWorkers={failedWorkerCount}
              validationActive={validationActive}
            />
            {Object.entries(extensionStatuses).length > 0 && (
              <div className="extension-statuses">
                {Object.entries(extensionStatuses).map(([key, value]) => <span key={key}><i />{value}</span>)}
              </div>
            )}
            {!project && detectionError && connection !== "online" && (
              <div className="setup-warning">
                <Warning size={14} />
                <span>{detectionError}</span>
                <button type="button" onClick={() => void runDetection()}>Check again</button>
              </div>
            )}
            {project && !online && connection !== "launching" && (
              <div className="process-warning">
                <Warning size={14} /> Pi is offline.
                <button type="button" onClick={() => void openProject(projectTrusted)}>Restart</button>
                {stderrTail.length > 0 && <span title={stderrTail.join("\n")}>Diagnostics available</span>}
              </div>
            )}
            <Composer
              connected={online}
              streaming={streaming}
              stopping={mainStopping}
              steeringCount={sessionState?.pendingSteeringCount ?? 0}
              followUpCount={sessionState?.pendingFollowUpCount ?? 0}
              state={sessionState}
              stats={stats}
              models={availableModels}
              thinkingLevels={availableThinkingLevels}
              injectedText={injectedComposerText}
              onInjectedTextConsumed={() => setInjectedComposerText(undefined)}
              onSubmit={submitMessage}
              onAbort={stopMainAgent}
              onSelectModel={(model) => void rpc(
                { type: "set_model", provider: model.provider, modelId: model.id },
                { onSuccess: refreshState },
              )}
              onSelectThinking={(level) => void rpc(
                { type: "set_thinking_level", level },
                { onSuccess: refreshState },
              )}
            />
          </div>
        </section>
      </main>
      <AgentActivityPanel
        runs={visibleSubagentRuns}
        activity={subagentActivity}
        transcriptItems={transcript.items}
        isStreaming={streaming}
        state={sessionState}
        onSteerSubagent={steerSubagent}
        onStopSubagent={stopSubagent}
      />
      {settingsOpen && (
        <SettingsSurface
          hasProject={Boolean(project)}
          models={availableModels}
          sessionModel={sessionState?.model}
          sessionThinking={sessionState?.thinkingLevel}
          activeAgents={activeAgentNames}
          onClose={closeSettings}
          onNotice={addToast}
        />
      )}
      {candidatePath && (
        <ProjectTrustDialog
          path={candidatePath}
          busy={connection === "launching"}
          onCancel={() => setCandidatePath(undefined)}
          onOpenWithoutConfig={() => void openProject(false)}
          onOpenWithConfig={() => void openProject(true)}
        />
      )}
      {activeDialog && <ExtensionDialog key={activeDialog.id} request={activeDialog} onRespond={respondToExtension} />}
      <UpdateNotice
        phase={appUpdater.phase}
        version={appUpdater.version}
        error={appUpdater.error}
        downloadedBytes={appUpdater.downloadedBytes}
        totalBytes={appUpdater.totalBytes}
        onInstall={() => void appUpdater.installAndRestart()}
        onRetry={() => void appUpdater.retry()}
        onDismiss={appUpdater.dismiss}
      />
      <ToastStack toasts={toasts} onDismiss={(id) => setToasts((current) => current.filter((toast) => toast.id !== id))} />
      {splashVisible && <StartupSplash exiting={splashExiting} />}
    </div>
  );
}

function ToastStack({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: string) => void }) {
  return (
    <div className="toast-stack" aria-live="polite">
      {toasts.map((toast) => (
        <div className={`toast toast--${toast.tone}`} key={toast.id}>
          <span>{toast.message}</span>
          <button type="button" onClick={() => onDismiss(toast.id)} aria-label="Dismiss"><X size={12} /></button>
        </div>
      ))}
    </div>
  );
}
