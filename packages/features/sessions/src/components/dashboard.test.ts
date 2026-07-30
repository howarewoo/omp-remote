import type { Session } from "@omp-remote/protocol";
import { isValidElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import {
  canKillSession,
  formatSubagentActivityLabel,
  getComposerAction,
  formatSystemTextPreview,
  formatToolTextPreview,
  groupSessionsByConnection,
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
    expect(block.props.open).toBeUndefined();
    expect(block.props.children[0].type).toBe("summary");
    expect(block.props.children[0].props.children[1].props.children).toBe(formatToolTextPreview(text));
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
