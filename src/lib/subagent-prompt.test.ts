import { describe, expect, it } from "vitest";
import { subagentPromptSummary, subagentWorkerSummary } from "./subagent-prompt";

describe("subagentPromptSummary", () => {
  it("uses a multiline chunk outcome instead of runner metadata", () => {
    const prompt = [
      "Execution mode: implementation",
      "",
      "Chunk outcome:",
      "Show the current branch name in the navigation bar.",
      "",
      "Child checklist:",
      "- Update the repository state",
    ].join("\n");

    expect(subagentPromptSummary(prompt)).toBe("Show the current branch name in the navigation bar.");
  });

  it("does not expose a task file path or delegated-runner preamble", () => {
    const prompt = [
      '<file name="/var/folders/example/pi-subagent/task.md">',
      "Task: You are a delegated subagent running from a fork of the parent session.",
      "",
      "Task:",
      "Implement the project switcher.",
      "</file>",
    ].join("\n");

    expect(subagentPromptSummary(prompt)).toBe("Implement the project switcher.");
  });

  it("prefers the dispatcher summary and limits it to eight words", () => {
    const prompt = [
      "You are reviving a previous subagent conversation.",
      "Worker summary: Repair remote settings layout and validation behavior today",
    ].join("\n");

    expect(subagentWorkerSummary(prompt)).toBe("Repair remote settings layout and validation behavior today");
    expect(subagentPromptSummary(prompt)).toBe("Repair remote settings layout and validation behavior today");
  });
});
