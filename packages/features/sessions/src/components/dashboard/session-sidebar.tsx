import { type Session } from "@omp-remote/protocol";
import { SESSION_STATUS_LABEL, SESSION_STATUS_TONE } from "@omp-remote/ui";
import { type FormEventHandler } from "react";
import { Button } from "../ui/button.js";
import { Input } from "../ui/input.js";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarRail,
  SidebarTrigger,
} from "../ui/sidebar.js";
import { cn } from "../ui/utils.js";
import { DashboardIcon } from "./session-header.js";

interface SessionSidebarSection {
  id: "terminal" | "daemon" | "disconnected";
  label: "Live terminal sessions" | "Live daemon-hosted sessions" | "Disconnected";
  sessions: Session[];
}

export interface SessionSidebarProps {
  mainSessions: Session[];
  sessionSections: SessionSidebarSection[];
  selectedSessionId: string | null;
  askingSessionIds: ReadonlySet<string>;
  historyLoading: boolean;
  hasMoreHistory: boolean;
  historyQuery: string;
  activeHistoryQuery: string;
  connection: "connecting" | "connected" | "disconnected";
  onHistoryQueryChange(value: string): void;
  onSubmitHistorySearch: FormEventHandler<HTMLFormElement>;
  onClearHistorySearch(): void;
  onLaunchSession(): void;
  onSelectSession(sessionId: string): void;
  onLoadMoreHistory(): void;
}

export function SessionSidebar({
  mainSessions,
  sessionSections,
  selectedSessionId,
  askingSessionIds,
  historyLoading,
  hasMoreHistory,
  historyQuery,
  activeHistoryQuery,
  connection,
  onHistoryQueryChange,
  onSubmitHistorySearch,
  onClearHistorySearch,
  onLaunchSession,
  onSelectSession,
  onLoadMoreHistory,
}: SessionSidebarProps) {
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">
            π
          </span>
          <span className="brand-word">omp</span>
          <span className="brand-remote">remote</span>
        </div>
        <SidebarTrigger />
      </SidebarHeader>

      <div className="sidebar-actions">
        <Button type="button" onClick={onLaunchSession} className="new-session-button">
          <DashboardIcon name="plus" />
          <span>New session</span>
        </Button>
        <form className="session-search" onSubmit={onSubmitHistorySearch}>
          <div className="session-search-field">
            <label className="sr-only" htmlFor="session-search-input">
              Search all local OMP sessions
            </label>
            <DashboardIcon name="search" />
            <Input
              id="session-search-input"
              type="search"
              value={historyQuery}
              onChange={(event) => onHistoryQueryChange(event.target.value)}
              placeholder="Search sessions"
              maxLength={200}
            />
          </div>
        </form>
      </div>

      <SidebarContent>
        <nav className="session-list" aria-label="Registered OMP sessions">
          {mainSessions.length === 0 ? (
            <div className="sidebar-empty" role="status">
              <span className="status-orbit" aria-hidden="true" />
              <strong>{historyLoading ? "Reading session history" : "No sessions found"}</strong>
              <p>
                {activeHistoryQuery
                  ? "Try another name, ID, or working directory."
                  : "Start a session here or connect a terminal session."}
              </p>
              {!historyLoading ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={activeHistoryQuery ? onClearHistorySearch : onLaunchSession}
                >
                  {activeHistoryQuery ? "Clear search" : "Start session"}
                </Button>
              ) : null}
            </div>
          ) : (
            sessionSections.map((section) => (
              <section
                className="session-group"
                aria-labelledby={`session-group-${section.id}`}
                key={section.id}
              >
                <h2 className="session-group-heading" id={`session-group-${section.id}`}>
                  <span>{section.label}</span>
                  {section.id !== "disconnected" ? (
                    <span>
                      {section.sessions.length.toLocaleString()}
                      <span className="sr-only">
                        {" "}
                        {section.sessions.length === 1 ? "session" : "sessions"}
                      </span>
                    </span>
                  ) : null}
                </h2>
                {section.sessions.map((session) => {
                  const selected = session.id === selectedSessionId;
                  const displayName =
                    session.name ?? session.cwd.split("/").filter(Boolean).at(-1) ?? "Untitled session";
                  const displayStatus = askingSessionIds.has(session.id) ? "waiting" : session.status;
                  return (
                    <button
                      className={cn("session-item", selected && "session-item-selected")}
                      type="button"
                      key={session.id}
                      aria-current={selected ? "page" : undefined}
                      aria-label={`${displayName}, ${SESSION_STATUS_LABEL[displayStatus]}`}
                      title={displayName}
                      onClick={() => onSelectSession(session.id)}
                    >
                      <span
                        className={cn(
                          "session-state-dot",
                          `session-state-${SESSION_STATUS_TONE[displayStatus]}`,
                        )}
                      />
                      <span className="session-copy">
                        <strong>{displayName}</strong>
                        <small>{compactPath(session.cwd)}</small>
                      </span>
                      <time dateTime={session.lastActivity}>{formatSessionTime(session.lastActivity)}</time>
                    </button>
                  );
                })}
              </section>
            ))
          )}
        </nav>
        {hasMoreHistory ? (
          <Button
            className="load-more-button"
            type="button"
            variant="ghost"
            size="sm"
            disabled={historyLoading}
            onClick={onLoadMoreHistory}
          >
            {historyLoading ? "Reading history…" : "Load older sessions"}
          </Button>
        ) : null}
      </SidebarContent>

      <SidebarFooter>
        <span className={cn("connection-dot", `connection-${connection}`)} aria-hidden="true" />
        <span>
          {connection === "connected"
            ? "Host connected"
            : connection === "connecting"
              ? "Connecting"
              : "Host offline"}
        </span>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

function compactPath(path: string): string {
  const segments = path.split("/").filter(Boolean);
  if (segments.length <= 2) return path;
  return `…/${segments.slice(-2).join("/")}`;
}

export function formatSessionTime(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime())
    ? "Unknown"
    : new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(date);
}
