import { CaretDown, CaretUp, Check, Circle, CircleNotch, ListChecks, LockSimple, Pause, Stop } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import type { TodoSnapshot, TodoTask } from "../lib/extension-todos";

const STATUS_ORDER: Record<TodoTask["status"], number> = {
  in_progress: 0,
  pending: 1,
  completed: 2,
  deleted: 3,
};

function TaskIcon({ task, blocked, interrupted, paused }: { task: TodoTask; blocked: boolean; interrupted: boolean; paused: boolean }) {
  if (task.status === "completed") return <Check size={13} weight="bold" />;
  if (task.status === "in_progress") return interrupted ? <Stop size={11} weight="fill" /> : paused ? <Pause size={11} weight="fill" /> : <CircleNotch className="spin" size={14} />;
  if (blocked) return <LockSimple size={12} />;
  return <Circle size={12} />;
}

type TodoPauseReason = "compacting" | "idle";

export function TodoPanel({ snapshot, hiddenCompletedIds, interrupted = false, pauseReason }: { snapshot?: TodoSnapshot; hiddenCompletedIds: Set<number>; interrupted?: boolean; pauseReason?: TodoPauseReason }) {
  const [collapsed, setCollapsed] = useState(false);
  const tasks = useMemo(() => {
    const completed = new Set(snapshot?.tasks.filter((task) => task.status === "completed").map((task) => task.id));
    return (snapshot?.tasks ?? [])
      .filter((task) => task.status !== "deleted" && !hiddenCompletedIds.has(task.id))
      .map((task) => ({
        task,
        blocked: task.status === "pending" && Boolean(task.blockedBy?.some((id) => !completed.has(id))),
      }))
      .sort((left, right) => STATUS_ORDER[left.task.status] - STATUS_ORDER[right.task.status] || left.task.id - right.task.id);
  }, [hiddenCompletedIds, snapshot]);

  if (!snapshot || tasks.length === 0) return null;
  const allVisibleTasks = snapshot.tasks.filter((task) => task.status !== "deleted");
  const completedCount = allVisibleTasks.filter((task) => task.status === "completed").length;
  const active = tasks.find(({ task }) => task.status === "in_progress")?.task;
  const planInterrupted = interrupted && Boolean(active);
  const planPaused = Boolean(pauseReason) && Boolean(active) && !planInterrupted;
  const pausedLabel = pauseReason === "compacting" ? "Compacting" : "Pi idle";
  const pausedDetail = pauseReason === "compacting"
    ? "Paused while Pi compacts the conversation context"
    : "Pi is idle; this step is not currently running";
  const progress = allVisibleTasks.length > 0 ? (completedCount / allVisibleTasks.length) * 100 : 0;

  return (
    <section className={`todo-panel${collapsed ? " todo-panel--collapsed" : ""}${planInterrupted ? " todo-panel--interrupted" : ""}${planPaused ? " todo-panel--paused" : ""}`} aria-label="Task plan">
      <button className="todo-panel__header" type="button" onClick={() => setCollapsed((value) => !value)} aria-expanded={!collapsed}>
        <span className="todo-panel__title"><ListChecks size={16} /><strong>Task plan</strong></span>
        <span className="todo-panel__summary">{planInterrupted ? "Stopped · " : planPaused ? `${pausedLabel} · ` : ""}{completedCount} of {allVisibleTasks.length} complete</span>
        <span className="todo-panel__progress" aria-hidden="true"><i style={{ width: `${progress}%` }} /></span>
        {collapsed && active && <span className="todo-panel__active">{planInterrupted ? "Stopped · " : planPaused ? "Paused · " : ""}{active.activeForm ?? active.subject}</span>}
        <span className="todo-panel__toggle">{collapsed ? <CaretUp size={13} /> : <CaretDown size={13} />}</span>
      </button>
      {!collapsed && (
        <div className="todo-panel__tasks">
          {tasks.map(({ task, blocked }) => (
            <div className={`todo-task todo-task--${task.status}${blocked ? " todo-task--blocked" : ""}${planInterrupted && task.status === "in_progress" ? " todo-task--interrupted" : ""}${planPaused && task.status === "in_progress" ? " todo-task--paused" : ""}`} key={task.id}>
              <span className="todo-task__status"><TaskIcon task={task} blocked={blocked} interrupted={planInterrupted} paused={planPaused} /></span>
              <span className="todo-task__copy">
                <strong>{task.subject}</strong>
                {(task.activeForm || task.description || ((planInterrupted || planPaused) && task.status === "in_progress")) && <small>{planInterrupted && task.status === "in_progress" ? "Stopped before this step completed" : planPaused && task.status === "in_progress" ? pausedDetail : task.status === "in_progress" ? task.activeForm ?? task.description : task.description}</small>}
              </span>
              {task.owner && <span className="todo-task__owner">{task.owner}</span>}
              {blocked && <span className="todo-task__dependency">After {task.blockedBy!.map((id) => `#${id}`).join(", ")}</span>}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
