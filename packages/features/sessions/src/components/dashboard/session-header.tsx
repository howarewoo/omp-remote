import { type Session } from "@omp-remote/protocol";
import { SESSION_STATUS_LABEL, SESSION_STATUS_TONE } from "@omp-remote/ui";
import { canKillSession } from "../dashboard-actions.js";
import { Badge } from "../ui/badge.js";
import { Button } from "../ui/button.js";
import { SidebarTrigger } from "../ui/sidebar.js";
import { cn } from "../ui/utils.js";
import { compactPath } from "./session-path.js";

export type NotificationState = "blocked" | "enabled" | "error" | "prompt" | "unsupported";

type DashboardIconName =
  | "bell"
  | "close"
  | "down"
  | "plus"
  | "power"
  | "search"
  | "send"
  | "stop"
  | "trash"
  | "up";

export interface SessionHeaderProps {
  selectedSession: Session | null;
  selectedSessionStatus: Session["status"] | undefined;
  notificationState: NotificationState;
  onOpenNotificationSettings(): void;
  onKillSession(): void;
  onLaunchSession(): void;
}

export function SessionHeader({
  selectedSession,
  selectedSessionStatus,
  notificationState,
  onOpenNotificationSettings,
  onKillSession,
  onLaunchSession,
}: SessionHeaderProps) {
  return (
    <header className="session-header">
      <div className="session-header-primary">
        <SidebarTrigger />
        {selectedSession && selectedSessionStatus ? (
          <>
            <div>
              <h1>{selectedSession.name ?? "Untitled session"}</h1>
              <p className="session-root" title={selectedSession.cwd}>
                {compactPath(selectedSession.cwd)}
              </p>
            </div>
            <Badge className={cn("status-badge", `status-${SESSION_STATUS_TONE[selectedSessionStatus]}`)}>
              <span aria-hidden="true" />
              {SESSION_STATUS_LABEL[selectedSessionStatus]}
            </Badge>
            {canKillSession(selectedSession) ? (
              <Button
                className="kill-session-button"
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Kill ${selectedSession.name ?? "session"}`}
                title="Kill session"
                onClick={onKillSession}
              >
                <DashboardIcon name="power" />
              </Button>
            ) : null}
          </>
        ) : (
          <h1>OMP Remote</h1>
        )}
      </div>
      <div className="session-header-actions">
        <Button
          className="notification-button"
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Notification settings"
          title="Notification settings"
          data-state={notificationState}
          onClick={onOpenNotificationSettings}
        >
          <DashboardIcon name="bell" />
        </Button>
        <Button className="new-session-button" type="button" variant="outline" onClick={onLaunchSession}>
          <DashboardIcon name="plus" />
          New session
        </Button>
      </div>
    </header>
  );
}

export function DashboardIcon({ name }: { name: DashboardIconName }) {
  const paths = {
    bell: (
      <>
        <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
        <path d="M10 21h4" />
      </>
    ),
    close: <path d="m6 6 12 12M18 6 6 18" />,
    down: <path d="m6 9 6 6 6-6" />,
    plus: <path d="M12 5v14M5 12h14" />,
    power: (
      <>
        <path d="M12 3v9" />
        <path d="M7.1 5.7a8 8 0 1 0 9.8 0" />
      </>
    ),
    search: <path d="m21 21-4.4-4.4m2.4-5.1a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0Z" />,
    send: <path d="m4 4 17 8-17 8 3-8-3-8Zm3 8h14" />,
    stop: <rect x="7" y="7" width="10" height="10" rx="1" />,
    trash: (
      <>
        <path d="M4 7h16" />
        <path d="m9 7 1-3h4l1 3" />
        <path d="m6 7 1 14h10l1-14M10 11v6M14 11v6" />
      </>
    ),
    up: <path d="m6 15 6-6 6 6" />,
  } as const;
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
