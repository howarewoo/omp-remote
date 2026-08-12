import type { RoleEffort, Session } from "@omp-remote/protocol";
import type { TodoOverallProgress, TodoTaskState } from "../todo-parser.js";
import { SessionCostMetadata } from "../session-cost-viewer.js";
import { Button } from "../ui/button.js";
import { DashboardIcon } from "./session-header.js";

interface TodoMetadata {
  overall: TodoOverallProgress;
  activeLabel: string;
  activeState: TodoTaskState;
  progressVerb: "complete" | "resolved";
  label: string;
}

export interface SessionMetadataProps {
  session: Session;
  canViewBranches: boolean;
  modelLabel: string;
  configurationPending: string | null;
  fileChangesMetadata: string;
  todo: TodoMetadata | null;
  onOpenBranchSelector(): void;
  onOpenConfiguration(): void;
  onOpenFileChanges(): void;
  onOpenCost(): void;
  onOpenTodo(): void;
}

export function SessionMetadata({
  session,
  canViewBranches,
  modelLabel,
  configurationPending,
  fileChangesMetadata,
  todo,
  onOpenBranchSelector,
  onOpenConfiguration,
  onOpenFileChanges,
  onOpenCost,
  onOpenTodo,
}: SessionMetadataProps) {
  return (
    <dl className="session-metadata">
      {session.branch ? (
        <div className="session-branch-metadata">
          <dt>Branch</dt>
          <dd>
            {canViewBranches ? (
              <Button
                className="session-branch-trigger"
                type="button"
                variant="ghost"
                aria-label={`Open branch viewer. Current branch ${session.branch}`}
                onClick={onOpenBranchSelector}
              >
                <span className="session-branch-value" title={session.branch}>
                  {session.branch}
                </span>
                <DashboardIcon name="up" />
              </Button>
            ) : (
              <span className="session-branch-value" title={session.branch}>
                {session.branch}
              </span>
            )}
          </dd>
        </div>
      ) : null}
      <div className="session-configuration-metadata">
        <dt>Model · Effort</dt>
        <dd>
          <Button
            className="session-configuration-trigger"
            type="button"
            variant="ghost"
            aria-label={`Change model and effort. Current model ${session.model ?? "Default"}, current effort ${formatEffortLabel(session.effort)}`}
            onClick={() => {
              if (!configurationPending) onOpenConfiguration();
            }}
          >
            <span className="session-configuration-value">{modelLabel}</span>
            <span className="session-configuration-separator" aria-hidden="true">
              ·
            </span>
            <span className="session-configuration-effort">{formatEffortLabel(session.effort)}</span>
            <DashboardIcon name="up" />
          </Button>
        </dd>
      </div>
      <div>
        <dt>Context</dt>
        <dd>{session.contextPercent === null ? "—" : `${Math.round(session.contextPercent)}%`}</dd>
      </div>
      <div className="session-changes-metadata">
        <dt>Changes</dt>
        <dd>
          <Button
            className="session-changes-trigger"
            type="button"
            variant="ghost"
            aria-label={`Open session file changes. ${fileChangesMetadata}`}
            onClick={onOpenFileChanges}
          >
            {fileChangesMetadata}
          </Button>
        </dd>
      </div>
      <div className="session-cost-metadata">
        <dt>Cost</dt>
        <dd>
          <SessionCostMetadata summary={session.costSummary} onOpen={onOpenCost} />
        </dd>
      </div>
      {todo ? (
        <div className="todo-tracker-metadata">
          <dt>Todo</dt>
          <dd>
            <Button
              className="todo-tracker-trigger"
              type="button"
              variant="ghost"
              aria-label={todo.label}
              onClick={onOpenTodo}
            >
              <span className="todo-tracker-copy">
                <strong>
                  {todo.overall.done}/{todo.overall.total}
                </strong>
                <span className="todo-tracker-active">
                  <span aria-hidden="true" className="todo-state-marker" data-state={todo.activeState} />
                  <span>{todo.activeLabel}</span>
                </span>
              </span>
              <progress
                aria-label={`Current Todo progress: ${todo.overall.done} of ${todo.overall.total} tasks ${todo.progressVerb}`}
                max={todo.overall.total}
                value={todo.overall.done}
              />
            </Button>
          </dd>
        </div>
      ) : null}
    </dl>
  );
}

export function formatEffortLabel(effort: RoleEffort | null | undefined): string {
  if (!effort) return "Default effort";
  if (effort === "off") return "No reasoning";
  if (effort === "xhigh") return "Extra high";
  return effort.charAt(0).toUpperCase() + effort.slice(1);
}
