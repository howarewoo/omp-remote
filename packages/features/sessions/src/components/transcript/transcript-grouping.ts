import type { AskRequest, Session } from "@omp-remote/protocol";

export type TranscriptEntryMessage = Session["messages"][number];

export type OmpToolCategory = "read" | "edit" | "search" | "terminal" | "web" | "task" | "other";

export type ActivityGroupAggregateState = "running" | "success" | "error" | "waiting" | "canceled";

export interface ActivityGroupDuration {
  durationMs: number;
  formattedDuration: string;
}

export interface TranscriptGroupingContext {
  sessionStatus?: Session["status"];
  activeAskRequest?: AskRequest | null;
  canceled?: boolean;
  waiting?: boolean;
}

export interface ActivityCategorySubgroup {
  key: string;
  category: OmpToolCategory;
  summary: string;
  aggregateState: ActivityGroupAggregateState;
  duration?: ActivityGroupDuration;
  messages: readonly TranscriptEntryMessage[];
  hasExplicitLifecycle: boolean;
}

export interface ActivityGroupData {
  key: string;
  summary: string;
  aggregateState: ActivityGroupAggregateState;
  duration?: ActivityGroupDuration;
  messages: readonly TranscriptEntryMessage[];
  subgroups: readonly ActivityCategorySubgroup[];
  hasExplicitLifecycle: boolean;
}

export type TranscriptDisplayItem =
  | {
      kind: "message";
      key: string;
      message: TranscriptEntryMessage;
    }
  | ({
      kind: "group";
    } & ActivityGroupData);

/**
 * Maps a tool name to one of the closed OMP tool categories.
 */
export function getToolCategory(toolName?: string): OmpToolCategory {
  if (!toolName) return "other";
  const normalized = toolName.trim().toLowerCase();
  switch (normalized) {
    case "read":
      return "read";
    case "edit":
    case "write":
    case "patch":
    case "ast_edit":
      return "edit";
    case "grep":
    case "search":
    case "find":
    case "glob":
      return "search";
    case "bash":
    case "terminal":
    case "sh":
    case "zsh":
    case "exec":
      return "terminal";
    case "web":
    case "web_search":
    case "web_fetch":
    case "browser":
    case "fetch":
      return "web";
    case "task":
    case "subagent":
      return "task";
    default:
      return "other";
  }
}

/**
 * Computes a deterministic stable key for the top-level activity group based on the first member ID.
 */
export function computeActivityGroupKey(firstMessageId: string): string {
  return `group:${firstMessageId}`;
}

/**
 * Computes a stable key for a category subgroup.
 */
export function computeSubgroupKey(firstMessageId: string, category: OmpToolCategory): string {
  return `subgroup:${category}:${firstMessageId}`;
}

/**
 * Derives the elapsed duration from valid timestamps of member messages.
 * Returns undefined if timestamps are missing, invalid, or decreasing.
 */
export function calculateGroupDuration(
  messages: readonly TranscriptEntryMessage[],
): ActivityGroupDuration | undefined {
  if (messages.length === 0) return undefined;
  const first = messages[0];
  const last = messages[messages.length - 1];
  if (!first || !last) return undefined;

  const startRaw = first.timestamp;
  const endRaw = last.timestamp;
  if (!startRaw || !endRaw) return undefined;

  const startTime = Date.parse(startRaw);
  const endTime = Date.parse(endRaw);
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime < startTime) {
    return undefined;
  }

  const durationMs = endTime - startTime;
  return {
    durationMs,
    formattedDuration: formatGroupDuration(durationMs),
  };
}

/**
 * Formats duration in milliseconds into a concise human-readable string.
 */
export function formatGroupDuration(durationMs: number): string {
  if (durationMs < 1000) {
    return `${(durationMs / 1000).toFixed(1)}s`;
  }
  if (durationMs < 60_000) {
    return `${(durationMs / 1000).toFixed(1)}s`;
  }
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.floor((durationMs % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/**
 * Resolves a concise single-message label if available.
 */
function getSingleToolTitle(entry: TranscriptEntryMessage): string | undefined {
  if (entry.toolTitle) return entry.toolTitle;
  if (entry.toolName === "read" && entry.readTarget) {
    return `Read: ${entry.readTarget}`;
  }
  return undefined;
}

/**
 * Returns concise activity labels when a group is actively running.
 */
export function getCategoryActivityLabel(
  category: OmpToolCategory,
  count: number,
  singleTitle?: string,
): string {
  if (count === 1 && singleTitle) {
    return singleTitle;
  }
  switch (category) {
    case "read":
      return count === 1 ? "Reading file..." : `Reading ${count} files...`;
    case "edit":
      return count === 1 ? "Editing file..." : `Editing ${count} files...`;
    case "search":
      return count === 1 ? "Searching..." : `Searching ${count} queries...`;
    case "terminal":
      return count === 1 ? "Running command..." : `Running ${count} commands...`;
    case "web":
      return count === 1 ? "Browsing web..." : `Browsing ${count} pages...`;
    case "task":
      return count === 1 ? "Running task..." : `Running ${count} tasks...`;
    case "other":
      return count === 1 ? "Running tool..." : `Running ${count} tools...`;
  }
}

/**
 * Returns concise outcome labels when a group has completed.
 */
export function getCategoryOutcomeLabel(
  category: OmpToolCategory,
  count: number,
  singleTitle?: string,
): string {
  if (count === 1 && singleTitle) {
    return singleTitle;
  }
  switch (category) {
    case "read":
      return count === 1 ? "Read file" : `Read ${count} files`;
    case "edit":
      return count === 1 ? "Edited file" : `Edited ${count} files`;
    case "search":
      return count === 1 ? "Searched" : `Searched ${count} queries`;
    case "terminal":
      return count === 1 ? "Ran command" : `Ran ${count} commands`;
    case "web":
      return count === 1 ? "Browsed web" : `Browsed ${count} pages`;
    case "task":
      return count === 1 ? "Completed task" : `Completed ${count} tasks`;
    case "other":
      return count === 1 ? "Completed tool" : `Completed ${count} tools`;
  }
}

/**
 * Formats the summary text for a category subgroup.
 */
export function formatSubgroupSummary(
  category: OmpToolCategory,
  messages: readonly TranscriptEntryMessage[],
  state: ActivityGroupAggregateState,
): string {
  const count = messages.length;
  const first = messages[0];
  const singleTitle = count === 1 && first ? getSingleToolTitle(first) : undefined;
  if (state === "running") {
    return getCategoryActivityLabel(category, count, singleTitle);
  }
  return getCategoryOutcomeLabel(category, count, singleTitle);
}

/**
 * Formats the summary text for the outer activity group.
 */
export function formatOuterGroupSummary(
  subgroups: readonly ActivityCategorySubgroup[],
  _state: ActivityGroupAggregateState,
): string {
  if (subgroups.length === 0) return "No activity";
  if (subgroups.length === 1) {
    const first = subgroups[0];
    return first ? first.summary : "Activity";
  }
  return subgroups.map((sg) => sg.summary).join(" · ");
}

/**
 * Determines the aggregate lifecycle state of an activity group or subgroup.
 * Precedence:
 * 1. Explicit error on any member -> "error"
 * 2. Explicit cancellation context on active group -> "canceled"
 * 3. Explicit waiting context on active group -> "waiting"
 * 4. Any member running/streaming -> "running"
 * 5. Default -> "success"
 */
export function deriveAggregateLifecycle(
  messages: readonly TranscriptEntryMessage[],
  isTrailing: boolean,
  context?: TranscriptGroupingContext,
): ActivityGroupAggregateState {
  if (messages.some((m) => m.lifecycle?.state === "error")) {
    return "error";
  }

  const isRunning = messages.some((m) => m.lifecycle?.state === "running" || m.streaming);

  if (isTrailing && isRunning) {
    if (context?.canceled) {
      return "canceled";
    }
    if (context?.waiting || context?.activeAskRequest || context?.sessionStatus === "waiting") {
      return "waiting";
    }
  }

  if (isRunning) {
    return "running";
  }

  return "success";
}

interface MutableSubgroupAccumulator {
  category: OmpToolCategory;
  messages: TranscriptEntryMessage[];
}

interface MutableOuterGroupAccumulator {
  messages: TranscriptEntryMessage[];
  subgroups: MutableSubgroupAccumulator[];
}

function finalizeSubgroup(
  subgroup: MutableSubgroupAccumulator,
  isTrailing: boolean,
  context?: TranscriptGroupingContext,
): ActivityCategorySubgroup {
  const first = subgroup.messages[0];
  const firstMessageId = first ? first.id : "empty";
  const key = computeSubgroupKey(firstMessageId, subgroup.category);
  const aggregateState = deriveAggregateLifecycle(subgroup.messages, isTrailing, context);
  const summary = formatSubgroupSummary(subgroup.category, subgroup.messages, aggregateState);
  const duration = calculateGroupDuration(subgroup.messages);
  const hasExplicitLifecycle = subgroup.messages.some((m) => m.lifecycle !== undefined);

  return {
    key,
    category: subgroup.category,
    summary,
    aggregateState,
    ...(duration !== undefined ? { duration } : {}),
    messages: subgroup.messages,
    hasExplicitLifecycle,
  };
}

function finalizeOuterGroupItem(
  outer: MutableOuterGroupAccumulator,
  isTrailing: boolean,
  context?: TranscriptGroupingContext,
): TranscriptDisplayItem {
  const first = outer.messages[0];
  const firstMessageId = first ? first.id : "empty";
  const key = computeActivityGroupKey(firstMessageId);
  const aggregateState = deriveAggregateLifecycle(outer.messages, isTrailing, context);
  const duration = calculateGroupDuration(outer.messages);
  const hasExplicitLifecycle = outer.messages.some((m) => m.lifecycle !== undefined);

  const finalizedSubgroups: ActivityCategorySubgroup[] = outer.subgroups.map((sg, idx) =>
    finalizeSubgroup(sg, isTrailing && idx === outer.subgroups.length - 1, context),
  );

  const summary = formatOuterGroupSummary(finalizedSubgroups, aggregateState);

  return {
    kind: "group",
    key,
    summary,
    aggregateState,
    ...(duration !== undefined ? { duration } : {}),
    messages: outer.messages,
    subgroups: finalizedSubgroups,
    hasExplicitLifecycle,
  };
}

/**
 * Derives pure display items from ordered transcript messages.
 * Consecutive eligible tool messages form a single outer activity group with ordered category subgroups.
 * Non-tool messages (user, assistant, system) and explicit error tool entries split outer groups.
 */
export function deriveTranscriptDisplayItems(
  messages: readonly TranscriptEntryMessage[],
  context?: TranscriptGroupingContext,
): TranscriptDisplayItem[] {
  const displayItems: TranscriptDisplayItem[] = [];
  let currentOuterGroup: MutableOuterGroupAccumulator | null = null;

  for (let i = 0; i < messages.length; i++) {
    const entry = messages[i];
    if (!entry) continue;

    // Ignore empty non-tool messages
    if (!entry.text && entry.role !== "tool") {
      continue;
    }

    if (entry.role !== "tool") {
      if (currentOuterGroup) {
        displayItems.push(finalizeOuterGroupItem(currentOuterGroup, false, context));
        currentOuterGroup = null;
      }
      displayItems.push({
        kind: "message",
        key: entry.id,
        message: entry,
      });
      continue;
    }

    // Role is "tool"
    const category = getToolCategory(entry.toolName);
    const isError = entry.lifecycle?.state === "error";

    if (isError) {
      if (currentOuterGroup) {
        displayItems.push(finalizeOuterGroupItem(currentOuterGroup, false, context));
        currentOuterGroup = null;
      }
      // Error entry forms its own elevated outer boundary group
      displayItems.push(
        finalizeOuterGroupItem(
          {
            messages: [entry],
            subgroups: [{ category, messages: [entry] }],
          },
          i === messages.length - 1,
          context,
        ),
      );
      continue;
    }

    if (currentOuterGroup) {
      currentOuterGroup.messages.push(entry);
      const lastSubgroup = currentOuterGroup.subgroups[currentOuterGroup.subgroups.length - 1];
      if (lastSubgroup && lastSubgroup.category === category) {
        lastSubgroup.messages.push(entry);
      } else {
        currentOuterGroup.subgroups.push({ category, messages: [entry] });
      }
    } else {
      currentOuterGroup = {
        messages: [entry],
        subgroups: [{ category, messages: [entry] }],
      };
    }
  }

  if (currentOuterGroup) {
    displayItems.push(finalizeOuterGroupItem(currentOuterGroup, true, context));
  }

  return displayItems;
}
