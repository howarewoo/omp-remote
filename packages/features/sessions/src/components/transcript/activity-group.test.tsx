import type * as ReactModule from "react";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type ActivityGroupData, TranscriptActivityGroup } from "./activity-group.js";
import { CollapsibleContent } from "../ui/collapsible.js";
import { MessageScrollerItem } from "../ui/message-scroller.js";
import type { TranscriptEntryMessage } from "./transcript-grouping.js";

type EffectRecord = { cleanup?: () => void; dependencies: readonly unknown[] | undefined };
const reactHarness = vi.hoisted(() => ({
  effectsEnabled: true,
  effectIndex: 0,
  effectValues: [] as EffectRecord[],
  lifecycleEffects: false,
  refIndex: 0,
  refValues: [] as { current: unknown }[],
  stateIndex: 0,
  stateValues: [] as unknown[],
}));

vi.mock("../ui/collapsible.js", () => ({
  Collapsible: ({ children, ...props }: Record<string, unknown> & { children?: ReactNode }) => (
    <div data-slot="collapsible" {...props}>
      {children}
    </div>
  ),
  CollapsibleTrigger: ({ children, ...props }: Record<string, unknown> & { children?: ReactNode }) => (
    <button data-slot="collapsible-trigger" type="button" {...props}>
      {children}
    </button>
  ),
  CollapsibleContent: ({ children, ...props }: Record<string, unknown> & { children?: ReactNode }) => (
    <div data-slot="collapsible-content" {...props}>
      {children}
    </div>
  ),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>();
  return {
    ...actual,
    useCallback: <T extends (...args: never[]) => unknown>(callback: T) => callback,
    useEffect: (
      effect: Parameters<typeof actual.useEffect>[0],
      dependencies?: Parameters<typeof actual.useEffect>[1],
    ) => {
      if (!reactHarness.lifecycleEffects) {
        if (reactHarness.effectsEnabled) void effect();
        return;
      }
      const index = reactHarness.effectIndex++;
      if (!reactHarness.effectsEnabled) return;
      const previous = reactHarness.effectValues[index];
      const changed =
        !previous ||
        dependencies === undefined ||
        previous.dependencies === undefined ||
        dependencies.length !== previous.dependencies.length ||
        dependencies.some(
          (dependency, dependencyIndex) => !Object.is(dependency, previous.dependencies?.[dependencyIndex]),
        );
      if (!changed) return;
      previous?.cleanup?.();
      const cleanup = effect();
      reactHarness.effectValues[index] = {
        ...(typeof cleanup === "function" ? { cleanup } : {}),
        dependencies,
      };
    },
    useLayoutEffect: (effect: Parameters<typeof actual.useLayoutEffect>[0]) => {
      if (reactHarness.effectsEnabled) void effect();
    },
    useMemo: <T,>(factory: () => T) => factory(),
    useRef: <T,>(initial: T) => {
      const index = reactHarness.refIndex++;
      if (!(index in reactHarness.refValues)) reactHarness.refValues[index] = { current: initial };
      return reactHarness.refValues[index] as { current: T };
    },
    useState: <T,>(initial: T | (() => T)) => {
      const index = reactHarness.stateIndex++;
      const stateValues = reactHarness.stateValues;
      if (!(index in stateValues))
        stateValues[index] = typeof initial === "function" ? (initial as () => T)() : initial;
      const setValue = (next: T | ((current: T) => T)) => {
        const current = stateValues[index] as T;
        stateValues[index] = typeof next === "function" ? (next as (value: T) => T)(current) : next;
      };
      return [stateValues[index] as T, setValue] as const;
    },
  };
});

beforeEach(() => {
  reactHarness.effectIndex = 0;
  reactHarness.refIndex = 0;
  reactHarness.stateIndex = 0;
  reactHarness.stateValues = [];
  reactHarness.refValues = [];
  reactHarness.effectValues = [];
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

  const isMessageScroller =
    element.type === MessageScrollerItem ||
    (typeof element.type === "function" &&
      (element.type.name === "MessageScrollerItem" || element.type.name.startsWith("MessageScroller")));

  if (!isMessageScroller) {
    if (typeof element.type === "function") {
      try {
        return renderTranscriptNodes(
          (element.type as (props: Record<string, unknown>) => ReactNode)(element.props),
        );
      } catch {
        // Fall through
      }
    }
    if (
      typeof element.type === "object" &&
      element.type !== null &&
      "type" in element.type &&
      typeof (element.type as { type: unknown }).type === "function"
    ) {
      try {
        return renderTranscriptNodes(
          (element.type as { type: (props: Record<string, unknown>) => ReactNode }).type(element.props),
        );
      } catch {
        // Fall through
      }
    }
    if (
      typeof element.type === "object" &&
      element.type !== null &&
      "render" in element.type &&
      typeof (element.type as { render: unknown }).render === "function"
    ) {
      try {
        return renderTranscriptNodes(
          (element.type as { render: (props: Record<string, unknown>, ref: unknown) => ReactNode }).render(
            element.props,
            null,
          ),
        );
      } catch {
        // Fall through
      }
    }
  }

  if (typeof element.type === "symbol") {
    return renderTranscriptNodes(element.props?.children as ReactNode);
  }

  const current: RenderedNode = {
    ...(typeof element.props?.className === "string" ? { className: element.props.className } : {}),
    ...(element.props !== undefined ? { props: element.props } : {}),
    text: "",
    ...(typeof element.type === "string" ? { type: element.type } : {}),
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

  const element = node as ReactElement<Record<string, unknown> & { children?: ReactNode }>;
  if (
    typeof element.type === "function" &&
    element.type !== MessageScrollerItem &&
    element.type.name !== "MessageScrollerItem"
  ) {
    const matchThis = predicate(element) ? [element] : [];
    try {
      const rendered = (element.type as (props: unknown) => ReactNode)(element.props);
      const renderedMatches = findElements(rendered, predicate);
      return matchThis.length > 0 && renderedMatches.length > 0
        ? renderedMatches
        : [...matchThis, ...renderedMatches];
    } catch {
      return [...matchThis, ...findElements(element.props?.children, predicate)];
    }
  }

  const matches = predicate(element) ? [element] : [];
  return [...matches, ...findElements(element.props?.children, predicate)];
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
    const status = nodes.find((n) => n.className === "transcript-disclosure-status");
    expect(status?.text).toBe("Running");
    const summary = nodes.find((n) => n.className === "transcript-activity-group-summary-text");
    expect(summary?.text).toBe("2 files...");
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

    const nodes = renderTranscriptNodes(tree);
    const summary = nodes.find((n) => n.className === "transcript-activity-group-summary-text");
    expect(summary?.text).toBe("2 files");
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

    const collapsibleContent = findElements(
      tree,
      (el) =>
        el.type === CollapsibleContent ||
        el.props?.["data-slot"] === "collapsible-content" ||
        el.props?.keepMounted === true,
    )[0];
    expect(collapsibleContent?.props.keepMounted).toBe(true);

    const scrollerItems = findElements(tree, (el) => el.props.messageId !== undefined);
    expect(scrollerItems.map((el) => el.props.messageId)).toEqual(["read-a", "read-b"]);
  });

  it("renders error, waiting, and canceled groups open and elevated", () => {
    const errorMsg = [makeToolMessage("read-err", "read", { lifecycle: { state: "error" } })];
    const errorGroup: ActivityGroupData = {
      key: "group:read-err",
      summary: "Read: file",
      aggregateState: "error",
      messages: errorMsg,
      subgroups: [
        {
          key: "subgroup:read:read-err",
          category: "read",
          summary: "Read: file",
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
    const errorStatus = errorNodes.find((n) => n.className === "transcript-disclosure-status");
    expect(errorStatus?.text).toBe("Failed");
    const errorSummary = errorNodes.find((n) => n.className === "transcript-activity-group-summary-text");
    expect(errorSummary?.text).toBe("file");
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
    const waitingStatus = waitingNodes.find((n) => n.className === "transcript-disclosure-status");
    expect(waitingStatus?.text).toBe("Waiting");
    const waitingSummary = waitingNodes.find((n) => n.className === "transcript-activity-group-summary-text");
    expect(waitingSummary?.text).toBe("command...");
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
    const canceledStatus = canceledNodes.find((n) => n.className === "transcript-disclosure-status");
    expect(canceledStatus?.text).toBe("Canceled");
    const canceledSummary = canceledNodes.find(
      (n) => n.className === "transcript-activity-group-summary-text",
    );
    expect(canceledSummary?.text).toBe("command...");
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

    reactHarness.stateIndex = 0;
    const firstRender = TranscriptActivityGroup({ group: runningGroup });
    expect(firstRender.props["data-state"]).toBe("open");

    const disclosure = findElements(firstRender, (el) => typeof el.props?.onOpenChange === "function")[0];
    const onOpenChange = disclosure?.props.onOpenChange as (open: boolean) => void;
    onOpenChange(false);

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
    const nodes = renderTranscriptNodes(tree);
    const trigger = nodes.find(
      (node) =>
        node.className === "transcript-disclosure-trigger" || typeof node.props?.["aria-label"] === "string",
    );

    expect(trigger).toBeDefined();
    expect(trigger?.props?.["aria-label"]).toBe("Edited 2 files (success)");
  });
});
