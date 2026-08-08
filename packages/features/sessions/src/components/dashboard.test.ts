import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import type {
  AskRequest,
  Session,
  SessionBranchTopology,
  SessionFileChangesResponse,
} from "@omp-remote/protocol";
import type * as ReactModule from "react";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

const messageScrollerHarness = vi.hoisted(() => ({
  scrollToEnd: vi.fn(),
}));

vi.mock("./ui/message-scroller.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    useMessageScroller: () => ({ scrollToEnd: messageScrollerHarness.scrollToEnd }),
  };
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
    useSidebar: () => ({ isMobile: reactHarness.isMobile, setOpenMobile: vi.fn() }),
  };
});

function cleanupReactHarnessEffects() {
  for (const effect of reactHarness.effectValues) effect.cleanup?.();
  reactHarness.effectIndex = 0;
  reactHarness.effectValues = [];
}

beforeEach(() => {
  if (reactHarness.lifecycleEffects) cleanupReactHarnessEffects();
  reactHarness.effectsEnabled = true;
  reactHarness.effectIndex = 0;
  reactHarness.effectValues = [];
  reactHarness.isMobile = false;
  reactHarness.lifecycleEffects = false;
  reactHarness.refIndex = 0;
  reactHarness.refValues = [];
  reactHarness.stateIndex = 0;
  reactHarness.stateValues = [];
  messageScrollerHarness.scrollToEnd.mockReset();
});

import {
  AskToolCall,
  canKillSession,
  Dashboard,
  type DashboardProps,
  findLatestTodoResult,
  formatSubagentActivityLabel,
  formatSystemTextPreview,
  formatToolTextPreview,
  getActiveAskRequest,
  getComposerAction,
  getSkillSuggestions,
  groupSessionsForSidebar,
  MessageScrollerScrollController,
  parseDisclosureImages,
  parseInlineTranscript,
  parseTodoResult,
  parseTranscriptBlocks,
  renderTranscriptMessageItems,
  SystemTranscriptText,
  TodoToolTranscript,
  ToolTranscriptText,
  TranscriptCodeBlock,
  TranscriptEntry,
  tokenizeBashTitle,
  tokenizeCode,
  WorkingIndicator,
} from "./dashboard.js";
import { SessionBranchSelector, type SessionBranchSelectorProps } from "./session-branch-selector.js";
import { SessionFileChangesViewer } from "./session-file-changes-viewer.js";
import { SubagentSessionViewer } from "./subagent-session-viewer.js";
import { Drawer } from "./ui/drawer.js";
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

describe("parseDisclosureImages", () => {
  it("preserves surrounding text and every HTTPS image in source order", () => {
    expect(
      parseDisclosureImages(
        "before ![first](https://cdn.example/first.png) between ![second](https://cdn.example/second.webp?size=2#chart) after",
      ),
    ).toEqual([
      { kind: "text", text: "before " },
      { kind: "image", alt: "first", source: "https://cdn.example/first.png" },
      { kind: "text", text: " between " },
      {
        kind: "image",
        alt: "second",
        source: "https://cdn.example/second.webp?size=2#chart",
      },
      { kind: "text", text: " after" },
    ]);
  });

  it("leaves non-HTTPS and unsupported image syntax completely literal", () => {
    const text = [
      "![http](http://example.com/image.png)",
      "![data](data:image/png;base64,AQID)",
      "![blob](blob:https://example.com/id)",
      '![title](https://example.com/image.png "caption")',
      "![broken](https://example.com/image.png",
      String.raw`\![escaped](https://example.com/image.png)`,
    ].join("\n");

    expect(parseDisclosureImages(text)).toEqual([{ kind: "text", text }]);
  });
});

describe("Bash title rendering", () => {
  it("tokenizes chained commands losslessly with shell operators and quoted strings", () => {
    const title = String.raw`pnpm test && printf '%s\n' "https://example.com/a?b=1" > out.txt`;
    const tokens = tokenizeBashTitle(title);

    expect(tokens.map((token) => token.text).join("")).toBe(title);
    expect(tokens.filter((token) => token.kind === "operator").map((token) => token.text)).toEqual([
      "&&",
      ">",
    ]);
    expect(tokens.filter((token) => token.kind === "string").map((token) => token.text)).toEqual([
      "'%s\\n'",
      '"https://example.com/a?b=1"',
    ]);
    expect(tokens.filter((token) => token.kind === "word").map((token) => token.text)).toEqual([
      "pnpm",
      "test",
      "printf",
      "out.txt",
    ]);
  });

  it("keeps complete option and format words neutral", () => {
    const tokens = tokenizeBashTitle("grep -n +format --color=auto");

    expect(tokens.filter((token) => token.kind === "option").map((token) => token.text)).toEqual([
      "-n",
      "+format",
      "--color=auto",
    ]);
    expect(tokens.map((token) => token.text).join("")).toBe("grep -n +format --color=auto");
  });

  it("keeps escapes and URLs as lossless ordinary command text", () => {
    const title = String.raw`echo https://example.com/a\?b=1`;
    const tokens = tokenizeBashTitle(title);

    expect(tokens.map((token) => token.text).join("")).toBe(title);
    expect(tokens.filter((token) => token.kind === "string")).toHaveLength(0);
    expect(tokens.filter((token) => token.kind === "word").map((token) => token.text)).toEqual([
      "echo",
      "https://example.com/a\\?b=1",
    ]);
  });

  it("handles descriptor redirects and contextual bang tokens without false fallback", () => {
    const title = "! exec 10>out 2>&1 && if ! false; then echo foo!bar !; else ! true; fi";
    const tokens = tokenizeBashTitle(title);

    expect(tokens.map((token) => token.text).join("")).toBe(title);
    expect(tokens.filter((token) => token.kind === "operator").map((token) => token.text)).toEqual([
      "!",
      "10>",
      "2>&1",
      "&&",
      "!",
      ";",
      ";",
      "!",
      ";",
    ]);
    expect(tokens.filter((token) => token.kind === "word").map((token) => token.text)).toEqual([
      "exec",
      "out",
      "if",
      "false",
      "then",
      "echo",
      "foo!bar",
      "!",
      "else",
      "true",
      "fi",
    ]);
  });

  it("balances grouping and command substitutions inside complete quoted strings", () => {
    const title = 'echo "$(date)" `whoami` (printf ok)';
    const tokens = tokenizeBashTitle(title);

    expect(tokens.map((token) => token.text).join("")).toBe(title);
    expect(tokens.filter((token) => token.kind === "string").map((token) => token.text)).toEqual([
      '"$(date)"',
      "`whoami`",
    ]);
    expect(tokens.filter((token) => token.kind === "operator").map((token) => token.text)).toEqual([
      "(",
      ")",
    ]);
  });

  it.each([
    'echo "unfinished',
    "echo trailing\\",
    "echo (",
    "echo foo >&",
    "echo $(date",
    "echo foo | | cat",
    "| cat",
    "echo (date",
    "echo foo)",
    'echo "$(date"',
    "echo `date",
    "echo >>> out",
  ])("falls back to a plain lossless title for incomplete shell text: %s", (title) => {
    expect(tokenizeBashTitle(title)).toEqual([{ kind: "plain", text: title }]);
  });

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
    expect(output?.text).toBe("output remains neutral");
    expect(output?.className).not.toContain("transcript-command-token");
  });

  it("keeps non-Bash and missing titles plain", () => {
    const nonBash = renderTranscriptNodes(
      ToolTranscriptText({
        entry: {
          id: "non-bash-title",
          role: "tool",
          toolName: "write",
          toolTitle: "Bash: echo should stay plain",
          text: "result",
          timestamp: "2026-07-29T12:00:00.000Z",
          streaming: false,
          presentation: "text",
        },
      }),
    );
    const missing = renderTranscriptNodes(
      ToolTranscriptText({
        entry: {
          id: "missing-title",
          role: "tool",
          toolName: "bash",
          text: "result",
          timestamp: "2026-07-29T12:00:00.000Z",
          streaming: false,
          presentation: "text",
        },
      }),
    );

    expect(nonBash.some((node) => node.className?.includes("transcript-command-token-"))).toBe(false);
    expect(missing.some((node) => node.className?.includes("transcript-command-token-"))).toBe(false);
  });

  it("updates a streaming Bash title without recoloring its output", () => {
    let entry = {
      id: "streaming-bash-title",
      role: "tool" as const,
      toolName: "bash",
      toolTitle: "Bash: ec",
      text: "partial output",
      timestamp: "2026-07-29T12:00:00.000Z",
      streaming: true,
      presentation: "text" as const,
    };

    const first = renderToolTranscriptWithHooks(entry);
    entry = { ...entry, toolTitle: "Bash: echo ready" };
    const second = renderToolTranscriptWithHooks(entry, true);

    const firstTitle = first.find((node) => node.className === "transcript-command-title");
    const secondTitle = second.find((node) => node.className === "transcript-command-title");
    expect(textContent(firstTitle?.props?.children as ReactNode)).toBe("Bash: ec");
    expect(textContent(secondTitle?.props?.children as ReactNode)).toBe("Bash: echo ready");
    expect(second.find((node) => node.className === "transcript-disclosure-text")?.text).toBe(
      "partial output",
    );
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
    expect(block.type).toBe("details");
    expect(block.props.open).toBe(false);
    expect(block.props.children[0].type).toBe("summary");
    expect(block.props.className).toBe(
      "tool-message-disclosure transcript-disclosure-frame tool-output-disclosure",
    );
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

  it("keeps markdown-like generic output literal with one preview and expanded text style", () => {
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
    const preview = disclosure.props.children[0].props.children[2];
    const expanded = disclosure.props.children[1];
    const expandedNodes = renderTranscriptNodes(expanded);

    expect(preview.type).toBe("div");
    expect(expanded.type).toBe("div");
    expect(preview.props.className).toBe("transcript-disclosure-content");
    expect(preview.props["data-variant"]).toBe("thumbnail");
    expect(expanded.props.className).toBe(preview.props.className);
    expect(expanded.props["data-variant"]).toBe("expanded");
    expect(
      renderTranscriptNodes(preview).find((node) => node.className === "transcript-disclosure-text")?.text,
    ).toBe(formatToolTextPreview(text));
    expect(expandedNodes.find((node) => node.className === "transcript-disclosure-text")?.text).toBe(text);
    expect(expandedNodes.some((node) => node.type === "strong")).toBe(false);
    expect(expandedNodes.filter((node) => node.type === "a").map((node) => node.props?.href)).toEqual([
      "https://example.com",
    ]);
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
    const thumbnail = disclosure.props.children[0].props.children[2];
    const expanded = disclosure.props.children[1];
    const thumbnailNodes = renderTranscriptNodes(thumbnail);
    const expandedNodes = renderTranscriptNodes(expanded);
    const thumbnailImages = thumbnailNodes.filter((node) => node.type === "img");
    const expandedImages = expandedNodes.filter((node) => node.type === "img");
    const expandedLinks = expandedNodes.filter((node) => node.className === "disclosure-image-link");

    expect(thumbnail.props["data-variant"]).toBe("thumbnail");
    expect(expanded.props["data-variant"]).toBe("expanded");
    expect(thumbnailNodes.filter((node) => node.className === "disclosure-image")).toHaveLength(2);
    expect(expandedNodes.filter((node) => node.className === "disclosure-image")).toHaveLength(2);
    expect(thumbnailNodes.some((node) => node.type === "a")).toBe(false);
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
      expandedNodes
        .filter(
          (node) =>
            node.className === "transcript-disclosure-text" || node.className === "disclosure-image-link",
        )
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

  it("does not invent text for an image-only tool disclosure", () => {
    const source = "https://cdn.example/image-only.png";
    const disclosure = ToolTranscriptText({
      entry: {
        id: "tool-image-only",
        role: "tool",
        toolName: "bash",
        text: `![](${source})`,
        timestamp: "2026-07-29T12:00:00.000Z",
        streaming: false,
        presentation: "text",
      },
    });
    const nodes = renderTranscriptNodes(disclosure);

    expect(nodes.filter((node) => node.type === "img").map((node) => node.props?.src)).toEqual([
      source,
      source,
    ]);
    expect(nodes.some((node) => node.className === "transcript-disclosure-text")).toBe(false);
    expect(textContent(disclosure)).not.toContain("No tool output");
    expect(nodes.find((node) => node.className === "disclosure-image-link")?.props?.["aria-label"]).toBe(
      "Open image source",
    );
  });

  it("replaces a failed remote image with an accessible alt fallback", () => {
    const entry = {
      id: "tool-image-failure",
      role: "tool" as const,
      toolName: "bash",
      text: "![Architecture diagram](https://cdn.example/diagram.png)",
      timestamp: "2026-07-29T12:00:00.000Z",
      streaming: false,
      presentation: "text" as const,
    };
    const initialNodes = renderTranscriptNodes(ToolTranscriptText({ entry }));
    const initialImages = initialNodes.filter((node) => node.type === "img");
    expect(initialImages).toHaveLength(2);
    for (const image of initialImages) {
      if (typeof image.props?.onError !== "function") throw new Error("Expected image error handler");
      image.props.onError();
    }

    reactHarness.stateIndex = 0;
    reactHarness.refIndex = 0;
    reactHarness.effectIndex = 0;
    const failedNodes = renderTranscriptNodes(ToolTranscriptText({ entry }));
    const fallbacks = failedNodes.filter((node) => node.className === "disclosure-image-fallback");
    const expandedLink = failedNodes.find((node) => node.className === "disclosure-image-link");

    expect(fallbacks).toHaveLength(2);
    expect(fallbacks.every((fallback) => fallback.text === "Image unavailable: Architecture diagram")).toBe(
      true,
    );
    expect(fallbacks.every((fallback) => fallback.props?.role === "img")).toBe(true);
    expect(
      fallbacks.every(
        (fallback) => fallback.props?.["aria-label"] === "Image unavailable: Architecture diagram",
      ),
    ).toBe(true);
    expect(expandedLink?.props?.href).toBe("https://cdn.example/diagram.png");
    expect(expandedLink?.props?.target).toBe("_blank");
    expect(expandedLink?.props?.rel).toBe("noreferrer");
    expect(expandedLink?.props?.["aria-label"]).toBe("Open image source: Architecture diagram");
  });

  it("shows the Grep query, result counts, and scope in the disclosure header", () => {
    const title =
      'Grep: type: "toolCall"|toolCallId|arguments: \\{ path|name: "bash"|name: "edit" 24 matches · 3 files · in apps, packages';
    const disclosure = ToolTranscriptText({
      entry: {
        id: "grep-1",
        role: "tool",
        toolName: "grep",
        toolTitle: title,
        text: "matches",
        timestamp: "2026-07-29T12:00:00.000Z",
        streaming: false,
        presentation: "text",
      },
    });

    expect(
      textContent(
        renderTranscriptNodes(disclosure).find((node) => node.className === "message-author")?.props
          ?.children as ReactNode,
      ),
    ).toContain(title);
  });

  it("shows a canonical Read filename without rendering the result", () => {
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

    expect(
      textContent(nodes.find((node) => node.className === "message-author")?.props?.children as ReactNode),
    ).toContain("Read: dashboard.tsx");
    expect(nodes.some((node) => node.className === "tool-message-preview")).toBe(false);
    expect(nodes.some((node) => node.className === "tool-output-divider")).toBe(false);
    expect(nodes.some((node) => node.text.includes("1091:  return <details />;"))).toBe(false);
  });

  it("renders an untargeted Read error as a closed inspectable disclosure", () => {
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
    const details = nodes.find((node) => node.type === "details");

    expect(nodes[0]).toEqual(
      expect.objectContaining({
        type: "div",
        className: expect.stringContaining("read-result-disclosure"),
      }),
    );
    expect(details?.open).toBe(false);
    expect(nodes.find((node) => node.className === "message-author")?.text).toContain("Read");
    expect(nodes.find((node) => node.className === "read-result-preview")?.text).toBe(text);
    expect(nodes.filter((node) => node.className === "transcript-disclosure-text")).toHaveLength(2);
    expect(nodes.find((node) => node.className === "tool-output-divider")?.text).toBe("Output");
  });

  it("shows metadata-backed Read filenames without rendering the result", () => {
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

    expect(disclosure.type).toBe("div");
    expect(
      textContent(nodes.find((node) => node.className === "message-author")?.props?.children as ReactNode),
    ).toContain("Read: index.ts");
    expect(nodes.some((node) => node.text.includes("canonical read result"))).toBe(false);
  });

  it.each([
    "skill://using-woostack/references/session-learning.md",
    "pr://howarewoo/omp-remote/42",
    "issue://OMP-123",
    "agent://reviewer-1/output",
    "artifact://dashboard-result",
    "history://session-1",
    "memory://notes/current",
    "mcp://linear/issues",
    "local://implementation-plan.md",
    "rule://typescript",
    "vault://team/secret",
    "conflict://packages/features/sessions/src/components/dashboard.tsx",
    "https://example.com/docs/read?mode=raw#result",
  ])("renders the complete URI-like Read target in a closed inspectable disclosure: %s", (readTarget) => {
    const text = "# Heading\n**bold** and [docs](https://example.com)\n- literal";
    const disclosure = ToolTranscriptText({
      entry: {
        id: `uri-read-${readTarget}`,
        role: "tool",
        toolName: "read",
        readTarget,
        text,
        timestamp: "2026-07-29T12:00:00.000Z",
        streaming: false,
        presentation: "text",
      },
    });
    const nodes = renderTranscriptNodes(disclosure);
    const details = nodes.find((node) => node.type === "details");
    const rawTextNodes = nodes.filter((node) => node.className === "transcript-disclosure-text");

    expect(nodes[0]).toEqual(
      expect.objectContaining({
        type: "div",
        className: expect.stringContaining("read-result-disclosure"),
      }),
    );
    expect(details?.open).toBe(false);
    expect(nodes.find((node) => node.className === "message-author")?.text).toContain(`Read ${readTarget}`);
    expect(rawTextNodes.map((node) => node.text)).toEqual([text, text]);
    expect(nodes.filter((node) => node.type === "a").map((node) => node.props?.href)).toEqual([
      "https://example.com",
      "https://example.com",
    ]);
    expect(nodes.filter((node) => node.type === "a").some((node) => node.props?.href === readTarget)).toBe(
      false,
    );
    expect(nodes.some((node) => ["strong", "code"].includes(node.type ?? ""))).toBe(false);
    expect(nodes.find((node) => node.className === "tool-output-divider")?.text).toBe("Output");
  });

  it("infers a URI-like Read target from the snapshot header", () => {
    const readTarget = "pr://howarewoo/omp-remote/42";
    const text = `[${readTarget}#ABCD]\nPull request result`;
    const nodes = renderTranscriptNodes(
      ToolTranscriptText({
        entry: {
          id: "header-uri-read",
          role: "tool",
          toolName: "read",
          text,
          timestamp: "2026-07-29T12:00:00.000Z",
          streaming: false,
          presentation: "text",
        },
      }),
    );

    expect(nodes[0]?.className).toContain("read-result-disclosure");
    expect(nodes.find((node) => node.className === "message-author")?.text).toContain(`Read ${readTarget}`);
    expect(
      nodes.filter((node) => node.className === "transcript-disclosure-text").map((node) => node.text),
    ).toEqual([text, text]);
  });

  it("shows resolved-path metadata for an inspectable Read result", () => {
    const readResolvedPath = "/Users/example/.agents/skills/using-woostack/references/session-learning.md";
    const disclosure = ToolTranscriptText({
      entry: {
        id: "resolved-uri-read",
        role: "tool",
        toolName: "read",
        readTarget: "skill://using-woostack/references/session-learning.md",
        readResolvedPath,
        text: "literal result",
        timestamp: "2026-07-29T12:00:00.000Z",
        streaming: false,
        presentation: "text",
      },
    });
    const nodes = renderTranscriptNodes(disclosure);

    expect(nodes.find((node) => node.className === "read-result-resolved-path")?.text).toContain(
      `Resolved path: ${readResolvedPath}`,
    );
  });

  it("keeps local Read image paths out of image disclosure content", () => {
    const readTarget = "/Users/example/work/private/diagram.png";
    const readResolvedPath = "/private/var/tmp/omp/blobs/diagram.png";
    const nodes = renderTranscriptNodes(
      ToolTranscriptText({
        entry: {
          id: "local-read-image",
          role: "tool",
          toolName: "read",
          readTarget,
          readResolvedPath,
          text: "",
          images: [{ status: "unavailable", reason: "missing" }],
          timestamp: "2026-07-29T12:00:00.000Z",
          streaming: false,
          presentation: "text",
        },
      }),
    );

    expect(nodes.find((node) => node.className === "message-author")?.text).toContain("Read diagram.png");
    expect(nodes.find((node) => node.className === "disclosure-image-fallback")?.text).toBe(
      "Image unavailable: diagram.png",
    );
    expect(nodes.some((node) => node.text.includes(readTarget) || node.text.includes(readResolvedPath))).toBe(
      false,
    );
  });

  it("renders every Read payload state without sourcing or exposing its resolved local path", async () => {
    const createObjectURL = vi.fn().mockReturnValue("blob:read-image");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    reactHarness.lifecycleEffects = true;
    const readTarget = "skill://using-woostack/assets/diagram.png";
    const readResolvedPath = "/Users/example/.agents/skills/using-woostack/assets/diagram.png";
    const entry: Session["messages"][number] = {
      id: "read-image-payloads",
      role: "tool",
      toolName: "read",
      readTarget,
      readResolvedPath,
      text: "",
      images: [
        { status: "available", mimeType: "image/png", data: "AQIDBA==" },
        { status: "unavailable", reason: "missing" },
        { status: "available", mimeType: "image/webp", data: "%%%=" },
      ],
      timestamp: "2026-07-29T12:00:00.000Z",
      streaming: false,
      presentation: "text",
    };

    try {
      const pendingNodes = renderToolTranscriptWithHooks(entry);
      expect(
        pendingNodes
          .filter((node) => node.className === "disclosure-image-fallback")
          .map((node) => node.text),
      ).toEqual([
        `Loading image: ${readTarget}`,
        `Image unavailable: ${readTarget}`,
        `Loading image: ${readTarget}`,
        `Loading image: ${readTarget}`,
        `Image unavailable: ${readTarget}`,
        `Loading image: ${readTarget}`,
      ]);
      const nodes = renderToolTranscriptWithHooks(entry, true);
      const images = nodes.filter((node) => node.type === "img");
      const links = nodes.filter((node) => node.className === "disclosure-image-link");
      const fallbacks = nodes.filter((node) => node.className === "disclosure-image-fallback");
      const blob = createObjectURL.mock.calls[0]?.[0];
      expect(blob).toBeInstanceOf(Blob);
      if (!(blob instanceof Blob)) throw new Error("Expected createObjectURL to receive a Blob");

      expect(createObjectURL).toHaveBeenCalledTimes(1);
      expect(blob.type).toBe("image/png");
      expect(Array.from(new Uint8Array(await blob.arrayBuffer()))).toEqual([1, 2, 3, 4]);
      expect(nodes.filter((node) => node.className === "disclosure-image")).toHaveLength(6);
      expect(images.map((node) => node.props?.src)).toEqual(["blob:read-image", "blob:read-image"]);
      expect(
        links.map((node) => ({
          href: node.props?.href,
          rel: node.props?.rel,
          target: node.props?.target,
        })),
      ).toEqual([{ href: "blob:read-image", rel: "noreferrer", target: "_blank" }]);
      expect(fallbacks).toHaveLength(4);
      expect(fallbacks.every((node) => node.text === `Image unavailable: ${readTarget}`)).toBe(true);
      expect(nodes.some((node) => node.text.includes(readResolvedPath))).toBe(false);
      expect(
        nodes.some((node) => node.props?.src === readResolvedPath || node.props?.href === readResolvedPath),
      ).toBe(false);

      const thumbnailImage = images[0];
      if (typeof thumbnailImage?.props?.onError !== "function")
        throw new Error("Expected Read image error handler");
      thumbnailImage.props.onError();
      const failedNodes = renderToolTranscriptWithHooks(entry, true);
      expect(
        failedNodes.filter((node) => node.className === "disclosure-image-fallback").map((node) => node.text),
      ).toContain(`Image unavailable: ${readTarget}`);
      expect(failedNodes.filter((node) => node.type === "img")).toHaveLength(1);
    } finally {
      cleanupReactHarnessEffects();
      reactHarness.lifecycleEffects = false;
      vi.unstubAllGlobals();
    }
  });

  it("revokes Read payload object URLs exactly on replacement and unmount", () => {
    const createObjectURL = vi
      .fn()
      .mockReturnValueOnce("blob:first-read-image")
      .mockReturnValueOnce("blob:replacement-read-image");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    reactHarness.lifecycleEffects = true;
    const firstImages: NonNullable<Session["messages"][number]["images"]> = [
      { status: "available", mimeType: "image/png", data: "AQIDBA==" },
    ];
    const replacementImages: NonNullable<Session["messages"][number]["images"]> = [
      { status: "available", mimeType: "image/jpeg", data: "BQYHCA==" },
    ];
    const baseEntry: Session["messages"][number] = {
      id: "read-image-lifecycle",
      role: "tool",
      toolName: "read",
      readTarget: "artifact://image-result",
      text: "",
      images: firstImages,
      timestamp: "2026-07-29T12:00:00.000Z",
      streaming: false,
      presentation: "text",
    };

    try {
      renderToolTranscriptWithHooks(baseEntry);
      const initialNodes = renderToolTranscriptWithHooks(baseEntry, true);
      expect(initialNodes.filter((node) => node.type === "img").map((node) => node.props?.src)).toEqual([
        "blob:first-read-image",
        "blob:first-read-image",
      ]);
      expect(revokeObjectURL).not.toHaveBeenCalled();

      const replacementEntry = { ...baseEntry, images: replacementImages };
      renderToolTranscriptWithHooks(replacementEntry, true);
      expect(revokeObjectURL).toHaveBeenCalledTimes(1);
      expect(revokeObjectURL).toHaveBeenLastCalledWith("blob:first-read-image");
      const replacementNodes = renderToolTranscriptWithHooks(replacementEntry, true);
      expect(replacementNodes.filter((node) => node.type === "img").map((node) => node.props?.src)).toEqual([
        "blob:replacement-read-image",
        "blob:replacement-read-image",
      ]);

      const emptyEntry = { ...baseEntry, images: [] };
      renderToolTranscriptWithHooks(emptyEntry, true);
      expect(revokeObjectURL).toHaveBeenCalledTimes(2);
      expect(revokeObjectURL).toHaveBeenLastCalledWith("blob:replacement-read-image");
      const emptyNodes = renderToolTranscriptWithHooks(emptyEntry, true);
      expect(emptyNodes.some((node) => node.type === "img")).toBe(false);

      cleanupReactHarnessEffects();
      expect(revokeObjectURL).toHaveBeenCalledTimes(2);
      expect(createObjectURL).toHaveBeenCalledTimes(2);
    } finally {
      cleanupReactHarnessEffects();
      reactHarness.lifecycleEffects = false;
      vi.unstubAllGlobals();
    }
  });

  it("truncates an inspectable Read preview without truncating its expandable raw result", () => {
    const text = Array.from({ length: 14 }, (_, index) => `line ${index + 1}`).join("\n");
    const disclosure = ToolTranscriptText({
      entry: {
        id: "truncated-uri-read",
        role: "tool",
        toolName: "read",
        readTarget: "ssh://example.com/var/log/omp.log",
        text,
        timestamp: "2026-07-29T12:00:00.000Z",
        streaming: false,
        presentation: "text",
      },
    });
    const nodes = renderTranscriptNodes(disclosure);

    expect(nodes.find((node) => node.className === "read-result-preview")?.text).toContain(
      "line 12… 2 more lines",
    );
    expect(nodes.filter((node) => node.className === "transcript-disclosure-text").at(-1)?.text).toBe(text);
  });

  it("renders adjacent Reads as separate sequential scroller items", () => {
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
    const rows = renderTranscriptMessageItems({ messages });

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row?.key)).toEqual(["read-first", "read-second"]);
    expect(rows.map((row) => row?.props.messageId)).toEqual(["read-first", "read-second"]);
  });

  it("renders edit output as an open disclosure by default", () => {
    const block = ToolTranscriptText({
      entry: {
        id: "edit-1",
        role: "tool",
        toolName: "edit",
        toolTitle: "Edit: 🟦 src/dashboard.tsx ⟦+1⟧ ⟦−1⟧",
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
    expect(
      textContent(nodes.find((node) => node.className === "message-author")?.props?.children as ReactNode),
    ).toContain("Edit: 🟦 src/dashboard.tsx ⟦+1⟧ ⟦−1⟧");
  });

  it("renders write output in the shared open frame with a labeled divider and full result", () => {
    const text = ["Wrote 42 bytes to", "packages/features/sessions/src/components/dashboard.tsx"].join("\n");
    const disclosure = ToolTranscriptText({
      entry: {
        id: "write-1",
        role: "tool",
        toolName: "write",
        toolTitle: "Write: packages/features/sessions/src/components/dashboard.tsx",
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
    expect(
      textContent(nodes.find((node) => node.className === "message-author")?.props?.children as ReactNode),
    ).toContain("Write: packages/features/sessions/src/components/dashboard.tsx");
    expect(nodes.find((node) => node.className === "tool-output-divider")?.text).toBe("Output");
    expect(disclosure.props.children[1].props.children).toBe(text);
  });

  it.each(["", " \n\t "])("labels empty write output in the expanded disclosure: %j", (text) => {
    const disclosure = ToolTranscriptText({
      entry: {
        id: "empty-write",
        role: "tool",
        toolName: "write",
        text,
        timestamp: "2026-07-29T12:00:00.000Z",
        streaming: false,
        presentation: "text",
      },
    });
    const expanded = disclosure.props.children[1];

    expect(expanded.props.className).toBe("transcript-disclosure-text");
    expect(expanded.props.children).toBe("No tool output");
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
    expect(nodes.find((node) => node.className === "tool-output-divider")?.text).toBe("Output");
    expect(nodes.findIndex((node) => node.className === "tool-output-divider")).toBeLessThan(
      nodes.findIndex((node) => node.className === "todo-tool-summary"),
    );
    expect(nodes.filter((node) => node.type === "ul")).toHaveLength(3);
    const summaryElement = disclosure.props.children[0].props.children[2];
    const summary = (summaryElement.type as (props: typeof summaryElement.props) => ReactElement)(
      summaryElement.props,
    );
    const progress = findElements(summary, (element) => element.type === "progress")[0];
    if (!progress) throw new Error("Expected Todo progress element");
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
    const droppedSummaryElement = droppedDisclosure.props.children[0].props.children[2];
    const droppedSummary = (
      droppedSummaryElement.type as (props: typeof droppedSummaryElement.props) => ReactElement
    )(droppedSummaryElement.props);
    expect(
      findElements(droppedSummary, (element) => element.props.className === "todo-state-marker")[0]?.props[
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
    const completedSummaryElement = completedDisclosure.props.children[0].props.children[2];
    const completedSummary = (
      completedSummaryElement.type as (props: typeof completedSummaryElement.props) => ReactElement
    )(completedSummaryElement.props);
    expect(
      findElements(completedSummary, (element) => element.props.className === "todo-state-marker")[0]?.props[
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
    expect(
      renderTranscriptNodes(block.props.children[0].props.children[2]).find(
        (node) => node.className === "transcript-disclosure-text",
      )?.text,
    ).toContain("Errors:");
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
    expect(
      renderTranscriptNodes(block.props.children[0].props.children[2]).find(
        (node) => node.className === "transcript-disclosure-text",
      )?.text,
    ).toBe(formatToolTextPreview(text));
    expect(renderTranscriptNodes(block).some((node) => node.className === "tool-output-divider")).toBe(true);
  });

  it("labels an empty tool result", () => {
    expect(formatToolTextPreview("")).toBe("No tool output");
  });
});

describe("approved transcript URL surfaces", () => {
  it("linkifies system, tool, Read, and Todo disclosure prose while keeping image syntax intact", () => {
    const systemNodes = renderTranscriptNodes(
      SystemTranscriptText({
        entry: {
          id: "system-url",
          role: "system",
          text: "System reference: https://system.example/docs.",
          timestamp: "2026-07-29T12:00:00.000Z",
          streaming: false,
          presentation: "text",
        },
      }),
    );
    const toolNodes = renderTranscriptNodes(
      ToolTranscriptText({
        entry: {
          id: "tool-url",
          role: "tool",
          toolName: "bash",
          text: "Output: https://tool.example/result.",
          timestamp: "2026-07-29T12:00:00.000Z",
          streaming: false,
          presentation: "text",
        },
      }),
    );
    const readNodes = renderTranscriptNodes(
      ToolTranscriptText({
        entry: {
          id: "read-url",
          role: "tool",
          toolName: "read",
          readTarget: "https://docs.example/guide",
          text: "Read more at https://docs.example/guide.",
          timestamp: "2026-07-29T12:00:00.000Z",
          streaming: false,
          presentation: "text",
        },
      }),
    );
    const todo = parseTodoResult(
      TODO_RESULT_TEXT.replaceAll(
        "Build custom todo tool interface",
        "Build https://todo.example/task",
      ).replace("format probe", "See https://todo.example/blocker"),
    );
    if (!todo) throw new Error("Expected Todo fixture");
    const todoNodes = renderTranscriptNodes(
      TodoToolTranscript({
        entry: {
          id: "todo-url",
          role: "tool",
          toolName: "todo",
          text: TODO_RESULT_TEXT,
          timestamp: "2026-07-29T12:00:00.000Z",
          streaming: false,
          presentation: "text",
        },
        todo,
      }),
    );
    const writeNodes = renderTranscriptNodes(
      ToolTranscriptText({
        entry: {
          id: "write-url",
          role: "tool",
          toolName: "write",
          toolTitle: "Write https://metadata.example/file",
          text: "Snapshot https://content.example/file",
          timestamp: "2026-07-29T12:00:00.000Z",
          streaming: false,
          presentation: "text",
        },
      }),
    );

    expect(systemNodes.filter((node) => node.type === "a").map((node) => node.props?.href)).toEqual([
      "https://system.example/docs",
      "https://system.example/docs",
    ]);
    expect(toolNodes.filter((node) => node.type === "a").map((node) => node.props?.href)).toEqual([
      "https://tool.example/result",
      "https://tool.example/result",
    ]);
    expect(readNodes.filter((node) => node.type === "a").map((node) => node.props?.href)).toEqual([
      "https://docs.example/guide",
      "https://docs.example/guide",
    ]);
    expect(todoNodes.filter((node) => node.type === "a").map((node) => node.props?.href)).toEqual([
      "https://todo.example/task",
      "https://todo.example/task",
      "https://todo.example/blocker",
    ]);
    expect(writeNodes.filter((node) => node.type === "a")).toHaveLength(0);
    expect(writeNodes.map((node) => node.text).join("")).toContain("Write https://metadata.example/file");
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
    expect(
      renderTranscriptNodes(block.props.children[0].props.children[1]).find(
        (node) => node.className === "transcript-disclosure-text",
      )?.text,
    ).toBe(`${"x".repeat(180)}…`);
    expect(
      renderTranscriptNodes(block.props.children[0]).some(
        (node) => node.className === "message-disclosure-chevron",
      ),
    ).toBe(true);
  });

  it("keeps markdown-like expanded system text literal with the preview style", () => {
    const text = "# Notice\n**literal emphasis** and [link](https://example.com)";
    const disclosure = SystemTranscriptText({
      entry: {
        id: "system-raw-text",
        role: "system",
        text,
        timestamp: "2026-07-29T12:00:00.000Z",
        streaming: false,
        presentation: "text",
      },
    });
    const preview = disclosure.props.children[0].props.children[1];
    const expanded = disclosure.props.children[1];
    const expandedNodes = renderTranscriptNodes(expanded);

    expect(preview.type).toBe("div");
    expect(expanded.type).toBe("div");
    expect(preview.props.className).toBe("transcript-disclosure-content");
    expect(preview.props["data-variant"]).toBe("thumbnail");
    expect(expanded.props.className).toBe(preview.props.className);
    expect(expanded.props["data-variant"]).toBe("expanded");
    expect(expandedNodes.find((node) => node.className === "transcript-disclosure-text")?.text).toBe(text);
    expect(expandedNodes.some((node) => node.type === "strong")).toBe(false);
    expect(expandedNodes.filter((node) => node.type === "a").map((node) => node.props?.href)).toEqual([
      "https://example.com",
    ]);
  });

  it("renders supported system images in both disclosure states without changing surrounding text", () => {
    const source = "https://status.example/system-alert.avif";
    const disclosure = SystemTranscriptText({
      entry: {
        id: "system-image",
        role: "system",
        text: `prefix ![System alert](${source}) suffix`,
        timestamp: "2026-07-29T12:00:00.000Z",
        streaming: false,
        presentation: "text",
      },
    });
    const thumbnailNodes = renderTranscriptNodes(disclosure.props.children[0].props.children[1]);
    const expandedNodes = renderTranscriptNodes(disclosure.props.children[1]);

    expect(thumbnailNodes.filter((node) => node.type === "img").map((node) => node.props?.src)).toEqual([
      source,
    ]);
    expect(thumbnailNodes.some((node) => node.type === "a")).toBe(false);
    expect(
      expandedNodes
        .filter((node) => node.className === "disclosure-image-link")
        .map((node) => node.props?.href),
    ).toEqual([source]);
    expect(
      expandedNodes
        .filter((node) => node.className === "transcript-disclosure-text")
        .map((node) => node.text),
    ).toEqual(["prefix ", " suffix"]);
  });

  it("does not invent text for an image-only system disclosure", () => {
    const source = "https://status.example/image-only.webp";
    const disclosure = SystemTranscriptText({
      entry: {
        id: "system-image-only",
        role: "system",
        text: `![Image only](${source})`,
        timestamp: "2026-07-29T12:00:00.000Z",
        streaming: false,
        presentation: "text",
      },
    });
    const nodes = renderTranscriptNodes(disclosure);

    expect(nodes.filter((node) => node.type === "img").map((node) => node.props?.src)).toEqual([
      source,
      source,
    ]);
    expect(nodes.some((node) => node.className === "transcript-disclosure-text")).toBe(false);
    expect(textContent(disclosure)).not.toContain("System message");
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
  if (typeof element.type === "function") {
    return renderTranscriptNodes(element.type(element.props) as ReactNode);
  }
  if (
    typeof element.type === "object" &&
    element.type !== null &&
    "type" in element.type &&
    typeof element.type.type === "function"
  ) {
    return renderTranscriptNodes(element.type.type(element.props) as ReactNode);
  }
  if (typeof element.type === "symbol") {
    return renderTranscriptNodes(element.props.children as ReactNode);
  }
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
  it("tokenizes absolute HTTP(S) URLs without sentence punctuation or unbalanced delimiters", () => {
    expect(parseInlineTranscript("See https://example.com/path_(safe), then https://omp.sh/docs.")).toEqual([
      { kind: "text", text: "See " },
      { kind: "link", text: "https://example.com/path_(safe)", href: "https://example.com/path_(safe)" },
      { kind: "text", text: ", then " },
      { kind: "link", text: "https://omp.sh/docs", href: "https://omp.sh/docs" },
      { kind: "text", text: "." },
    ]);
  });
  it("keeps escaped backslashes outside URL anchors", () => {
    expect(parseInlineTranscript("See https://example.com/project-url\\")).toEqual([
      { kind: "text", text: "See " },
      { kind: "link", text: "https://example.com/project-url", href: "https://example.com/project-url" },
      { kind: "text", text: "\\" },
    ]);
  });

  it("keeps code, bare www, and unsafe schemes literal", () => {
    expect(
      parseInlineTranscript(
        "`https://code.example` www.example.com javascript:https://example.com foohttps://embedded.example https://safe.example",
      ),
    ).toEqual([
      { kind: "code", text: "https://code.example" },
      {
        kind: "text",
        text: " www.example.com javascript:https://example.com foohttps://embedded.example ",
      },
      { kind: "link", text: "https://safe.example", href: "https://safe.example" },
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

describe("dashboard session branch selector", () => {
  const TOPOLOGY: SessionBranchTopology = {
    sessionId: BASE_SESSION.id,
    currentBranch: BASE_SESSION.branch as string,
    branches: [
      { name: BASE_SESSION.branch as string, parent: "main" },
      { name: "feature/sibling", parent: "main" },
      { name: "main" },
    ],
  };

  function branchSelector(output: ReactNode): ReactElement<SessionBranchSelectorProps> {
    const selector = findElements(output, (element) => element.type === SessionBranchSelector)[0];
    if (!selector) throw new Error("Expected Dashboard to render SessionBranchSelector");
    return selector as unknown as ReactElement<SessionBranchSelectorProps>;
  }

  function metadata(output: ReactNode): ReactElement<Record<string, unknown>> {
    const element = findElements(output, (candidate) => candidate.props.className === "session-metadata")[0];
    if (!element) throw new Error("Expected Dashboard to render session metadata");
    return element;
  }

  function branchTrigger(output: ReactNode): ReactElement<Record<string, unknown>> | undefined {
    return findElements(output, (element) => element.props.className === "session-branch-trigger")[0];
  }

  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((settle, fail) => {
      resolve = settle;
      reject = fail;
    });
    return { promise, reject, resolve };
  }

  async function settlePromises() {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }

  it("moves Branch out of the header and into the first metadata position with the full long name", () => {
    const longBranch = `feature/${"nested-segment-".repeat(18)}`.slice(0, 255);
    const output = renderControlledDashboard(composerDashboardProps({ ...BASE_SESSION, branch: longBranch }));
    const header = findElements(output, (element) => element.props.className === "session-header")[0];
    const metadataElement = metadata(output);
    const labels = findElements(metadataElement, (element) => element.type === "dt");
    const value = findElements(
      metadataElement,
      (element) => element.props.className === "session-branch-value",
    )[0];

    expect(textContent(header)).not.toContain(longBranch);
    expect(labels.map((label) => textContent(label))[0]).toBe("Branch");
    expect(value?.props.title).toBe(longBranch);
    expect(textContent(value)).toBe(longBranch);
  });

  it("omits Branch metadata for non-Git or detached sessions", () => {
    const output = renderControlledDashboard(composerDashboardProps({ ...BASE_SESSION, branch: null }));

    expect(
      findElements(metadata(output), (element) => element.type === "dt").map((label) => textContent(label)),
    ).not.toContain("Branch");
    expect(branchTrigger(output)).toBeUndefined();
  });

  it.each([
    ["idle RPC", { source: "rpc", status: "idle", connected: true }],
    ["waiting extension", { source: "extension", status: "waiting", connected: true }],
  ] as const)("offers the ghost trigger for an eligible %s session", (_label, sessionState) => {
    const session: Session = { ...BASE_SESSION, ...sessionState };
    const output = renderControlledDashboard(composerDashboardProps(session));

    expect(branchTrigger(output)?.props).toMatchObject({
      variant: "ghost",
      "aria-label": `Switch branch. Current branch ${session.branch}`,
    });
  });

  it.each([
    ["running", { status: "running" }],
    ["disconnected", { status: "disconnected", connected: false }],
    ["historical", { source: "history", status: "history", connected: false }],
  ] as const)("shows Branch without an interactive trigger for a %s session", (_label, sessionState) => {
    const session = { ...BASE_SESSION, ...sessionState } as Session;
    const output = renderControlledDashboard(composerDashboardProps(session));

    expect(textContent(metadata(output))).toContain(BASE_SESSION.branch as string);
    expect(branchTrigger(output)).toBeUndefined();
  });

  it("loads topology exactly once per open and resets before a fresh reopen", async () => {
    const onLoadSessionBranchTopology = vi.fn().mockResolvedValue(TOPOLOGY);
    const props = { ...composerDashboardProps(), onLoadSessionBranchTopology };
    let output = renderControlledDashboard(props);

    branchSelector(output).props.onOpenChange(true);
    branchSelector(output).props.onOpenChange(true);
    expect(onLoadSessionBranchTopology).toHaveBeenCalledTimes(1);
    await settlePromises();
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });
    expect(branchSelector(output).props).toMatchObject({
      open: true,
      topology: TOPOLOGY,
      loading: false,
    });

    branchSelector(output).props.onOpenChange(false);
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });
    expect(branchSelector(output).props).toMatchObject({
      open: false,
      topology: null,
      query: "",
    });

    branchSelector(output).props.onOpenChange(true);
    await settlePromises();
    expect(onLoadSessionBranchTopology).toHaveBeenCalledTimes(2);
  });

  it("aborts and ignores a deferred topology result after close", async () => {
    const pending = deferred<SessionBranchTopology>();
    const onLoadSessionBranchTopology = vi.fn().mockReturnValue(pending.promise);
    const props = { ...composerDashboardProps(), onLoadSessionBranchTopology };
    let output = renderControlledDashboard(props);

    branchSelector(output).props.onOpenChange(true);
    const signal = onLoadSessionBranchTopology.mock.calls[0]?.[1] as AbortSignal;
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });
    branchSelector(output).props.onOpenChange(false);
    pending.resolve(TOPOLOGY);
    await settlePromises();
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });

    expect(signal.aborted).toBe(true);
    expect(branchSelector(output).props).toMatchObject({
      open: false,
      topology: null,
      loadError: null,
    });
  });

  it("prevents an old session load from replacing a newly selected session topology", async () => {
    const firstPending = deferred<SessionBranchTopology>();
    const secondSession: Session = {
      ...BASE_SESSION,
      id: "session-2",
      name: "Second",
      branch: "feature/second",
    };
    const secondTopology: SessionBranchTopology = {
      sessionId: secondSession.id,
      currentBranch: secondSession.branch as string,
      branches: [{ name: secondSession.branch as string }, { name: "main" }],
    };
    const onLoadSessionBranchTopology = vi
      .fn()
      .mockReturnValueOnce(firstPending.promise)
      .mockResolvedValueOnce(secondTopology);
    const firstProps = {
      ...composerDashboardProps(),
      sessions: [BASE_SESSION, secondSession],
      onLoadSessionBranchTopology,
    };
    let output = renderControlledDashboard(firstProps);

    branchSelector(output).props.onOpenChange(true);
    const firstSignal = onLoadSessionBranchTopology.mock.calls[0]?.[1] as AbortSignal;
    const secondProps = { ...firstProps, selectedSessionId: secondSession.id };
    output = renderControlledDashboard(secondProps, { preserveState: true });
    output = renderControlledDashboard(secondProps, {
      preserveState: true,
      effectsEnabled: false,
    });
    expect(firstSignal.aborted).toBe(true);
    expect(branchSelector(output).props.open).toBe(false);

    branchSelector(output).props.onOpenChange(true);
    await settlePromises();
    firstPending.resolve(TOPOLOGY);
    await settlePromises();
    output = renderControlledDashboard(secondProps, {
      preserveState: true,
      effectsEnabled: false,
    });

    expect(onLoadSessionBranchTopology).toHaveBeenCalledTimes(2);
    expect(branchSelector(output).props).toMatchObject({
      open: true,
      topology: secondTopology,
      currentBranch: secondSession.branch,
    });
  });

  it("keeps the drawer open and disables checkout if the session starts running", async () => {
    const props = {
      ...composerDashboardProps(),
      onLoadSessionBranchTopology: vi.fn().mockResolvedValue(TOPOLOGY),
    };
    let output = renderControlledDashboard(props);
    branchSelector(output).props.onOpenChange(true);
    await settlePromises();

    const runningProps = {
      ...props,
      sessions: [{ ...BASE_SESSION, status: "running" as const }],
    };
    output = renderControlledDashboard(runningProps, { preserveState: true });

    expect(branchSelector(output).props).toMatchObject({ open: true, running: true });
    expect(branchTrigger(output)).toBeUndefined();
  });

  it("closes stale topology when the live session branch changes outside the selector", async () => {
    const props = {
      ...composerDashboardProps(),
      onLoadSessionBranchTopology: vi.fn().mockResolvedValue(TOPOLOGY),
    };
    let output = renderControlledDashboard(props);
    branchSelector(output).props.onOpenChange(true);
    await settlePromises();
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });
    expect(branchSelector(output).props).toMatchObject({ open: true, topology: TOPOLOGY });

    const patchedProps = {
      ...props,
      sessions: [{ ...BASE_SESSION, branch: "feature/sibling" }],
    };
    output = renderControlledDashboard(patchedProps, { preserveState: true });
    output = renderControlledDashboard(patchedProps, {
      preserveState: true,
      effectsEnabled: false,
    });

    expect(branchSelector(output).props).toMatchObject({
      open: false,
      topology: null,
      query: "",
    });
  });

  it.each([
    ["disconnects", { connected: false, status: "disconnected" }],
    ["becomes historical", { connected: false, source: "history", status: "history" }],
    ["loses its branch", { branch: null }],
  ] as const)("closes and resets when the selected session %s", async (_label, sessionState) => {
    const props = {
      ...composerDashboardProps(),
      onLoadSessionBranchTopology: vi.fn().mockResolvedValue(TOPOLOGY),
    };
    let output = renderControlledDashboard(props);
    branchSelector(output).props.onOpenChange(true);
    await settlePromises();
    output = renderControlledDashboard(
      {
        ...props,
        sessions: [{ ...BASE_SESSION, ...sessionState } as Session],
      },
      { preserveState: true },
    );
    output = renderControlledDashboard(
      {
        ...props,
        sessions: [{ ...BASE_SESSION, ...sessionState } as Session],
      },
      { preserveState: true, effectsEnabled: false },
    );

    expect(branchSelector(output).props).toMatchObject({
      open: false,
      topology: null,
      query: "",
      checkoutPending: null,
      checkoutError: null,
    });
  });

  it("retains query and pending state until checkout succeeds, then relies on the session patch", async () => {
    const checkout = deferred<void>();
    const onSwitchBranch = vi.fn().mockReturnValue(checkout.promise);
    const props = {
      ...composerDashboardProps(),
      onLoadSessionBranchTopology: vi.fn().mockResolvedValue(TOPOLOGY),
      onSwitchBranch,
    };
    let output = renderControlledDashboard(props);
    branchSelector(output).props.onOpenChange(true);
    await settlePromises();
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });
    branchSelector(output).props.onQueryChange("sibling");
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });
    branchSelector(output).props.onSelectBranch("feature/sibling");
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });

    expect(onSwitchBranch).toHaveBeenCalledWith(BASE_SESSION.id, "feature/sibling");
    expect(branchSelector(output).props).toMatchObject({
      open: true,
      query: "sibling",
      checkoutPending: "feature/sibling",
    });

    checkout.resolve();
    await settlePromises();
    const patchedProps = {
      ...props,
      sessions: [{ ...BASE_SESSION, branch: "feature/sibling" }],
    };
    output = renderControlledDashboard(patchedProps, {
      preserveState: true,
      effectsEnabled: false,
    });
    expect(branchSelector(output).props).toMatchObject({
      open: false,
      query: "",
      checkoutPending: null,
    });
    expect(textContent(metadata(output))).toContain("feature/sibling");
  });

  it("keeps topology and query open while exposing the exact checkout failure", async () => {
    const exactError = "error: Your local changes would be overwritten by checkout";
    const props = {
      ...composerDashboardProps(),
      onLoadSessionBranchTopology: vi.fn().mockResolvedValue(TOPOLOGY),
      onSwitchBranch: vi.fn().mockRejectedValue(new Error(exactError)),
    };
    let output = renderControlledDashboard(props);
    branchSelector(output).props.onOpenChange(true);
    await settlePromises();
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });
    branchSelector(output).props.onQueryChange("sibling");
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });
    branchSelector(output).props.onSelectBranch("feature/sibling");
    await settlePromises();
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });

    expect(branchSelector(output).props).toMatchObject({
      open: true,
      topology: TOPOLOGY,
      query: "sibling",
      checkoutPending: null,
      checkoutError: exactError,
    });
    expect(textContent(metadata(output))).toContain(BASE_SESSION.branch as string);
  });

  it("drops pending checkout state and ignores its late error after session selection changes", async () => {
    const checkout = deferred<void>();
    const secondSession: Session = {
      ...BASE_SESSION,
      id: "session-2",
      branch: "feature/second",
    };
    const firstProps = {
      ...composerDashboardProps(),
      sessions: [BASE_SESSION, secondSession],
      onLoadSessionBranchTopology: vi.fn().mockResolvedValue(TOPOLOGY),
      onSwitchBranch: vi.fn().mockReturnValue(checkout.promise),
    };
    let output = renderControlledDashboard(firstProps);
    branchSelector(output).props.onOpenChange(true);
    await settlePromises();
    output = renderControlledDashboard(firstProps, {
      preserveState: true,
      effectsEnabled: false,
    });
    branchSelector(output).props.onSelectBranch("feature/sibling");
    output = renderControlledDashboard(firstProps, {
      preserveState: true,
      effectsEnabled: false,
    });
    expect(branchSelector(output).props.checkoutPending).toBe("feature/sibling");

    const secondProps = { ...firstProps, selectedSessionId: secondSession.id };
    output = renderControlledDashboard(secondProps, { preserveState: true });
    output = renderControlledDashboard(secondProps, {
      preserveState: true,
      effectsEnabled: false,
    });
    expect(branchSelector(output).props).toMatchObject({
      open: false,
      topology: null,
      checkoutPending: null,
      checkoutError: null,
    });

    checkout.reject(new Error("late checkout failure"));
    await settlePromises();
    output = renderControlledDashboard(secondProps, {
      preserveState: true,
      effectsEnabled: false,
    });
    expect(branchSelector(output).props.checkoutError).toBeNull();
  });

  it("keeps the exact topology source error in the open selector until close", async () => {
    const exactError = "Session branch topology could not be read";
    const props = {
      ...composerDashboardProps(),
      onLoadSessionBranchTopology: vi.fn().mockRejectedValue(new Error(exactError)),
    };
    let output = renderControlledDashboard(props);
    branchSelector(output).props.onOpenChange(true);
    await settlePromises();
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });

    expect(branchSelector(output).props).toMatchObject({
      open: true,
      topology: null,
      loading: false,
      loadError: exactError,
    });
  });
});

describe("dashboard session-file-change refresh", () => {
  type FileChangesViewerProps = {
    open: boolean;
    result: SessionFileChangesResponse | null;
    loading: boolean;
    error: string | null;
    onOpenChange(open: boolean): void;
  };

  function changesFor(session: Session): SessionFileChangesResponse {
    return {
      sessionId: session.id,
      state: "available",
      sources: [
        {
          sessionId: session.id,
          root: session.cwd,
          files: [
            {
              path: `${session.cwd}/src/app.ts`,
              operations: [
                {
                  type: "edit",
                  timestamp: "2026-08-01T10:00:00.000Z",
                  sessionId: session.id,
                  op: "update",
                  additions: 1,
                  deletions: 1,
                  patch: "@@ -1 +1 @@\n-old\n+new",
                },
              ],
            },
          ],
        },
      ],
      fileCount: 1,
      operationCount: 1,
      additions: 1,
      deletions: 1,
      changedLines: 2,
      message: null,
    };
  }

  function fileChangesViewer(output: ReactNode): ReactElement<FileChangesViewerProps> {
    return findElements(
      output,
      (element) => element.type === SessionFileChangesViewer,
    )[0] as ReactElement<FileChangesViewerProps>;
  }

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((settle) => {
      resolve = settle;
    });
    return { promise, resolve };
  }

  it("ignores a deferred result after the drawer closes", async () => {
    vi.useFakeTimers();
    try {
      const pendingChanges = deferred<SessionFileChangesResponse>();
      const onLoadSessionFileChanges = vi.fn().mockReturnValue(pendingChanges.promise);
      const props = { ...composerDashboardProps(), onLoadSessionFileChanges };

      const output = renderControlledDashboard(props);
      const viewer = fileChangesViewer(output);
      viewer.props.onOpenChange(true);
      await vi.advanceTimersByTimeAsync(0);
      const signal = onLoadSessionFileChanges.mock.calls[0]?.[1] as AbortSignal;

      viewer.props.onOpenChange(false);
      pendingChanges.resolve(changesFor(BASE_SESSION));
      await vi.advanceTimersByTimeAsync(0);

      const closedOutput = renderControlledDashboard(props, {
        preserveState: true,
        effectsEnabled: false,
      });
      expect(signal.aborted).toBe(true);
      expect(fileChangesViewer(closedOutput).props).toMatchObject({
        open: false,
        result: null,
        loading: false,
        error: null,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a deferred result after switching sessions", async () => {
    vi.useFakeTimers();
    try {
      const secondSession = {
        ...BASE_SESSION,
        id: "session-2",
        name: "Second session",
        lastActivity: "2026-07-28T18:00:00.000Z",
      };
      const pendingFirstChanges = deferred<SessionFileChangesResponse>();
      const secondChanges = changesFor(secondSession);
      const onLoadSessionFileChanges = vi
        .fn()
        .mockReturnValueOnce(pendingFirstChanges.promise)
        .mockResolvedValueOnce(secondChanges);
      const firstProps = { ...composerDashboardProps(), onLoadSessionFileChanges };

      let output = renderControlledDashboard(firstProps);
      fileChangesViewer(output).props.onOpenChange(true);
      await vi.advanceTimersByTimeAsync(0);
      const firstSignal = onLoadSessionFileChanges.mock.calls[0]?.[1] as AbortSignal;

      const switchedProps = {
        ...firstProps,
        sessions: [BASE_SESSION, secondSession],
        selectedSessionId: secondSession.id,
      };
      renderControlledDashboard(switchedProps, { preserveState: true });
      await vi.advanceTimersByTimeAsync(750);
      pendingFirstChanges.resolve(changesFor(BASE_SESSION));
      await vi.advanceTimersByTimeAsync(0);

      output = renderControlledDashboard(switchedProps, {
        preserveState: true,
        effectsEnabled: false,
      });
      expect(firstSignal.aborted).toBe(true);
      expect(onLoadSessionFileChanges).toHaveBeenCalledTimes(2);
      expect(fileChangesViewer(output).props).toMatchObject({
        result: secondChanges,
        loading: false,
        error: null,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("loads on demand and preserves matching metadata without rescanning while closed", async () => {
    vi.useFakeTimers();
    try {
      const successfulChanges = changesFor(BASE_SESSION);
      const onLoadSessionFileChanges = vi.fn().mockResolvedValue(successfulChanges);
      const firstProps = { ...composerDashboardProps(), onLoadSessionFileChanges };

      let output = renderControlledDashboard(firstProps);
      await vi.advanceTimersByTimeAsync(750);
      expect(onLoadSessionFileChanges).not.toHaveBeenCalled();

      let viewer = fileChangesViewer(output);
      viewer.props.onOpenChange(true);
      await vi.advanceTimersByTimeAsync(0);
      output = renderControlledDashboard(firstProps, { preserveState: true, effectsEnabled: false });
      viewer = fileChangesViewer(output);
      expect(viewer.props).toMatchObject({
        open: true,
        result: successfulChanges,
        loading: false,
        error: null,
      });
      expect(onLoadSessionFileChanges).toHaveBeenCalledTimes(1);

      viewer.props.onOpenChange(false);
      const laterSession = { ...BASE_SESSION, lastActivity: "2026-07-28T18:00:00.000Z" };
      const laterProps = { ...firstProps, sessions: [laterSession] };
      renderControlledDashboard(laterProps, { preserveState: true });
      await vi.advanceTimersByTimeAsync(750);
      output = renderControlledDashboard(laterProps, {
        preserveState: true,
        effectsEnabled: false,
      });
      viewer = fileChangesViewer(output);
      expect(onLoadSessionFileChanges).toHaveBeenCalledTimes(1);
      expect(viewer.props).toMatchObject({
        open: false,
        result: successfulChanges,
        loading: false,
        error: null,
      });
      expect(textContent(output)).toContain("1 file · 1 operation");
    } finally {
      vi.useRealTimers();
    }
  });
  it("keeps the matching result visible during a deferred same-session refresh", async () => {
    vi.useFakeTimers();
    try {
      const initialChanges = changesFor(BASE_SESSION);
      const refreshedChanges = {
        ...initialChanges,
        operationCount: 2,
        additions: 2,
        changedLines: 3,
      };
      const pendingRefresh = deferred<SessionFileChangesResponse>();
      const onLoadSessionFileChanges = vi
        .fn()
        .mockResolvedValueOnce(initialChanges)
        .mockReturnValueOnce(pendingRefresh.promise);
      const firstProps = { ...composerDashboardProps(), onLoadSessionFileChanges };

      let output = renderControlledDashboard(firstProps);
      fileChangesViewer(output).props.onOpenChange(true);
      await vi.advanceTimersByTimeAsync(0);

      const refreshedProps = {
        ...firstProps,
        sessions: [{ ...BASE_SESSION, lastActivity: "2026-07-28T18:00:00.000Z" }],
      };
      renderControlledDashboard(refreshedProps, { preserveState: true });
      output = renderControlledDashboard(refreshedProps, {
        preserveState: true,
        effectsEnabled: false,
      });
      expect(fileChangesViewer(output).props).toMatchObject({
        result: initialChanges,
        loading: true,
        error: null,
      });

      await vi.advanceTimersByTimeAsync(750);
      output = renderControlledDashboard(refreshedProps, {
        preserveState: true,
        effectsEnabled: false,
      });
      expect(onLoadSessionFileChanges).toHaveBeenCalledTimes(2);
      expect(fileChangesViewer(output).props).toMatchObject({
        result: initialChanges,
        loading: true,
        error: null,
      });

      pendingRefresh.resolve(refreshedChanges);
      await vi.advanceTimersByTimeAsync(0);
      output = renderControlledDashboard(refreshedProps, {
        preserveState: true,
        effectsEnabled: false,
      });
      expect(fileChangesViewer(output).props).toMatchObject({
        result: refreshedChanges,
        loading: false,
        error: null,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows loading and suppresses the previous result during a debounced open-drawer switch", async () => {
    vi.useFakeTimers();
    try {
      const secondSession = {
        ...BASE_SESSION,
        id: "session-2",
        name: "Second session",
        lastActivity: "2026-07-28T18:00:00.000Z",
      };
      const firstChanges = changesFor(BASE_SESSION);
      const secondChanges = changesFor(secondSession);
      const onLoadSessionFileChanges = vi
        .fn()
        .mockResolvedValueOnce(firstChanges)
        .mockResolvedValueOnce(secondChanges);
      const firstProps = { ...composerDashboardProps(), onLoadSessionFileChanges };

      let output = renderControlledDashboard(firstProps);
      fileChangesViewer(output).props.onOpenChange(true);
      await vi.advanceTimersByTimeAsync(0);
      output = renderControlledDashboard(firstProps, { preserveState: true, effectsEnabled: false });
      expect(fileChangesViewer(output).props.result).toBe(firstChanges);

      const switchedProps = {
        ...firstProps,
        sessions: [BASE_SESSION, secondSession],
        selectedSessionId: secondSession.id,
      };
      output = renderControlledDashboard(switchedProps, { preserveState: true });
      expect(fileChangesViewer(output).props).toMatchObject({
        open: true,
        result: null,
        loading: true,
        error: null,
      });
      expect(onLoadSessionFileChanges).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(749);
      expect(onLoadSessionFileChanges).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      output = renderControlledDashboard(switchedProps, {
        preserveState: true,
        effectsEnabled: false,
      });
      expect(onLoadSessionFileChanges).toHaveBeenCalledTimes(2);
      expect(onLoadSessionFileChanges.mock.calls[1]?.[0]).toBe(secondSession.id);
      expect(fileChangesViewer(output).props).toMatchObject({
        result: secondChanges,
        loading: false,
        error: null,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels scheduled refreshes on close without disrupting an immediate quick-reopen load", async () => {
    vi.useFakeTimers();
    try {
      const successfulChanges = changesFor(BASE_SESSION);
      const onLoadSessionFileChanges = vi.fn().mockResolvedValue(successfulChanges);
      const firstProps = { ...composerDashboardProps(), onLoadSessionFileChanges };

      let output = renderControlledDashboard(firstProps);
      fileChangesViewer(output).props.onOpenChange(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(onLoadSessionFileChanges).toHaveBeenCalledTimes(1);

      const firstActivityProps = {
        ...firstProps,
        sessions: [{ ...BASE_SESSION, lastActivity: "2026-07-28T18:00:00.000Z" }],
      };
      output = renderControlledDashboard(firstActivityProps, { preserveState: true });
      fileChangesViewer(output).props.onOpenChange(false);
      await vi.advanceTimersByTimeAsync(750);
      expect(onLoadSessionFileChanges).toHaveBeenCalledTimes(1);

      fileChangesViewer(output).props.onOpenChange(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(onLoadSessionFileChanges).toHaveBeenCalledTimes(2);

      const secondActivityProps = {
        ...firstProps,
        sessions: [{ ...BASE_SESSION, lastActivity: "2026-07-28T19:00:00.000Z" }],
      };
      output = renderControlledDashboard(secondActivityProps, { preserveState: true });
      const viewer = fileChangesViewer(output);
      viewer.props.onOpenChange(false);
      viewer.props.onOpenChange(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(onLoadSessionFileChanges).toHaveBeenCalledTimes(3);
      const quickReopenSignal = onLoadSessionFileChanges.mock.calls[2]?.[1] as AbortSignal;

      await vi.advanceTimersByTimeAsync(750);
      expect(onLoadSessionFileChanges).toHaveBeenCalledTimes(3);
      expect(quickReopenSignal.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears successful counts when an open-drawer refresh fails", async () => {
    vi.useFakeTimers();
    try {
      const successfulChanges = changesFor(BASE_SESSION);
      const onLoadSessionFileChanges = vi
        .fn()
        .mockResolvedValueOnce(successfulChanges)
        .mockRejectedValueOnce(new Error("Host refresh failed"));
      const firstProps = { ...composerDashboardProps(), onLoadSessionFileChanges };

      let output = renderControlledDashboard(firstProps);
      fileChangesViewer(output).props.onOpenChange(true);
      await vi.advanceTimersByTimeAsync(0);
      output = renderControlledDashboard(firstProps, { preserveState: true, effectsEnabled: false });
      expect(fileChangesViewer(output).props.result).toBe(successfulChanges);

      const laterSession = { ...BASE_SESSION, lastActivity: "2026-07-28T18:00:00.000Z" };
      const laterProps = { ...firstProps, sessions: [laterSession] };
      renderControlledDashboard(laterProps, { preserveState: true });
      await vi.advanceTimersByTimeAsync(750);
      output = renderControlledDashboard(laterProps, {
        preserveState: true,
        effectsEnabled: false,
      });
      expect(fileChangesViewer(output).props).toMatchObject({
        result: null,
        loading: false,
        error: "Host refresh failed",
      });
      expect(textContent(output)).toContain("Changes unavailable");
      expect(textContent(output)).not.toContain("1 file · 1 operation");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("dashboard Read transcript", () => {
  it("renders adjacent Reads as separate rows without their output", () => {
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
    const nodes = rows.slice(0, 2).flatMap((row) => renderTranscriptNodes(row.props.children as ReactNode));

    expect(rows.map((row) => row.props.messageId)).toEqual([
      "dashboard-read-a",
      "dashboard-read-b",
      "dashboard-assistant",
    ]);
    expect(
      nodes
        .filter((node) => node.className === "message-author")
        .map((node) => textContent(node.props?.children as ReactNode)),
    ).toEqual(expect.arrayContaining(["·Read: a.ts", "·Read: b.ts"]));
    expect(nodes.some((node) => node.text.includes("alpha dashboard contents"))).toBe(false);
    expect(nodes.some((node) => node.text.includes("beta dashboard contents"))).toBe(false);
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
    const rows = findElements(transcript, (element) => element.type === MessageScrollerItem);

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
    expect(rows.map((row) => row.props.messageId)).toEqual([
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
    ).toEqual(["Branch", "Model", "Effort", "Context", "Changes", "Updated"]);
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

  it("registers an immediate scroll-to-end handler for submitted messages", () => {
    const onScrollToEnd = vi.fn();

    MessageScrollerScrollController({ onScrollToEnd });

    const handler = onScrollToEnd.mock.calls[0]?.[0] as (() => void) | undefined;
    expect(handler).toBeTypeOf("function");
    handler?.();
    expect(messageScrollerHarness.scrollToEnd).toHaveBeenCalledWith({ behavior: "auto" });
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

  it("scrolls the transcript to the end after a message is submitted", async () => {
    const onCommand = vi.fn().mockResolvedValue(undefined);
    const props = { ...composerDashboardProps(), onCommand };
    let output = renderControlledDashboard(props);

    (findComposerTextarea(output).props.onChange as (event: { target: { value: string } }) => void)({
      target: { value: "Show the latest output" },
    });
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });

    const scrollToEnd = vi.fn();
    const controller = findElements(output, (element) => element.type === MessageScrollerScrollController)[0];
    (controller?.props.onScrollToEnd as ((handler: () => void) => void) | undefined)?.(scrollToEnd);
    const form = findElements(output, (element) => element.props.className === "composer")[0];
    await (form?.props.onSubmit as ((event: { preventDefault(): void }) => Promise<void>) | undefined)?.({
      preventDefault: vi.fn(),
    });

    expect(onCommand).toHaveBeenCalledWith("session-1", "steer", "Show the latest output");
    expect(scrollToEnd).toHaveBeenCalledOnce();
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
  it("keeps Ask links outside native controls while preserving option activation", () => {
    const onActivity = vi.fn();
    const onRespond = vi.fn().mockResolvedValue(undefined);
    const legacy = renderAskToolCall(
      {
        ...SELECT_ASK,
        title: "Review https://omp.sh/ask",
        options: ["Open https://omp.sh/docs"],
      },
      { onActivity, onRespond },
    );
    const legacyOptionLinks = findElements(
      legacy,
      (element) => element.props.className === "ask-option-links",
    )[0];
    const legacyLink = findElements(legacyOptionLinks, (element) => element.type === "a")[0];
    const legacyButton = findElements(legacy, (element) => element.props.className === "ask-option")[0];
    expect(legacyLink?.props.href).toBe("https://omp.sh/docs");
    expect(findElements(legacyButton, (element) => element.type === "a")).toHaveLength(0);
    const stopPropagation = vi.fn();
    (legacyLink?.props.onClick as ((event: { stopPropagation(): void }) => void) | undefined)?.({
      stopPropagation,
    });
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(onRespond).not.toHaveBeenCalled();
    (legacyButton?.props.onClick as (() => void) | undefined)?.();

    const richQuestion = RICH_ASK.questions[0];
    if (!richQuestion) throw new Error("Expected rich question fixture");
    const richMultiRequest: AskRequest = {
      ...RICH_ASK,
      questions: [
        {
          ...richQuestion,
          options: [{ label: "Open https://omp.sh/multi", description: "Docs https://omp.sh/info" }],
        },
      ],
    };
    const richMulti = renderAskToolCall(richMultiRequest, { onActivity, onRespond });
    const multiOptionLinks = findElements(
      richMulti,
      (element) => element.props.className === "ask-option-links",
    )[0];
    const multiLink = findElements(multiOptionLinks, (element) => element.type === "a")[0];
    const multiButton = findElements(
      richMulti,
      (element) => element.props.className === "ask-option ask-rich-option",
    )[0];
    expect(multiLink?.props.href).toBe("https://omp.sh/multi");
    expect(findElements(multiButton, (element) => element.type === "a")).toHaveLength(0);
    (multiButton?.props.onClick as (() => void) | undefined)?.();
    const richMultiSelected = renderAskToolCall(richMultiRequest, { onActivity, onRespond }, true);
    expect(findElements(richMultiSelected, (element) => element.props["aria-pressed"] === true)).toHaveLength(
      1,
    );

    const radioQuestion = MULTIPLE_RICH_ASK.questions[0];
    if (!radioQuestion) throw new Error("Expected radio question fixture");
    const richRadioRequest: AskRequest = {
      ...MULTIPLE_RICH_ASK,
      questions: [
        {
          ...radioQuestion,
          options: [{ label: "Open https://omp.sh/radio", preview: "More https://omp.sh/preview" }],
          multi: false,
        },
      ],
    };
    const richRadio = renderAskToolCall(richRadioRequest, { onActivity, onRespond });
    const radioOptionLinks = findElements(
      richRadio,
      (element) => element.props.className === "ask-option-links",
    )[0];
    const radioLink = findElements(radioOptionLinks, (element) => element.type === "a")[0];
    const radio = findElements(richRadio, (element) => element.type === Radio.Root)[0];
    expect(radioLink?.props.href).toBe("https://omp.sh/radio");
    expect(findElements(radio, (element) => element.type === "a")).toHaveLength(0);
    const radioStopPropagation = vi.fn();
    (radioLink?.props.onClick as ((event: { stopPropagation(): void }) => void) | undefined)?.({
      stopPropagation: radioStopPropagation,
    });
    expect(radioStopPropagation).toHaveBeenCalledOnce();
    expect(onActivity).toHaveBeenCalled();
  });

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

  it("shows one accessible question at a time with Base UI radios and progressive navigation", () => {
    let output = renderAskToolCall(MULTIPLE_RICH_ASK);
    let fieldsets = findElements(output, (element) => element.type === "fieldset");
    let legends = findElements(output, (element) => element.type === "legend");
    let radioGroups = findElements(output, (element) => element.type === RadioGroup);
    let radios = findElements(output, (element) => element.type === Radio.Root);

    expect(textContent(output)).toContain("2 questions");
    expect(textContent(output)).toContain("Question 1 of 2");
    expect(fieldsets).toHaveLength(1);
    expect(radioGroups).toHaveLength(1);
    expect(radios).toHaveLength(2);
    expect(radioGroups[0]?.props["aria-labelledby"]).toBe(legends[0]?.props.id);
    expect(radioGroups[0]?.props.disabled).toBe(false);
    expect(textContent(radios[0])).toContain("preview.example.test");
    const previous = findElements(output, (element) => textContent(element) === "Previous")[0];
    expect(previous?.props.disabled).toBe(true);

    const next = findElements(output, (element) => textContent(element) === "Next")[0];
    expect(next?.props.disabled).toBe(false);
    (next?.props.onClick as (() => void) | undefined)?.();
    output = renderAskToolCall(MULTIPLE_RICH_ASK, {}, true);
    fieldsets = findElements(output, (element) => element.type === "fieldset");
    const toggleButtons = findElements(
      fieldsets[0],
      (element) => element.props.className === "ask-option ask-rich-option",
    );

    expect(textContent(output)).toContain("Question 2 of 2");
    expect(fieldsets).toHaveLength(1);
    expect(findElements(output, (element) => element.type === RadioGroup)).toHaveLength(0);
    expect(toggleButtons.map((button) => button.props["aria-pressed"])).toEqual([false, false]);

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

  it("allows unanswered review, preserves indexed answers, gates final submit, and emits activity", async () => {
    const onActivity = vi.fn();
    const onRespond = vi.fn().mockResolvedValue(undefined);
    let output = renderAskToolCall(MULTIPLE_RICH_ASK, { onActivity, onRespond });
    const firstRadioGroup = findElements(output, (element) => element.type === RadioGroup)[0];
    (firstRadioGroup?.props.onValueChange as ((value: string) => void) | undefined)?.("Preview");
    output = renderAskToolCall(MULTIPLE_RICH_ASK, { onActivity, onRespond }, true);

    const firstCustom = findElements(
      output,
      (element) => element.props.id === "ask-answer-session-1-ask-multiple-rich-0-custom",
    )[0];
    const firstNote = findElements(
      output,
      (element) => element.props.id === "ask-answer-session-1-ask-multiple-rich-0-note",
    )[0];
    (firstCustom?.props.onChange as ((event: { target: { value: string } }) => void) | undefined)?.({
      target: { value: "Preview mirror" },
    });
    (firstNote?.props.onChange as ((event: { target: { value: string } }) => void) | undefined)?.({
      target: { value: "Keep rollout private" },
    });
    output = renderAskToolCall(MULTIPLE_RICH_ASK, { onActivity, onRespond }, true);

    const next = findElements(output, (element) => textContent(element) === "Next")[0];
    (next?.props.onClick as (() => void) | undefined)?.();
    output = renderAskToolCall(MULTIPLE_RICH_ASK, { onActivity, onRespond }, true);
    expect(textContent(output)).toContain("Question 2 of 2");
    expect(findElements(output, (element) => textContent(element) === "Submit answers")).toHaveLength(1);
    expect(
      findElements(
        output,
        (element) => typeof element.props.onClick === "function" && textContent(element) === "Submit answers",
      )[0]?.props.disabled,
    ).toBe(true);

    const secondOption = findElements(
      output,
      (element) =>
        element.props.className === "ask-option ask-rich-option" && element.props["aria-pressed"] === false,
    )[0];
    (secondOption?.props.onClick as (() => void) | undefined)?.();
    output = renderAskToolCall(MULTIPLE_RICH_ASK, { onActivity, onRespond }, true);
    const secondCustom = findElements(
      output,
      (element) => element.props.id === "ask-answer-session-1-ask-multiple-rich-1-custom",
    )[0];
    const secondNote = findElements(
      output,
      (element) => element.props.id === "ask-answer-session-1-ask-multiple-rich-1-note",
    )[0];
    (secondCustom?.props.onChange as ((event: { target: { value: string } }) => void) | undefined)?.({
      target: { value: "Run canary checks" },
    });
    (secondNote?.props.onChange as ((event: { target: { value: string } }) => void) | undefined)?.({
      target: { value: "Before promotion" },
    });
    output = renderAskToolCall(MULTIPLE_RICH_ASK, { onActivity, onRespond }, true);
    const submit = findElements(
      output,
      (element) => typeof element.props.onClick === "function" && textContent(element) === "Submit answers",
    )[0];
    expect(submit?.props.disabled).toBe(false);

    const previous = findElements(output, (element) => textContent(element) === "Previous")[0];
    (previous?.props.onClick as (() => void) | undefined)?.();
    output = renderAskToolCall(MULTIPLE_RICH_ASK, { onActivity, onRespond }, true);
    expect(textContent(output)).toContain("Question 1 of 2");
    expect(findElements(output, (element) => element.type === RadioGroup)[0]?.props.value).toBe("");
    expect(
      findElements(
        output,
        (element) => element.props.id === "ask-answer-session-1-ask-multiple-rich-0-custom",
      )[0]?.props.value,
    ).toBe("Preview mirror");
    expect(
      findElements(
        output,
        (element) => element.props.id === "ask-answer-session-1-ask-multiple-rich-0-note",
      )[0]?.props.value,
    ).toBe("Keep rollout private");

    (findElements(output, (element) => textContent(element) === "Next")[0]?.props.onClick as () => void)?.();
    output = renderAskToolCall(MULTIPLE_RICH_ASK, { onActivity, onRespond }, true);
    const finalSubmit = findElements(
      output,
      (element) => typeof element.props.onClick === "function" && textContent(element) === "Submit answers",
    )[0];
    (finalSubmit?.props.onClick as (() => void) | undefined)?.();
    await Promise.resolve();

    expect(onRespond).toHaveBeenCalledWith({
      kind: "submit",
      results: [
        {
          id: "target",
          question: "Which deployment target?",
          options: ["Preview", "Production"],
          multi: false,
          selectedOptions: [],
          customInput: "Preview mirror",
          note: "Keep rollout private",
        },
        {
          id: "checks",
          question: "Which checks should run?",
          options: ["Smoke tests", "Full suite"],
          multi: true,
          selectedOptions: ["Smoke tests"],
          customInput: "Run canary checks",
          note: "Before promotion",
        },
      ],
    });
    expect(onActivity).toHaveBeenCalledTimes(6);
  });
  it("focuses the newly visible question heading after navigation", () => {
    let output = renderAskToolCall(MULTIPLE_RICH_ASK);
    const legend = findElements(output, (element) => element.type === "legend")[0];
    const focus = vi.fn();
    const headingRef = legend?.props.ref as { current: { focus(): void } | null } | undefined;
    if (headingRef) headingRef.current = { focus };

    const next = findElements(output, (element) => textContent(element) === "Next")[0];
    (next?.props.onClick as (() => void) | undefined)?.();
    output = renderAskToolCall(MULTIPLE_RICH_ASK, {}, true);

    expect(textContent(output)).toContain("Question 2 of 2");
    expect(focus).toHaveBeenCalledOnce();
    expect(findElements(output, (element) => element.type === "legend")[0]?.props.tabIndex).toBe(-1);
  });

  it("keeps single-select options and custom answers mutually exclusive in both directions", async () => {
    const onRespond = vi.fn().mockResolvedValue(undefined);
    const onActivity = vi.fn();
    let output = renderAskToolCall(SINGLE_RICH_ASK, { onRespond, onActivity });
    expect(findElements(output, (element) => element.props.className === "ask-progress")).toHaveLength(0);
    expect(findElements(output, (element) => textContent(element) === "Previous")).toHaveLength(0);
    expect(findElements(output, (element) => textContent(element) === "Next")).toHaveLength(0);
    expect(findElements(output, (element) => textContent(element) === "Submit answers")).toHaveLength(1);

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
  it("marks a session with a pending question as waiting", () => {
    const output = renderControlledDashboard({
      ...composerDashboardProps(),
      askRequests: [SELECT_ASK],
    });
    const sidebarSession = findElements(
      output,
      (element) => element.props.className === "session-item session-item-selected",
    )[0];
    const statusDot = findElements(
      sidebarSession,
      (element) => element.props.className === "session-state-dot session-state-waiting",
    )[0];
    const statusBadge = findElements(
      output,
      (element) => element.props.className === "status-badge status-waiting",
    )[0];

    expect(sidebarSession?.props["aria-label"]).toBe("Bootstrap, Waiting");
    expect(statusDot).toBeDefined();
    expect(textContent(statusBadge)).toBe("Waiting");
  });

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

  it("loads cost for the viewed session as selection changes", () => {
    const onLoadCost = vi.fn().mockResolvedValue(undefined);
    const secondSession = { ...BASE_SESSION, id: "session-2", name: "Second session" };
    const props = {
      ...composerDashboardProps(),
      sessions: [BASE_SESSION, secondSession],
      onLoadCost,
    };

    renderControlledDashboard(props);
    renderControlledDashboard({ ...props, selectedSessionId: secondSession.id }, { preserveState: true });
    expect(onLoadCost.mock.calls).toEqual([[BASE_SESSION.id], [secondSession.id]]);
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
      provider: "anthropic",
      id: "claude-opus-4.7",
      name: "Claude Opus 4.7",
      efforts: ["low", "medium", "high", "max"],
    },
    {
      provider: "openai",
      id: "gpt-5.6",
      name: "GPT-5.6",
      efforts: ["low", "medium", "high", "xhigh"],
      roles: ["default"],
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
    (element) => element.type === Drawer && textContent(element.props.children as ReactNode).includes(title),
  )[0];
}

describe("session model and effort selectors", () => {
  it("renders separate tappable Model and Effort selector cells", () => {
    const output = renderControlledDashboard(configurationProps(CONFIGURABLE_SESSION));

    expect(findConfigurationTrigger(output, "model")?.props.disabled).not.toBe(true);
    expect(findConfigurationTrigger(output, "effort")?.props.disabled).not.toBe(true);
    expect(
      findElements(output, (element) => element.type === "dt").map((element) => textContent(element)),
    ).toEqual(["Branch", "Model", "Effort", "Context", "Changes", "Updated"]);
  });

  it("opens a populated model-only drawer", () => {
    const props = configurationProps(CONFIGURABLE_SESSION);
    let output = renderControlledDashboard(props);

    (findConfigurationTrigger(output, "model")?.props.onClick as (() => void) | undefined)?.();
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });

    const drawer = findConfigurationDrawer(output, "Model");
    expect(drawer?.props.open).toBe(true);
    expect(drawer?.props).toMatchObject({ showSwipeHandle: false, swipeDirection: "right" });
    expect(textContent(drawer?.props.children as ReactNode)).toContain("GPT-5.6");
    expect(textContent(drawer?.props.children as ReactNode)).toContain("Configured roles: default");
    expect(textContent(drawer?.props.children as ReactNode)).toContain("Claude Opus 4.7");
    const modelButtons = findElements(
      drawer?.props.children as ReactNode,
      (element) =>
        typeof element.props.className === "string" &&
        element.props.className.split(/\s+/).includes("model-option"),
    );
    expect(modelButtons.map((button) => textContent(button))).toEqual([
      "GPT-5.6Configured roles: defaultopenai/gpt-5.6",
      "Claude Opus 4.7anthropic/claude-opus-4.7",
    ]);
    expect(textContent(drawer?.props.children as ReactNode)).not.toContain("Effort");
  });

  it("uses mobile bottom sheets for model and effort selectors", () => {
    reactHarness.isMobile = true;
    const props = configurationProps(CONFIGURABLE_SESSION);
    let output = renderControlledDashboard(props);

    (findConfigurationTrigger(output, "model")?.props.onClick as (() => void) | undefined)?.();
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });
    expect(findConfigurationDrawer(output, "Model")?.props).toMatchObject({
      showSwipeHandle: true,
      swipeDirection: "down",
    });

    (findConfigurationTrigger(output, "effort")?.props.onClick as (() => void) | undefined)?.();
    output = renderControlledDashboard(props, { preserveState: true, effectsEnabled: false });
    expect(findConfigurationDrawer(output, "Effort")?.props).toMatchObject({
      showSwipeHandle: true,
      swipeDirection: "down",
    });
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
    expect(findConfigurationDrawer(output, "Effort")?.props).toMatchObject({
      showSwipeHandle: false,
      swipeDirection: "right",
    });
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
