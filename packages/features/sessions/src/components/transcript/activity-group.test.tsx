import type * as ReactModule from "react";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type ActivityGroupData, TranscriptActivityGroup } from "./activity-group.js";
import { CollapsibleContent } from "../ui/collapsible.js";
import type { TranscriptEntryMessage } from "./transcript-grouping.js";

type EffectRecord = { cleanup?: () => void; dependencies: readonly unknown[] | undefined };
const reactHarness = vi.hoisted(() => ({
  effectIndex: 0,
  effectValues: [] as EffectRecord[],
  lifecycleEffects: false,
  refIndex: 0,
  stateIndex: 0,
  stateValues: [] as unknown[],
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>();
  return {
    ...actual,
    useMemo: <T,>(factory: () => T) => factory(),
    useState: <T,>(initial: T | (() => T)) => {
      const index = reactHarness.stateIndex++;
      if (!(index in reactHarness.stateValues))
        reactHarness.stateValues[index] = typeof initial === "function" ? (initial as () => T)() : initial;
      const setValue = (next: T | ((current: T) => T)) => {
        const current = reactHarness.stateValues[index] as T;
        reactHarness.stateValues[index] =
          typeof next === "function" ? (next as (value: T) => T)(current) : next;
      };
      return [reactHarness.stateValues[index] as T, setValue] as const;
    },
  };
});

beforeEach(() => {
  reactHarness.stateIndex = 0;
  reactHarness.stateValues = [];
});

interface RenderedNode {
  className?: string;
  props?: Record<string, unknown>;
  text: string;
  type?: unknown;
}

function renderTranscriptNodes(node: ReactNode): RenderedNode[] {
  if (node === null || node === undefined || typeof node === "boolean") return [];
  if (typeof node === "string" || typeof node === "number") return [{ text: String(node) }];
  if (Array.isArray(node)) return node.flatMap(renderTranscriptNodes);
  if (!isValidElement(node)) return [];

  const element = node as { type: unknown; props: Record<string, unknown> };
  const current: RenderedNode = {
    ...(typeof element.props?.className === "string" ? { className: element.props.className } : {}),
    ...(element.props !== undefined ? { props: element.props } : {}),
    text: "",
    ...(element.type !== undefined ? { type: element.type } : {}),
  };

  const children = element.props?.children as ReactNode;
  const childNodes = children ? renderTranscriptNodes(children) : [];
  current.text = childNodes.map((n) => n.text).join("");
  return [current, ...childNodes];
}

function findElements(
  node: ReactNode,
  predicate: (element: ReactElement<Record<string, unknown>>) => boolean,
): ReactElement<Record<string, unknown>>[] {
  if (node === null || node === undefined || typeof node === "boolean") return [];
  if (Array.isArray(node)) return node.flatMap((child) => findElements(child, predicate));
  if (!isValidElement(node)) return [];

  const element = node as ReactElement<Record<string, unknown>>;
  const matches = predicate(element) ? [element] : [];
  const children = element.props?.children as ReactNode;
  return [...matches, ...findElements(children, predicate)];
}

function makeToolMessage(
  id: string,
  toolName: string,
  overrides: Partial<TranscriptEntryMessage> = {},
): TranscriptEntryMessage {
  return {
    id,
    role: "tool",
    toolName,
    text: `Result of ${id}`,
    timestamp: "2026-08-14T12:00:00.000Z",
    streaming: false,
    presentation: "text",
    ...overrides,
  };
}

describe("TranscriptActivityGroup", () => {
  it("renders running group open by default with running badge", () => {
    const readMessages = [
      makeToolMessage("read-1", "read", { streaming: true }),
      makeToolMessage("read-2", "read", { streaming: true }),
    ];
    const group: ActivityGroupData = {
      key: "group:read-1",
      summary: "Reading 2 files...",
      aggregateState: "running",
      duration: { durationMs: 1500, formattedDuration: "1.5s" },
      messages: readMessages,
      subgroups: [
        {
          key: "subgroup:read:read-1",
          category: "read",
          summary: "Reading 2 files...",
          aggregateState: "running",
          duration: { durationMs: 1500, formattedDuration: "1.5s" },
          messages: readMessages,
          hasExplicitLifecycle: true,
        },
      ],
      hasExplicitLifecycle: true,
    };

    const tree = TranscriptActivityGroup({ group });
    expect(tree.props["data-state"]).toBe("open");
    expect(tree.props["data-aggregate-state"]).toBe("running");

    const nodes = renderTranscriptNodes(tree);
    const badge = nodes.find((n) => n.className?.includes("streaming-badge"));
    expect(badge?.text).toBe("Running");

    const duration = nodes.find((n) => n.className?.includes("transcript-activity-group-duration"));
    expect(duration?.text).toBe("1.5s");
  });

  it("renders completed success group closed by default", () => {
    const readMessages = [makeToolMessage("read-1", "read"), makeToolMessage("read-2", "read")];
    const group: ActivityGroupData = {
      key: "group:read-1",
      summary: "Read 2 files",
      aggregateState: "success",
      duration: { durationMs: 2000, formattedDuration: "2.0s" },
      messages: readMessages,
      subgroups: [
        {
          key: "subgroup:read:read-1",
          category: "read",
          summary: "Read 2 files",
          aggregateState: "success",
          duration: { durationMs: 2000, formattedDuration: "2.0s" },
          messages: readMessages,
          hasExplicitLifecycle: true,
        },
      ],
      hasExplicitLifecycle: true,
    };

    const tree = TranscriptActivityGroup({ group });
    expect(tree.props["data-state"]).toBe("closed");
    expect(tree.props["data-aggregate-state"]).toBe("success");
  });

  it("ensures original member anchors remain mounted when group is collapsed via keepMounted", () => {
    const messages = [
      makeToolMessage("read-a", "read", { text: "File A content" }),
      makeToolMessage("read-b", "read", { text: "File B content" }),
    ];
    const group: ActivityGroupData = {
      key: "group:read-a",
      summary: "Read 2 files",
      aggregateState: "success",
      messages,
      subgroups: [
        {
          key: "subgroup:read:read-a",
          category: "read",
          summary: "Read 2 files",
          aggregateState: "success",
          messages,
          hasExplicitLifecycle: true,
        },
      ],
      hasExplicitLifecycle: true,
    };

    const tree = TranscriptActivityGroup({ group });
    expect(tree.props["data-state"]).toBe("closed");

    // Verify CollapsibleContent has keepMounted=true
    const collapsibleContent = findElements(tree, (el) => el.type === CollapsibleContent)[0];
    expect(collapsibleContent?.props.keepMounted).toBe(true);

    // Verify all member MessageScrollerItem anchors remain present in the tree
    const scrollerItems = findElements(tree, (el) => el.props.messageId !== undefined);
    expect(scrollerItems.map((el) => el.props.messageId)).toEqual(["read-a", "read-b"]);
  });

  it("renders error, waiting, and canceled groups open and elevated", () => {
    const errorMsg = [makeToolMessage("read-err", "read", { lifecycle: { state: "error" } })];
    const errorGroup: ActivityGroupData = {
      key: "group:read-err",
      summary: "Read file",
      aggregateState: "error",
      messages: errorMsg,
      subgroups: [
        {
          key: "subgroup:read:read-err",
          category: "read",
          summary: "Read file",
          aggregateState: "error",
          messages: errorMsg,
          hasExplicitLifecycle: true,
        },
      ],
      hasExplicitLifecycle: true,
    };
    const errorTree = TranscriptActivityGroup({ group: errorGroup });
    expect(errorTree.props["data-state"]).toBe("open");
    expect(errorTree.props.className).toContain("transcript-activity-group-elevated");
    const errorNodes = renderTranscriptNodes(errorTree);
    expect(errorNodes.some((n) => n.className?.includes("error-badge"))).toBe(true);

    reactHarness.stateIndex = 0;
    const waitMsg = [makeToolMessage("bash-1", "bash", { streaming: true })];
    const waitingGroup: ActivityGroupData = {
      key: "group:bash-1",
      summary: "Running command...",
      aggregateState: "waiting",
      messages: waitMsg,
      subgroups: [
        {
          key: "subgroup:terminal:bash-1",
          category: "terminal",
          summary: "Running command...",
          aggregateState: "waiting",
          messages: waitMsg,
          hasExplicitLifecycle: true,
        },
      ],
      hasExplicitLifecycle: true,
    };
    const waitingTree = TranscriptActivityGroup({ group: waitingGroup });
    expect(waitingTree.props["data-state"]).toBe("open");
    expect(waitingTree.props.className).toContain("transcript-activity-group-elevated");
    const waitingNodes = renderTranscriptNodes(waitingTree);
    expect(waitingNodes.some((n) => n.className?.includes("waiting-badge"))).toBe(true);

    reactHarness.stateIndex = 0;
    const cancelMsg = [makeToolMessage("bash-2", "bash", { streaming: true })];
    const canceledGroup: ActivityGroupData = {
      key: "group:bash-2",
      summary: "Running command...",
      aggregateState: "canceled",
      messages: cancelMsg,
      subgroups: [
        {
          key: "subgroup:terminal:bash-2",
          category: "terminal",
          summary: "Running command...",
          aggregateState: "canceled",
          messages: cancelMsg,
          hasExplicitLifecycle: true,
        },
      ],
      hasExplicitLifecycle: true,
    };
    const canceledTree = TranscriptActivityGroup({ group: canceledGroup });
    expect(canceledTree.props["data-state"]).toBe("open");
    expect(canceledTree.props.className).toContain("transcript-activity-group-elevated");
    const canceledNodes = renderTranscriptNodes(canceledTree);
    expect(canceledNodes.some((n) => n.className?.includes("canceled-badge"))).toBe(true);
  });

  it("preserves manual user toggle across updates while mounted", () => {
    const runningMsgs = [makeToolMessage("read-1", "read", { streaming: true })];
    const runningGroup: ActivityGroupData = {
      key: "group:read-1",
      summary: "Reading 1 file...",
      aggregateState: "running",
      messages: runningMsgs,
      subgroups: [
        {
          key: "subgroup:read:read-1",
          category: "read",
          summary: "Reading 1 file...",
          aggregateState: "running",
          messages: runningMsgs,
          hasExplicitLifecycle: true,
        },
      ],
      hasExplicitLifecycle: true,
    };

    // Initial render: running group is open by default
    reactHarness.stateIndex = 0;
    const firstRender = TranscriptActivityGroup({ group: runningGroup });
    expect(firstRender.props["data-state"]).toBe("open");

    // Simulate user toggling the group closed via Collapsible onOpenChange
    const collapsible = firstRender.props.children as ReactElement<Record<string, unknown>>;
    const onOpenChange = collapsible.props.onOpenChange as (open: boolean) => void;
    onOpenChange(false);

    // Re-render with streaming update (new message added to same mounted group)
    reactHarness.stateIndex = 0;
    const updatedMsgs = [
      makeToolMessage("read-1", "read", { streaming: true }),
      makeToolMessage("read-2", "read", { streaming: true }),
    ];
    const updatedRunningGroup: ActivityGroupData = {
      ...runningGroup,
      summary: "Reading 2 files...",
      messages: updatedMsgs,
      subgroups: [
        {
          key: "subgroup:read:read-1",
          category: "read",
          summary: "Reading 2 files...",
          aggregateState: "running",
          messages: updatedMsgs,
          hasExplicitLifecycle: true,
        },
      ],
    };
    const secondRender = TranscriptActivityGroup({ group: updatedRunningGroup });
    // User's manual toggle to close the group is preserved!
    expect(secondRender.props["data-state"]).toBe("closed");
  });

  it("preserves each member message ID as a reachable MessageScrollerItem anchor in exact chronological order across multiple subgroups", () => {
    const readMsgs = [
      makeToolMessage("read-a", "read", { text: "Alpha content" }),
      makeToolMessage("read-b", "read", { text: "Beta content" }),
    ];
    const bashMsgs = [makeToolMessage("bash-a", "bash", { text: "Ran test" })];
    const allMsgs = [...readMsgs, ...bashMsgs];

    const group: ActivityGroupData = {
      key: "group:read-a",
      summary: "Read 2 files · Ran 1 command",
      aggregateState: "success",
      duration: { durationMs: 3000, formattedDuration: "3.0s" },
      messages: allMsgs,
      subgroups: [
        {
          key: "subgroup:read:read-a",
          category: "read",
          summary: "Read 2 files",
          aggregateState: "success",
          duration: { durationMs: 1000, formattedDuration: "1.0s" },
          messages: readMsgs,
          hasExplicitLifecycle: true,
        },
        {
          key: "subgroup:terminal:bash-a",
          category: "terminal",
          summary: "Ran 1 command",
          aggregateState: "success",
          duration: { durationMs: 2000, formattedDuration: "2.0s" },
          messages: bashMsgs,
          hasExplicitLifecycle: true,
        },
      ],
      hasExplicitLifecycle: true,
    };

    const tree = TranscriptActivityGroup({ group });
    const scrollerItems = findElements(tree, (el) => el.props.messageId !== undefined);

    expect(scrollerItems).toHaveLength(3);
    expect(scrollerItems.map((el) => el.props.messageId)).toEqual(["read-a", "read-b", "bash-a"]);
    expect(scrollerItems.every((el) => el.props.scrollAnchor === false)).toBe(true);
  });

  it("includes accessible aria-label on the collapsible trigger", () => {
    const editMsgs = [makeToolMessage("edit-1", "edit"), makeToolMessage("edit-2", "edit")];
    const group: ActivityGroupData = {
      key: "group:edit-1",
      summary: "Edited 2 files",
      aggregateState: "success",
      messages: editMsgs,
      subgroups: [
        {
          key: "subgroup:edit:edit-1",
          category: "edit",
          summary: "Edited 2 files",
          aggregateState: "success",
          messages: editMsgs,
          hasExplicitLifecycle: true,
        },
      ],
      hasExplicitLifecycle: true,
    };

    const tree = TranscriptActivityGroup({ group });
    const triggers = findElements(tree, (el) => typeof el.props["aria-label"] === "string");

    expect(triggers.length).toBeGreaterThanOrEqual(1);
    expect(triggers[0]?.props["aria-label"]).toBe("Edited 2 files (success)");
  });
});
