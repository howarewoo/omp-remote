import type * as ReactModule from "react";
import { isValidElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  renderPlainTextWithLinks,
  renderSafeHttpLinkSiblings,
  renderSafeHttpText,
  renderSafeHttpTextWithoutLinks,
  TranscriptProse,
} from "./inline-transcript.js";

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
  type?: unknown;
  text: string;
}

function renderTranscriptNodes(node: ReactNode): RenderedNode[] {
  if (node === null || node === undefined || typeof node === "boolean") return [];
  if (typeof node === "string" || typeof node === "number") return [{ text: String(node) }];
  if (Array.isArray(node)) return node.flatMap(renderTranscriptNodes);
  if (!isValidElement(node)) return [];

  const element = node as { type: unknown; props: Record<string, unknown> };

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

  const rawChildren = element.props?.children as ReactNode;
  const childGroups = (Array.isArray(rawChildren) ? rawChildren : [rawChildren]).map(renderTranscriptNodes);
  const childText = childGroups.map((children) => children[0]?.text ?? "").join("");
  const className = typeof element.props?.className === "string" ? element.props.className : undefined;

  return [
    {
      type: typeof element.type === "string" ? element.type : undefined,
      ...(className !== undefined ? { className } : {}),
      props: element.props,
      text: childText,
    },
    ...childGroups.flat(),
  ];
}

describe("TranscriptProse empty line handling", () => {
  it("strips trailing empty lines and does not emit trailing transcript-line-empty elements", () => {
    const textWith50TrailingNewlines = `Hello world${"\n".repeat(55)}`;
    const nodes = renderTranscriptNodes(<TranscriptProse text={textWith50TrailingNewlines} />);

    const emptyLines = nodes.filter((n) => n.className?.includes("transcript-line-empty"));
    expect(emptyLines).toHaveLength(0);

    const proseLines = nodes.filter(
      (n) => n.className === "transcript-line" || n.className?.includes("transcript-line "),
    );
    expect(proseLines).toHaveLength(1);
    expect(nodes.some((n) => n.text === "Hello world")).toBe(true);
  });

  it("strips leading empty lines and whitespace-only lines", () => {
    const textWithLeadingNewlines = `\n\n   \n\t  \n\nFirst line of text\nSecond line`;
    const nodes = renderTranscriptNodes(<TranscriptProse text={textWithLeadingNewlines} />);

    const emptyLines = nodes.filter((n) => n.className?.includes("transcript-line-empty"));
    expect(emptyLines).toHaveLength(0);

    const proseLines = nodes.filter((n) => n.className === "transcript-line");
    expect(proseLines).toHaveLength(2);
    expect(nodes.some((n) => n.text === "First line of text")).toBe(true);
    expect(nodes.some((n) => n.text === "Second line")).toBe(true);
  });

  it("collapses multiple consecutive empty lines to exactly 1 transcript-line-empty span", () => {
    const textWithConsecutiveEmptyLines = `Paragraph 1\n\n\n\n\n\nParagraph 2`;
    const nodes = renderTranscriptNodes(<TranscriptProse text={textWithConsecutiveEmptyLines} />);

    const emptyLines = nodes.filter((n) => n.className?.includes("transcript-line-empty"));
    expect(emptyLines).toHaveLength(1);

    const proseLines = nodes.filter((n) => n.className === "transcript-line");
    expect(proseLines).toHaveLength(2);
    expect(nodes.some((n) => n.text === "Paragraph 1")).toBe(true);
    expect(nodes.some((n) => n.text === "Paragraph 2")).toBe(true);
  });

  it("treats whitespace-only lines as empty and collapses them", () => {
    const textWithWhitespaceLines = `Paragraph A\n   \n\t\t\n   \nParagraph B`;
    const nodes = renderTranscriptNodes(<TranscriptProse text={textWithWhitespaceLines} />);

    const emptyLines = nodes.filter((n) => n.className?.includes("transcript-line-empty"));
    expect(emptyLines).toHaveLength(1);

    const proseLines = nodes.filter((n) => n.className === "transcript-line");
    expect(proseLines).toHaveLength(2);
  });

  it("renders 0 line spans if text is completely empty or only whitespace", () => {
    const emptyNodes = renderTranscriptNodes(<TranscriptProse text="" />);
    const lineNodesFromEmpty = emptyNodes.filter((n) => n.className?.includes("transcript-line"));
    expect(lineNodesFromEmpty).toHaveLength(0);

    const whitespaceNodes = renderTranscriptNodes(<TranscriptProse text={"   \n\n\t  \n   \n"} />);
    const lineNodesFromWhitespace = whitespaceNodes.filter((n) => n.className?.includes("transcript-line"));
    expect(lineNodesFromWhitespace).toHaveLength(0);
  });

  it("normalizes CRLF and CR line breaks correctly", () => {
    const crlfText = `Line 1\r\n\r\n\r\nLine 2\r\rLine 3`;
    const nodes = renderTranscriptNodes(<TranscriptProse text={crlfText} />);

    const emptyLines = nodes.filter((n) => n.className?.includes("transcript-line-empty"));
    // Between Line 1 and Line 2: 2 empty lines collapsed to 1
    // Between Line 2 and Line 3: 1 empty line
    expect(emptyLines).toHaveLength(2);

    const proseLines = nodes.filter((n) => n.className === "transcript-line");
    expect(proseLines).toHaveLength(3);
  });

  it("preserves single empty line for paragraph separation", () => {
    const text = `First paragraph\n\nSecond paragraph`;
    const nodes = renderTranscriptNodes(<TranscriptProse text={text} />);

    const emptyLines = nodes.filter((n) => n.className?.includes("transcript-line-empty"));
    expect(emptyLines).toHaveLength(1);

    const proseLines = nodes.filter((n) => n.className === "transcript-line");
    expect(proseLines).toHaveLength(2);
  });
});

describe("TranscriptProse structured markdown elements", () => {
  it("renders markdown headings with data-level attribute", () => {
    const text = `# Level 1\n## Level 2\n### Level 3`;
    const nodes = renderTranscriptNodes(<TranscriptProse text={text} />);

    const headingNodes = nodes.filter((n) => n.className === "transcript-heading");
    expect(headingNodes).toHaveLength(3);
    expect(headingNodes[0]?.props?.["data-level"]).toBe(1);
    expect(headingNodes[1]?.props?.["data-level"]).toBe(2);
    expect(headingNodes[2]?.props?.["data-level"]).toBe(3);
  });

  it("renders blockquotes with transcript-quote class", () => {
    const text = `> A quoted insight\n> Another quote line`;
    const nodes = renderTranscriptNodes(<TranscriptProse text={text} />);

    const quoteNodes = nodes.filter((n) => n.className === "transcript-quote");
    expect(quoteNodes).toHaveLength(2);
  });

  it("renders bullet list items and ordered list items with marker", () => {
    const text = `- Bullet item\n* Star item\n+ Plus item\n1. Numbered item\n  - Indented item`;
    const nodes = renderTranscriptNodes(<TranscriptProse text={text} />);

    const listNodes = nodes.filter((n) => n.className === "transcript-list-item");
    expect(listNodes).toHaveLength(5);
  });

  it("renders horizontal rules with transcript-rule class", () => {
    const text = `Before rule\n---\nAfter rule\n***\nEnd`;
    const nodes = renderTranscriptNodes(<TranscriptProse text={text} />);

    const ruleNodes = nodes.filter((n) => n.className === "transcript-rule");
    expect(ruleNodes).toHaveLength(2);
  });

  it("renders inline tokens (code, strong, link) inside prose lines", () => {
    const text = `Use **bold text**, \`inline code\`, and [docs](https://example.com/docs).`;
    const nodes = renderTranscriptNodes(<TranscriptProse text={text} />);

    expect(nodes.some((n) => n.type === "strong")).toBe(true);
    expect(nodes.some((n) => n.type === "code" && n.text === "inline code")).toBe(true);
    const link = nodes.find((n) => n.className === "transcript-link");
    expect(link).toBeDefined();
    expect(link?.props?.href).toBe("https://example.com/docs");
  });
});

describe("safe HTTP render helpers", () => {
  it("renderSafeHttpText renders links and plain text spans", () => {
    const rendered = renderSafeHttpText("Check https://example.com/api for info", "prefix");
    const nodes = renderTranscriptNodes(rendered);
    const link = nodes.find((n) => n.className === "transcript-link");
    expect(link).toBeDefined();
    expect(link?.props?.href).toBe("https://example.com/api");
  });

  it("renderSafeHttpTextWithoutLinks renders text only and drops links", () => {
    const rendered = renderSafeHttpTextWithoutLinks("Check https://example.com/api for info", "prefix");
    const nodes = renderTranscriptNodes(rendered);
    const link = nodes.find((n) => n.className === "transcript-link");
    expect(link).toBeUndefined();
    expect(nodes.some((n) => n.text === "Check ")).toBe(true);
  });

  it("renderSafeHttpLinkSiblings filters only link elements", () => {
    const rendered = renderSafeHttpLinkSiblings(
      "Go to https://example.com/one and https://example.com/two",
      "prefix",
    );
    const nodes = renderTranscriptNodes(rendered);
    const links = nodes.filter((n) => n.className === "transcript-link");
    expect(links).toHaveLength(2);
  });

  it("renderPlainTextWithLinks renders pre block with safe HTTP links", () => {
    const rendered = renderPlainTextWithLinks("Log output https://example.com", "key-prefix");
    const nodes = renderTranscriptNodes(rendered);
    const pre = nodes.find((n) => n.type === "pre");
    expect(pre).toBeDefined();
    const link = nodes.find((n) => n.className === "transcript-link");
    expect(link).toBeDefined();
  });
});
