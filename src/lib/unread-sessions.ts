import type { PiSessionSummary } from "./pi-types";

export const UNREAD_FINAL_REPLIES_STORAGE_KEY = "lemonpi.unread-final-replies.v1";

export type UnreadFinalReplyState = {
  version: 1;
  initializedProjects: string[];
  readFinalReplyMarkers: Record<string, string>;
};

const emptyUnreadFinalReplyState = (): UnreadFinalReplyState => ({
  version: 1,
  initializedProjects: [],
  readFinalReplyMarkers: {},
});

export function parseUnreadFinalReplyState(raw: string | null): UnreadFinalReplyState {
  if (!raw) return emptyUnreadFinalReplyState();
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return emptyUnreadFinalReplyState();
    const candidate = value as Partial<UnreadFinalReplyState>;
    if (candidate.version !== 1) return emptyUnreadFinalReplyState();
    const initializedProjects = Array.isArray(candidate.initializedProjects)
      ? [...new Set(candidate.initializedProjects.filter((path): path is string => typeof path === "string" && path.length > 0))]
      : [];
    const readFinalReplyMarkers = Object.fromEntries(
      Object.entries(candidate.readFinalReplyMarkers ?? {}).filter(([path, marker]) => (
        typeof path === "string" && path.length > 0 && typeof marker === "string" && marker.length > 0
      )),
    );
    return { version: 1, initializedProjects, readFinalReplyMarkers };
  } catch {
    return emptyUnreadFinalReplyState();
  }
}

export function serializeUnreadFinalReplyState(state: UnreadFinalReplyState): string {
  return JSON.stringify(state);
}

export function isSessionFinalReplyUnread(session: PiSessionSummary, state: UnreadFinalReplyState): boolean {
  const marker = session.lastFinalReply?.marker;
  return Boolean(marker && state.readFinalReplyMarkers[session.path] !== marker);
}

export function countUnreadFinalReplies(sessions: PiSessionSummary[], state: UnreadFinalReplyState): number {
  return sessions.reduce((count, session) => count + Number(isSessionFinalReplyUnread(session, state)), 0);
}

export function markSessionFinalReplyRead(state: UnreadFinalReplyState, session: PiSessionSummary): UnreadFinalReplyState {
  const marker = session.lastFinalReply?.marker;
  if (!marker || state.readFinalReplyMarkers[session.path] === marker) return state;
  return {
    ...state,
    readFinalReplyMarkers: { ...state.readFinalReplyMarkers, [session.path]: marker },
  };
}

/**
 * On first use for a project, old final replies are receipts rather than new
 * notifications. Subsequent markers are compared normally and become unread.
 */
export function baselineProjectFinalReplies(
  state: UnreadFinalReplyState,
  projectPath: string,
  sessions: PiSessionSummary[],
): UnreadFinalReplyState {
  if (!projectPath || state.initializedProjects.includes(projectPath)) return state;
  const readFinalReplyMarkers = { ...state.readFinalReplyMarkers };
  for (const session of sessions) {
    const marker = session.lastFinalReply?.marker;
    if (marker) readFinalReplyMarkers[session.path] = marker;
  }
  return {
    ...state,
    initializedProjects: [...state.initializedProjects, projectPath],
    readFinalReplyMarkers,
  };
}
