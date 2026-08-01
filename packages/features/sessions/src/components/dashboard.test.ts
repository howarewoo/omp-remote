import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
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
  AskToolCall,
  canKillSession,
  Dashboard,
  type DashboardProps,
  formatSubagentActivityLabel,
  formatSystemTextPreview,
  formatToolTextPreview,
  formatReadTarget,
  getActiveAskRequest,
  getComposerAction,
  getSkillSuggestions,
  groupSessionsForSidebar,
  GroupedReadTranscript,
  groupTranscriptEntries,
  parseInlineTranscript,
  parseTodoResult,
  parseTranscriptBlocks,
  SystemTranscriptText,
  TodoToolTranscript,
  ToolTranscriptText,
  TranscriptCodeBlock,
  renderTranscriptMessageItems,
  TranscriptEntry,
  tokenizeCode,
  WorkingIndicator,
} from "./dashboard.js";
import { SubagentSessionViewer } from "./subagent-session-viewer.js";
import {
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerViewport,
} from "./ui/message-scroller.js";

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

describe("groupSessionsForSidebar", () => {
  it("separates live terminal and daemon-hosted sessions before disconnected sessions", () => {
    const sessions = [
      { ...BASE_SESSION, id: "disconnected-new", connected: false, status: "disconnected" as const },
      { ...BASE_SESSION, id: "terminal-new", source: "extension" as const },
      { ...BASE_SESSION, id: "daemon-new" },
      { ...BASE_SESSION, id: "terminal-old", source: "extension" as const },
      { ...BASE_SESSION, id: "daemon-old" },
      {
        ...BASE_SESSION,
        id: "disconnected-old",
        connected: false,
        source: "history" as const,
        status: "history" as const,
      },
    ];

    expect(groupSessionsForSidebar(sessions)).toEqual([
      {
        id: "terminal",
        label: "Live terminal sessions",
        sessions: [sessions[1], sessions[3]],
      },
      {
        id: "daemon",
        label: "Live daemon-hosted sessions",
        sessions: [sessions[2], sessions[4]],
      },
      {
        id: "disconnected",
        label: "Disconnected",
        sessions: [sessions[0], sessions[5]],
      },
    ]);
  });

  it("omits empty sidebar sections", () => {
    expect(groupSessionsForSidebar([BASE_SESSION])).toEqual([
      {
        id: "daemon",
        label: "Live daemon-hosted sessions",
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
    expect(block.props.className).toBe("transcript-disclosure-frame code-block");
  });
});

const TODO_RESULT_TEXT = [
  "Remaining items (1):",
  "  - Build custom todo tool interface [in_progress] (Implementation)",
  "Overall: 2/4 done, 1 open, 1 blocked.",
  'Active phase 2/3 "Implementation" (0/1) — earliest phase with open work',
  "  Research:",
  "    - [X] Locate todo rendering and UI conventions",
  "    - [X] Define todo interaction contract",
  "  Implementation:",
  "    - [ ] Build custom todo tool interface (in progress)",
  "  Verification:",
  "    - [ ] Exercise todo flow in browser (blocked: format probe)",
].join("\n");

describe("parseTodoResult", () => {
  it("parses canonical multi-phase progress and derives phase states", () => {
    expect(parseTodoResult(TODO_RESULT_TEXT)).toEqual({
      overall: { done: 2, total: 4, open: 1, blocked: 1 },
      activePhase: { index: 2, total: 3, name: "Implementation", done: 0, taskTotal: 1 },
      phases: [
        {
          name: "Research",
          state: "completed",
          tasks: [
            { label: "Locate todo rendering and UI conventions", state: "completed" },
            { label: "Define todo interaction contract", state: "completed" },
          ],
        },
        {
          name: "Implementation",
          state: "in-progress",
          tasks: [{ label: "Build custom todo tool interface", state: "in-progress" }],
        },
        {
          name: "Verification",
          state: "blocked",
          tasks: [{ label: "Exercise todo flow in browser", state: "blocked", reason: "format probe" }],
        },
      ],
    });
  });

  it("preserves completed, blocked, and dropped task states", () => {
    const parsed = parseTodoResult(
      [
        "Overall: 2/3 done, 0 open, 1 blocked.",
        'Active phase 1/1 "Delivery" (2/3).',
        "  Delivery:",
        "    - [x] Ship renderer (completed)",
        "    - [ ] Await approval (blocked: review pending)",
        "    - [ ] Remove obsolete branch (dropped)",
      ].join("\n"),
    );

    expect(parsed?.overall).toEqual({ done: 2, total: 3, open: 0, blocked: 1 });
    expect(parsed?.phases[0]).toEqual({
      name: "Delivery",
      state: "blocked",
      tasks: [
        { label: "Ship renderer", state: "completed" },
        { label: "Await approval", state: "blocked", reason: "review pending" },
        { label: "Remove obsolete branch", state: "dropped" },
      ],
    });
  });

  it("accepts completed output without an active phase or open count", () => {
    expect(
      parseTodoResult(["Overall: 1/1 done.", "  Finish:", "    - [x] Hand off"].join("\n")),
    ).toMatchObject({
      overall: { done: 1, total: 1 },
      phases: [{ state: "completed" }],
    });
  });

  it("rejects overall and active counts that contradict task states", () => {
    expect(parseTodoResult(TODO_RESULT_TEXT.replace("2/4 done, 1 open", "1/4 done, 2 open"))).toBeNull();
    expect(parseTodoResult(TODO_RESULT_TEXT.replace("(0/1) —", "(1/1) —"))).toBeNull();
  });

  it("treats omitted open and blocked counts as zero", () => {
    expect(
      parseTodoResult(
        [
          "Overall: 0/1 done.",
          'Active phase 1/1 "Work" (0/1).',
          "  Work:",
          "    - [ ] Continue work (in progress)",
        ].join("\n"),
      ),
    ).toBeNull();
    expect(
      parseTodoResult(
        [
          "Overall: 0/1 done.",
          'Active phase 1/1 "Work" (0/1).',
          "  Work:",
          "    - [ ] Await access (blocked)",
        ].join("\n"),
      ),
    ).toBeNull();
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
    const nodes = renderTranscriptNodes(block);

    expect(formatToolTextPreview(`${text}\n`)).toBe(
      Array.from({ length: 10 }, (_, index) => `line ${index + 3}`).join("\n"),
    );
    expect(block.type).toBe("details");
    expect(block.props.open).toBe(false);
    expect(block.props.children[0].type).toBe("summary");
    expect(block.props.className).toBe(
      "tool-message-disclosure transcript-disclosure-frame tool-output-disclosure",
    );
    expect(nodes.find((node) => node.className === "tool-output-divider")?.text).toBe("Output");
    expect(block.props.children[0].props.children[1].props.children).toBe(formatToolTextPreview(text));
  });

  it("shows a canonical read basename in the header without hiding the full result", () => {
    const text = [
      "[packages/features/sessions/src/components/dashboard.tsx#ABCD]",
      "1090:export function ToolTranscriptText() {",
      "1091:  return <details />;",
      "1092:}",
    ].join("\n");
    const disclosure = ToolTranscriptText({
      entry: {
        id: "read-1",
        role: "tool",
        toolName: "read",
        text,
        timestamp: "2026-07-29T12:00:00.000Z",
        streaming: false,
        presentation: "text",
      },
    });
    const nodes = renderTranscriptNodes(disclosure);

    expect(disclosure.type).toBe("details");
    expect(disclosure.props.open).toBe(false);
    expect(nodes.find((node) => node.className === "message-author")?.text).toContain("read dashboard.tsx");
    expect(nodes.some((node) => node.className === "tool-message-preview")).toBe(false);
    expect(nodes.find((node) => node.className === "tool-output-divider")?.text).toBe("Output");
    expect(nodes.some((node) => node.text.includes("1091:  return <details />;"))).toBe(true);
  });

  it("keeps the generic preview when read output has no canonical header", () => {
    const text = "Error: file not found";
    const disclosure = ToolTranscriptText({
      entry: {
        id: "read-error",
        role: "tool",
        toolName: "read",
        text,
        timestamp: "2026-07-29T12:00:00.000Z",
        streaming: false,
        presentation: "text",
      },
    });
    const nodes = renderTranscriptNodes(disclosure);

    expect(nodes.find((node) => node.className === "message-author")?.text).toContain("read");
    expect(nodes.find((node) => node.className === "tool-message-preview")?.text).toBe(text);
  });

  it("keeps metadata-backed reads on the existing single-read disclosure", () => {
    const disclosure = ToolTranscriptText({
      entry: {
        id: "read-metadata",
        role: "tool",
        toolName: "read",
        readTarget: "/work/omp-remote/src/index.ts:1-180",
        text: "canonical read result",
        timestamp: "2026-07-29T12:00:00.000Z",
        streaming: false,
        presentation: "text",
      },
    });
    const nodes = renderTranscriptNodes(disclosure);

    expect(disclosure.type).toBe("details");
    expect(disclosure.props.open).toBe(false);
    expect(nodes.find((node) => node.className === "message-author")?.text).toContain("read index.ts");
    expect(nodes.some((node) => node.className === "tool-message-preview")).toBe(false);
  });

  it("renders a framed skill read with its full URI, exact truncation count, and resolved output", () => {
    const uri = "skill://using-woostack/references/session-learning.md";
    const resolvedPath = "/Users/example/.agents/skills/using-woostack/references/session-learning.md";
    const text = [
      "# Session learning",
      "",
      "Use this guidance at every final response.",
      "## Rules",
      "- Keep claims grounded.",
      "- Record evidence.",
      "- Capture a reusable lesson.",
      "- Keep output compact.",
    ].join("\n");
    const disclosure = ToolTranscriptText({
      entry: {
        id: "skill-read-long",
        role: "tool",
        toolName: "read",
        readTarget: uri,
        readResolvedPath: resolvedPath,
        text,
        timestamp: "2026-07-29T12:00:00.000Z",
        streaming: false,
        presentation: "text",
      },
    });
    const nodes = renderTranscriptNodes(disclosure);
    const expandedNodes = renderTranscriptNodes(disclosure.props.children[1]);

    expect(disclosure.type).toBe("details");
    expect(disclosure.props.className).toContain("skill-read-disclosure");
    expect(nodes.find((node) => node.className === "message-author")?.text).toContain(`Read ${uri}`);
    expect(nodes.find((node) => node.className === "skill-read-expand")?.text).toBe("2 more linesExpand");
    expect(nodes.find((node) => node.className === "skill-read-output")?.text).toBe(
      `OutputResolved path: ${resolvedPath}`,
    );
    expect(nodes.find((node) => node.className === "skill-read-preview")?.text).not.toContain(
      "Capture a reusable lesson.",
    );
    expect(expandedNodes.some((node) => node.text.includes("Capture a reusable lesson."))).toBe(true);
    expect(expandedNodes.some((node) => node.text.includes("Keep output compact."))).toBe(true);
  });

  it("renders all short skill content without a truncation affordance", () => {
    const disclosure = ToolTranscriptText({
      entry: {
        id: "skill-read-short",
        role: "tool",
        toolName: "read",
        readTarget: "skill://frontend-design",
        text: "# Frontend design\nUse existing tokens.",
        timestamp: "2026-07-29T12:00:00.000Z",
        streaming: false,
        presentation: "text",
      },
    });
    const nodes = renderTranscriptNodes(disclosure);

    expect(nodes.find((node) => node.className === "skill-read-preview")?.text).toContain(
      "Use existing tokens.",
    );
    expect(nodes.some((node) => node.className === "skill-read-expand")).toBe(false);
  });

  it("omits the skill read Output footer when resolved metadata is unavailable", () => {
    const disclosure = ToolTranscriptText({
      entry: {
        id: "skill-read-no-path",
        role: "tool",
        toolName: "read",
        readTarget: "skill://verification",
        text: "# Verification",
        timestamp: "2026-07-29T12:00:00.000Z",
        streaming: false,
        presentation: "text",
      },
    });

    expect(renderTranscriptNodes(disclosure).some((node) => node.className === "skill-read-output")).toBe(
      false,
    );
  });

  it("groups only adjacent read entries and preserves their order", () => {
    const messages: Session["messages"] = [
      {
        id: "read-1",
        role: "tool",
        toolName: "read",
        readTarget: "/work/omp-remote/a.ts",
        text: "alpha",
        timestamp: "2026-07-29T12:00:00.000Z",
        streaming: false,
        presentation: "text",
      },
      {
        id: "read-2",
        role: "tool",
        toolName: "read",
        readTarget: "/work/omp-remote/b.ts",
        text: "beta",
        timestamp: "2026-07-29T12:00:01.000Z",
        streaming: false,
        presentation: "text",
      },
      {
        id: "assistant-1",
        role: "assistant",
        text: "Between reads",
        timestamp: "2026-07-29T12:00:02.000Z",
        streaming: false,
        presentation: "text",
      },
      {
        id: "read-3",
        role: "tool",
        toolName: "read",
        readTarget: "/work/omp-remote/c.ts",
        text: "gamma",
        timestamp: "2026-07-29T12:00:03.000Z",
        streaming: false,
        presentation: "text",
      },
    ];

    expect(groupTranscriptEntries(messages)).toEqual([
      { kind: "read-group", entries: messages.slice(0, 2) },
      { kind: "entry", entry: messages[2] },
      { kind: "entry", entry: messages[3] },
    ]);
  });

  it("formats grouped targets relative to cwd without allowing parent traversal", () => {
    expect(formatReadTarget("/work/omp-remote/src/index.ts:1-180", "/work/omp-remote")).toBe(
      "src/index.ts:1-180",
    );
    expect(formatReadTarget("/work/omp-remote/../secret.txt:raw", "/work/omp-remote")).toBe(
      "/work/omp-remote/../secret.txt:raw",
    );
    expect(formatReadTarget("/other/index.ts:5-16,20-30", "/work/omp-remote")).toBe(
      "/other/index.ts:5-16,20-30",
    );
  });

  it("renders a grouped read tree and keeps every result inspectable", () => {
    const entries: Session["messages"] = [
      {
        id: "read-a",
        role: "tool",
        toolName: "read",
        readTarget: "/work/omp-remote/src/a.ts:1-20",
        text: "alpha contents",
        timestamp: "2026-07-29T12:00:00.000Z",
        streaming: false,
        presentation: "text",
      },
      {
        id: "read-b",
        role: "tool",
        toolName: "read",
        readTarget: "/work/omp-remote/src/b.ts:raw",
        text: "beta contents",
        timestamp: "2026-07-29T12:00:01.000Z",
        streaming: false,
        presentation: "text",
      },
    ];
    const disclosure = GroupedReadTranscript({ entries, cwd: "/work/omp-remote" });
    if (!disclosure) throw new Error("Expected grouped read disclosure");
    const nodes = renderTranscriptNodes(disclosure);

    expect(nodes.find((node) => node.className === "message-author")?.text).toContain("Read (2)");
    expect(nodes.some((node) => node.className === "tool-message-disclosure grouped-read-disclosure")).toBe(
      true,
    );
    expect(nodes.find((node) => node.className === "read-target-tree")?.text).toBe(
      "├─ src/a.ts:1-20└─ src/b.ts:raw",
    );
    expect(nodes.some((node) => node.text.includes("alpha contents"))).toBe(true);
    expect(nodes.some((node) => node.text.includes("beta contents"))).toBe(true);
    expect(
      nodes.filter((node) => node.className === "tool-message-disclosure grouped-read-result-disclosure"),
    ).toHaveLength(2);
    expect(nodes.some((node) => node.className?.includes("transcript-disclosure-frame"))).toBe(false);
    expect(nodes.some((node) => node.className === "tool-output-divider")).toBe(false);
  });

  it("does not specialize adjacent skill reads inside the grouped-read disclosure", () => {
    const entries: Session["messages"] = [
      {
        id: "skill-read-a",
        role: "tool",
        toolName: "read",
        readTarget: "skill://using-woostack",
        text: "# Using woostack",
        timestamp: "2026-07-29T12:00:00.000Z",
        streaming: false,
        presentation: "text",
      },
      {
        id: "skill-read-b",
        role: "tool",
        toolName: "read",
        readTarget: "skill://verification",
        text: "# Verification",
        timestamp: "2026-07-29T12:00:01.000Z",
        streaming: false,
        presentation: "text",
      },
    ];
    const disclosure = GroupedReadTranscript({ entries, cwd: "/work/omp-remote" });
    if (!disclosure) throw new Error("Expected grouped read disclosure");
    const nodes = renderTranscriptNodes(disclosure);

    expect(nodes.find((node) => node.className === "message-author")?.text).toContain("Read (2)");
    expect(nodes.some((node) => node.className?.includes("skill-read-disclosure"))).toBe(false);
  });

  it("renders a consecutive read group as one stable scroller item", () => {
    const messages: Session["messages"] = [
      {
        id: "read-first",
        role: "tool",
        toolName: "read",
        readTarget: "/work/omp-remote/a.ts",
        text: "alpha",
        timestamp: "2026-07-29T12:00:00.000Z",
        streaming: false,
        presentation: "text",
      },
      {
        id: "read-second",
        role: "tool",
        toolName: "read",
        readTarget: "/work/omp-remote/b.ts",
        text: "beta",
        timestamp: "2026-07-29T12:00:01.000Z",
        streaming: false,
        presentation: "text",
      },
    ];
    const rows = renderTranscriptMessageItems({ messages, cwd: "/work/omp-remote" });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe(MessageScrollerItem);
    expect(rows[0]?.key).toBe("read-group:read-first");
    expect(rows[0]?.props.messageId).toBe("read-group:read-first");
    expect(rows[0]?.props.scrollAnchor).toBeUndefined();
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
    const nodes = renderTranscriptNodes(block);

    expect(block.props.open).toBe(true);
    expect(block.props.className).toBe(
      "tool-message-disclosure transcript-disclosure-frame tool-output-disclosure",
    );
    expect(nodes.find((node) => node.className === "tool-output-divider")?.text).toBe("Output");
  });

  it("renders write output in the shared open frame with a labeled divider and full result", () => {
    const text = ["Wrote 42 bytes to", "packages/features/sessions/src/components/dashboard.tsx"].join("\n");
    const disclosure = ToolTranscriptText({
      entry: {
        id: "write-1",
        role: "tool",
        toolName: "write",
        text,
        timestamp: "2026-07-29T12:00:00.000Z",
        streaming: false,
        presentation: "text",
      },
    });
    const nodes = renderTranscriptNodes(disclosure);

    expect(disclosure.type).toBe("details");
    expect(disclosure.props.open).toBe(true);
    expect(disclosure.props.className).toBe(
      "tool-message-disclosure transcript-disclosure-frame tool-output-disclosure",
    );
    expect(disclosure.props.children[0].type).toBe("summary");
    expect(nodes.find((node) => node.className === "message-author")?.text).toContain("write");
    expect(nodes.find((node) => node.className === "tool-output-divider")?.text).toBe("Output");
    expect(nodes.find((node) => node.className === "transcript-message")?.text).toContain(
      "packages/features/sessions/src/components/dashboard.tsx",
    );
  });

  it("routes canonical todo output to a closed progress summary and state list", () => {
    const entry = {
      id: "todo-1",
      role: "tool" as const,
      toolName: "todo",
      text: TODO_RESULT_TEXT,
      timestamp: "2026-07-29T12:00:00.000Z",
      streaming: false,
      presentation: "text" as const,
    };
    const nodes = renderTranscriptNodes(ToolTranscriptText({ entry }));

    expect(nodes.find((node) => node.className === "todo-tool-summary")?.text).toContain("2/4 complete");
    expect(nodes.find((node) => node.className === "todo-blocked-count")?.text).toBe("1 blocked");
    expect(nodes.find((node) => node.className === "todo-active-task")?.text).toContain(
      "In progress: Build custom todo tool interface",
    );
    expect(nodes.find((node) => node.className === "todo-task-reason")?.text).toBe(
      "Blocked reason: format probe",
    );

    const parsed = parseTodoResult(TODO_RESULT_TEXT);
    if (!parsed) throw new Error("Expected canonical todo output to parse");
    const disclosure = TodoToolTranscript({ entry, todo: parsed });
    expect(disclosure.type).toBe("details");
    expect(disclosure.props.open).toBeUndefined();
    expect(disclosure.props.className).toBe(
      "tool-message-disclosure transcript-disclosure-frame todo-tool-disclosure",
    );
    expect(nodes.some((node) => node.className === "tool-output-divider")).toBe(false);
    expect(nodes.filter((node) => node.type === "ul")).toHaveLength(3);
    const progress = disclosure.props.children[0].props.children[1].props.children[1];
    expect({
      type: progress.type,
      value: progress.props.value,
      max: progress.props.max,
      label: progress.props["aria-label"],
    }).toEqual({
      type: "progress",
      value: 2,
      max: 4,
      label: "Overall todo progress: 2 of 4 tasks complete",
    });
    expect(
      nodes.filter((node) => node.className?.includes("todo-state-badge")).map((node) => node.text),
    ).toEqual(["Completed", "Completed", "Completed", "In progress", "In progress", "Blocked", "Blocked"]);
  });

  it("uses resolved semantics when dropped tasks contribute to done progress", () => {
    const mixedText = [
      "Overall: 1/2 done, 1 open.",
      'Active phase 1/1 "Work" (1/2).',
      "  Work:",
      "    - [ ] Retire legacy path (dropped)",
      "    - [ ] Build replacement (in progress)",
    ].join("\n");
    const mixedTodo = parseTodoResult(mixedText);
    if (!mixedTodo) throw new Error("Expected mixed dropped todo output to parse");
    const mixedNodes = renderTranscriptNodes(
      TodoToolTranscript({
        entry: {
          id: "todo-mixed-dropped",
          role: "tool",
          toolName: "todo",
          text: mixedText,
          timestamp: "2026-07-29T12:00:00.000Z",
          streaming: false,
          presentation: "text",
        },
        todo: mixedTodo,
      }),
    );
    expect(mixedNodes.find((node) => node.className === "todo-tool-summary")?.text).toContain("1/2 resolved");

    const droppedText = ["Overall: 1/1 done.", "  Finish:", "    - [ ] Retire task (dropped)"].join("\n");
    const droppedTodo = parseTodoResult(droppedText);
    if (!droppedTodo) throw new Error("Expected all-dropped todo output to parse");
    const droppedDisclosure = TodoToolTranscript({
      entry: {
        id: "todo-all-dropped",
        role: "tool",
        toolName: "todo",
        text: droppedText,
        timestamp: "2026-07-29T12:00:00.000Z",
        streaming: false,
        presentation: "text",
      },
      todo: droppedTodo,
    });
    const droppedNodes = renderTranscriptNodes(droppedDisclosure);
    expect(droppedNodes.find((node) => node.className === "todo-active-task")?.text).toBe("No tasks remain");
    expect(
      droppedDisclosure.props.children[0].props.children[1].props.children[2].props.children[0].props[
        "data-state"
      ],
    ).toBe("dropped");

    const completedText = ["Overall: 1/1 done.", "  Finish:", "    - [x] Ship task"].join("\n");
    const completedTodo = parseTodoResult(completedText);
    if (!completedTodo) throw new Error("Expected completed todo output to parse");
    const completedDisclosure = TodoToolTranscript({
      entry: {
        id: "todo-completed",
        role: "tool",
        toolName: "todo",
        text: completedText,
        timestamp: "2026-07-29T12:00:00.000Z",
        streaming: false,
        presentation: "text",
      },
      todo: completedTodo,
    });
    const completedNodes = renderTranscriptNodes(completedDisclosure);
    expect(completedNodes.find((node) => node.className === "todo-active-task")?.text).toBe(
      "All tasks complete",
    );
    expect(
      completedDisclosure.props.children[0].props.children[1].props.children[2].props.children[0].props[
        "data-state"
      ],
    ).toBe("completed");
  });

  it("falls back to generic output when a todo result includes errors", () => {
    const text = [
      "Errors: failed to update todo state",
      "Overall: 1/1 done.",
      "  Finish:",
      "    - [x] Hand off",
    ].join("\n");
    const block = ToolTranscriptText({
      entry: {
        id: "todo-error",
        role: "tool",
        toolName: "todo",
        text,
        timestamp: "2026-07-29T12:00:00.000Z",
        streaming: false,
        presentation: "text",
      },
    });

    expect(parseTodoResult(text)).toBeNull();
    expect(block.type).toBe("details");
    expect(block.props.className).toBe(
      "tool-message-disclosure transcript-disclosure-frame tool-output-disclosure",
    );
    expect(block.props.children[0].props.children[1].props.children).toContain("Errors:");
    expect(renderTranscriptNodes(block).some((node) => node.className === "tool-output-divider")).toBe(true);
  });

  it("falls back to the generic todo disclosure for malformed output", () => {
    const text = "Overall: almost done.\nArbitrary output";
    const block = ToolTranscriptText({
      entry: {
        id: "todo-invalid",
        role: "tool",
        toolName: "todo",
        text,
        timestamp: "2026-07-29T12:00:00.000Z",
        streaming: false,
        presentation: "text",
      },
    });

    expect(block.type).toBe("details");
    expect(block.props.className).toBe(
      "tool-message-disclosure transcript-disclosure-frame tool-output-disclosure",
    );
    expect(block.props.children[0].props.children[1].props.children).toBe(formatToolTextPreview(text));
    expect(renderTranscriptNodes(block).some((node) => node.className === "tool-output-divider")).toBe(true);
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
    const nodes = renderTranscriptNodes(block);

    expect(formatSystemTextPreview(text)).toBe(`${"x".repeat(180)}…`);
    expect(block.type).toBe("details");
    expect(block.props.open).toBeUndefined();
    expect(block.props.children[0].type).toBe("summary");
    expect(block.props.className).toBe("system-message-disclosure transcript-disclosure-frame");
    expect(nodes.some((node) => node.className === "tool-output-divider")).toBe(false);
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

  it("returns only a request belonging to the selected session", () => {
    expect(getActiveAskRequest(requests, "missing-session")).toBeNull();
    expect(getActiveAskRequest(requests, null)).toBeNull();
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
  type?: string;
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
      type: element.type,
      ...(typeof element.props.className === "string" ? { className: element.props.className } : {}),
      text: childGroups.map((children) => children[0]?.text ?? "").join(""),
    },
    ...childGroups.flat(),
  ];
}

describe("structured transcript presentation", () => {
  it("omits empty assistant entries while retaining empty tool disclosures", () => {
    expect(
      TranscriptEntry({
        entry: {
          id: "empty-assistant",
          role: "assistant",
          text: "",
          timestamp: "2026-07-29T12:00:00.000Z",
          streaming: true,
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
    expect(nodes.find((node) => node.className === "tool-message-preview")?.text).toBe("No tool output");
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

describe("dashboard grouped read transcript", () => {
  it("renders adjacent reads as one transcript row without consuming the following message", () => {
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
    const rows = findElements(transcript, (element) => element.type === MessageScrollerItem);
    const groupedRead = findElements(rows[0], (element) => element.type === GroupedReadTranscript)[0];
    const groupedNodes = renderTranscriptNodes(groupedRead);

    expect(rows.map((row) => row.props.messageId)).toEqual([
      "read-group:dashboard-read-a",
      "dashboard-assistant",
    ]);
    expect(groupedNodes.find((node) => node.className === "message-author")?.text).toContain("Read (2)");
    expect(groupedNodes.find((node) => node.className === "read-target-tree")?.text).toBe(
      "├─ src/a.ts:1-10└─ src/b.ts:raw",
    );
    expect(groupedNodes.some((node) => node.text.includes("alpha dashboard contents"))).toBe(true);
    expect(groupedNodes.some((node) => node.text.includes("beta dashboard contents"))).toBe(true);
  });
});

describe("dashboard working status", () => {
  it("appends an announced Working status only to a running main transcript", () => {
    const runningOutput = renderControlledDashboard(
      composerDashboardProps({ ...BASE_SESSION, status: "running" }),
    );
    const runningTranscript = findElements(
      runningOutput,
      (element) => element.props.className === "transcript",
    )[0];

    const runningWorkingRows = findElements(
      runningTranscript,
      (element) => element.type === MessageScrollerItem && element.props.messageId === "working:session-1",
    );
    const runningIndicator = findElements(
      runningWorkingRows[0],
      (element) => element.type === WorkingIndicator,
    )[0];
    expect(
      renderTranscriptNodes(runningIndicator).filter(
        (node) => node.className === "ui-badge working-indicator",
      ),
    ).toEqual([expect.objectContaining({ text: "Working" })]);
    expect(runningWorkingRows).toHaveLength(1);
    expect((WorkingIndicator({ status: "running" }) as ReactElement<{ role?: string }>).props.role).toBe(
      "status",
    );

    const idleOutput = renderControlledDashboard(composerDashboardProps());
    const idleTranscript = findElements(idleOutput, (element) => element.props.className === "transcript")[0];
    expect(findElements(idleTranscript, (element) => element.type === WorkingIndicator)).toHaveLength(0);
    expect(
      findElements(
        idleTranscript,
        (element) => element.type === MessageScrollerItem && element.props.messageId === "working:session-1",
      ),
    ).toHaveLength(0);
  });

  it("appends the same Working status to a viewed running subagent transcript", () => {
    const subagent = {
      id: "subagent-1",
      name: "ResearchAgent",
      lastActivity: "2026-07-31T12:00:00.000Z",
    };
    const mainSession = { ...BASE_SESSION, activeSubagents: [subagent] };
    const subagentSession = {
      ...BASE_SESSION,
      id: subagent.id,
      name: subagent.name,
      status: "running" as const,
    };
    const props = composerDashboardProps(mainSession);
    props.sessions = [mainSession, subagentSession];

    let output = renderControlledDashboard(props);
    const openSubagent = findElements(
      output,
      (element) => element.props["aria-label"] === "Open ResearchAgent session",
    )[0];
    (openSubagent?.props.onClick as (() => void) | undefined)?.();
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });

    const viewer = findElements(output, (element) => element.type === SubagentSessionViewer)[0];
    expect(viewer?.props.open).toBe(true);
    const viewedWorkingRows = findElements(
      viewer?.props.children as ReactNode,
      (element) => element.type === MessageScrollerItem && element.props.messageId === "working:subagent-1",
    );
    expect(viewedWorkingRows).toHaveLength(1);
    const viewedIndicators = findElements(
      viewer?.props.children as ReactNode,
      (element) => element.type === WorkingIndicator,
    );
    expect(viewedIndicators).toHaveLength(1);
    expect(viewedIndicators[0]?.props.status).toBe("running");
    expect(
      renderTranscriptNodes(viewedIndicators[0]).filter(
        (node) => node.className === "ui-badge working-indicator",
      ),
    ).toEqual([expect.objectContaining({ text: "Working" })]);
  });
});
describe("message scroller controls", () => {
  it("uses immediate jump controls so reduced-motion preferences are respected", () => {
    expect(MessageScrollerButton({}).props.behavior).toBe("auto");
  });
});

function findComposerTextarea(output: ReactNode): ReactElement<Record<string, unknown>> {
  const textarea = findElements(output, (element) => element.props.id === "composer-message")[0];
  if (!textarea) throw new Error("Expected dashboard composer textarea");
  return textarea;
}

function pressComposerKey(
  textarea: ReactElement<Record<string, unknown>>,
  key: string,
  shiftKey = false,
  isComposing = false,
) {
  const preventDefault = vi.fn();
  const requestSubmit = vi.fn();
  (
    textarea.props.onKeyDown as (event: {
      key: string;
      shiftKey: boolean;
      metaKey: boolean;
      ctrlKey: boolean;
      altKey: boolean;
      nativeEvent: { isComposing: boolean };
      preventDefault(): void;
      currentTarget: { form: { requestSubmit(): void } };
    }) => void
  )({
    key,
    shiftKey,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    nativeEvent: { isComposing },
    preventDefault,
    currentTarget: { form: { requestSubmit } },
  });
  return { preventDefault, requestSubmit };
}

describe("dashboard composer keyboard", () => {
  it("requests form submission and prevents a native newline on plain Enter", () => {
    const output = renderControlledDashboard(composerDashboardProps());
    const { preventDefault, requestSubmit } = pressComposerKey(findComposerTextarea(output), "Enter");

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(requestSubmit).toHaveBeenCalledOnce();
  });

  it("leaves Shift+Enter untouched for the textarea's native newline behavior", () => {
    const output = renderControlledDashboard(composerDashboardProps());
    const { preventDefault, requestSubmit } = pressComposerKey(findComposerTextarea(output), "Enter", true);

    expect(preventDefault).not.toHaveBeenCalled();
    expect(requestSubmit).not.toHaveBeenCalled();
  });

  it("leaves Shift+Enter untouched when autocomplete suggestions are visible", () => {
    const props = composerDashboardProps({
      ...BASE_SESSION,
      skillCommands: [{ name: "skill:seo", description: "Audit search visibility" }],
    });
    let output = renderControlledDashboard(props);
    (findComposerTextarea(output).props.onChange as (event: { target: { value: string } }) => void)({
      target: { value: "/" },
    });
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });

    const { preventDefault, requestSubmit } = pressComposerKey(findComposerTextarea(output), "Enter", true);
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });

    expect(preventDefault).not.toHaveBeenCalled();
    expect(requestSubmit).not.toHaveBeenCalled();
    expect(findComposerTextarea(output).props.value).toBe("/");
  });

  it("leaves composing Enter untouched when autocomplete suggestions are visible", () => {
    const props = composerDashboardProps({
      ...BASE_SESSION,
      skillCommands: [{ name: "skill:seo", description: "Audit search visibility" }],
    });
    let output = renderControlledDashboard(props);
    (findComposerTextarea(output).props.onChange as (event: { target: { value: string } }) => void)({
      target: { value: "/" },
    });
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });

    const { preventDefault, requestSubmit } = pressComposerKey(
      findComposerTextarea(output),
      "Enter",
      false,
      true,
    );
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });

    expect(preventDefault).not.toHaveBeenCalled();
    expect(requestSubmit).not.toHaveBeenCalled();
    expect(findComposerTextarea(output).props.value).toBe("/");
  });

  it.each(["Enter", "Tab"])(
    "accepts the active autocomplete suggestion with %s instead of submitting",
    (key) => {
      const props = composerDashboardProps({
        ...BASE_SESSION,
        skillCommands: [{ name: "skill:seo", description: "Audit search visibility" }],
      });
      let output = renderControlledDashboard(props);
      (findComposerTextarea(output).props.onChange as (event: { target: { value: string } }) => void)({
        target: { value: "/" },
      });
      output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });

      const { preventDefault, requestSubmit } = pressComposerKey(findComposerTextarea(output), key);
      output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });

      expect(preventDefault).toHaveBeenCalledOnce();
      expect(requestSubmit).not.toHaveBeenCalled();
      expect(findComposerTextarea(output)?.props.value).toBe("/skill:seo ");
    },
  );

  it("does not render a composer footer or its keyboard shortcut", () => {
    const output = renderControlledDashboard(composerDashboardProps());

    expect(findElements(output, (element) => element.props.className === "composer-footer")).toHaveLength(0);
    expect(textContent(output)).not.toContain("⌘ ↵ to send");
  });
});

function renderAskToolCall(
  request: AskRequest,
  overrides: Partial<Parameters<typeof AskToolCall>[0]> = {},
  preserveState = false,
): ReactNode {
  if (!preserveState) {
    reactHarness.refValues = [];
    reactHarness.stateValues = [];
  }
  reactHarness.refIndex = 0;
  reactHarness.stateIndex = 0;
  const element = AskToolCall({
    request,
    connection: "connected",
    onRespond: vi.fn().mockResolvedValue(undefined),
    onActivity: vi.fn(),
    ...overrides,
  });
  if (!isValidElement(element) || typeof element.type !== "function") return element;
  return (element.type as (props: typeof element.props) => ReactNode)(element.props);
}

const SELECT_ASK: AskRequest = {
  sessionId: "session-1",
  requestId: "ask-select",
  kind: "select",
  title: "Choose a deployment target",
  options: ["Preview", "Production"],
  initialValue: null,
  expiresAt: null,
};

const TEXT_ASK: AskRequest = {
  sessionId: "session-1",
  requestId: "ask-text",
  kind: "text",
  title: "Describe the release",
  options: [],
  initialValue: "Initial context",
  expiresAt: null,
};

const RICH_ASK: AskRequest = {
  sessionId: "session-1",
  requestId: "ask-rich",
  kind: "rich",
  questions: [
    {
      id: "database",
      question: "Which database?",
      header: "Storage",
      options: [
        { label: "SQLite", description: "Embedded", preview: "file:local.db" },
        { label: "PostgreSQL", description: "Server", preview: "postgres://…" },
      ],
      multi: true,
      recommended: 1,
    },
  ],
  expiresAt: null,
};

const MULTIPLE_RICH_ASK: AskRequest = {
  sessionId: "session-1",
  requestId: "ask-multiple-rich",
  kind: "rich",
  questions: [
    {
      id: "target",
      question: "Which deployment target?",
      header: "Deployment",
      options: [
        { label: "Preview", description: "Private validation", preview: "preview.example.test" },
        { label: "Production", description: "Public release" },
      ],
      multi: false,
      recommended: 0,
    },
    {
      id: "checks",
      question: "Which checks should run?",
      options: [{ label: "Smoke tests" }, { label: "Full suite" }],
      multi: true,
    },
  ],
  expiresAt: null,
};

const SINGLE_RICH_ASK: AskRequest = {
  ...MULTIPLE_RICH_ASK,
  requestId: "ask-single-rich",
  questions: MULTIPLE_RICH_ASK.questions.slice(0, 1),
};

describe("AskToolCall", () => {
  it("renders transcript-native select controls and sends the selected value", async () => {
    const onRespond = vi.fn().mockResolvedValue(undefined);
    const output = renderAskToolCall(SELECT_ASK, { onRespond });
    const article = findElements(output, (element) => element.type === "article")[0];
    const preview = findElements(output, (element) => element.props.className === "ask-option")[0];

    expect(article?.props.className).toBe("transcript-entry transcript-tool transcript-ask");
    expect(textContent(output)).toContain("Choose a deployment target");
    expect(preview?.props.disabled).toBe(false);

    (preview?.props.onClick as (() => void) | undefined)?.();
    await Promise.resolve();

    expect(onRespond).toHaveBeenCalledWith({ value: "Preview" });
  });

  it("renders and submits every rich ask answer field", async () => {
    const onRespond = vi.fn().mockResolvedValue(undefined);
    let output = renderAskToolCall(RICH_ASK, { onRespond });
    expect(textContent(output)).toContain("Storage");
    expect(textContent(output)).toContain("Embedded");
    expect(textContent(output)).toContain("file:local.db");
    expect(textContent(output)).toContain("Recommended");

    const options = findElements(
      output,
      (element) => element.props.className === "ask-option ask-rich-option",
    );
    expect(options[0]?.props["aria-pressed"]).toBe(false);
    (options[1]?.props.onClick as (() => void) | undefined)?.();
    output = renderAskToolCall(RICH_ASK, { onRespond }, true);

    const custom = findElements(
      output,
      (element) => element.props.id === "ask-answer-session-1-ask-rich-0-custom",
    )[0];
    const note = findElements(
      output,
      (element) => element.props.id === "ask-answer-session-1-ask-rich-0-note",
    )[0];
    (custom?.props.onChange as ((event: { target: { value: string } }) => void) | undefined)?.({
      target: { value: "CockroachDB" },
    });
    (note?.props.onChange as ((event: { target: { value: string } }) => void) | undefined)?.({
      target: { value: "Needs horizontal scaling" },
    });
    output = renderAskToolCall(RICH_ASK, { onRespond }, true);
    const submit = findElements(
      output,
      (element) => typeof element.props.onClick === "function" && textContent(element) === "Submit answers",
    )[0];
    expect(submit?.props.disabled).toBe(false);
    (submit?.props.onClick as (() => void) | undefined)?.();
    await Promise.resolve();

    expect(onRespond).toHaveBeenCalledWith({
      kind: "submit",
      results: [
        {
          id: "database",
          question: "Which database?",
          options: ["SQLite", "PostgreSQL"],
          multi: true,
          selectedOptions: ["PostgreSQL"],
          customInput: "CockroachDB",
          note: "Needs horizontal scaling",
        },
      ],
    });
  });

  it("uses Base UI radios for single-select questions and toggle buttons for multi-select", () => {
    const output = renderAskToolCall(MULTIPLE_RICH_ASK);
    const fieldsets = findElements(output, (element) => element.type === "fieldset");
    const legends = findElements(output, (element) => element.type === "legend");
    const radioGroups = findElements(output, (element) => element.type === RadioGroup);
    const radios = findElements(output, (element) => element.type === Radio.Root);
    const multiGroup = fieldsets[1];
    const toggleButtons = findElements(
      multiGroup,
      (element) => element.props.className === "ask-option ask-rich-option",
    );

    expect(textContent(output)).toContain("2 questions");
    expect(fieldsets).toHaveLength(2);
    expect(radioGroups).toHaveLength(1);
    expect(radios).toHaveLength(2);
    expect(radioGroups[0]?.props["aria-labelledby"]).toBe(legends[0]?.props.id);
    expect(radioGroups[0]?.props.disabled).toBe(false);
    expect(toggleButtons.map((button) => button.props["aria-pressed"])).toEqual([false, false]);
    expect(textContent(radios[0])).toContain("preview.example.test");

    const disconnected = renderAskToolCall(MULTIPLE_RICH_ASK, { connection: "disconnected" });
    expect(findElements(disconnected, (element) => element.type === RadioGroup)[0]?.props.disabled).toBe(
      true,
    );
    expect(
      findElements(
        disconnected,
        (element) =>
          element.props.className === "ask-option ask-rich-option" && "aria-pressed" in element.props,
      ).every((button) => button.props.disabled === true),
    ).toBe(true);
  });

  it("requires every rich question and emits activity for each option and input change", () => {
    const onActivity = vi.fn();
    let output = renderAskToolCall(MULTIPLE_RICH_ASK, { onActivity });
    expect(
      findElements(
        output,
        (element) => typeof element.props.onClick === "function" && textContent(element) === "Submit answers",
      )[0]?.props.disabled,
    ).toBe(true);
    const radioGroup = findElements(output, (element) => element.type === RadioGroup)[0];
    (radioGroup?.props.onValueChange as ((value: string) => void) | undefined)?.("Preview");
    output = renderAskToolCall(MULTIPLE_RICH_ASK, { onActivity }, true);
    expect(
      findElements(
        output,
        (element) => typeof element.props.onClick === "function" && textContent(element) === "Submit answers",
      )[0]?.props.disabled,
    ).toBe(true);

    const multiOption = findElements(
      output,
      (element) =>
        element.props.className === "ask-option ask-rich-option" && element.props["aria-pressed"] === false,
    ).at(-1);
    (multiOption?.props.onClick as (() => void) | undefined)?.();
    output = renderAskToolCall(MULTIPLE_RICH_ASK, { onActivity }, true);
    expect(
      findElements(
        output,
        (element) => typeof element.props.onClick === "function" && textContent(element) === "Submit answers",
      )[0]?.props.disabled,
    ).toBe(false);

    const custom = findElements(
      output,
      (element) => element.props.id === "ask-answer-session-1-ask-multiple-rich-1-custom",
    )[0];
    const note = findElements(
      output,
      (element) => element.props.id === "ask-answer-session-1-ask-multiple-rich-1-note",
    )[0];
    (custom?.props.onChange as ((event: { target: { value: string } }) => void) | undefined)?.({
      target: { value: "Canary check" },
    });
    (note?.props.onChange as ((event: { target: { value: string } }) => void) | undefined)?.({
      target: { value: "Run before promotion" },
    });
    expect(onActivity).toHaveBeenCalledTimes(4);
  });

  it("keeps single-select options and custom answers mutually exclusive in both directions", async () => {
    const onRespond = vi.fn().mockResolvedValue(undefined);
    const onActivity = vi.fn();
    let output = renderAskToolCall(SINGLE_RICH_ASK, { onRespond, onActivity });
    let radioGroup = findElements(output, (element) => element.type === RadioGroup)[0];
    (radioGroup?.props.onValueChange as ((value: string) => void) | undefined)?.("Preview");
    output = renderAskToolCall(SINGLE_RICH_ASK, { onRespond, onActivity }, true);

    let custom = findElements(
      output,
      (element) => element.props.id === "ask-answer-session-1-ask-single-rich-0-custom",
    )[0];
    expect(custom?.props.value).toBe("");
    (custom?.props.onChange as ((event: { target: { value: string } }) => void) | undefined)?.({
      target: { value: "Staging" },
    });
    output = renderAskToolCall(SINGLE_RICH_ASK, { onRespond, onActivity }, true);
    radioGroup = findElements(output, (element) => element.type === RadioGroup)[0];
    expect(radioGroup?.props.value).toBe("");

    (radioGroup?.props.onValueChange as ((value: string) => void) | undefined)?.("Production");
    output = renderAskToolCall(SINGLE_RICH_ASK, { onRespond, onActivity }, true);
    custom = findElements(
      output,
      (element) => element.props.id === "ask-answer-session-1-ask-single-rich-0-custom",
    )[0];
    expect(custom?.props.value).toBe("");
    const submit = findElements(
      output,
      (element) => typeof element.props.onClick === "function" && textContent(element) === "Submit answers",
    )[0];
    (submit?.props.onClick as (() => void) | undefined)?.();
    await Promise.resolve();

    expect(onRespond).toHaveBeenCalledWith({
      kind: "submit",
      results: [
        {
          id: "target",
          question: "Which deployment target?",
          options: ["Preview", "Production"],
          multi: false,
          selectedOptions: ["Production"],
        },
      ],
    });
    expect(onActivity).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["Chat about this", { kind: "chat" }],
    ["Cancel", { cancelled: true }],
  ])("supports rich ask %s", async (label, response) => {
    const onRespond = vi.fn().mockResolvedValue(undefined);
    const output = renderAskToolCall(RICH_ASK, { onRespond });
    const action = findElements(
      output,
      (element) => typeof element.props.onClick === "function" && textContent(element) === label,
    )[0];
    (action?.props.onClick as (() => void) | undefined)?.();
    await Promise.resolve();
    expect(onRespond).toHaveBeenCalledWith(response);
  });

  it("keeps text input labelled, does not autofocus it, and submits the current draft", async () => {
    const onRespond = vi.fn().mockResolvedValue(undefined);
    const textRequest = { ...TEXT_ASK, sessionId: "session one", requestId: "ask / text" };
    let output = renderAskToolCall(textRequest, { onRespond });
    let textarea = findElements(output, (element) => element.props.className === "ask-textarea")[0];

    expect(textarea?.props.value).toBe("Initial context");
    expect(textarea?.props.autoFocus).toBeUndefined();
    expect(findElements(output, (element) => element.type === "label")[0]?.props.htmlFor).toBe(
      textarea?.props.id,
    );
    expect(textarea?.props.id).toBe("ask-answer-session%20one-ask%20%2F%20text");

    (textarea?.props.onChange as ((event: { target: { value: string } }) => void) | undefined)?.({
      target: { value: "Release after smoke checks" },
    });
    output = renderAskToolCall(textRequest, { onRespond }, true);
    textarea = findElements(output, (element) => element.props.className === "ask-textarea")[0];
    const form = findElements(output, (element) => element.type === "form")[0];
    const preventDefault = vi.fn();
    (form?.props.onSubmit as ((event: { preventDefault(): void }) => void) | undefined)?.({
      preventDefault,
    });
    await Promise.resolve();

    expect(textarea?.props.value).toBe("Release after smoke checks");
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(onRespond).toHaveBeenCalledWith({ value: "Release after smoke checks" });
  });
  it("sends cancellation and restores composer focus only after success", async () => {
    const focus = vi.fn();
    const querySelector = vi.fn().mockReturnValue({ focus });
    vi.stubGlobal("document", { querySelector });
    try {
      const onRespond = vi.fn().mockResolvedValue(undefined);
      const output = renderAskToolCall(SELECT_ASK, { onRespond });
      const cancel = findElements(
        output,
        (element) => typeof element.props.onClick === "function" && textContent(element) === "Cancel",
      )[0];

      (cancel?.props.onClick as (() => void) | undefined)?.();
      await Promise.resolve();

      expect(onRespond).toHaveBeenCalledWith({ cancelled: true });
      expect(querySelector).toHaveBeenCalledWith("#composer-message");
      expect(focus).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("disables all actions while pending and leaves cancel available when disconnected", () => {
    const pending = new Promise<void>(() => {});
    const onRespond = vi.fn().mockReturnValue(pending);
    let output = renderAskToolCall(SELECT_ASK, { onRespond });
    expect(textContent(findElements(output, (element) => element.props.className === "ask-status")[0])).toBe(
      "Waiting for your response",
    );
    const preview = findElements(output, (element) => element.props.className === "ask-option")[0];
    (preview?.props.onClick as (() => void) | undefined)?.();

    output = renderAskToolCall(SELECT_ASK, { onRespond }, true);
    expect(findElements(output, (element) => element.type === "article")[0]?.props["aria-busy"]).toBe(true);
    expect(textContent(findElements(output, (element) => element.props.className === "ask-status")[0])).toBe(
      "Sending response…",
    );
    expect(
      findElements(output, (element) => element.props.className === "ask-option").every(
        (element) => element.props.disabled === true,
      ),
    ).toBe(true);
    expect(
      findElements(
        output,
        (element) => typeof element.props.onClick === "function" && textContent(element) === "Cancel",
      )[0]?.props.disabled,
    ).toBe(true);

    output = renderAskToolCall(SELECT_ASK, { connection: "disconnected" });
    expect(
      findElements(output, (element) => element.props.className === "ask-option")[0]?.props.disabled,
    ).toBe(true);
    expect(
      findElements(
        output,
        (element) => typeof element.props.onClick === "function" && textContent(element) === "Cancel",
      )[0]?.props.disabled,
    ).toBe(false);
  });

  it("shows a delivery error, re-enables controls, and does not steal focus", async () => {
    const querySelector = vi.fn();
    vi.stubGlobal("document", { querySelector });
    try {
      const onRespond = vi.fn().mockRejectedValue(new Error("Host connection dropped"));
      let output = renderAskToolCall(SELECT_ASK, { onRespond });
      const preview = findElements(output, (element) => element.props.className === "ask-option")[0];
      (preview?.props.onClick as (() => void) | undefined)?.();
      await Promise.resolve();
      await Promise.resolve();

      output = renderAskToolCall(SELECT_ASK, { onRespond }, true);
      const alert = findElements(output, (element) => element.props.role === "alert")[0];
      expect(textContent(alert)).toBe("Host connection dropped");
      expect(
        findElements(output, (element) => element.props.className === "ask-option")[0]?.props.disabled,
      ).toBe(false);
      expect(querySelector).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("dashboard ask stream", () => {
  it("keeps the selected session ask as a stable row inside transcript content", async () => {
    const message = {
      id: "message-1",
      role: "user" as const,
      text: "Transcript input",
      presentation: "text" as const,
      timestamp: "2026-07-31T12:00:00.000Z",
      streaming: false,
    };
    const onRespondToAsk = vi.fn().mockResolvedValue(undefined);
    const onAskActivity = vi.fn().mockResolvedValue(undefined);
    const output = renderControlledDashboard({
      ...DASHBOARD_DEFAULTS,
      sessions: [{ ...BASE_SESSION, messages: [message] }],
      askRequests: [SELECT_ASK],
      sessionsReady: true,
      historyLoading: false,
      hasMoreHistory: false,
      connection: "connected",
      error: null,
      notificationState: "unsupported",
      selectedSessionId: "session-1",
      onRespondToAsk,
      onAskActivity,
      onSelectedSessionChange: vi.fn(),
    });
    const viewport = findElements(output, (element) => element.type === MessageScrollerViewport)[0];
    const content = findElements(viewport, (element) => element.type === MessageScrollerContent)[0];
    const rows = findElements(content, (element) => element.type === MessageScrollerItem);
    const messageRow = rows.find((row) => row.props.messageId === "message-1");
    const askRow = rows.find((row) => row.props.messageId === "ask:session-1:ask-select");
    const ask = findElements(askRow, (element) => element.type === AskToolCall)[0];

    expect(viewport?.props.className).toBe("transcript");
    expect(viewport?.props["aria-label"]).toBe("Session transcript");
    expect(content?.props.role).toBe("log");
    expect(content?.props["aria-live"]).toBe("polite");
    expect(messageRow?.props.scrollAnchor).toBe(true);
    expect(askRow).toBeDefined();
    await (ask?.props.onRespond as ((response: { value: string }) => Promise<void>) | undefined)?.({
      value: "Preview",
    });
    expect(onRespondToAsk).toHaveBeenCalledWith("session-1", "ask-select", { value: "Preview" });
    (ask?.props.onActivity as (() => void) | undefined)?.();
    expect(onAskActivity).toHaveBeenCalledWith("session-1", "ask-select");
    expect(findElements(output, (element) => element.props.open === true)).toHaveLength(0);
  });

  it("shows an ask in an empty selected session without rendering the ready state", () => {
    const output = renderControlledDashboard({
      ...DASHBOARD_DEFAULTS,
      sessions: [BASE_SESSION],
      askRequests: [SELECT_ASK],
      sessionsReady: true,
      historyLoading: false,
      hasMoreHistory: false,
      connection: "connected",
      error: null,
      notificationState: "unsupported",
      selectedSessionId: "session-1",
      onSelectedSessionChange: vi.fn(),
    });

    expect(textContent(output)).not.toContain("Ready for an instruction");
    expect(findElements(output, (element) => element.type === AskToolCall)).toHaveLength(1);
  });

  it("does not render another session's ask in the selected transcript", () => {
    const otherAsk = { ...SELECT_ASK, sessionId: "session-2", title: "Other session question" };
    const output = renderControlledDashboard({
      ...DASHBOARD_DEFAULTS,
      sessions: [BASE_SESSION, { ...BASE_SESSION, id: "session-2" }],
      askRequests: [otherAsk],
      sessionsReady: true,
      historyLoading: false,
      hasMoreHistory: false,
      connection: "connected",
      error: null,
      notificationState: "unsupported",
      selectedSessionId: "session-1",
      onSelectedSessionChange: vi.fn(),
    });

    expect(findElements(output, (element) => element.type === AskToolCall)).toHaveLength(0);
    expect(textContent(output)).not.toContain("Other session question");
    expect(textContent(output)).toContain("Ready for an instruction");
  });
});

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

describe("dashboard launch selection", () => {
  const baseProps = {
    sessions: [BASE_SESSION],
    sessionsReady: true,
    historyLoading: false,
    hasMoreHistory: false,
    connection: "connected" as const,
    error: null,
    notificationState: "enabled" as const,
    selectedSessionId: BASE_SESSION.id,
    ...DASHBOARD_DEFAULTS,
  };

  it("selects the exact session returned by a successful new launch and resets the modal", async () => {
    const onLaunch = vi.fn().mockResolvedValue("new-session-id");
    const onSelectedSessionChange = vi.fn();
    const props = { ...baseProps, onLaunch, onSelectedSessionChange };
    let output = renderControlledDashboard(props);
    const newSessionButton = findElements(output, (element) => textContent(element) === "New session")[0];
    (newSessionButton?.props.onClick as (() => void) | undefined)?.();
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });
    const cwdInput = findElements(output, (element) => element.props.id === "launch-cwd")[0];
    (cwdInput?.props.onChange as ((event: { target: { value: string } }) => void) | undefined)?.({
      target: { value: " /work/new-project " },
    });
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });
    const form = findElements(output, (element) => element.props.className === "launch-form")[0];
    const reset = vi.fn();
    vi.stubGlobal(
      "FormData",
      class {
        get() {
          return " resume-session ";
        }
      },
    );
    try {
      await (
        form?.props.onSubmit as
          | ((event: { preventDefault(): void; currentTarget: { reset(): void } }) => Promise<void>)
          | undefined
      )?.({ preventDefault: vi.fn(), currentTarget: { reset } });
    } finally {
      vi.unstubAllGlobals();
    }

    expect(onLaunch).toHaveBeenCalledWith("/work/new-project", "resume-session");
    expect(onSelectedSessionChange).toHaveBeenCalledOnce();
    expect(onSelectedSessionChange).toHaveBeenCalledWith("new-session-id");
    expect(reset).toHaveBeenCalledOnce();
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });
    expect(
      findElements(output, (element) => element.props.title === "Start an OMP session")[0]?.props.open,
    ).toBe(false);
  });

  it("selects the exact session returned by a successful resume", async () => {
    const historySession = {
      ...BASE_SESSION,
      source: "history" as const,
      status: "history" as const,
      connected: false,
    };
    const onLaunch = vi.fn().mockResolvedValue("resumed-session-id");
    const onSelectedSessionChange = vi.fn();
    const output = renderControlledDashboard({
      ...baseProps,
      sessions: [historySession],
      selectedSessionId: historySession.id,
      onLaunch,
      onSelectedSessionChange,
    });
    const resumeButton = findElements(output, (element) => textContent(element) === "Resume session")[0];
    (resumeButton?.props.onClick as (() => void) | undefined)?.();
    await Promise.resolve();

    expect(onLaunch).toHaveBeenCalledWith(historySession.cwd, historySession.sessionPath);
    expect(onSelectedSessionChange).toHaveBeenCalledOnce();
    expect(onSelectedSessionChange).toHaveBeenCalledWith("resumed-session-id");
  });

  it("does not select a session when resume fails", async () => {
    const historySession = {
      ...BASE_SESSION,
      source: "history" as const,
      status: "history" as const,
      connected: false,
    };
    const onSelectedSessionChange = vi.fn();
    const output = renderControlledDashboard({
      ...baseProps,
      sessions: [historySession],
      selectedSessionId: historySession.id,
      onLaunch: vi.fn().mockRejectedValue(new Error("resume failed")),
      onSelectedSessionChange,
    });
    const resumeButton = findElements(output, (element) => textContent(element) === "Resume session")[0];
    (resumeButton?.props.onClick as (() => void) | undefined)?.();
    await Promise.resolve();

    expect(onSelectedSessionChange).not.toHaveBeenCalled();
  });

  it("does not select or reset the modal when a new launch fails", async () => {
    const onLaunch = vi.fn().mockRejectedValue(new Error("launch failed"));
    const onSelectedSessionChange = vi.fn();
    const props = { ...baseProps, onLaunch, onSelectedSessionChange };
    let output = renderControlledDashboard(props);
    const newSessionButton = findElements(output, (element) => textContent(element) === "New session")[0];
    (newSessionButton?.props.onClick as (() => void) | undefined)?.();
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });
    const cwdInput = findElements(output, (element) => element.props.id === "launch-cwd")[0];
    (cwdInput?.props.onChange as ((event: { target: { value: string } }) => void) | undefined)?.({
      target: { value: "/work/failing-project" },
    });
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });
    const form = findElements(output, (element) => element.props.className === "launch-form")[0];
    const reset = vi.fn();
    vi.stubGlobal(
      "FormData",
      class {
        get() {
          return "";
        }
      },
    );
    try {
      await (
        form?.props.onSubmit as
          | ((event: { preventDefault(): void; currentTarget: { reset(): void } }) => Promise<void>)
          | undefined
      )?.({ preventDefault: vi.fn(), currentTarget: { reset } });
    } finally {
      vi.unstubAllGlobals();
    }

    expect(onSelectedSessionChange).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });
    expect(textContent(output)).toContain("launch failed");
    expect(
      findElements(output, (element) => element.props.title === "Start an OMP session")[0]?.props.open,
    ).toBe(true);
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
