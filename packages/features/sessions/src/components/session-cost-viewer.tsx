import type { Session, SessionCostSummary } from "@omp-remote/protocol";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  getResponsiveDrawerProps,
} from "./ui/drawer.js";
import { Button } from "./ui/button.js";
import { formatUsd, getSessionCostRows } from "./session-cost.js";

type CostSession = Pick<Session, "id" | "name" | "costSummary">;

export interface SessionCostMetadataProps {
  summary: SessionCostSummary | undefined;
  onOpen(): void;
}

export function SessionCostMetadata({ summary, onOpen }: SessionCostMetadataProps) {
  const display = summary
    ? `${formatUsd(summary.totalUsd)}${summary.partial ? " · Partial" : ""}`
    : "Unavailable · Partial";
  return (
    <Button
      className="session-cost-trigger"
      type="button"
      variant="ghost"
      aria-label={`Open session cost details. Cost: ${display}`}
      onClick={onOpen}
    >
      {display}
    </Button>
  );
}

export interface SessionCostViewerProps {
  session: CostSession | null;
  mobile: boolean;
  open: boolean;
  onOpenChange(open: boolean): void;
}

export function SessionCostViewer({ session, mobile, open, onOpenChange }: SessionCostViewerProps) {
  const summary = session?.costSummary;
  const rows = session ? getSessionCostRows(summary, session.id) : [];
  const visibleRows =
    rows.length > 0
      ? rows
      : session
        ? [
            {
              agent: {
                sessionId: session.id,
                name: session.name ?? "Session",
                parentSessionId: null,
                totalUsd: 0,
                available: false,
              },
              depth: 0,
            },
          ]
        : [];

  return (
    <Drawer open={open && session !== null} onOpenChange={onOpenChange} {...getResponsiveDrawerProps(mobile)}>
      <DrawerContent className="session-cost-sheet">
        <DrawerHeader className="session-cost-header">
          <div>
            <DrawerTitle>Session cost</DrawerTitle>
            <DrawerDescription>
              {summary?.partial
                ? "Partial cost summary."
                : summary
                  ? "Cost summary for this session."
                  : "Cost unavailable for this legacy session."}
            </DrawerDescription>
          </div>
          <DrawerClose
            render={
              <Button type="button" variant="ghost" size="icon" autoFocus aria-label="Close session cost" />
            }
          >
            <svg
              className="icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              aria-hidden="true"
            >
              <path d="m6 6 12 12M18 6 6 18" />
            </svg>
          </DrawerClose>
        </DrawerHeader>
        <div className="session-cost-body">
          <ul className="session-cost-list" aria-label="Session cost agents">
            {visibleRows.map(({ agent, depth }) => (
              <li
                key={agent.sessionId}
                className="session-cost-row"
                style={{ paddingInlineStart: `${depth * 1.25}rem` }}
              >
                <span>{agent.name}</span>
                <span>{agent.available ? formatUsd(agent.totalUsd) : "Unavailable"}</span>
              </li>
            ))}
          </ul>
        </div>
      </DrawerContent>
    </Drawer>
  );
}
