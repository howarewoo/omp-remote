import type { AskRequest, Session } from "@omp-remote/protocol";
import type * as ReactModule from "react";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const reactHarness = vi.hoisted(() => ({
  effectsEnabled: true,
  stateIndex: 0,
  refIndex: 0,
  refValues: [] as { current: unknown }[],
  stateValues: [] as unknown[],
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>();
  return {
    ...actual,
    useEffect: (effect: Parameters<typeof actual.useEffect>[0]) => {
      if (reactHarness.effectsEnabled) void effect();
    },
    useLayoutEffect: (effect: Parameters<typeof actual.useLayoutEffect>[0]) => {
      if (reactHarness.effectsEnabled) void effect();
    },
    useMemo: <T>(factory: () => T) => factory(),
    useRef: <T>(initial: T) => {
      const index = reactHarness.refIndex++;
      if (!(index in reactHarness.refValues)) reactHarness.refValues[index] = { current: initial };
      return reactHarness.refValues[index] as { current: T };
    },
    useState: <T>(initial: T | (() => T)) => {
      const index = reactHarness.stateIndex++;
      const stateValues = reactHarness.stateValues;
      if (!(index in stateValues)) {
        stateValues[index] = typeof initial === "function" ? (initial as () => T)() : initial;
      }
      const setValue = (next: T | ((current: T) => T)) => {
        const current = stateValues[index] as T;
        stateValues[index] = typeof next === "function" ? (next as (value: T) => T)(current) : next;
      };
      return [stateValues[index] as T, setValue] as const;
    },
  };
});

vi.mock("./ui/sidebar.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    useSidebar: () => ({ isMobile: false, setOpenMobile: vi.fn() }),
  };
});

beforeEach(() => {
  reactHarness.effectsEnabled = true;
  reactHarness.refIndex = 0;
  reactHarness.refValues = [];
  reactHarness.stateIndex = 0;
  reactHarness.stateValues = [];
});

import {
  canKillSession,
  Dashboard,
  type DashboardProps,
  formatSubagentActivityLabel,
  formatSystemTextPreview,
  formatToolTextPreview,
  getActiveAskRequest,
  getComposerAction,
  getSkillSuggestions,
  groupSessionsByConnection,
  isNearTranscriptBottom,
  parseInlineTranscript,
  parseTranscriptBlocks,
  SystemTranscriptText,
  ToolTranscriptText,
  TranscriptCodeBlock,
  TranscriptEntry,
  tokenizeCode,
} from "./dashboard.js";

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

describe("getComposerAction", () => {
  it("uses the integrated submit control to abort a running session when the composer is blank", () => {
    expect(getComposerAction({ ...BASE_SESSION, status: "running" }, "   ")).toBe("abort");
  });

  it("changes the integrated submit control to steer when the composer contains text", () => {
    expect(getComposerAction({ ...BASE_SESSION, status: "running" }, "Change direction")).toBe("steer");
  });

  it("has no action for blank input when the session cannot be aborted", () => {
    expect(getComposerAction(BASE_SESSION, "")).toBeNull();
    expect(
      getComposerAction(
        {
          ...BASE_SESSION,
          status: "running",
          capabilities: BASE_SESSION.capabilities.filter((capability) => capability !== "abort"),
        },
        "",
      ),
    ).toBeNull();
  });
});

describe("isNearTranscriptBottom", () => {
  it("treats only the final 80 pixels as the live-follow region", () => {
    expect(isNearTranscriptBottom(1_000, 421, 500)).toBe(true);
    expect(isNearTranscriptBottom(1_000, 420, 500)).toBe(false);
  });
});

describe("getSkillSuggestions", () => {
  const skills: Session["skillCommands"] = [
    { name: "skill:seo", description: "Audit search visibility" },
    { name: "skill:woostack-change", description: "Ship a bounded enhancement" },
    { name: "skill:woostack-fix", description: "Diagnose and fix a bug" },
  ];

  it("shows sorted skill commands for an empty slash query", () => {
    expect(getSkillSuggestions("/", skills)).toEqual(skills);
  });

  it.each(["/woo", "/skill:woo"])("filters skills from %s", (message) => {
    expect(getSkillSuggestions(message, skills).map(({ name }) => name)).toEqual([
      "skill:woostack-change",
      "skill:woostack-fix",
    ]);
  });

  it("closes suggestions once command arguments begin", () => {
    expect(getSkillSuggestions("/skill:seo audit this page", skills)).toEqual([]);
  });
});

describe("canKillSession", () => {
  it("allows killing only sessions that advertise the capability", () => {
    expect(canKillSession({ ...BASE_SESSION, capabilities: [...BASE_SESSION.capabilities, "kill"] })).toBe(
      true,
    );
    expect(canKillSession(BASE_SESSION)).toBe(false);
  });
});

describe("groupSessionsByConnection", () => {
  it("lists connected sessions before disconnected sessions while preserving their order", () => {
    const sessions = [
      { ...BASE_SESSION, id: "disconnected-new", connected: false, status: "disconnected" as const },
      { ...BASE_SESSION, id: "connected-new" },
      { ...BASE_SESSION, id: "connected-old" },
      { ...BASE_SESSION, id: "disconnected-old", connected: false, status: "history" as const },
    ];

    expect(groupSessionsByConnection(sessions)).toEqual([
      {
        id: "connected",
        label: "Connected",
        sessions: [sessions[1], sessions[2]],
      },
      {
        id: "disconnected",
        label: "Disconnected",
        sessions: [sessions[0], sessions[3]],
      },
    ]);
  });

  it("omits empty connection sections", () => {
    expect(groupSessionsByConnection([BASE_SESSION])).toEqual([
      {
        id: "connected",
        label: "Connected",
        sessions: [BASE_SESSION],
      },
    ]);
  });
});

describe("formatSubagentActivityLabel", () => {
  it.each([
    [1, "1 subagent running"],
    [3, "3 subagents running"],
  ])("formats %i active subagents", (count, expected) => {
    expect(formatSubagentActivityLabel(count)).toBe(expected);
  });
});

describe("TranscriptCodeBlock", () => {
  it("renders code as a closed disclosure by default", () => {
    const block = TranscriptCodeBlock({ code: "const ready = true;", language: "ts" });

    expect(block.type).toBe("details");
    expect(block.props.open).toBeUndefined();
    expect(block.props.children[0].type).toBe("summary");
  });
});

describe("ToolTranscriptText", () => {
  it("renders the last ten output lines in a closed disclosure", () => {
    const text = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n");
    const entry = {
      id: "tool-1",
      role: "tool" as const,
      toolName: "bash",
      text,
      timestamp: "2026-07-29T12:00:00.000Z",
      streaming: false,
      presentation: "text" as const,
    };
    const block = ToolTranscriptText({ entry });

    expect(formatToolTextPreview(`${text}\n`)).toBe(
      Array.from({ length: 10 }, (_, index) => `line ${index + 3}`).join("\n"),
    );
    expect(block.type).toBe("details");
    expect(block.props.open).toBe(false);
    expect(block.props.children[0].type).toBe("summary");
    expect(block.props.children[0].props.children[1].props.children).toBe(formatToolTextPreview(text));
  });

  it("renders edit output as an open disclosure by default", () => {
    const block = ToolTranscriptText({
      entry: {
        id: "edit-1",
        role: "tool",
        toolName: "edit",
        text: "-1|before\n+1|after",
        timestamp: "2026-07-29T12:00:00.000Z",
        streaming: false,
        presentation: "diff",
      },
    });

    expect(block.props.open).toBe(true);
  });

  it("labels an empty tool result", () => {
    expect(formatToolTextPreview("")).toBe("No tool output");
  });
});

describe("SystemTranscriptText", () => {
  it("renders a truncated preview with a chevron in the closed system header", () => {
    const text = `${"x".repeat(180)}tail`;
    const entry = {
      id: "system-1",
      role: "system" as const,
      text,
      timestamp: "2026-07-29T12:00:00.000Z",
      streaming: false,
      presentation: "text" as const,
    };
    const block = SystemTranscriptText({ entry });

    expect(formatSystemTextPreview(text)).toBe(`${"x".repeat(180)}…`);
    expect(block.type).toBe("details");
    expect(block.props.open).toBeUndefined();
    expect(block.props.children[0].type).toBe("summary");
    expect(block.props.children[0].props.children[1].props.children).toBe(`${"x".repeat(180)}…`);
    expect(
      renderTranscriptNodes(block.props.children[0]).some(
        (node) => node.className === "message-disclosure-chevron",
      ),
    ).toBe(true);
  });

  it.each([
    ["", "System message"],
    ["  Build finished.\nNo errors.  ", "Build finished. No errors."],
  ])("formats the preview for %j", (text, expected) => {
    expect(formatSystemTextPreview(text)).toBe(expected);
  });
});

describe("getActiveAskRequest", () => {
  const requests: AskRequest[] = [
    {
      sessionId: "session-2",
      requestId: "ask-2",
      kind: "select",
      title: "Second session question",
      options: ["Continue", "Stop"],
      initialValue: null,
      expiresAt: null,
    },
    {
      sessionId: "session-1",
      requestId: "ask-1",
      kind: "text",
      title: "Selected session question",
      options: [],
      initialValue: null,
      expiresAt: null,
    },
  ];

  it("prioritizes the selected session without reordering the request queue", () => {
    expect(getActiveAskRequest(requests, "session-1")).toBe(requests[1]);
    expect(requests.map(({ requestId }) => requestId)).toEqual(["ask-2", "ask-1"]);
  });

  it("falls back to the oldest pending request", () => {
    expect(getActiveAskRequest(requests, "missing-session")).toBe(requests[0]);
    expect(getActiveAskRequest([], "session-1")).toBeNull();
  });
});

describe("parseTranscriptBlocks", () => {
  it("marks additions and deletions inside fenced diffs", () => {
    expect(
      parseTranscriptBlocks(
        [
          "Updated the component:",
          "```diff",
          " const stable = true;",
          "-const tone = 'blue';",
          "+const tone = 'green';",
          "```",
        ].join("\n"),
      ),
    ).toEqual([
      { kind: "text", text: "Updated the component:" },
      {
        kind: "diff",
        lines: [
          { kind: "context", text: " const stable = true;" },
          { kind: "removed", text: "-const tone = 'blue';" },
          { kind: "added", text: "+const tone = 'green';" },
        ],
      },
    ]);
  });

  it("keeps unified diff metadata distinct from following prose", () => {
    expect(
      parseTranscriptBlocks(
        [
          "diff --git a/source.ts b/source.ts",
          "--- a/source.ts",
          "+++ b/source.ts",
          "@@ -1 +1 @@",
          "-const before = true;",
          "+const after = true;",
          "Finished.",
        ].join("\n"),
      ),
    ).toEqual([
      {
        kind: "diff",
        lines: [
          { kind: "meta", text: "diff --git a/source.ts b/source.ts" },
          { kind: "meta", text: "--- a/source.ts" },
          { kind: "meta", text: "+++ b/source.ts" },
          { kind: "meta", text: "@@ -1 +1 @@" },
          { kind: "removed", text: "-const before = true;" },
          { kind: "added", text: "+const after = true;" },
        ],
      },
      { kind: "text", text: "Finished." },
    ]);
  });

  it("does not color ordinary prose that starts with plus or minus", () => {
    expect(parseTranscriptBlocks("- Removed clutter\n+ Added clarity")).toEqual([
      { kind: "text", text: "- Removed clutter\n+ Added clarity" },
    ]);
  });

  it("extracts a labeled fenced code block between prose", () => {
    expect(
      parseTranscriptBlocks(
        ["Use this helper:", "```ts", "const tone = 'cyan';", "```", "Then render it."].join("\n"),
      ),
    ).toEqual([
      { kind: "text", text: "Use this helper:" },
      { kind: "code", language: "ts", text: "const tone = 'cyan';" },
      { kind: "text", text: "Then render it." },
    ]);
  });

  it("keeps an unfinished streaming fence as code", () => {
    expect(parseTranscriptBlocks("```\nconst pending = true;")).toEqual([
      { kind: "code", language: null, text: "const pending = true;" },
    ]);
  });

  it("leaves inline backticks in ordinary transcript text", () => {
    expect(parseTranscriptBlocks("Run `pnpm test` next.")).toEqual([
      { kind: "text", text: "Run `pnpm test` next." },
    ]);
  });
});

interface RenderedNode {
  className?: string;
  text: string;
}

function renderTranscriptNodes(node: ReactNode): RenderedNode[] {
  if (node === null || node === undefined || typeof node === "boolean") return [];
  if (typeof node === "string" || typeof node === "number") return [{ text: String(node) }];
  if (Array.isArray(node)) return node.flatMap(renderTranscriptNodes);
  if (!isValidElement(node)) return [];

  const element = node as { type: unknown; props: Record<string, unknown> };
  if (typeof element.type === "function") {
    return renderTranscriptNodes(element.type(element.props) as ReactNode);
  }
  if (
    typeof element.type === "object" &&
    element.type !== null &&
    "type" in element.type &&
    typeof element.type.type === "function"
  ) {
    if (element.type.type.name === "InlineTranscript") {
      return [{ text: String(element.props.text ?? "") }];
    }
    return renderTranscriptNodes(element.type.type(element.props) as ReactNode);
  }
  if (typeof element.type !== "string") return [];

  const rawChildren = element.props.children as ReactNode;
  const childGroups = (Array.isArray(rawChildren) ? rawChildren : [rawChildren]).map(renderTranscriptNodes);
  return [
    {
      ...(typeof element.props.className === "string" ? { className: element.props.className } : {}),
      text: childGroups.map((children) => children[0]?.text ?? "").join(""),
    },
    ...childGroups.flat(),
  ];
}

describe("structured transcript presentation", () => {
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

    expect({
      author: nodes.find((node) => node.className === "message-author")?.text,
      diffRows: nodes
        .filter((node) => node.className?.startsWith("diff-line diff-"))
        .map(({ className, text }) => ({ className, text })),
    }).toEqual({
      author: "·edit",
      diffRows: [
        { className: "diff-line diff-removed", text: "-1|before" },
        { className: "diff-line diff-added", text: "+1|after" },
      ],
    });
  });
});

describe("OMP-style transcript formatting", () => {
  it("parses the inline markdown roles used by the OMP stream", () => {
    expect(parseInlineTranscript("Use **bold**, `pnpm test`, and [docs](https://omp.sh).")).toEqual([
      { kind: "text", text: "Use " },
      { kind: "strong", text: "bold" },
      { kind: "text", text: ", " },
      { kind: "code", text: "pnpm test" },
      { kind: "text", text: ", and " },
      { kind: "link", text: "docs", href: "https://omp.sh" },
      { kind: "text", text: "." },
    ]);
  });

  it("maps source tokens to OMP's semantic syntax categories", () => {
    expect(tokenizeCode('const answer: Result = run("42"); // ready', "ts")).toEqual(
      expect.arrayContaining([
        { kind: "keyword", text: "const" },
        { kind: "variable", text: "answer" },
        { kind: "type", text: "Result" },
        { kind: "operator", text: "=" },
        { kind: "function", text: "run" },
        { kind: "string", text: '"42"' },
        { kind: "comment", text: "// ready" },
      ]),
    );
  });

  it("keeps arithmetic operators separate from adjacent numbers", () => {
    expect(tokenizeCode("const total = 1+2;", "ts")).toEqual(
      expect.arrayContaining([
        { kind: "number", text: "1" },
        { kind: "operator", text: "+" },
        { kind: "number", text: "2" },
      ]),
    );
  });
});

type ControlledDashboardProps = DashboardProps & {
  selectedSessionId: string | null;
  onSelectedSessionChange(sessionId: string): void;
};

const DASHBOARD_DEFAULTS = {
  askRequests: [] as AskRequest[],
  onEnableNotifications: vi.fn().mockResolvedValue(undefined),
  onLaunch: vi.fn().mockResolvedValue(undefined),
  onCommand: vi.fn().mockResolvedValue(undefined),
  onAbort: vi.fn().mockResolvedValue(undefined),
  onKill: vi.fn().mockResolvedValue(undefined),
  onSetModel: vi.fn().mockResolvedValue(undefined),
  onSetEffort: vi.fn().mockResolvedValue(undefined),
  onRespondToAsk: vi.fn().mockResolvedValue(undefined),
  onSearchHistory: vi.fn().mockResolvedValue(undefined),
  onLoadMoreHistory: vi.fn().mockResolvedValue(undefined),
  onLoadTranscript: vi.fn().mockResolvedValue(undefined),
};

function renderControlledDashboard(
  props: ControlledDashboardProps,
  options: { preserveState?: boolean; effectsEnabled?: boolean } = {},
): ReactNode {
  if (!options.preserveState) {
    reactHarness.refValues = [];
    reactHarness.stateValues = [];
  }
  reactHarness.refIndex = 0;
  reactHarness.stateIndex = 0;
  reactHarness.effectsEnabled = options.effectsEnabled ?? true;
  const dashboard = Dashboard(props) as ReactElement<{
    children: ReactElement<ControlledDashboardProps>;
  }>;
  const content = dashboard.props.children;
  return (content.type as (contentProps: ControlledDashboardProps) => ReactNode)(content.props);
}

function findHostText(node: ReactNode, hostType: string): string | undefined {
  if (node === null || node === undefined || typeof node === "boolean") return undefined;
  if (Array.isArray(node)) {
    for (const child of node) {
      const match = findHostText(child, hostType);
      if (match !== undefined) return match;
    }
    return undefined;
  }
  if (!isValidElement(node)) return undefined;
  const element = node as ReactElement<{ children?: ReactNode }>;
  if (element.type === hostType) {
    const children = element.props.children;
    return Array.isArray(children) ? children.join("") : String(children ?? "");
  }
  return findHostText(element.props.children, hostType);
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

describe("controlled dashboard selection", () => {
  it("uses a requested session instead of the default first session", () => {
    const sessions = [BASE_SESSION, { ...BASE_SESSION, id: "session-2", name: "Requested session" }];

    const output = renderControlledDashboard({
      sessions,
      sessionsReady: true,
      historyLoading: false,
      hasMoreHistory: false,
      connection: "connected",
      error: null,
      notificationState: "enabled",
      selectedSessionId: "session-2",
      onSelectedSessionChange: vi.fn(),
      ...DASHBOARD_DEFAULTS,
    });

    expect(findHostText(output, "h1")).toBe("Requested session");
  });

  it("preserves a requested session while the list is empty and selects it when sessions arrive", () => {
    const onSelectedSessionChange = vi.fn();
    const baseProps = {
      sessionsReady: true,
      historyLoading: false,
      hasMoreHistory: false,
      connection: "connected" as const,
      error: null,
      notificationState: "enabled" as const,
      selectedSessionId: "session-2",
      onSelectedSessionChange,
      ...DASHBOARD_DEFAULTS,
    };

    renderControlledDashboard({ ...baseProps, sessions: [] });
    expect(onSelectedSessionChange).not.toHaveBeenCalled();

    const output = renderControlledDashboard({
      ...baseProps,
      sessions: [BASE_SESSION, { ...BASE_SESSION, id: "session-2", name: "Requested session" }],
    });
    expect(findHostText(output, "h1")).toBe("Requested session");
  });

  it("does not replace a requested ID from a nonempty partial session update", () => {
    const onSelectedSessionChange = vi.fn();
    const props = {
      historyLoading: false,
      hasMoreHistory: false,
      connection: "connected" as const,
      error: null,
      notificationState: "enabled" as const,
      selectedSessionId: "session-2",
      onSelectedSessionChange,
      ...DASHBOARD_DEFAULTS,
    };

    renderControlledDashboard({ ...props, sessions: [BASE_SESSION], sessionsReady: false });
    expect(onSelectedSessionChange).not.toHaveBeenCalled();

    const output = renderControlledDashboard({
      ...props,
      sessions: [BASE_SESSION, { ...BASE_SESSION, id: "session-2", name: "Requested session" }],
      sessionsReady: true,
    });
    expect(findHostText(output, "h1")).toBe("Requested session");
    expect(onSelectedSessionChange).not.toHaveBeenCalled();
  });

  it("falls back deterministically and reports the first session when the requested ID is absent", () => {
    const onSelectedSessionChange = vi.fn();

    const output = renderControlledDashboard({
      sessions: [BASE_SESSION, { ...BASE_SESSION, id: "session-2", name: "Second session" }],
      sessionsReady: true,
      historyLoading: false,
      hasMoreHistory: false,
      connection: "connected",
      error: null,
      notificationState: "enabled",
      selectedSessionId: "missing-session",
      onSelectedSessionChange,
      ...DASHBOARD_DEFAULTS,
    });

    expect(findHostText(output, "h1")).toBe("Bootstrap");
    expect(onSelectedSessionChange).toHaveBeenCalledWith("session-1");
  });
});

const CONFIGURABLE_SESSION: Session = {
  ...BASE_SESSION,
  capabilities: [...BASE_SESSION.capabilities, "model", "effort"],
  effort: "medium",
  availableModels: [
    {
      provider: "openai",
      id: "gpt-5.6",
      name: "GPT-5.6",
      efforts: ["low", "medium", "high", "xhigh"],
    },
    {
      provider: "anthropic",
      id: "claude-opus-4.7",
      name: "Claude Opus 4.7",
      efforts: ["low", "medium", "high", "max"],
    },
  ],
};

function configurationProps(
  session: Session,
  callbacks: Partial<Pick<DashboardProps, "onSetModel" | "onSetEffort">> = {},
): ControlledDashboardProps {
  return {
    sessions: [session],
    sessionsReady: true,
    historyLoading: false,
    hasMoreHistory: false,
    connection: "connected",
    error: null,
    notificationState: "enabled",
    selectedSessionId: session.id,
    onSelectedSessionChange: vi.fn(),
    ...DASHBOARD_DEFAULTS,
    ...callbacks,
  };
}

function findConfigurationTrigger(output: ReactNode, kind: "model" | "effort") {
  const label = `Change ${kind}.`;
  return findElements(
    output,
    (element) =>
      typeof element.props["aria-label"] === "string" && element.props["aria-label"].startsWith(label),
  )[0];
}

function findConfigurationDrawer(output: ReactNode, title: "Model" | "Effort") {
  return findElements(
    output,
    (element) =>
      element.props.showSwipeHandle === true &&
      textContent(element.props.children as ReactNode).includes(title),
  )[0];
}

describe("session model and effort selectors", () => {
  it("renders separate tappable Model and Effort selector cells", () => {
    const output = renderControlledDashboard(configurationProps(CONFIGURABLE_SESSION));

    expect(findConfigurationTrigger(output, "model")?.props.disabled).not.toBe(true);
    expect(findConfigurationTrigger(output, "effort")?.props.disabled).not.toBe(true);
    expect(
      findElements(output, (element) => element.type === "dt").map((element) => textContent(element)),
    ).toEqual(["Model", "Effort", "Context", "Updated"]);
  });

  it("opens a populated model-only drawer", () => {
    const props = configurationProps(CONFIGURABLE_SESSION);
    let output = renderControlledDashboard(props);

    (findConfigurationTrigger(output, "model")?.props.onClick as (() => void) | undefined)?.();
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });

    const drawer = findConfigurationDrawer(output, "Model");
    expect(drawer?.props.open).toBe(true);
    expect(textContent(drawer?.props.children as ReactNode)).toContain("GPT-5.6");
    expect(textContent(drawer?.props.children as ReactNode)).toContain("Claude Opus 4.7");
    expect(textContent(drawer?.props.children as ReactNode)).not.toContain("Effort");
  });

  it("keeps only the most recently opened configuration drawer open", () => {
    const props = configurationProps(CONFIGURABLE_SESSION);
    let output = renderControlledDashboard(props);

    (findConfigurationTrigger(output, "model")?.props.onClick as (() => void) | undefined)?.();
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });
    expect(findConfigurationDrawer(output, "Model")?.props.open).toBe(true);
    expect(findConfigurationDrawer(output, "Effort")?.props.open).toBe(false);

    (findConfigurationTrigger(output, "effort")?.props.onClick as (() => void) | undefined)?.();
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });
    expect(findConfigurationDrawer(output, "Model")?.props.open).toBe(false);
    expect(findConfigurationDrawer(output, "Effort")?.props.open).toBe(true);
  });

  it("opens truthful recovery guidance when configuration data is unavailable", () => {
    const staleProps = configurationProps(BASE_SESSION);
    let output = renderControlledDashboard(staleProps);

    expect(findConfigurationTrigger(output, "model")?.props.disabled).not.toBe(true);
    (findConfigurationTrigger(output, "model")?.props.onClick as (() => void) | undefined)?.();
    output = renderControlledDashboard(staleProps, { preserveState: true, effectsEnabled: false });
    expect(textContent(findConfigurationDrawer(output, "Model")?.props.children as ReactNode)).toMatch(
      /restart/i,
    );

    const disconnectedLiveSession: Session = {
      ...BASE_SESSION,
      connected: false,
      status: "disconnected",
    };
    const disconnectedLiveProps = configurationProps(disconnectedLiveSession);
    output = renderControlledDashboard(disconnectedLiveProps);
    (findConfigurationTrigger(output, "model")?.props.onClick as (() => void) | undefined)?.();
    output = renderControlledDashboard(disconnectedLiveProps, {
      preserveState: true,
      effectsEnabled: false,
    });
    expect(textContent(findConfigurationDrawer(output, "Model")?.props.children as ReactNode)).toMatch(
      /restart/i,
    );

    output = renderControlledDashboard(disconnectedLiveProps);
    (findConfigurationTrigger(output, "effort")?.props.onClick as (() => void) | undefined)?.();
    output = renderControlledDashboard(disconnectedLiveProps, {
      preserveState: true,
      effectsEnabled: false,
    });
    expect(textContent(findConfigurationDrawer(output, "Effort")?.props.children as ReactNode)).toMatch(
      /restart/i,
    );

    const historySession: Session = {
      ...BASE_SESSION,
      connected: false,
      source: "history",
      status: "history",
    };
    const historyProps = configurationProps(historySession);
    output = renderControlledDashboard(historyProps);
    expect(findConfigurationTrigger(output, "effort")?.props.disabled).not.toBe(true);
    (findConfigurationTrigger(output, "effort")?.props.onClick as (() => void) | undefined)?.();
    output = renderControlledDashboard(historyProps, { preserveState: true, effectsEnabled: false });
    expect(textContent(findConfigurationDrawer(output, "Effort")?.props.children as ReactNode)).toMatch(
      /resume/i,
    );
  });

  it("sends only an effort command when an available effort is selected", async () => {
    const onSetModel = vi.fn().mockResolvedValue(undefined);
    const onSetEffort = vi.fn().mockResolvedValue(undefined);
    const props = configurationProps(CONFIGURABLE_SESSION, { onSetModel, onSetEffort });
    let output = renderControlledDashboard(props);

    (findConfigurationTrigger(output, "effort")?.props.onClick as (() => void) | undefined)?.();
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });
    const effortDrawerText = textContent(
      findConfigurationDrawer(output, "Effort")?.props.children as ReactNode,
    );
    expect(effortDrawerText).toContain("Extra high");
    expect(effortDrawerText).not.toContain("Claude Opus 4.7");
    expect(effortDrawerText).not.toContain("Max");
    const highOption = findElements(
      findConfigurationDrawer(output, "Effort")?.props.children as ReactNode,
      (element) => textContent(element) === "High",
    )[0];
    (highOption?.props.onClick as (() => void) | undefined)?.();
    await Promise.resolve();

    expect(onSetEffort).toHaveBeenCalledWith(CONFIGURABLE_SESSION.id, "high");
    expect(onSetModel).not.toHaveBeenCalled();
  });

  it("shows request errors only in the drawer that initiated them", async () => {
    const modelProps = configurationProps(CONFIGURABLE_SESSION, {
      onSetModel: vi.fn().mockRejectedValue(new Error("Model request failed")),
    });
    let output = renderControlledDashboard(modelProps);

    (findConfigurationTrigger(output, "model")?.props.onClick as (() => void) | undefined)?.();
    output = renderControlledDashboard(modelProps, { preserveState: true, effectsEnabled: false });
    const alternateModel = findElements(
      findConfigurationDrawer(output, "Model")?.props.children as ReactNode,
      (element) =>
        typeof element.props.onClick === "function" && textContent(element).includes("Claude Opus 4.7"),
    )[0];
    (alternateModel?.props.onClick as (() => void) | undefined)?.();
    await Promise.resolve();
    output = renderControlledDashboard(modelProps, { preserveState: true, effectsEnabled: false });
    expect(textContent(findConfigurationDrawer(output, "Model")?.props.children as ReactNode)).toContain(
      "Model request failed",
    );

    (findConfigurationTrigger(output, "effort")?.props.onClick as (() => void) | undefined)?.();
    output = renderControlledDashboard(modelProps, { preserveState: true, effectsEnabled: false });
    expect(textContent(findConfigurationDrawer(output, "Effort")?.props.children as ReactNode)).not.toContain(
      "Model request failed",
    );

    const effortProps = configurationProps(CONFIGURABLE_SESSION, {
      onSetEffort: vi.fn().mockRejectedValue(new Error("Effort request failed")),
    });
    output = renderControlledDashboard(effortProps);
    (findConfigurationTrigger(output, "effort")?.props.onClick as (() => void) | undefined)?.();
    output = renderControlledDashboard(effortProps, { preserveState: true, effectsEnabled: false });
    const highEffort = findElements(
      findConfigurationDrawer(output, "Effort")?.props.children as ReactNode,
      (element) => typeof element.props.onClick === "function" && textContent(element) === "High",
    )[0];
    (highEffort?.props.onClick as (() => void) | undefined)?.();
    await Promise.resolve();
    output = renderControlledDashboard(effortProps, { preserveState: true, effectsEnabled: false });
    expect(textContent(findConfigurationDrawer(output, "Effort")?.props.children as ReactNode)).toContain(
      "Effort request failed",
    );

    (findConfigurationTrigger(output, "model")?.props.onClick as (() => void) | undefined)?.();
    output = renderControlledDashboard(effortProps, { preserveState: true, effectsEnabled: false });
    expect(textContent(findConfigurationDrawer(output, "Model")?.props.children as ReactNode)).not.toContain(
      "Effort request failed",
    );
  });

  it("ignores stale configuration completions after switching sessions", async () => {
    let rejectFirstModelRequest: (reason: Error) => void = () => undefined;
    const firstModelRequest = new Promise<void>((_resolve, reject) => {
      rejectFirstModelRequest = reject;
    });
    let resolveSecondEffortRequest: () => void = () => undefined;
    const secondEffortRequest = new Promise<void>((resolve) => {
      resolveSecondEffortRequest = resolve;
    });
    const secondSession: Session = {
      ...CONFIGURABLE_SESSION,
      id: "session-2",
      name: "Second session",
    };
    const firstProps: ControlledDashboardProps = {
      ...configurationProps(CONFIGURABLE_SESSION),
      sessions: [CONFIGURABLE_SESSION, secondSession],
      onSetModel: vi.fn().mockReturnValue(firstModelRequest),
    };
    let output = renderControlledDashboard(firstProps);

    (findConfigurationTrigger(output, "model")?.props.onClick as (() => void) | undefined)?.();
    output = renderControlledDashboard(firstProps, { preserveState: true, effectsEnabled: false });
    const alternateModel = findElements(
      findConfigurationDrawer(output, "Model")?.props.children as ReactNode,
      (element) =>
        typeof element.props.onClick === "function" && textContent(element).includes("Claude Opus 4.7"),
    )[0];
    (alternateModel?.props.onClick as (() => void) | undefined)?.();

    const secondProps: ControlledDashboardProps = {
      ...firstProps,
      selectedSessionId: secondSession.id,
      onSetEffort: vi.fn().mockReturnValue(secondEffortRequest),
    };
    renderControlledDashboard(secondProps, { preserveState: true });
    output = renderControlledDashboard(secondProps, {
      preserveState: true,
      effectsEnabled: false,
    });
    (findConfigurationTrigger(output, "effort")?.props.onClick as (() => void) | undefined)?.();
    output = renderControlledDashboard(secondProps, {
      preserveState: true,
      effectsEnabled: false,
    });
    const highEffort = findElements(
      findConfigurationDrawer(output, "Effort")?.props.children as ReactNode,
      (element) => typeof element.props.onClick === "function" && textContent(element) === "High",
    )[0];
    (highEffort?.props.onClick as (() => void) | undefined)?.();

    rejectFirstModelRequest(new Error("Old session model failure"));
    await Promise.resolve();
    output = renderControlledDashboard(secondProps, {
      preserveState: true,
      effectsEnabled: false,
    });
    const effortDrawer = findConfigurationDrawer(output, "Effort");
    expect(textContent(effortDrawer?.props.children as ReactNode)).not.toContain("Old session model failure");
    expect(
      findElements(effortDrawer?.props.children as ReactNode, (element) => textContent(element) === "High")[0]
        ?.props.disabled,
    ).toBe(true);

    resolveSecondEffortRequest();
    await Promise.resolve();
  });
});
