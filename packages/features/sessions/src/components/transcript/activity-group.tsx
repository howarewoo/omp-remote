import { memo, useState } from "react";
import { MessageScrollerItem } from "../ui/message-scroller.js";
import { cn } from "../ui/utils.js";
import { TranscriptEntry } from "./transcript-entry.js";
import { type DisclosureCategory, TranscriptDisclosure } from "./transcript-disclosure.js";
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

const CATEGORY_DISCLOSURE_MAP: Record<OmpToolCategory, DisclosureCategory> = {
  read: "read",
  edit: "edit",
  search: "grep",
  terminal: "bash",
  web: "read",
  task: "task",
  other: "tool",
};
function formatGroupVisibleSummary(summary: string, isSingleSubgroup: boolean): string {
  if (!isSingleSubgroup) return summary;
  const stripped = summary.replace(
    /^(Reading|Read|Editing|Edited|Searching|Searched|Running|Ran|Browsing|Browsed|Completed)(?::\s*|\s+)/i,
    "",
  );
  return stripped || summary;
}

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
  const isSingleSubgroup = group.subgroups.length === 1;
  const disclosureCategory = isSingleSubgroup ? CATEGORY_DISCLOSURE_MAP[primaryCategory] : "group";
  const visibleSummary = formatGroupVisibleSummary(group.summary, isSingleSubgroup);
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
      <TranscriptDisclosure
        category={disclosureCategory}
        className="transcript-activity-group-disclosure"
        keepMounted
        lifecycle={group.aggregateState}
        onOpenChange={handleOpenChange}
        open={isOpen}
        time={
          group.duration ? (
            <time aria-label="Duration" className="transcript-activity-group-duration">
              {group.duration.formattedDuration}
            </time>
          ) : null
        }
        title={
          <>
            <span className={cn("transcript-tool-name", CATEGORY_COLOR_CLASS[primaryCategory])}>
              {isSingleSubgroup ? CATEGORY_LABEL[primaryCategory] : "Activity"}
            </span>
            <span className="transcript-activity-group-summary-text">{visibleSummary}</span>
          </>
        }
        triggerAriaLabel={`${group.summary} (${group.aggregateState})`}
      >
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
                  <span className="transcript-activity-subgroup-summary">
                    {formatGroupVisibleSummary(subgroup.summary, true)}
                  </span>
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
      </TranscriptDisclosure>
    </article>
  );
}

export const MemoizedTranscriptActivityGroup = memo(TranscriptActivityGroup);
