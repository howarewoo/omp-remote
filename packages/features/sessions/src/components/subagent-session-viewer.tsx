import type { ActiveSubagent, Session } from "@omp-remote/protocol";
import { SESSION_STATUS_LABEL, SESSION_STATUS_TONE } from "@omp-remote/ui";
import { type ReactNode, useEffect, useRef } from "react";
import { formatEffortLabel } from "./dashboard/session-metadata.js";
import { formatUsd } from "./session-cost.js";
import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  getResponsiveDrawerProps,
} from "./ui/drawer.js";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "./ui/message-scroller.js";
import { cn } from "./ui/utils.js";

interface SubagentSessionViewerProps {
  open: boolean;
  mobile: boolean;
  subagent: ActiveSubagent | null;
  session: Session | null;
  detailsState: "live" | "loading" | "saved" | "empty" | "error";
  onRetry(): void;
  onOpenChange(open: boolean): void;
  children: ReactNode;
}
export function formatSubagentModelLabel(session: Session | null | undefined): string {
  if (!session?.model) return "Default";
  const match = session.availableModels?.find(
    (model) => `${model.provider}/${model.id}` === session.model || model.id === session.model,
  );
  return match?.name ?? session.model.split("/").at(-1) ?? "Default";
}

/** Presents a subagent transcript as a mobile bottom sheet or desktop side panel. */
export function SubagentSessionViewer({
  open,
  subagent,
  session,
  detailsState,
  onRetry,
  mobile,
  onOpenChange,
  children,
}: SubagentSessionViewerProps) {
  const lastSubagentRef = useRef<ActiveSubagent | null>(subagent);
  const displayedSubagent = subagent ?? lastSubagentRef.current;

  useEffect(() => {
    if (subagent) lastSubagentRef.current = subagent;
  }, [subagent]);

  if (!displayedSubagent) return null;

  return (
    <Drawer open={open} onOpenChange={onOpenChange} {...getResponsiveDrawerProps(mobile)}>
      <DrawerContent className="subagent-session-panel">
        <DrawerHeader className="subagent-session-header">
          <div>
            <DrawerTitle>{session?.name ?? displayedSubagent.name}</DrawerTitle>
            <DrawerDescription>
              {session?.cwd ??
                (detailsState === "loading"
                  ? "Loading saved session"
                  : detailsState === "error"
                    ? "Saved session unavailable"
                    : detailsState === "live"
                      ? "Live subagent session"
                      : "Saved subagent session")}
            </DrawerDescription>
          </div>
          <div className="subagent-session-header-actions">
            {detailsState === "live" && session ? (
              <Badge className={cn("status-badge", `status-${SESSION_STATUS_TONE[session.status]}`)}>
                <span aria-hidden="true" />
                {SESSION_STATUS_LABEL[session.status]}
              </Badge>
            ) : detailsState === "loading" ? (
              <Badge className="status-badge status-waiting">
                <span aria-hidden="true" />
                Loading
              </Badge>
            ) : detailsState === "error" ? (
              <>
                <Badge className="status-badge status-disconnected">
                  <span aria-hidden="true" />
                  Unavailable
                </Badge>
                <Button type="button" variant="outline" size="sm" onClick={onRetry}>
                  Retry
                </Button>
              </>
            ) : (
              <Badge className="status-badge status-history">
                <span aria-hidden="true" />
                Saved session
              </Badge>
            )}
            <DrawerClose
              render={
                <Button type="button" variant="ghost" size="icon" aria-label="Close subagent session" />
              }
            >
              <svg aria-hidden="true" viewBox="0 0 24 24">
                <path d="m6 6 12 12M18 6 6 18" />
              </svg>
            </DrawerClose>
          </div>
        </DrawerHeader>
        {session ? (
          <dl className="subagent-session-metadata">
            {session.branch ? (
              <div className="subagent-metadata-branch">
                <dt>Branch</dt>
                <dd>
                  <span className="subagent-metadata-value" title={session.branch}>
                    {session.branch}
                  </span>
                </dd>
              </div>
            ) : null}
            <div className="subagent-metadata-model">
              <dt>Model · Effort</dt>
              <dd>
                <span className="subagent-metadata-value">{formatSubagentModelLabel(session)}</span>
                <span className="subagent-metadata-separator" aria-hidden="true">
                  ·
                </span>
                <span className="subagent-metadata-effort">{formatEffortLabel(session.effort)}</span>
              </dd>
            </div>
            <div className="subagent-metadata-context">
              <dt>Context</dt>
              <dd>{session.contextPercent === null ? "—" : `${Math.round(session.contextPercent)}%`}</dd>
            </div>
            <div className="subagent-metadata-cost">
              <dt>Cost</dt>
              <dd>
                {session.costSummary
                  ? `${formatUsd(session.costSummary.totalUsd)}${session.costSummary.partial ? " · Partial" : ""}`
                  : "—"}
              </dd>
            </div>
          </dl>
        ) : null}
        <MessageScrollerProvider
          key={`${session?.id ?? displayedSubagent.id}:${open ? "open" : "closed"}`}
          autoScroll
          defaultScrollPosition="end"
          scrollEdgeThreshold={80}
        >
          <MessageScroller className="transcript-region subagent-session-transcript-region">
            <MessageScrollerViewport
              className="transcript"
              aria-label={`${displayedSubagent.name} transcript`}
            >
              <MessageScrollerContent
                className="transcript-messages"
                role="log"
                aria-live="polite"
                aria-busy={detailsState === "loading" || session?.messages.at(-1)?.streaming === true}
              >
                {children}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton
              className="scroll-to-bottom-button"
              aria-label="Scroll to latest subagent output"
              title="Scroll to latest subagent output"
            />
          </MessageScroller>
        </MessageScrollerProvider>
      </DrawerContent>
    </Drawer>
  );
}
