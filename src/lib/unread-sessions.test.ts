import { describe, expect, it } from "vitest";
import type { PiSessionSummary } from "./pi-types";
import {
  baselineProjectFinalReplies,
  countUnreadFinalReplies,
  isSessionFinalReplyUnread,
  markSessionFinalReplyRead,
  parseUnreadFinalReplyState,
  serializeUnreadFinalReplyState,
} from "./unread-sessions";

function session(path: string, marker?: string): PiSessionSummary {
  return {
    path,
    id: path,
    modified: 1,
    messageCount: 2,
    firstMessage: "Hello",
    ...(marker ? { lastFinalReply: { marker, timestamp: "1" } } : {}),
  };
}

describe("unread final reply state", () => {
  it("baselines known project history without marking it unread", () => {
    const sessions = [session("/sessions/one", "reply-1"), session("/sessions/two", "reply-2")];
    const baseline = baselineProjectFinalReplies(parseUnreadFinalReplyState(null), "/project", sessions);

    expect(countUnreadFinalReplies(sessions, baseline)).toBe(0);
    expect(baseline.initializedProjects).toEqual(["/project"]);
    expect(baseline.readFinalReplyMarkers).toEqual({
      "/sessions/one": "reply-1",
      "/sessions/two": "reply-2",
    });
  });

  it("counts only a newer final reply and clears it when read", () => {
    const initial = baselineProjectFinalReplies(
      parseUnreadFinalReplyState(null),
      "/project",
      [session("/sessions/one", "reply-1")],
    );
    const updated = session("/sessions/one", "reply-2");

    expect(isSessionFinalReplyUnread(updated, initial)).toBe(true);
    expect(countUnreadFinalReplies([updated, session("/sessions/pending")], initial)).toBe(1);

    const read = markSessionFinalReplyRead(initial, updated);
    expect(isSessionFinalReplyUnread(updated, read)).toBe(false);
    expect(countUnreadFinalReplies([updated], read)).toBe(0);
  });

  it("keeps initialization and receipts across storage round trips", () => {
    const state = markSessionFinalReplyRead(
      baselineProjectFinalReplies(parseUnreadFinalReplyState(null), "/project", []),
      session("/sessions/one", "reply-1"),
    );

    expect(parseUnreadFinalReplyState(serializeUnreadFinalReplyState(state))).toEqual(state);
    expect(baselineProjectFinalReplies(state, "/project", [session("/sessions/two", "reply-2")])).toBe(state);
  });
});
