import type { ActiveSubagent, Session } from "@omp-remote/protocol";
import { SESSION_STATUS_LABEL, SESSION_STATUS_TONE } from "@omp-remote/ui";
import { type ReactNode, useEffect, useRef } from "react";
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
  onOpenChange(open: boolean): void;
  children: ReactNode;
}

/** Presents a subagent transcript as a mobile bottom sheet or desktop side panel. */
export function SubagentSessionViewer({
  open,
  subagent,
  session,
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
            <DrawerDescription>{session?.cwd ?? "Live subagent session"}</DrawerDescription>
          </div>
          <div className="subagent-session-header-actions">
            {session ? (
              <Badge className={cn("status-badge", `status-${SESSION_STATUS_TONE[session.status]}`)}>
                <span aria-hidden="true" />
                {SESSION_STATUS_LABEL[session.status]}
              </Badge>
            ) : (
              <Badge className="status-badge status-waiting">
                <span aria-hidden="true" />
                Connecting
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
                aria-busy={session?.messages.at(-1)?.streaming === true}
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
