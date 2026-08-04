import type { AgentMessage, PiEvent } from "./pi-types";

export type TodoStatus = "pending" | "in_progress" | "completed" | "deleted";

export type TodoTask = {
  id: number;
  subject: string;
  description?: string;
  activeForm?: string;
  status: TodoStatus;
  blockedBy?: number[];
  owner?: string;
  runtimeStatus?: "pending" | "in_progress" | "validating" | "completed" | "needs_attention";
};

export type TodoSnapshot = {
  tasks: TodoTask[];
  nextId: number;
  source?: "todo" | "mission";
  missionId?: string;
  historyCount?: number;
};

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : undefined;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseTask(value: unknown): TodoTask | undefined {
  const task = asRecord(value);
  if (!task || typeof task.id !== "number" || typeof task.subject !== "string") return undefined;
  if (!(["pending", "in_progress", "completed", "deleted"] as unknown[]).includes(task.status)) return undefined;
  const blockedBy = Array.isArray(task.blockedBy)
    ? task.blockedBy.filter((id): id is number => typeof id === "number")
    : undefined;
  return {
    id: task.id,
    subject: task.subject,
    status: task.status as TodoStatus,
    ...(optionalText(task.description) ? { description: optionalText(task.description) } : {}),
    ...(optionalText(task.activeForm) ? { activeForm: optionalText(task.activeForm) } : {}),
    ...(blockedBy?.length ? { blockedBy } : {}),
    ...(optionalText(task.owner) ? { owner: optionalText(task.owner) } : {}),
    ...(([
      "pending",
      "in_progress",
      "validating",
      "completed",
      "needs_attention",
    ] as unknown[]).includes(task.runtimeStatus) ? { runtimeStatus: task.runtimeStatus as TodoTask["runtimeStatus"] } : {}),
  };
}

/** Parses rpiv-todo's public, version-stable tool-result snapshot. */
export function parseTodoSnapshot(value: unknown): TodoSnapshot | undefined {
  const envelope = asRecord(value);
  const details = asRecord(envelope?.details) ?? envelope;
  if (!details || !Array.isArray(details.tasks) || typeof details.nextId !== "number") return undefined;
  const tasks = details.tasks.map(parseTask);
  if (tasks.some((task) => !task)) return undefined;
  return {
    tasks: tasks as TodoTask[],
    nextId: details.nextId,
    ...(details.source === "mission" ? { source: "mission" as const } : { source: "todo" as const }),
    ...(optionalText(details.missionId) ? { missionId: optionalText(details.missionId) } : {}),
    ...(typeof details.historyCount === "number" ? { historyCount: details.historyCount } : {}),
  };
}

function parseLifecycleSnapshot(message: unknown): TodoSnapshot | undefined {
  const record = asRecord(message);
  if (record?.role !== "custom" || !["lemonpi-todo-lifecycle", "lemonpi-mission-outcomes"].includes(String(record.customType))) return undefined;
  if (typeof record.content !== "string") return undefined;
  try {
    return parseTodoSnapshot(JSON.parse(record.content));
  } catch {
    return undefined;
  }
}

export function todoSnapshotFromEvent(event: PiEvent): TodoSnapshot | undefined {
  if (event.type === "tool_execution_end" && event.toolName === "todo" && event.isError !== true) {
    return parseTodoSnapshot(event.result);
  }
  if (event.type !== "message_end") return undefined;
  const message = asRecord(event.message);
  const lifecycle = parseLifecycleSnapshot(message);
  if (lifecycle) return lifecycle;
  if (message?.role !== "toolResult" || message.toolName !== "todo" || message.isError === true) return undefined;
  return parseTodoSnapshot(message.details);
}

export function todoSnapshotFromMessages(messages: AgentMessage[]): TodoSnapshot | undefined {
  let snapshot: TodoSnapshot | undefined;
  for (const message of messages) {
    const lifecycle = parseLifecycleSnapshot(message);
    if (lifecycle) {
      snapshot = lifecycle;
      continue;
    }
    if (message.role !== "toolResult" || message.toolName !== "todo" || message.isError) continue;
    snapshot = parseTodoSnapshot(message.details) ?? snapshot;
  }
  return snapshot;
}
