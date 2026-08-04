import { describe, expect, it } from "vitest";
import { parseTodoSnapshot, todoSnapshotFromMessages } from "./extension-todos";

const details = {
  action: "update",
  params: { id: 1, status: "in_progress" },
  tasks: [
    { id: 1, subject: "Wire the bridge", activeForm: "wiring the bridge", status: "in_progress", owner: "worker" },
    { id: 2, subject: "Polish the panel", status: "pending", blockedBy: [1] },
  ],
  nextId: 3,
};

describe("rpiv-todo snapshots", () => {
  it("reads the structured tool result envelope", () => {
    expect(parseTodoSnapshot({ details })).toEqual({ tasks: details.tasks, nextId: 3, source: "todo" });
  });

  it("restores the latest valid todo snapshot from session messages", () => {
    const first = { ...details, tasks: [details.tasks[0]], nextId: 2 };
    expect(todoSnapshotFromMessages([
      { role: "toolResult", toolName: "todo", details: first },
      { role: "toolResult", toolName: "bash", details: { tasks: [] } },
      { role: "toolResult", toolName: "todo", details },
    ])).toEqual({ tasks: details.tasks, nextId: 3, source: "todo" });
  });

  it("restores LemonPi-owned worker lifecycle transitions", () => {
    const completed = { ...details, tasks: details.tasks.map((task) => task.id === 1 ? { ...task, status: "completed" } : task) };
    expect(todoSnapshotFromMessages([
      { role: "toolResult", toolName: "todo", details },
      { role: "custom", customType: "lemonpi-todo-lifecycle", content: JSON.stringify(completed) },
    ])).toEqual({ tasks: completed.tasks, nextId: 3, source: "todo" });
  });

  it("prefers the controller-owned compact outcome projection", () => {
    const outcomes = {
      source: "mission",
      missionId: "mission-1",
      historyCount: 17,
      tasks: [
        { id: 1, subject: "Finish Apple unread UI", status: "in_progress", runtimeStatus: "validating" },
        { id: 2, subject: "Verify desktop unread UI", status: "pending", runtimeStatus: "pending" },
      ],
      nextId: 3,
    };
    expect(todoSnapshotFromMessages([
      { role: "toolResult", toolName: "todo", details },
      { role: "custom", customType: "lemonpi-mission-outcomes", content: JSON.stringify(outcomes) },
    ])).toEqual({ ...outcomes, source: "mission" });
  });

  it("rejects malformed snapshots instead of partially rendering them", () => {
    expect(parseTodoSnapshot({ details: { tasks: [{ id: 1, subject: "Missing status" }], nextId: 2 } })).toBeUndefined();
  });
});
