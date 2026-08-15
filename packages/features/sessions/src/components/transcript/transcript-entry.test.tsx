import type { AskRequest, Session } from "@omp-remote/protocol";
import type * as ReactModule from "react";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard, type DashboardProps } from "../dashboard.js";
import { MessageScrollerItem } from "../ui/message-scroller.js";
import { TranscriptCodeBlock } from "./code-block.js";
import { formatToolTextPreview, ToolTranscriptText } from "./tool-transcript.js";
import { renderTranscriptMessageItems, TranscriptEntry } from "./transcript-entry.js";

const reactHarness = vi.hoisted(() => ({
  effectsEnabled: true,
  effectIndex: 0,
  effectValues: [] as {
    cleanup?: () => void;
    dependencies: readonly unknown[] | undefined;
  }[],
  lifecycleEffects: false,
  isMobile: false,
  stateIndex: 0,
  refIndex: 0,
  refValues: [] as { current: unknown }[],
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

interface RenderedNode {
  className?: string;
  open?: boolean;
  props?: Record<string, unknown>;
  type?: unknown;
  text: string;
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

  const rawChildren = element.props?.children as ReactNode;
  const childGroups = (Array.isArray(rawChildren) ? rawChildren : [rawChildren]).map(renderTranscriptNodes);
  const childText = childGroups.map((children) => children[0]?.text ?? "").join("");

  return [
    {
      type: typeof element.type === "string" ? element.type : undefined,
      ...(typeof element.props?.className === "string" ? { className: element.props.className } : {}),
      ...(typeof element.props?.open === "boolean" ? { open: element.props.open } : {}),
      props: element.props,
      text: childText,
    },
    ...childGroups.flat(),
  ];
}

function renderToolTranscriptWithHooks(
  entry: Session["messages"][number],
  preserveState = false,
): RenderedNode[] {
  if (!preserveState) {
    cleanupReactHarnessEffects();
    reactHarness.refValues = [];
    reactHarness.stateValues = [];
  }
  reactHarness.effectIndex = 0;
  reactHarness.refIndex = 0;
  reactHarness.stateIndex = 0;
  return renderTranscriptNodes(ToolTranscriptText({ entry }));
}

type ControlledDashboardProps = DashboardProps & {
  selectedSessionId: string | null;
  onSelectedSessionChange(sessionId: string): void;
};

const DASHBOARD_DEFAULTS = {
  askRequests: [] as AskRequest[],
  savedWorkingDirectories: [] as string[],
  onEnableNotifications: vi.fn().mockResolvedValue(undefined),
  onLaunch: vi.fn().mockResolvedValue("created-session"),
  onSaveWorkingDirectory: vi.fn().mockResolvedValue(undefined),
  onRemoveWorkingDirectory: vi.fn().mockResolvedValue(undefined),
  onCommand: vi.fn().mockResolvedValue(undefined),
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

describe("TranscriptCodeBlock", () => {
  it("renders code as a closed disclosure by default", () => {
    const block = TranscriptCodeBlock({ code: "const ready = true;", language: "ts" });
    const nodes = renderTranscriptNodes(block);
    const frame = nodes.find((node) => node.className?.includes("transcript-disclosure-frame code-block"));
    const trigger = nodes.find((node) => node.className === "transcript-disclosure-trigger");
    const icon = nodes.find((node) => node.className === "transcript-disclosure-icon");

    expect(frame).toBeDefined();
    expect(frame?.props?.["data-state"]).toBe("closed");
    expect(trigger).toBeDefined();
    expect(icon?.props?.["data-category"]).toBe("code");
  });
});

describe("Bash title rendering", () => {
  it("renders only exact Bash titles with command token spans and keeps output neutral", () => {
    const title = 'Bash: echo "title" && cat --raw';
    const nodes = renderTranscriptNodes(
      ToolTranscriptText({
        entry: {
          id: "bash-title",
          role: "tool",
          toolName: "bash",
          toolTitle: title,
          text: "output remains neutral",
          timestamp: "2026-07-29T12:00:00.000Z",
          streaming: false,
          presentation: "text",
        },
      }),
    );
    const commandTitle = nodes.find((node) => node.className === "transcript-command-title");
    const toolName = nodes.find(
      (node) => node.className === "transcript-tool-name transcript-tool-name-bash",
    );
    const commandSpans = nodes.filter((node) => node.className?.includes("transcript-command-token-"));
    const output = nodes.find((node) => node.className === "transcript-disclosure-text");

    expect(textContent(commandTitle?.props?.children as ReactNode)).toBe(title);
    expect(commandSpans.map(({ className, text }) => ({ className, text }))).toEqual([
      {
        className: "transcript-command-token transcript-command-token-word",
        text: "echo",
      },
      {
        className: "transcript-command-token transcript-command-token-string",
        text: '"title"',
      },
      {
        className: "transcript-command-token transcript-command-token-operator",
        text: "&&",
      },
      {
        className: "transcript-command-token transcript-command-token-word",
        text: "cat",
      },
      {
        className: "transcript-command-token transcript-command-token-option",
        text: "--raw",
      },
    ]);
    expect(toolName?.props?.children).toBe("Bash");
    expect(output?.text).toBe("output remains neutral");
  });

  it.each([
    ["Bash: ", "Bash: "],
    ["Bash: \n\t  ", "Bash: \n\t  "],
    ["Bash: invalid 'string", "Bash: invalid 'string"],
    ["Bash: unfinished \\", "Bash: unfinished \\"],
  ])("keeps incomplete and whitespace titles completely literal: %j", (title, expected) => {
    const nodes = renderTranscriptNodes(
      ToolTranscriptText({
        entry: {
          id: `bash-literal-${title}`,
          role: "tool",
          toolName: "bash",
          toolTitle: title,
          text: "output",
          timestamp: "2026-07-29T12:00:00.000Z",
          streaming: false,
          presentation: "text",
        },
      }),
    );
    const commandTitle = nodes.find((node) => node.className === "transcript-command-title");

    expect(textContent(commandTitle?.props?.children as ReactNode)).toBe(expected);
    expect(nodes.some((node) => node.className?.includes("transcript-command-token-"))).toBe(false);
  });
});

describe("structured transcript presentation", () => {
  it("omits empty assistant entries while retaining empty tool disclosures", () => {
    expect(
      TranscriptEntry({
        entry: {
          id: "empty-assistant",
          role: "assistant",
          text: "",
          timestamp: "2026-07-29T12:00:00.000Z",
          streaming: false,
          presentation: "text",
        },
      }),
    ).toBeNull();

    const nodes = renderTranscriptNodes(
      TranscriptEntry({
        entry: {
          id: "empty-tool-result",
          role: "tool",
          text: "",
          timestamp: "2026-07-29T12:00:00.000Z",
          streaming: true,
          presentation: "text",
        },
      }),
    );

    expect(nodes.some((node) => node.type === "article")).toBe(true);
    expect(nodes.find((node) => node.className === "transcript-disclosure-text")?.text).toBe(
      "No tool output",
    );
  });

  it("renders a canonical numbered edit diff with tool identity", () => {
    const nodes = renderTranscriptNodes(
      TranscriptEntry({
        entry: {
          id: "edit-result-1",
          role: "tool",
          text: "-1|before\n+1|after",
          timestamp: "2026-07-29T12:00:00.000Z",
          streaming: false,
          presentation: "diff",
          toolName: "edit",
        },
      }),
    );

    const authorNode = nodes.find(
      (node) => node.className === "transcript-disclosure-title" || node.className === "message-author",
    );
    expect({
      author: authorNode?.text,
      diffRows: nodes
        .filter((node) => node.className?.startsWith("diff-line diff-"))
        .map(({ className, text }) => ({ className, text })),
    }).toEqual({
      author: "edit",
      diffRows: [
        { className: "diff-line diff-removed", text: "-1|before" },
        { className: "diff-line diff-added", text: "+1|after" },
      ],
    });
  });

  it("linkifies assistant and user prose without expanding other Markdown", () => {
    const renderMessage = (role: "assistant" | "user") =>
      renderTranscriptNodes(
        TranscriptEntry({
          entry: {
            id: `${role}-url`,
            role,
            text: `See https://${role}.example/docs and **literal**.`,
            timestamp: "2026-07-29T12:00:00.000Z",
            streaming: false,
            presentation: "text",
          },
        }),
      );

    expect(
      renderMessage("assistant")
        .filter((node) => node.type === "a")
        .map((node) => node.props?.href),
    ).toEqual(["https://assistant.example/docs"]);
    expect(
      renderMessage("user")
        .filter((node) => node.type === "a")
        .map((node) => node.props?.href),
    ).toEqual(["https://user.example/docs"]);
  });
});

describe("dashboard Read transcript", () => {
  it("renders adjacent Reads as separate rows before the assistant message", () => {
    const readMessages: Session["messages"] = [
      {
        id: "dashboard-read-a",
        role: "tool",
        toolName: "read",
        readTarget: "/work/omp-remote/src/a.ts:1-10",
        text: "alpha dashboard contents",
        timestamp: "2026-07-31T12:00:00.000Z",
        streaming: false,
        presentation: "text",
      },
      {
        id: "dashboard-read-b",
        role: "tool",
        toolName: "read",
        readTarget: "/work/omp-remote/src/b.ts:raw",
        text: "beta dashboard contents",
        timestamp: "2026-07-31T12:00:01.000Z",
        streaming: false,
        presentation: "text",
      },
      {
        id: "dashboard-assistant",
        role: "assistant",
        text: "Reads complete",
        timestamp: "2026-07-31T12:00:02.000Z",
        streaming: false,
        presentation: "text",
      },
    ];
    const output = renderControlledDashboard(
      composerDashboardProps({ ...BASE_SESSION, messages: readMessages }),
    );
    const transcript = findElements(output, (element) => element.props.className === "transcript")[0];
    const content = findElements(
      transcript,
      (element) => element.props.className === "transcript-messages",
    )[0];
    const items = Children.toArray(content?.props.children as ReactNode) as ReactElement<
      Record<string, unknown>
    >[];

    expect(items).toHaveLength(3);
    expect(items.map((item) => item.props.messageId)).toEqual([
      "dashboard-read-a",
      "dashboard-read-b",
      "dashboard-assistant",
    ]);
  });
});

describe("ToolTranscriptText", () => {
  it("renders the last ten output lines in a closed disclosure", () => {
    const text = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n");
    const entry = {
      id: "tool-1",
      role: "tool" as const,
      toolName: "bash",
      toolTitle: "Bash: pnpm test",
      text,
      timestamp: "2026-07-29T12:00:00.000Z",
      streaming: false,
      presentation: "text" as const,
    };
    const block = ToolTranscriptText({ entry });
    const nodes = renderTranscriptNodes(block);

    expect(formatToolTextPreview(`${text}\n`)).toBe(
      Array.from({ length: 10 }, (_, index) => `line ${index + 3}`).join("\n"),
    );
    const frame = nodes.find((node) => node.className?.includes("transcript-disclosure-frame"));
    expect(frame?.props?.["data-state"]).toBe("closed");
    expect(frame?.className).toContain("tool-message-disclosure");
    expect(frame?.className).toContain("transcript-disclosure-frame");
    expect(frame?.className).toContain("tool-output-disclosure");
    expect(nodes.some((node) => node.className === "transcript-disclosure-trigger")).toBe(true);
    expect(nodes.find((node) => node.className === "tool-output-divider")?.text).toBe("Output");
    const commandTitle = nodes.find((node) => node.className === "transcript-command-title");
    expect(textContent(commandTitle?.props?.children as ReactNode)).toBe("Bash: pnpm test");
    expect(nodes.findIndex((node) => node.className === "tool-output-divider")).toBeLessThan(
      nodes.findIndex((node) => node.className === "transcript-disclosure-text"),
    );
    expect(nodes.find((node) => node.className === "transcript-disclosure-text")?.text).toBe(
      formatToolTextPreview(text),
    );
  });

  it("keeps short markdown-like generic output literal without disclosure controls", () => {
    const text = "# Heading\n**bold** and [docs](https://example.com)\n- item";
    const disclosure = ToolTranscriptText({
      entry: {
        id: "tool-raw-text",
        role: "tool",
        toolName: "bash",
        text,
        timestamp: "2026-07-29T12:00:00.000Z",
        streaming: false,
        presentation: "text",
      },
    });
    const nodes = renderTranscriptNodes(disclosure);
    const previewContent = nodes.find(
      (node) =>
        node.className === "transcript-disclosure-content" && node.props?.["data-variant"] === "thumbnail",
    );
    const expandedContent = nodes.find(
      (node) =>
        node.className === "transcript-disclosure-content" && node.props?.["data-variant"] === "expanded",
    );

    expect(previewContent?.props?.["data-variant"]).toBe("thumbnail");
    expect(expandedContent).toBeUndefined();
    expect(previewContent?.text).toBe(text);
    expect(nodes.some((node) => node.type === "strong")).toBe(false);
    expect(nodes.filter((node) => node.type === "a").map((node) => node.props?.href)).toEqual([
      "https://example.com",
    ]);
    expect(nodes.some((node) => node.className === "transcript-disclosure-trigger")).toBe(false);
  });

  it("renders every HTTPS image as an unlinked thumbnail and exact-source expanded link in order", () => {
    const firstSource = "https://cdn.example/first.png?size=small#preview";
    const secondSource = "https://cdn.example/second.webp";
    const text = `before ![First diagram](${firstSource}) between ![Second chart](${secondSource}) after`;
    const disclosure = ToolTranscriptText({
      entry: {
        id: "tool-images",
        role: "tool",
        toolName: "bash",
        text,
        timestamp: "2026-07-29T12:00:00.000Z",
        streaming: false,
        presentation: "text",
      },
    });
    const nodes = renderTranscriptNodes(disclosure);
    const thumbnail = nodes.find(
      (node) =>
        node.className === "transcript-disclosure-content" && node.props?.["data-variant"] === "thumbnail",
    );
    const expanded = nodes.find(
      (node) =>
        node.className === "transcript-disclosure-content" && node.props?.["data-variant"] === "expanded",
    );
    const thumbnailImages = nodes.filter((node) => node.type === "img").slice(0, 2);
    const expandedImages = nodes.filter((node) => node.type === "img").slice(2, 4);
    const expandedLinks = nodes.filter((node) => node.className === "disclosure-image-link");

    expect(thumbnail?.props?.["data-variant"]).toBe("thumbnail");
    expect(expanded?.props?.["data-variant"]).toBe("expanded");
    expect(nodes.filter((node) => node.className === "disclosure-image")).toHaveLength(4);
    expect(nodes.filter((node) => node.type === "a").map((node) => node.props?.href)).toEqual([
      firstSource,
      secondSource,
    ]);
    expect(thumbnailImages.map((node) => node.props?.src)).toEqual([firstSource, secondSource]);
    expect(expandedImages.map((node) => node.props?.src)).toEqual([firstSource, secondSource]);
    expect(
      [...thumbnailImages, ...expandedImages].map((node) => ({
        decoding: node.props?.decoding,
        loading: node.props?.loading,
        referrerPolicy: node.props?.referrerPolicy,
      })),
    ).toEqual(
      Array.from({ length: 4 }, () => ({
        decoding: "async",
        loading: "lazy",
        referrerPolicy: "no-referrer",
      })),
    );
    expect(
      expandedLinks.map((node) => ({
        href: node.props?.href,
        rel: node.props?.rel,
        target: node.props?.target,
      })),
    ).toEqual([
      { href: firstSource, rel: "noreferrer", target: "_blank" },
      { href: secondSource, rel: "noreferrer", target: "_blank" },
    ]);
    expect(
      nodes
        .filter(
          (node) =>
            node.className === "transcript-disclosure-text" || node.className === "disclosure-image-link",
        )
        .slice(1)
        .map((node) =>
          node.className === "transcript-disclosure-text"
            ? { kind: "text", value: node.text }
            : { kind: "image", value: node.props?.href },
        ),
    ).toEqual([
      { kind: "text", value: "before " },
      { kind: "image", value: firstSource },
      { kind: "text", value: " between " },
      { kind: "image", value: secondSource },
      { kind: "text", value: " after" },
    ]);
  });
});
describe("renderTranscriptMessageItems", () => {
  it("renders adjacent tools as separate sequential scroller items", () => {
    const messages: Session["messages"] = [
      {
        id: "read-1",
        role: "tool",
        toolName: "read",
        readTarget: "src/a.ts",
        text: "content of a",
        timestamp: "2026-08-14T12:00:00.000Z",
        streaming: false,
        presentation: "text",
      },
      {
        id: "read-2",
        role: "tool",
        toolName: "read",
        readTarget: "src/b.ts",
        text: "content of b",
        timestamp: "2026-08-14T12:00:01.000Z",
        streaming: false,
        presentation: "text",
      },
    ];

    const items = renderTranscriptMessageItems({ messages });

    expect(items).toHaveLength(2);
    expect(items.map((item) => item?.key)).toEqual(["read-1", "read-2"]);
    expect(items.map((item) => item?.props.messageId)).toEqual(["read-1", "read-2"]);
  });

  it("preserves message order and user scroll anchors", () => {
    const messages: Session["messages"] = [
      {
        id: "user-msg",
        role: "user",
        text: "Check the status",
        timestamp: "2026-08-14T12:00:00.000Z",
        streaming: false,
        presentation: "text",
      },
      {
        id: "read-1",
        role: "tool",
        toolName: "read",
        text: "done",
        timestamp: "2026-08-14T12:00:01.000Z",
        streaming: false,
        presentation: "text",
      },
      {
        id: "assistant-msg",
        role: "assistant",
        text: "All clear.",
        timestamp: "2026-08-14T12:00:02.000Z",
        streaming: false,
        presentation: "text",
      },
    ];

    const items = renderTranscriptMessageItems({ messages });

    expect(items.map((item) => item?.key)).toEqual(["user-msg", "read-1", "assistant-msg"]);
    expect(items.map((item) => item?.props.scrollAnchor)).toEqual([true, false, false]);
  });
});
