import { describe, expect, it } from "vitest";
import type { PiSessionSummary } from "./pi-types";
import { filterSessions, groupSessions, sessionTitle } from "./sessions-view";

function session(path: string, modified: number, overrides: Partial<PiSessionSummary> = {}): PiSessionSummary {
  return {
    path,
    id: path,
    modified,
    messageCount: 3,
    firstMessage: "Refactor the sidebar",
    ...overrides,
  };
}

describe("session view", () => {
  it("groups sessions by useful recency buckets", () => {
    const now = new Date(2026, 7, 2, 12).getTime();
    const groups = groupSessions([
      session("today", now - 60_000),
      session("yesterday", now - 26 * 60 * 60_000),
      session("week", now - 3 * 86_400_000),
    ], now);

    expect(groups.map((group) => group.label)).toEqual(["Today", "Yesterday", "Previous 7 days"]);
  });

  it("filters over titles, messages, and paths using every search term", () => {
    const sessions = [
      session("/sessions/sidebar.jsonl", 1, { name: "Rail polish" }),
      session("/sessions/backend.jsonl", 2, { name: "Rust parser", firstMessage: "Fix malformed JSON" }),
    ];

    expect(filterSessions(sessions, "rail polish").map((item) => item.path)).toEqual(["/sessions/sidebar.jsonl"]);
    expect(filterSessions(sessions, "malformed rust").map((item) => item.path)).toEqual(["/sessions/backend.jsonl"]);
  });

  it("provides a useful title for unnamed and empty sessions", () => {
    expect(sessionTitle(session("one", 1))).toBe("Refactor the sidebar");
    expect(sessionTitle(session("two", 1, { firstMessage: "" }))).toBe("Untitled session");
  });
});
