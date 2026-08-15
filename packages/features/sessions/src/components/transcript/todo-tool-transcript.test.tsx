import type { AskRequest, Session } from "@omp-remote/protocol";
import type * as ReactModule from "react";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard, type DashboardProps } from "../dashboard.js";
import { Drawer } from "../ui/drawer.js";
import { MessageScrollerItem } from "../ui/message-scroller.js";
import { findLatestTodoResult } from "./todo-tool-transcript.js";

const reactHarness = vi.hoisted(() => ({
  effectsEnabled: true,
  effectIndex: 0,
  effectValues: [] as { cleanup?: () => void; dependencies: readonly unknown[] | undefined }[],
  lifecycleEffects: false,
  isMobile: false,
  stateIndex: 0,
  refIndex: 0,
  refValues: [] as { current: unknown }[],
  stateValues: [] as unknown[],
}));
const messageScrollerHarness = vi.hoisted(() => ({ scrollToEnd: vi.fn() }));

vi.mock("../ui/message-scroller.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, useMessageScroller: () => ({ scrollToEnd: messageScrollerHarness.scrollToEnd }) };
});
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>();
  return {
    ...actual,
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
    useCallback: <T extends (...args: never[]) => unknown>(callback: T) => callback,
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
vi.mock("../ui/sidebar.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, useSidebar: () => ({ isMobile: reactHarness.isMobile, setOpenMobile: vi.fn() }) };
});

function cleanupReactHarnessEffects() {
  for (const effect of reactHarness.effectValues) effect.cleanup?.();
  reactHarness.effectIndex = 0;
  reactHarness.effectValues = [];
}
beforeEach(() => {
  if (reactHarness.lifecycleEffects) cleanupReactHarnessEffects();
  Object.assign(reactHarness, {
    effectsEnabled: true,
    effectIndex: 0,
    effectValues: [],
    isMobile: false,
    lifecycleEffects: false,
    refIndex: 0,
    refValues: [],
    stateIndex: 0,
    stateValues: [],
  });
  messageScrollerHarness.scrollToEnd.mockReset();
});

const BASE_SESSION: Session = {
  id: "session-1",
  source: "rpc",
  name: "Bootstrap",
  cwd: "/work/omp-remote",
  branch: "feature/session-header",
  status: "idle",
  connected: true,
  model: "openai/gpt-5.6",
  contextPercent: 12,
  createdAt: "2026-07-28T16:00:00.000Z",
  lastActivity: "2026-07-28T17:00:00.000Z",
  capabilities: ["prompt", "steer", "follow_up", "abort", "resume"],
  messages: [],
  sessionPath: "/work/.omp/session.jsonl",
  activeSubagents: [],
  skillCommands: [],
};
const TODO_RESULT_TEXT =
  'Remaining items (1):\n  - Build custom todo tool interface [in_progress] (Implementation)\nOverall: 2/4 done, 1 open, 1 blocked.\nActive phase 2/3 "Implementation" (0/1) — earliest phase with open work\n  Research:\n    - [X] Locate todo rendering and UI conventions\n    - [X] Define todo interaction contract\n  Implementation:\n    - [ ] Build custom todo tool interface (in progress)\n  Verification:\n    - [ ] Exercise todo flow in browser (blocked: format probe)';

interface RenderedNode {
  className?: string;
  open?: boolean;
  props?: Record<string, unknown>;
  type?: string;
  text: string;
}
function renderTranscriptNodes(node: ReactNode): RenderedNode[] {
  if (node === null || node === undefined || typeof node === "boolean") return [];
  if (typeof node === "string" || typeof node === "number") return [{ text: String(node) }];
  if (Array.isArray(node)) return node.flatMap(renderTranscriptNodes);
  if (!isValidElement(node)) return [];
  const element = node as { type: unknown; props: Record<string, unknown> };
  if (typeof element.type === "function")
    return renderTranscriptNodes(element.type(element.props) as ReactNode);
  if (
    typeof element.type === "object" &&
    element.type !== null &&
    "type" in element.type &&
    typeof element.type.type === "function"
  )
    return renderTranscriptNodes(element.type.type(element.props) as ReactNode);
  if (typeof element.type === "symbol") return renderTranscriptNodes(element.props.children as ReactNode);
  if (typeof element.type !== "string") return [];
  const rawChildren = element.props.children as ReactNode;
  const childGroups = (Array.isArray(rawChildren) ? rawChildren : [rawChildren]).map(renderTranscriptNodes);
  return [
    {
      type: element.type,
      ...(typeof element.props.className === "string" ? { className: element.props.className } : {}),
      ...(typeof element.props.open === "boolean" ? { open: element.props.open } : {}),
      props: element.props,
      text: childGroups.map((children) => children[0]?.text ?? "").join(""),
    },
    ...childGroups.flat(),
  ];
}

type ControlledDashboardProps = DashboardProps & {
  selectedSessionId: string | null;
  onSelectedSessionChange(sessionId: string): void;
};
const DASHBOARD_DEFAULTS = {
  queuedMessages: [],
  askRequests: [] as AskRequest[],
  savedWorkingDirectories: [] as string[],
  onEnableNotifications: vi.fn().mockResolvedValue(undefined),
  onLaunch: vi.fn().mockResolvedValue("created-session"),
  onSaveWorkingDirectory: vi.fn().mockResolvedValue(undefined),
  onRemoveWorkingDirectory: vi.fn().mockResolvedValue(undefined),
  onCommand: vi.fn().mockResolvedValue(undefined),
  onCancelQueuedMessage: vi.fn(),
  onAbort: vi.fn().mockResolvedValue(undefined),
  onKill: vi.fn().mockResolvedValue(undefined),
  onSetModel: vi.fn().mockResolvedValue(undefined),
  onSetEffort: vi.fn().mockResolvedValue(undefined),
  onRespondToAsk: vi.fn().mockResolvedValue(undefined),
  onAskActivity: vi.fn().mockResolvedValue(undefined),
  onSearchHistory: vi.fn().mockResolvedValue(undefined),
  onLoadMoreHistory: vi.fn().mockResolvedValue(undefined),
  onLoadTranscript: vi.fn().mockResolvedValue(undefined),
  onLoadSession: vi.fn().mockResolvedValue(undefined),
  onLoadCost: vi.fn().mockResolvedValue(undefined),
  onLoadSessionBranchTopology: vi.fn().mockResolvedValue({
    sessionId: "session-1",
    currentBranch: "feature/session-header",
    branches: [{ name: "feature/session-header", parent: "main" }, { name: "main" }],
  }),
  onSwitchBranch: vi.fn().mockResolvedValue(undefined),
  onLoadSessionFileChanges: vi.fn().mockResolvedValue({
    sessionId: "session-1",
    state: "available",
    sources: [],
    fileCount: 0,
    operationCount: 0,
    additions: 0,
    deletions: 0,
    changedLines: 0,
    message: null,
  }),
};
function renderControlledDashboard(
  props: ControlledDashboardProps,
  options: { preserveState?: boolean; effectsEnabled?: boolean } = {},
): ReactNode {
  if (!options.preserveState) {
    if (reactHarness.lifecycleEffects) cleanupReactHarnessEffects();
    reactHarness.refValues = [];
    reactHarness.stateValues = [];
  }
  if (reactHarness.lifecycleEffects) reactHarness.effectIndex = 0;
  reactHarness.refIndex = 0;
  reactHarness.stateIndex = 0;
  reactHarness.effectsEnabled = options.effectsEnabled ?? true;
  const dashboard = Dashboard(props) as ReactElement<{ children: ReactElement<ControlledDashboardProps> }>;
  const content = dashboard.props.children;
  return (content.type as (contentProps: ControlledDashboardProps) => ReactNode)(content.props);
}
function findElements(
  node: ReactNode,
  predicate: (element: ReactElement<Record<string, unknown>>) => boolean,
): ReactElement<Record<string, unknown>>[] {
  if (node === null || node === undefined || typeof node === "boolean") return [];
  if (Array.isArray(node)) return node.flatMap((child) => findElements(child, predicate));
  if (!isValidElement(node)) return [];
  const element = node as ReactElement<Record<string, unknown> & { children?: ReactNode }>;
  return [...(predicate(element) ? [element] : []), ...findElements(element.props.children, predicate)];
}
function textContent(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textContent).join("");
  if (!isValidElement(node)) return "";
  return textContent((node as ReactElement<{ children?: ReactNode }>).props.children);
}
function composerDashboardProps(session: Session = BASE_SESSION): ControlledDashboardProps {
  return {
    ...DASHBOARD_DEFAULTS,
    sessions: [session],
    sessionsReady: true,
    historyLoading: false,
    hasMoreHistory: false,
    connection: "connected",
    error: null,
    notificationState: "unsupported",
    selectedSessionId: session.id,
    onSelectedSessionChange: vi.fn(),
  };
}
describe("findLatestTodoResult", () => {
  it("keeps the latest completed canonical result through malformed and streaming tails", () => {
    const latestText = TODO_RESULT_TEXT.replaceAll(
      "Build custom todo tool interface",
      "Verify current Todo tracker",
    );
    const messages: Session["messages"] = [
      {
        id: "todo-older",
        role: "tool",
        toolName: "todo",
        text: TODO_RESULT_TEXT,
        timestamp: "2026-07-29T12:00:00.000Z",
        streaming: false,
        presentation: "text",
      },
      {
        id: "todo-latest",
        role: "tool",
        toolName: "todo",
        text: latestText,
        timestamp: "2026-07-29T12:00:01.000Z",
        streaming: false,
        presentation: "text",
      },
      {
        id: "todo-malformed",
        role: "tool",
        toolName: "todo",
        text: "Overall: almost done.\nArbitrary output",
        timestamp: "2026-07-29T12:00:02.000Z",
        streaming: false,
        presentation: "text",
      },
      {
        id: "todo-streaming",
        role: "tool",
        toolName: "todo",
        text: TODO_RESULT_TEXT,
        timestamp: "2026-07-29T12:00:03.000Z",
        streaming: true,
        presentation: "text",
      },
    ];

    expect(findLatestTodoResult(messages)?.phases[1]?.tasks[0]?.label).toBe("Verify current Todo tracker");
  });

  it("ignores parseable Todo output from a non-tool role", () => {
    const latestToolText = TODO_RESULT_TEXT.replaceAll(
      "Build custom todo tool interface",
      "Use the latest tool-role Todo",
    );
    const spoofedAssistantText = TODO_RESULT_TEXT.replaceAll(
      "Build custom todo tool interface",
      "Ignore this assistant-role Todo",
    );
    const messages: Session["messages"] = [
      {
        id: "todo-tool",
        role: "tool",
        toolName: "todo",
        text: latestToolText,
        timestamp: "2026-07-29T12:00:00.000Z",
        streaming: false,
        presentation: "text",
      },
      {
        id: "todo-assistant",
        role: "assistant",
        toolName: "todo",
        text: spoofedAssistantText,
        timestamp: "2026-07-29T12:00:01.000Z",
        streaming: false,
        presentation: "text",
      },
    ];

    expect(findLatestTodoResult(messages)?.phases[1]?.tasks[0]?.label).toBe("Use the latest tool-role Todo");
  });
});

describe("dashboard current Todo tracker", () => {
  const latestTodoText = TODO_RESULT_TEXT.replaceAll(
    "Build custom todo tool interface",
    "Verify current Todo tracker",
  );
  const messages: Session["messages"] = [
    {
      id: "todo-first",
      role: "tool",
      toolName: "todo",
      text: TODO_RESULT_TEXT,
      timestamp: "2026-07-29T12:00:00.000Z",
      streaming: false,
      presentation: "text",
    },
    {
      id: "assistant-between",
      role: "assistant",
      text: "Continuing with verification.",
      timestamp: "2026-07-29T12:00:01.000Z",
      streaming: false,
      presentation: "text",
    },
    {
      id: "todo-latest",
      role: "tool",
      toolName: "todo",
      text: latestTodoText,
      timestamp: "2026-07-29T12:00:02.000Z",
      streaming: false,
      presentation: "text",
    },
    {
      id: "todo-malformed-tail",
      role: "tool",
      toolName: "todo",
      text: "Overall: almost done.\nArbitrary output",
      timestamp: "2026-07-29T12:00:03.000Z",
      streaming: false,
      presentation: "text",
    },
    {
      id: "todo-streaming-tail",
      role: "tool",
      toolName: "todo",
      text: TODO_RESULT_TEXT,
      timestamp: "2026-07-29T12:00:04.000Z",
      streaming: true,
      presentation: "text",
    },
  ];

  function findTodoDrawer(output: ReactNode) {
    return findElements(
      output,
      (element) =>
        element.type === Drawer && textContent(element.props.children as ReactNode).includes("Current Todo"),
    )[0];
  }

  function openTodoDrawer(output: ReactNode) {
    const tracker = findElements(output, (element) => element.props.className === "todo-tracker-trigger")[0];
    (tracker?.props.onClick as (() => void) | undefined)?.();
  }

  it("shows the latest canonical result while preserving transcript chronology", () => {
    const output = renderControlledDashboard(composerDashboardProps({ ...BASE_SESSION, messages }));
    const tracker = findElements(output, (element) => element.props.className === "todo-tracker-trigger")[0];
    const progress = findElements(tracker, (element) => element.type === "progress")[0];
    const transcript = findElements(output, (element) => element.props.className === "transcript")[0];
    const content = findElements(
      transcript,
      (element) => element.props.className === "transcript-messages",
    )[0];
    const items = Children.toArray(content?.props.children as ReactNode) as ReactElement<
      Record<string, unknown>
    >[];

    expect(tracker?.props["aria-label"]).toBe(
      "Open current Todo: 2 of 4 tasks complete. In progress: Verify current Todo tracker.",
    );
    expect(textContent(tracker?.props.children as ReactNode)).toContain("2/4");
    expect(textContent(tracker?.props.children as ReactNode)).toContain("Verify current Todo tracker");
    expect(progress?.props).toMatchObject({
      "aria-label": "Current Todo progress: 2 of 4 tasks complete",
      max: 4,
      value: 2,
    });

    const displayMessageIds = items.flatMap((item) => {
      const messageId = item?.props?.messageId;
      if (typeof messageId === "string") return [messageId];
      const group = item?.props?.group as { messages: Session["messages"] } | undefined;
      if (group?.messages) {
        return group.messages.map((m) => m.id);
      }
      return [];
    });

    expect(displayMessageIds).toEqual([
      "todo-first",
      "assistant-between",
      "todo-latest",
      "todo-malformed-tail",
      "todo-streaming-tail",
    ]);
  });

  it("opens the full latest Todo in a responsive drawer", () => {
    const props = composerDashboardProps({ ...BASE_SESSION, messages });
    let output = renderControlledDashboard(props);
    openTodoDrawer(output);
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });

    const drawer = findTodoDrawer(output);
    const drawerText = findElements(drawer, (element) => element.props.todo !== undefined)
      .flatMap((element) => renderTranscriptNodes(element))
      .map((node) => node.text)
      .join(" ");

    expect(drawer?.props.open).toBe(true);
    expect(drawer?.props).toMatchObject({ showSwipeHandle: false, swipeDirection: "right" });
    expect(drawerText).toContain("Verify current Todo tracker");
    expect(drawerText).toContain("Locate todo rendering and UI conventions");
    expect(
      findElements(drawer, (element) => {
        const render = element.props.render;
        return (
          isValidElement(render) &&
          (render as ReactElement<Record<string, unknown>>).props["aria-label"] === "Close current Todo"
        );
      }),
    ).toHaveLength(1);
  });

  it("uses a mobile bottom sheet for the current Todo", () => {
    reactHarness.isMobile = true;
    const props = composerDashboardProps({ ...BASE_SESSION, messages });
    let output = renderControlledDashboard(props);
    openTodoDrawer(output);
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });

    expect(findTodoDrawer(output)?.props).toMatchObject({ showSwipeHandle: true, swipeDirection: "down" });
  });

  it("closes an open Todo drawer when the selected session changes", () => {
    const firstSession = { ...BASE_SESSION, messages };
    const secondSession: Session = {
      ...BASE_SESSION,
      id: "session-2",
      name: "Second session",
      messages,
    };
    let props = {
      ...composerDashboardProps(firstSession),
      sessions: [firstSession, secondSession],
    };
    let output = renderControlledDashboard(props);

    openTodoDrawer(output);
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });
    expect(findTodoDrawer(output)?.props.open).toBe(true);

    props = { ...props, selectedSessionId: secondSession.id };
    output = renderControlledDashboard(props, { preserveState: true });

    expect(findTodoDrawer(output)?.props.open).toBe(false);
  });

  it("keeps an open Todo drawer updated for a newer valid result in the same session", () => {
    const session = { ...BASE_SESSION, messages };
    let props = composerDashboardProps(session);
    let output = renderControlledDashboard(props);

    openTodoDrawer(output);
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });
    expect(findTodoDrawer(output)?.props.open).toBe(true);

    const newerText = latestTodoText.replaceAll("Verify current Todo tracker", "Show the newer Todo result");
    props = composerDashboardProps({
      ...session,
      messages: [
        ...messages,
        {
          id: "todo-newer",
          role: "tool",
          toolName: "todo",
          text: newerText,
          timestamp: "2026-07-29T12:00:05.000Z",
          streaming: false,
          presentation: "text",
        },
      ],
    });
    output = renderControlledDashboard(props, { preserveState: true });
    const drawer = findTodoDrawer(output);
    const drawerText = findElements(drawer, (element) => element.props.todo !== undefined)
      .flatMap((element) => renderTranscriptNodes(element))
      .map((node) => node.text)
      .join(" ");

    expect(drawer?.props.open).toBe(true);
    expect(drawerText).toContain("Show the newer Todo result");
  });

  it("clears latent open state when the current Todo disappears", () => {
    const session = { ...BASE_SESSION, messages };
    let props = composerDashboardProps(session);
    let output = renderControlledDashboard(props);

    openTodoDrawer(output);
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });
    expect(findTodoDrawer(output)?.props.open).toBe(true);

    props = composerDashboardProps({ ...session, messages: [] });
    output = renderControlledDashboard(props, { preserveState: true });
    expect(findTodoDrawer(output)?.props.open).toBe(false);

    props = composerDashboardProps(session);
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });
    expect(findTodoDrawer(output)?.props.open).toBe(false);
  });

  it("omits the tracker when the selected session has no canonical Todo", () => {
    const output = renderControlledDashboard(composerDashboardProps());

    expect(
      findElements(output, (element) => element.props.className === "todo-tracker-trigger"),
    ).toHaveLength(0);
    expect(
      findElements(output, (element) => element.type === "dt").map((element) => textContent(element)),
    ).toEqual(["Branch", "Model · Effort", "Context", "Changes", "Cost"]);
  });
});
