import { describe, expect, it } from "vitest";
import type { PiSessionSummary } from "./pi-types";
import {
  applyHostReadReceipt,
  countUnreadFinalReplies,
  focusedSessionReadRequest,
  isSessionFinalReplyUnread,
} from "./unread-sessions";

function session(path: string, unread?: boolean, replyId?: string): PiSessionSummary {
  return {
    path,
    id: path,
    modified: 1,
    messageCount: 2,
    firstMessage: "Hello",
    hasUnreadFinalReply: unread,
    lastFinalReplyId: replyId,
  };
}

describe("host-authoritative unread final replies", () => {
  it("treats absent and baselined host projections as read", () => {
    expect(isSessionFinalReplyUnread(session("/sessions/unknown"))).toBe(false);
    expect(countUnreadFinalReplies([
      session("/sessions/one", false, "reply_baseline"),
      session("/sessions/two"),
    ])).toBe(0);
  });

  it("counts only host-projected unread sessions", () => {
    expect(countUnreadFinalReplies([
      session("/sessions/one", true, "reply_new"),
      session("/sessions/two", false, "reply_old"),
      session("/sessions/pending"),
    ])).toBe(1);
  });

  it("requests local reads only for the focused current unread host session", () => {
    const sessions = [session("/sessions/one", true, "reply_1")];
    expect(focusedSessionReadRequest(true, "/sessions/one", sessions)).toEqual({
      sessionPath: "/sessions/one",
      readReplyId: "reply_1",
    });
    expect(focusedSessionReadRequest(false, "/sessions/one", sessions)).toBeUndefined();
    expect(focusedSessionReadRequest(true, "/sessions/other", sessions)).toBeUndefined();
    expect(focusedSessionReadRequest(true, "/sessions/one", [session("/sessions/one", false, "reply_1")])).toBeUndefined();
  });

  it("applies a focused host receipt without changing another session", () => {
    const sessions = [
      session("/sessions/one", true, "reply_1"),
      session("/sessions/two", true, "reply_2"),
    ];
    const next = applyHostReadReceipt(sessions, "/sessions/one", {
      projectId: "project_1",
      sessionId: "session_1",
      hasUnreadFinalReply: false,
      lastFinalReplyId: "reply_1",
      unreadSessionCount: 1,
    });

    expect(next[0]).toMatchObject({ hasUnreadFinalReply: false, lastFinalReplyId: "reply_1" });
    expect(next[1]).toBe(sessions[1]);
    expect(countUnreadFinalReplies(next)).toBe(1);
  });
});
