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
} from "./ui/drawer.js";
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
  const transcriptRef = useRef<HTMLDivElement>(null);
  const followTranscriptRef = useRef(true);
  const lastSubagentRef = useRef<ActiveSubagent | null>(subagent);
  const displayedSubagent = subagent ?? lastSubagentRef.current;
  const lastMessage = session?.messages.at(-1);

  useEffect(() => {
    if (subagent) lastSubagentRef.current = subagent;
  }, [subagent]);

  useEffect(() => {
    if (!open) return;
    followTranscriptRef.current = true;
    const frame = requestAnimationFrame(() => {
      const transcript = transcriptRef.current;
      if (transcript) transcript.scrollTop = transcript.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [open, session?.id]);

  useEffect(() => {
    const transcript = transcriptRef.current;
    if (transcript && followTranscriptRef.current) transcript.scrollTop = transcript.scrollHeight;
  }, [lastMessage?.text, session?.messages.length, session?.status]);

  if (!displayedSubagent) return null;

  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      showSwipeHandle={mobile}
      swipeDirection={mobile ? "down" : "right"}
    >
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
        <div
          ref={transcriptRef}
          className="subagent-session-transcript transcript"
          role="log"
          aria-live="polite"
          aria-label={`${displayedSubagent.name} transcript`}
          onScroll={(event) => {
            const target = event.currentTarget;
            followTranscriptRef.current = target.scrollHeight - target.scrollTop - target.clientHeight < 80;
          }}
        >
          {children}
        </div>
      </DrawerContent>
    </Drawer>
  );
}
