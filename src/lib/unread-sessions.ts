import type { PiSessionSummary, UnreadReceiptSnapshot } from "./pi-types";

/** The desktop host is the sole source of unread truth; no browser persistence is consulted. */
export function isSessionFinalReplyUnread(session: PiSessionSummary): boolean {
  return session.hasUnreadFinalReply === true;
}

export function countUnreadFinalReplies(sessions: PiSessionSummary[]): number {
  return sessions.reduce((count, session) => count + Number(isSessionFinalReplyUnread(session)), 0);
}

export type FocusedSessionReadRequest = { sessionPath: string; readReplyId: string };

/** Selects a receipt only while the host-projected current session is visibly focused and unread. */
export function focusedSessionReadRequest(
  conversationViewed: boolean,
  sessionFile: string | undefined,
  sessions: PiSessionSummary[],
): FocusedSessionReadRequest | undefined {
  if (!conversationViewed || !sessionFile) return undefined;
  const session = sessions.find((candidate) => candidate.path === sessionFile);
  if (!session?.hasUnreadFinalReply || !session.lastFinalReplyId) return undefined;
  return { sessionPath: session.path, readReplyId: session.lastFinalReplyId };
}

/** Applies the result of the host's focused read transaction without inventing local receipt state. */
export function applyHostReadReceipt(
  sessions: PiSessionSummary[],
  sessionPath: string,
  receipt: UnreadReceiptSnapshot,
): PiSessionSummary[] {
  return sessions.map((session) => session.path === sessionPath ? {
    ...session,
    hasUnreadFinalReply: receipt.hasUnreadFinalReply,
    ...(receipt.lastFinalReplyId
      ? { lastFinalReplyId: receipt.lastFinalReplyId }
      : { lastFinalReplyId: undefined }),
  } : session);
}
