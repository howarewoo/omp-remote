import type { AskRequest } from "@omp-remote/protocol";
import { describe, expect, it } from "vitest";
import {
  calculateGroupDuration,
  computeActivityGroupKey,
  computeSubgroupKey,
  deriveAggregateLifecycle,
  deriveTranscriptDisplayItems,
  formatGroupDuration,
  formatOuterGroupSummary,
  formatSubgroupSummary,
  getCategoryActivityLabel,
  getCategoryOutcomeLabel,
  getToolCategory,
  type TranscriptEntryMessage,
} from "./transcript-grouping.js";

function makeToolMessage(
  id: string,
  toolName: string,
  overrides: Partial<TranscriptEntryMessage> = {},
): TranscriptEntryMessage {
  return {
    id,
    role: "tool",
    toolName,
    text: `Result for ${id}`,
    timestamp: "2026-08-14T12:00:00.000Z",
    streaming: false,
    presentation: "text",
    ...overrides,
  };
}

const VALID_ASK_REQUEST: AskRequest = {
  sessionId: "session-1",
  requestId: "ask-1",
  kind: "text",
  title: "Allow execution?",
  options: [],
  initialValue: null,
  expiresAt: null,
};

describe("getToolCategory", () => {
  it.each([
    ["read", "read"],
    ["READ", "read"],
    ["edit", "edit"],
    ["write", "edit"],
    ["patch", "edit"],
    ["ast_edit", "edit"],
    ["grep", "search"],
    ["search", "search"],
    ["find", "search"],
    ["glob", "search"],
    ["bash", "terminal"],
    ["terminal", "terminal"],
    ["sh", "terminal"],
    ["zsh", "terminal"],
    ["exec", "terminal"],
    ["web_search", "web"],
    ["browser", "web"],
    ["web_fetch", "web"],
    ["fetch", "web"],
    ["task", "task"],
    ["subagent", "task"],
    ["todo", "other"],
    ["hub", "other"],
    ["yield", "other"],
    ["unknown-tool", "other"],
    [undefined, "other"],
  ] as const)("maps %s to %s category", (toolName, expectedCategory) => {
    expect(getToolCategory(toolName)).toBe(expectedCategory);
  });
});

describe("calculateGroupDuration & formatGroupDuration", () => {
  it("formats millisecond durations concisely", () => {
    expect(formatGroupDuration(0)).toBe("0.0s");
    expect(formatGroupDuration(450)).toBe("0.5s");
    expect(formatGroupDuration(1200)).toBe("1.2s");
    expect(formatGroupDuration(15_400)).toBe("15.4s");
    expect(formatGroupDuration(65_000)).toBe("1m 5s");
    expect(formatGroupDuration(125_000)).toBe("2m 5s");
  });

  it("derives duration from first and last valid message timestamps", () => {
    const messages = [
      makeToolMessage("1", "read", { timestamp: "2026-08-14T12:00:00.000Z" }),
      makeToolMessage("2", "read", { timestamp: "2026-08-14T12:00:01.500Z" }),
      makeToolMessage("3", "read", { timestamp: "2026-08-14T12:00:03.200Z" }),
    ];
    const duration = calculateGroupDuration(messages);
    expect(duration).toEqual({
      durationMs: 3200,
      formattedDuration: "3.2s",
    });
  });

  it("handles single message with zero duration", () => {
    const messages = [makeToolMessage("1", "read", { timestamp: "2026-08-14T12:00:00.000Z" })];
    const duration = calculateGroupDuration(messages);
    expect(duration).toEqual({
      durationMs: 0,
      formattedDuration: "0.0s",
    });
  });

  it("returns undefined for invalid or reversed timestamps", () => {
    expect(calculateGroupDuration([])).toBeUndefined();
    expect(
      calculateGroupDuration([
        makeToolMessage("1", "read", { timestamp: "invalid-time" }),
        makeToolMessage("2", "read", { timestamp: "2026-08-14T12:00:00.000Z" }),
      ]),
    ).toBeUndefined();
    expect(
      calculateGroupDuration([
        makeToolMessage("1", "read", { timestamp: "2026-08-14T12:00:05.000Z" }),
        makeToolMessage("2", "read", { timestamp: "2026-08-14T12:00:01.000Z" }),
      ]),
    ).toBeUndefined();
  });
});

describe("Labels & Summaries", () => {
  it("uses singleToolTitle when single item has explicit title", () => {
    expect(getCategoryOutcomeLabel("read", 1, "Read: src/app.tsx")).toBe("Read: src/app.tsx");
    expect(getCategoryActivityLabel("read", 1, "Read: src/app.tsx")).toBe("Read: src/app.tsx");
  });

  it("uses counts only for repeated ambiguous work", () => {
    expect(getCategoryOutcomeLabel("read", 1)).toBe("Read file");
    expect(getCategoryOutcomeLabel("read", 4)).toBe("Read 4 files");
    expect(getCategoryOutcomeLabel("edit", 2)).toBe("Edited 2 files");
    expect(getCategoryOutcomeLabel("terminal", 3)).toBe("Ran 3 commands");
    expect(getCategoryOutcomeLabel("search", 2)).toBe("Searched 2 queries");
    expect(getCategoryOutcomeLabel("web", 5)).toBe("Browsed 5 pages");
    expect(getCategoryOutcomeLabel("task", 3)).toBe("Completed 3 tasks");
    expect(getCategoryOutcomeLabel("other", 2)).toBe("Completed 2 tools");

    expect(getCategoryActivityLabel("read", 1)).toBe("Reading file...");
    expect(getCategoryActivityLabel("read", 4)).toBe("Reading 4 files...");
    expect(getCategoryActivityLabel("edit", 2)).toBe("Editing 2 files...");
    expect(getCategoryActivityLabel("terminal", 3)).toBe("Running 3 commands...");
  });

  it("formats activity summary appropriately for running vs completed states", () => {
    const singleMsg = [makeToolMessage("1", "read", { toolTitle: "Read: index.ts" })];
    expect(formatSubgroupSummary("read", singleMsg, "running")).toBe("Read: index.ts");
    expect(formatSubgroupSummary("read", singleMsg, "success")).toBe("Read: index.ts");

    const multiMsg = [
      makeToolMessage("1", "read"),
      makeToolMessage("2", "read"),
      makeToolMessage("3", "read"),
    ];
    expect(formatSubgroupSummary("read", multiMsg, "running")).toBe("Reading 3 files...");
    expect(formatSubgroupSummary("read", multiMsg, "success")).toBe("Read 3 files");
  });

  it("formats outer group summary across multiple subgroups", () => {
    const subgroups = [
      {
        key: "subgroup:read:1",
        category: "read" as const,
        summary: "Read 2 files",
        aggregateState: "success" as const,
        messages: [makeToolMessage("1", "read"), makeToolMessage("2", "read")],
        hasExplicitLifecycle: true,
      },
      {
        key: "subgroup:edit:3",
        category: "edit" as const,
        summary: "Edited 1 file",
        aggregateState: "success" as const,
        messages: [makeToolMessage("3", "edit")],
        hasExplicitLifecycle: true,
      },
    ];

    expect(formatOuterGroupSummary(subgroups, "success")).toBe("Read 2 files · Edited 1 file");
  });
});

describe("deriveAggregateLifecycle", () => {
  it("prioritizes explicit error over running or success", () => {
    const messages = [
      makeToolMessage("1", "read", { lifecycle: { state: "success" } }),
      makeToolMessage("2", "read", { lifecycle: { state: "error" } }),
    ];
    expect(deriveAggregateLifecycle(messages, false)).toBe("error");
  });

  it("detects running when any member is running or streaming", () => {
    const runningMessages = [
      makeToolMessage("1", "read", { lifecycle: { state: "success" } }),
      makeToolMessage("2", "read", { lifecycle: { state: "running" }, streaming: true }),
    ];
    expect(deriveAggregateLifecycle(runningMessages, false)).toBe("running");

    const streamingMessages = [makeToolMessage("1", "read", { streaming: true })];
    expect(deriveAggregateLifecycle(streamingMessages, false)).toBe("running");
  });

  it("applies waiting and canceled context to trailing active groups", () => {
    const activeMessages = [
      makeToolMessage("1", "read", { streaming: true, lifecycle: { state: "running" } }),
    ];

    expect(deriveAggregateLifecycle(activeMessages, true, { canceled: true })).toBe("canceled");

    expect(
      deriveAggregateLifecycle(activeMessages, true, {
        activeAskRequest: VALID_ASK_REQUEST,
      }),
    ).toBe("waiting");

    expect(deriveAggregateLifecycle(activeMessages, true, { waiting: true })).toBe("waiting");

    expect(deriveAggregateLifecycle(activeMessages, true, { sessionStatus: "waiting" })).toBe("waiting");
  });

  it("never infers waiting or canceled from disconnect or idle session status", () => {
    const activeMessages = [
      makeToolMessage("1", "read", { streaming: true, lifecycle: { state: "running" } }),
    ];
    expect(deriveAggregateLifecycle(activeMessages, true, { sessionStatus: "disconnected" })).toBe("running");
    expect(deriveAggregateLifecycle(activeMessages, true, { sessionStatus: "idle" })).toBe("running");
  });

  it("returns success for completed non-error members", () => {
    const messages = [
      makeToolMessage("1", "read", { lifecycle: { state: "success" } }),
      makeToolMessage("2", "read", { lifecycle: { state: "success" } }),
    ];
    expect(deriveAggregateLifecycle(messages, false)).toBe("success");
  });

  it("handles legacy messages without fabricated lifecycles", () => {
    const legacyCompleted = [
      makeToolMessage("1", "read", { streaming: false }),
      makeToolMessage("2", "read", { streaming: false }),
    ];
    expect(deriveAggregateLifecycle(legacyCompleted, false)).toBe("success");
  });
});

describe("deriveTranscriptDisplayItems", () => {
  it("derives one outer group across adjacent tool categories with nested category subgroups", () => {
    const messages: TranscriptEntryMessage[] = [
      makeToolMessage("read-1", "read", {
        timestamp: "2026-08-14T12:00:00.000Z",
        readTarget: "src/a.ts",
      }),
      makeToolMessage("read-2", "read", {
        timestamp: "2026-08-14T12:00:01.000Z",
        readTarget: "src/b.ts",
      }),
      makeToolMessage("bash-1", "bash", {
        timestamp: "2026-08-14T12:00:02.000Z",
        toolTitle: "Bash: pnpm test",
      }),
      makeToolMessage("edit-1", "edit", {
        timestamp: "2026-08-14T12:00:03.000Z",
        toolTitle: "Edit: src/app.tsx",
      }),
    ];

    const items = deriveTranscriptDisplayItems(messages);
    expect(items).toHaveLength(1);
    const outerGroup = items[0];
    expect(outerGroup?.kind).toBe("group");
    if (outerGroup?.kind === "group") {
      // Top-level key is derived from the first member message ID
      expect(outerGroup.key).toBe(computeActivityGroupKey("read-1"));
      expect(outerGroup.messages.map((m) => m.id)).toEqual(["read-1", "read-2", "bash-1", "edit-1"]);
      expect(outerGroup.duration).toEqual({ durationMs: 3000, formattedDuration: "3.0s" });

      // Ordered nested category subgroups
      expect(outerGroup.subgroups).toHaveLength(3);
      expect(outerGroup.subgroups[0]?.category).toBe("read");
      expect(outerGroup.subgroups[0]?.key).toBe(computeSubgroupKey("read-1", "read"));
      expect(outerGroup.subgroups[0]?.messages.map((m) => m.id)).toEqual(["read-1", "read-2"]);
      expect(outerGroup.subgroups[0]?.summary).toBe("Read 2 files");

      expect(outerGroup.subgroups[1]?.category).toBe("terminal");
      expect(outerGroup.subgroups[1]?.key).toBe(computeSubgroupKey("bash-1", "terminal"));
      expect(outerGroup.subgroups[1]?.messages.map((m) => m.id)).toEqual(["bash-1"]);
      expect(outerGroup.subgroups[1]?.summary).toBe("Bash: pnpm test");

      expect(outerGroup.subgroups[2]?.category).toBe("edit");
      expect(outerGroup.subgroups[2]?.key).toBe(computeSubgroupKey("edit-1", "edit"));
      expect(outerGroup.subgroups[2]?.messages.map((m) => m.id)).toEqual(["edit-1"]);
      expect(outerGroup.subgroups[2]?.summary).toBe("Edit: src/app.tsx");

      expect(outerGroup.summary).toBe("Read 2 files · Bash: pnpm test · Edit: src/app.tsx");
    }
  });

  it("splits groups on conversational boundaries (user, assistant, system)", () => {
    const messages: TranscriptEntryMessage[] = [
      {
        id: "user-1",
        role: "user",
        text: "Please inspect files",
        timestamp: "2026-08-14T12:00:00.000Z",
        streaming: false,
        presentation: "text",
      },
      makeToolMessage("read-1", "read"),
      makeToolMessage("read-2", "read"),
      {
        id: "assistant-1",
        role: "assistant",
        text: "I found the issue.",
        timestamp: "2026-08-14T12:00:05.000Z",
        streaming: false,
        presentation: "text",
      },
      makeToolMessage("edit-1", "edit"),
      {
        id: "system-1",
        role: "system",
        text: "System notification",
        timestamp: "2026-08-14T12:00:10.000Z",
        streaming: false,
        presentation: "text",
      },
    ];

    const items = deriveTranscriptDisplayItems(messages);
    expect(items.map((item) => item.kind)).toEqual(["message", "group", "message", "group", "message"]);

    expect(items[0]).toMatchObject({ kind: "message", key: "user-1" });
    expect(items[1]).toMatchObject({ kind: "group", key: "group:read-1" });
    expect(items[2]).toMatchObject({ kind: "message", key: "assistant-1" });
    expect(items[3]).toMatchObject({ kind: "group", key: "group:edit-1" });
    expect(items[4]).toMatchObject({ kind: "message", key: "system-1" });
  });

  it("treats explicit tool lifecycle error as a boundary and elevated standalone item", () => {
    const messages: TranscriptEntryMessage[] = [
      makeToolMessage("read-1", "read", { lifecycle: { state: "success" } }),
      makeToolMessage("read-2", "read", { lifecycle: { state: "error" } }),
      makeToolMessage("read-3", "read", { lifecycle: { state: "success" } }),
    ];

    const items = deriveTranscriptDisplayItems(messages);
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({
      kind: "group",
      aggregateState: "success",
    });
    expect(items[1]).toMatchObject({
      kind: "group",
      aggregateState: "error",
    });
    expect(items[2]).toMatchObject({
      kind: "group",
      aggregateState: "success",
    });
  });

  it("computes deterministic keys and ensures live and hydrated input derive equal structures and labels", () => {
    const liveMessages: TranscriptEntryMessage[] = [
      makeToolMessage("t1", "bash", {
        toolTitle: "Bash: pnpm test",
        timestamp: "2026-08-14T12:00:00.000Z",
        lifecycle: { state: "success" },
      }),
      makeToolMessage("t2", "bash", {
        toolTitle: "Bash: pnpm lint",
        timestamp: "2026-08-14T12:00:03.000Z",
        lifecycle: { state: "success" },
      }),
    ];

    const hydratedMessages: TranscriptEntryMessage[] = JSON.parse(JSON.stringify(liveMessages));

    const liveItems = deriveTranscriptDisplayItems(liveMessages);
    const hydratedItems = deriveTranscriptDisplayItems(hydratedMessages);

    expect(liveItems).toEqual(hydratedItems);
    expect(liveItems[0]?.key).toBe(hydratedItems[0]?.key);
    if (liveItems[0]?.kind === "group" && hydratedItems[0]?.kind === "group") {
      expect(liveItems[0].summary).toBe(hydratedItems[0].summary);
      expect(liveItems[0].duration).toEqual(hydratedItems[0].duration);
    }
  });

  it("handles long runs of repeated tools cleanly", () => {
    const messages: TranscriptEntryMessage[] = Array.from({ length: 15 }, (_, index) =>
      makeToolMessage(`read-${index}`, "read", {
        timestamp: `2026-08-14T12:00:${index.toString().padStart(2, "0")}.000Z`,
        lifecycle: { state: "success" },
      }),
    );

    const items = deriveTranscriptDisplayItems(messages);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "group",
      summary: "Read 15 files",
      duration: { durationMs: 14_000, formattedDuration: "14.0s" },
    });
  });
});
