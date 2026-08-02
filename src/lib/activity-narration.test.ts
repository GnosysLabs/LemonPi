import { describe, expect, it } from "vitest";
import { describeToolActivity, summarizeSurfacedThinking } from "./activity-narration";

describe("describeToolActivity", () => {
  it("turns file tools into readable first-person progress", () => {
    expect(describeToolActivity({ name: "read", args: { path: "/Users/me/project/src/App.tsx" }, status: "running" }))
      .toBe("I'm reading …/src/App.tsx…");
    expect(describeToolActivity({ name: "edit", args: { path: "src/App.tsx" }, status: "complete" }, true))
      .toBe("Updated src/App.tsx");
  });

  it("recognizes test commands without exposing the full command", () => {
    expect(describeToolActivity({ name: "bash", args: { command: "pnpm build && pnpm test" }, status: "running" }))
      .toBe("I'm running the tests…");
  });

  it("describes delegated work", () => {
    expect(describeToolActivity({
      name: "subagent",
      args: { tasks: [{ agent: "reviewer" }, { agent: "designer" }] },
      status: "running",
    })).toBe("I'm waiting for 2 delegated agents to finish…");

    expect(describeToolActivity({
      name: "subagent",
      args: { tasks: [{ agent: "reviewer" }, { agent: "designer" }], async: true },
      status: "running",
    })).toBe("I'm launching 2 delegated agents in the background…");

    expect(describeToolActivity({
      name: "subagent_wait",
      args: { all: true },
      status: "running",
    })).toBe("I'm waiting at the integration point for delegated results…");
  });

  it("uses only explicit high-level thinking headings for history summaries", () => {
    expect(summarizeSurfacedThinking("**Inspecting the project structure**\nprivate detail"))
      .toBe("Inspecting the project structure");
    expect(summarizeSurfacedThinking("private detail without a summary heading")).toBeUndefined();
  });
});
