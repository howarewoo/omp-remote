import { type Session } from "@omp-remote/protocol";
import { memo } from "react";
import { Badge } from "../ui/badge.js";
import { parseTodoResult, type TodoResult, type TodoTask, type TodoTaskState } from "../todo-parser.js";
import { renderSafeHttpText } from "./inline-transcript.js";
import { formatTime, renderToolTitle, ToolOutputDivider } from "./transcript-entry.js";
import { TranscriptDisclosure } from "./transcript-disclosure.js";

const TODO_STATE_LABEL: Record<TodoTaskState, string> = {
  pending: "Pending",
  "in-progress": "In progress",
  completed: "Completed",
  blocked: "Blocked",
  dropped: "Dropped",
};

type TodoPresentation = {
  activeTask?: TodoTask;
  activeLabel: string;
  activeState: TodoTaskState;
  blocked: number;
  open: number;
  progressVerb: "complete" | "resolved";
};

export function getTodoPresentation(todo: TodoResult): TodoPresentation {
  const activePhase = todo.activePhase ? todo.phases[todo.activePhase.index - 1] : undefined;
  let activeTask = activePhase?.tasks.find((task) => task.state === "in-progress");
  if (!activeTask) {
    for (const phase of todo.phases) {
      activeTask = phase.tasks.find((task) => task.state === "in-progress");
      if (activeTask) break;
    }
  }
  activeTask ??= activePhase?.tasks.find((task) => task.state === "blocked" || task.state === "pending");

  const blocked = todo.overall.blocked ?? 0;
  const open = todo.overall.open ?? todo.overall.total - todo.overall.done - blocked;
  const hasDroppedTasks = todo.phases.some((phase) => phase.tasks.some((task) => task.state === "dropped"));
  const terminalState: TodoTaskState = hasDroppedTasks ? "dropped" : "completed";

  return {
    ...(activeTask ? { activeTask } : {}),
    activeLabel:
      activeTask?.label ??
      (todo.overall.done === todo.overall.total
        ? hasDroppedTasks
          ? "No tasks remain"
          : "All tasks complete"
        : `${open} tasks open`),
    activeState: activeTask?.state ?? (todo.overall.done === todo.overall.total ? terminalState : "pending"),
    blocked,
    open,
    progressVerb: hasDroppedTasks ? "resolved" : "complete",
  };
}

export function getTodoTrackerLabel(todo: TodoResult): string {
  const { activeLabel, activeTask, progressVerb } = getTodoPresentation(todo);
  const context = activeTask ? `${TODO_STATE_LABEL[activeTask.state]}: ${activeLabel}` : activeLabel;
  return `Open current Todo: ${todo.overall.done} of ${todo.overall.total} tasks ${progressVerb}. ${context}.`;
}
export function TodoProgressSummary({ todo }: { todo: TodoResult }) {
  const { activeLabel, activeState, activeTask, blocked, open, progressVerb } = getTodoPresentation(todo);

  return (
    <div className="todo-tool-summary">
      <div className="todo-progress-copy">
        <strong>
          {todo.overall.done}/{todo.overall.total} {progressVerb}
        </strong>
        <span className="todo-progress-counts">
          <span>{open} open</span>
          {blocked > 0 ? <span className="todo-blocked-count">{blocked} blocked</span> : null}
        </span>
      </div>
      <progress
        aria-label={`Overall todo progress: ${todo.overall.done} of ${
          todo.overall.total
        } tasks ${progressVerb}`}
        max={todo.overall.total}
        value={todo.overall.done}
      />
      <div className="todo-active-task">
        <span aria-hidden="true" className="todo-state-marker" data-state={activeState} />
        <span>
          <span className="sr-only">{activeTask ? `${TODO_STATE_LABEL[activeTask.state]}: ` : ""}</span>
          {renderSafeHttpText(activeLabel, "todo-active")}
        </span>
      </div>
    </div>
  );
}
export function TodoPhaseList({ todo }: { todo: TodoResult }) {
  return (
    <div className="todo-phase-list">
      {todo.phases.map((phase, phaseIndex) => (
        <section className="todo-phase" key={`${phaseIndex}:${phase.name}`}>
          <header>
            <h3>{renderSafeHttpText(phase.name, `todo-phase-${phaseIndex}`)}</h3>
            <Badge className={`todo-state-badge todo-state-${phase.state}`}>
              {TODO_STATE_LABEL[phase.state]}
            </Badge>
          </header>
          <ul>
            {phase.tasks.map((task, taskIndex) => (
              <li key={`${taskIndex}:${task.label}`}>
                <span aria-hidden="true" className="todo-state-marker" data-state={task.state} />
                <span className="todo-task-label">
                  <span className="sr-only">{TODO_STATE_LABEL[task.state]}: </span>
                  {renderSafeHttpText(task.label, `todo-task-${phaseIndex}`)}
                  {task.reason ? (
                    <span className="todo-task-reason">
                      <span className="sr-only">Blocked reason: </span>
                      {renderSafeHttpText(task.reason, `todo-reason-${phaseIndex}`)}
                    </span>
                  ) : null}
                </span>
                <Badge aria-hidden="true" className={`todo-state-badge todo-state-${task.state}`}>
                  {TODO_STATE_LABEL[task.state]}
                </Badge>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

export function TodoToolTranscript({
  entry,
  todo,
}: {
  entry: Session["messages"][number];
  todo: TodoResult;
}) {
  return (
    <TranscriptDisclosure
      badge={entry.streaming ? <Badge className="streaming-badge">Streaming</Badge> : null}
      category="todo"
      className="tool-message-disclosure todo-tool-disclosure tool-output-disclosure"
      defaultOpen={entry.streaming === true}
      lifecycle={entry.streaming ? "running" : undefined}
      preview={
        <>
          <ToolOutputDivider />
          <TodoProgressSummary todo={todo} />
        </>
      }
      time={formatTime(entry.timestamp)}
      timestamp={entry.timestamp}
      title={renderToolTitle(entry, "Todo")}
    >
      <TodoPhaseList todo={todo} />
    </TranscriptDisclosure>
  );
}
export const MemoizedTodoToolTranscript = memo(TodoToolTranscript);

export function findLatestTodoResult(messages: readonly Session["messages"][number][]): TodoResult | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const entry = messages[index];
    if (!entry || entry.role !== "tool" || entry.toolName !== "todo" || entry.streaming) continue;
    const todo = parseTodoResult(entry.text);
    if (todo) return todo;
  }
  return null;
}
