import { memo, useState } from "react";
import { Badge } from "../ui/badge.js";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible.js";
import { MessageScrollerItem } from "../ui/message-scroller.js";
import { cn } from "../ui/utils.js";
import { TranscriptEntry } from "./transcript-entry.js";
import type { ActivityGroupData, OmpToolCategory } from "./transcript-grouping.js";

export type { ActivityGroupData } from "./transcript-grouping.js";

export interface TranscriptActivityGroupProps {
  group: ActivityGroupData;
}

const CATEGORY_LABEL: Record<OmpToolCategory, string> = {
  read: "Read",
  edit: "Edit",
  search: "Search",
  terminal: "Terminal",
  web: "Web",
  task: "Task",
  other: "Tool",
};

const CATEGORY_COLOR_CLASS: Record<OmpToolCategory, string> = {
  read: "transcript-tool-name-read",
  edit: "transcript-tool-name-edit",
  search: "transcript-tool-name-grep",
  terminal: "transcript-tool-name-bash",
  web: "transcript-tool-name-read",
  task: "transcript-tool-name-task",
  other: "transcript-tool-name-todo",
};

export function TranscriptActivityGroup({ group }: TranscriptActivityGroupProps) {
  const [userToggledOpen, setUserToggledOpen] = useState<boolean | null>(null);

  const defaultOpen =
    group.aggregateState === "running" ||
    group.aggregateState === "error" ||
    group.aggregateState === "waiting" ||
    group.aggregateState === "canceled";

  const isOpen = userToggledOpen ?? defaultOpen;

  const handleOpenChange = (open: boolean) => {
    setUserToggledOpen(open);
  };

  const isElevated =
    group.aggregateState === "error" ||
    group.aggregateState === "waiting" ||
    group.aggregateState === "canceled";

  const firstSubgroup = group.subgroups[0];
  const primaryCategory: OmpToolCategory = firstSubgroup ? firstSubgroup.category : "other";

  return (
    <article
      className={cn(
        "transcript-entry",
        "transcript-activity-group-entry",
        `transcript-activity-group-${primaryCategory}`,
        `transcript-activity-group-${group.aggregateState}`,
        isElevated && "transcript-activity-group-elevated",
      )}
      data-aggregate-state={group.aggregateState}
      data-state={isOpen ? "open" : "closed"}
    >
      <Collapsible open={isOpen} onOpenChange={handleOpenChange}>
        <header className="transcript-activity-group-header">
          <CollapsibleTrigger
            className="transcript-activity-group-trigger"
            aria-label={`${group.summary} (${group.aggregateState})`}
          >
            <span className="message-author">
              <i aria-hidden="true">·</i>
              <span className={cn("transcript-tool-name", CATEGORY_COLOR_CLASS[primaryCategory])}>
                {group.subgroups.length === 1 ? CATEGORY_LABEL[primaryCategory] : "Activity"}
              </span>
              <span className="transcript-activity-group-summary-text">{group.summary}</span>
              <span className="message-disclosure-chevron" aria-hidden="true" />
            </span>
          </CollapsibleTrigger>
          {group.duration ? (
            <time className="transcript-activity-group-duration" aria-label="Duration">
              {group.duration.formattedDuration}
            </time>
          ) : null}
          {group.aggregateState === "running" ? (
            <Badge className="streaming-badge">Running</Badge>
          ) : group.aggregateState === "error" ? (
            <Badge className="error-badge">Error</Badge>
          ) : group.aggregateState === "waiting" ? (
            <Badge className="waiting-badge">Waiting</Badge>
          ) : group.aggregateState === "canceled" ? (
            <Badge className="canceled-badge">Canceled</Badge>
          ) : null}
        </header>
        <CollapsibleContent keepMounted className="transcript-activity-group-content">
          <div className="transcript-activity-group-members">
            {group.subgroups.map((subgroup) => (
              <div
                key={subgroup.key}
                className={cn(
                  "transcript-activity-subgroup",
                  `transcript-activity-subgroup-${subgroup.category}`,
                )}
              >
                {group.subgroups.length > 1 ? (
                  <div className="transcript-activity-subgroup-header">
                    <span className={cn("transcript-tool-name", CATEGORY_COLOR_CLASS[subgroup.category])}>
                      {CATEGORY_LABEL[subgroup.category]}
                    </span>
                    <span className="transcript-activity-subgroup-summary">{subgroup.summary}</span>
                    {subgroup.duration ? (
                      <time className="transcript-activity-subgroup-duration">
                        {subgroup.duration.formattedDuration}
                      </time>
                    ) : null}
                  </div>
                ) : null}
                <div className="transcript-activity-subgroup-items">
                  {subgroup.messages.map((entry) => (
                    <MessageScrollerItem key={entry.id} messageId={entry.id} scrollAnchor={false}>
                      <TranscriptEntry entry={entry} />
                    </MessageScrollerItem>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </article>
  );
}

export const MemoizedTranscriptActivityGroup = memo(TranscriptActivityGroup);
