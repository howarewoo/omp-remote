import type * as ReactModule from "react";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseTodoResult } from "../todo-parser.js";
import { MessageScrollerItem } from "../ui/message-scroller.js";
import { formatSystemTextPreview } from "./code-block.js";
import { parseDisclosureImages } from "./disclosure-content.js";
import { TodoToolTranscript } from "./todo-tool-transcript.js";
import { SystemTranscriptText } from "./transcript-entry.js";
import { ToolTranscriptText } from "./tool-transcript.js";

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

function textContent(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textContent).join("");
  if (!isValidElement(node)) return "";
  return textContent((node as ReactElement<{ children?: ReactNode }>).props.children);
}

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
      "![http](http://cdn.example/insecure.png)",
      "![data](data:image/png;base64,AAAA)",
      "![relative](./image.png)",
      "![protocol-relative](//cdn.example/image.png)",
      "![missing-close](https://cdn.example/unclosed.png",
      "![missing-target]()",
      "![unsupported-extension](https://cdn.example/vector.svg)",
    ].join("\n");

    expect(parseDisclosureImages(text)).toEqual([
      {
        kind: "text",
        text: [
          "![http](http://cdn.example/insecure.png)",
          "![data](data:image/png;base64,AAAA)",
          "![relative](./image.png)",
          "![protocol-relative](//cdn.example/image.png)",
          "![missing-close](https://cdn.example/unclosed.png",
          "![missing-target]()\n",
        ].join("\n"),
      },
      {
        kind: "image",
        alt: "unsupported-extension",
        source: "https://cdn.example/vector.svg",
      },
    ]);
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
    ]);
    expect(readNodes.filter((node) => node.type === "a").map((node) => node.props?.href)).toEqual([
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
    const frame = nodes.find((node) => node.className?.includes("transcript-disclosure-frame"));
    expect(frame).toBeDefined();
    expect(frame?.props?.["data-state"]).toBe("closed");
    expect(frame?.className).toContain("system-message-disclosure");
    expect(frame?.className).toContain("transcript-disclosure-frame");
    expect(nodes.some((node) => node.className === "transcript-disclosure-trigger")).toBe(true);
    expect(nodes.some((node) => node.className === "tool-output-divider")).toBe(false);
    expect(nodes.find((node) => node.className === "transcript-disclosure-text")?.text).toBe(
      `${"x".repeat(180)}…`,
    );
    expect(nodes.some((node) => node.className === "transcript-disclosure-chevron")).toBe(true);
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
    const nodes = renderTranscriptNodes(disclosure);
    const preview = nodes.find((node) => node.className === "transcript-disclosure-preview");
    const previewContent = nodes.find(
      (node) =>
        node.className === "transcript-disclosure-content" && node.props?.["data-variant"] === "thumbnail",
    );
    const expandedContent = nodes.find(
      (node) =>
        node.className === "transcript-disclosure-content" && node.props?.["data-variant"] === "expanded",
    );

    expect(preview).toBeDefined();
    expect(previewContent).toBeDefined();
    expect(expandedContent).toBeDefined();
    expect(expandedContent?.text).toBe(text);
    expect(nodes.some((node) => node.type === "strong")).toBe(false);
    expect(nodes.filter((node) => node.type === "a").map((node) => node.props?.href)).toEqual([
      "https://example.com",
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
    const nodes = renderTranscriptNodes(disclosure);

    expect(nodes.filter((node) => node.type === "img").map((node) => node.props?.src)).toEqual([
      source,
      source,
    ]);
    expect(nodes.some((node) => node.type === "a")).toBe(true);
    expect(
      nodes.filter((node) => node.className === "disclosure-image-link").map((node) => node.props?.href),
    ).toEqual([source]);
    expect(
      nodes.filter((node) => node.className === "transcript-disclosure-text").map((node) => node.text),
    ).toEqual(["prefix suffix", "prefix ", " suffix"]);
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
