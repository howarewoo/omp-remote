import { type ReactNode, useState } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible.js";
import { cn } from "../ui/utils.js";

export type DisclosureCategory =
  | "system"
  | "tool"
  | "read"
  | "write"
  | "edit"
  | "bash"
  | "grep"
  | "task"
  | "todo"
  | "yield"
  | "code"
  | (string & {});

export type DisclosureLifecycle =
  | "idle"
  | "running"
  | "error"
  | "waiting"
  | "canceled"
  | "completed"
  | "done"
  | "success"
  | (string & {});

const LIFECYCLE_LABEL: Record<string, string> = {
  running: "Running",
  error: "Failed",
  waiting: "Waiting",
  canceled: "Canceled",
};

const LIFECYCLE_ANNOUNCEMENT: Record<string, string> = {
  running: "Operation running",
  error: "Operation failed",
  waiting: "Action required",
  canceled: "Operation canceled",
};

export interface TranscriptDisclosureProps {
  id?: string | undefined;
  className?: string | undefined;
  category?: DisclosureCategory | undefined;
  lifecycle?: DisclosureLifecycle | undefined;
  title: ReactNode;
  time?: ReactNode | undefined;
  timestamp?: string | undefined;
  status?: ReactNode | undefined;
  badge?: ReactNode | undefined;
  preview?: ReactNode | undefined;
  children: ReactNode;
  expandable?: boolean | undefined;
  open?: boolean | undefined;
  defaultOpen?: boolean | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined;
  keepMounted?: boolean | undefined;
  disabled?: boolean | undefined;
  announcement?: string | undefined;
  triggerAriaLabel?: string | undefined;
}

export function DisclosureChevronIcon() {
  return (
    <svg
      aria-hidden="true"
      className="transcript-disclosure-chevron-svg"
      fill="none"
      height="14"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
      width="14"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export function DisclosureCategoryIcon({ category = "tool" }: { category?: DisclosureCategory }) {
  const iconProps = {
    fill: "none",
    height: "14",
    stroke: "currentColor",
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    strokeWidth: "2",
    viewBox: "0 0 24 24",
    width: "14",
  };

  switch (category) {
    case "system":
      return (
        <svg aria-hidden="true" {...iconProps}>
          <circle cx="12" cy="12" r="10" />
          <path d="M12 16v-4M12 8h.01" />
        </svg>
      );
    case "read":
      return (
        <svg aria-hidden="true" {...iconProps}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" x2="8" y1="13" y2="13" />
          <line x1="16" x2="8" y1="17" y2="17" />
        </svg>
      );
    case "write":
      return (
        <svg aria-hidden="true" {...iconProps}>
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
        </svg>
      );
    case "edit":
      return (
        <svg aria-hidden="true" {...iconProps}>
          <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
        </svg>
      );
    case "bash":
      return (
        <svg aria-hidden="true" {...iconProps}>
          <polyline points="4 17 10 11 4 5" />
          <line x1="12" x2="20" y1="19" y2="19" />
        </svg>
      );
    case "grep":
      return (
        <svg aria-hidden="true" {...iconProps}>
          <circle cx="11" cy="11" r="8" />
          <line x1="21" x2="16.65" y1="21" y2="16.65" />
        </svg>
      );
    case "task":
      return (
        <svg aria-hidden="true" {...iconProps}>
          <path d="M9 11l3 3L22 4" />
          <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
        </svg>
      );
    case "todo":
      return (
        <svg aria-hidden="true" {...iconProps}>
          <circle cx="12" cy="12" r="10" />
          <path d="m9 12 2 2 4-4" />
        </svg>
      );
    case "yield":
      return (
        <svg aria-hidden="true" {...iconProps}>
          <circle cx="12" cy="12" r="10" />
          <polyline points="12 8 8 12 12 16" />
          <line x1="16" x2="8" y1="12" y2="12" />
        </svg>
      );
    case "code":
      return (
        <svg aria-hidden="true" {...iconProps}>
          <polyline points="16 18 22 12 16 6" />
          <polyline points="8 6 2 12 8 18" />
        </svg>
      );
    case "tool":
    default:
      return (
        <svg aria-hidden="true" {...iconProps}>
          <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
        </svg>
      );
  }
}

function TranscriptDisclosureHeader({
  badge,
  category,
  expandable,
  resolvedStatus,
  time,
  timestamp,
  title,
}: {
  badge: ReactNode;
  category: DisclosureCategory;
  expandable: boolean;
  resolvedStatus: ReactNode;
  time: ReactNode;
  timestamp: string | undefined;
  title: ReactNode;
}) {
  return (
    <span className="transcript-disclosure-header" data-expandable={expandable}>
      <span className="transcript-disclosure-icon" data-category={category}>
        <DisclosureCategoryIcon category={category} />
      </span>
      <span className="transcript-disclosure-title">{title}</span>
      {time ? (
        typeof time === "string" && timestamp ? (
          <time className="transcript-disclosure-time" dateTime={timestamp}>
            {time}
          </time>
        ) : (
          <span className="transcript-disclosure-time">{time}</span>
        )
      ) : null}
      {resolvedStatus || badge ? (
        <span className="transcript-disclosure-state">
          {resolvedStatus ? <span className="transcript-disclosure-status">{resolvedStatus}</span> : null}
          {badge}
        </span>
      ) : null}
      {expandable ? (
        <span aria-hidden="true" className="transcript-disclosure-chevron">
          <DisclosureChevronIcon />
        </span>
      ) : null}
    </span>
  );
}

export function TranscriptDisclosure({
  id,
  className,
  category = "tool",
  lifecycle,
  title,
  time,
  timestamp,
  status,
  badge,
  preview,
  children,
  expandable = true,
  open,
  defaultOpen = false,
  onOpenChange,
  keepMounted = false,
  disabled = false,
  announcement: explicitAnnouncement,
  triggerAriaLabel,
}: TranscriptDisclosureProps) {
  const isControlled = open !== undefined;
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const isOpen = isControlled ? open : internalOpen;

  const handleOpenChange = (nextOpen: boolean) => {
    if (!isControlled) {
      setInternalOpen(nextOpen);
    }
    onOpenChange?.(nextOpen);
  };

  const activeAnnouncement =
    explicitAnnouncement ?? (lifecycle ? LIFECYCLE_ANNOUNCEMENT[lifecycle] : undefined);
  const resolvedStatus = status ?? (lifecycle ? LIFECYCLE_LABEL[lifecycle] : null);
  const header = (
    <TranscriptDisclosureHeader
      badge={badge}
      category={category}
      expandable={expandable}
      resolvedStatus={resolvedStatus}
      time={time}
      timestamp={timestamp}
      title={title}
    />
  );
  const announcement = activeAnnouncement ? (
    <span
      aria-atomic="true"
      aria-live="polite"
      className="transcript-disclosure-announcement sr-only"
      role="status"
    >
      {activeAnnouncement}
    </span>
  ) : null;

  if (!expandable) {
    return (
      <div
        className={cn("transcript-disclosure-frame", className)}
        data-lifecycle={lifecycle}
        data-state="static"
        id={id}
      >
        <div className="transcript-disclosure-summary">{header}</div>
        {preview ? <div className="transcript-disclosure-preview">{preview}</div> : null}
        {announcement}
      </div>
    );
  }

  return (
    <Collapsible
      className={cn("transcript-disclosure-frame", className)}
      data-lifecycle={lifecycle}
      data-state={isOpen ? "open" : "closed"}
      disabled={disabled}
      id={id}
      onOpenChange={handleOpenChange}
      open={isOpen}
    >
      <CollapsibleTrigger
        aria-label={triggerAriaLabel}
        className="transcript-disclosure-trigger"
        type="button"
      >
        {header}
      </CollapsibleTrigger>
      {preview ? <div className="transcript-disclosure-preview">{preview}</div> : null}
      <CollapsibleContent className="transcript-disclosure-panel" keepMounted={keepMounted}>
        {children}
      </CollapsibleContent>
      {announcement}
    </Collapsible>
  );
}
