import { Button } from "../ui/button.js";
import { DashboardIcon } from "./session-header.js";

export interface EmptyDashboardProps {
  onLaunchSession(): void;
}

export function EmptyDashboard({ onLaunchSession }: EmptyDashboardProps) {
  return (
    <section className="no-session">
      <span className="terminal-prompt" aria-hidden="true">
        π
      </span>
      <h2>Start a session from anywhere.</h2>
      <p>
        Launch OMP here or connect a terminal session on this host. Updates stream into this workspace live.
      </p>
      <Button type="button" onClick={onLaunchSession}>
        <DashboardIcon name="plus" />
        Start session
      </Button>
    </section>
  );
}
