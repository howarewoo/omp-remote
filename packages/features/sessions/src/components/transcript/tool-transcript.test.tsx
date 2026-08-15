import type { Session } from "@omp-remote/protocol";
import type * as ReactModule from "react";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseTodoResult } from "../todo-parser.js";
import { MessageScrollerItem } from "../ui/message-scroller.js";
import { renderTranscriptMessageItems } from "./transcript-entry.js";
import { TodoToolTranscript } from "./todo-tool-transcript.js";
import { formatToolTextPreview, ToolTranscriptText } from "./tool-transcript.js";

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

function cleanupReactHarnessEffects() {
  for (const effect of reactHarness.effectValues) effect.cleanup?.();
  reactHarness.effectValues = [];
}

beforeEach(() => {
  cleanupReactHarnessEffects();
  Object.assign(reactHarness, {
    effectIndex: 0,
    lifecycleEffects: false,
    refIndex: 0,
    refValues: [],
    stateIndex: 0,
    stateValues: [],
  });
});

const TODO_RESULT_TEXT =
  'Remaining items (1):\n  - Build custom todo tool interface [in_progress] (Implementation)\nOverall: 2/4 done, 1 open, 1 blocked.\nActive phase 2/3 "Implementation" (0/1) — earliest phase with open work\n  Research:\n    - [X] Locate todo rendering and UI conventions\n    - [X] Define todo interaction contract\n  Implementation:\n    - [ ] Build custom todo tool interface (in progress)\n  Verification:\n    - [ ] Exercise todo flow in browser (blocked: format probe)';

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

function findElements(
  node: ReactNode,
  predicate: (element: ReactElement<Record<string, unknown>>) => boolean,
): ReactElement<Record<string, unknown>>[] {
  if (node === null || node === undefined || typeof node === "boolean") return [];
  if (Array.isArray(node)) return node.flatMap((child) => findElements(child, predicate));
  if (!isValidElement(node)) return [];
  const element = node as ReactElement<Record<string, unknown> & { children?: ReactNode }>;
  if (typeof element.type === "function") {
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
  return [...(predicate(element) ? [element] : []), ...findElements(element.props.children, predicate)];
}

function textContent(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textContent).join("");
  if (!isValidElement(node)) return "";
  return textContent((node as ReactElement<{ children?: ReactNode }>).props.children);
}

function renderToolTranscriptWithHooks(
  entry: Session["messages"][number],
  preserveState = false,
): RenderedNode[] {
  if (!preserveState) {
    cleanupReactHarnessEffects();
    reactHarness.stateValues = [];
  }
  reactHarness.effectIndex = 0;
  reactHarness.refIndex = 0;
  reactHarness.stateIndex = 0;
  return renderTranscriptNodes(ToolTranscriptText({ entry }));
}
describe("ToolTranscriptText", () => {
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
        renderTranscriptNodes(disclosure).find(
          (node) => node.className === "transcript-disclosure-title" || node.className === "message-author",
        )?.props?.children as ReactNode,
      ),
    ).toContain(title);
  });

  it("shows a canonical Read filename with its icon without rendering the result", () => {
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
      textContent(
        nodes.find(
          (node) => node.className === "transcript-disclosure-title" || node.className === "message-author",
        )?.props?.children as ReactNode,
      ),
    ).toContain("Read: dashboard.tsx");
    expect(
      nodes.find((node) => node.className === "transcript-disclosure-icon")?.props?.["data-category"],
    ).toBe("read");
    expect(nodes.some((node) => node.className === "transcript-disclosure-trigger")).toBe(false);
    expect(nodes.some((node) => node.className === "tool-message-preview")).toBe(false);
    expect(nodes.some((node) => node.className === "tool-output-divider")).toBe(false);
    expect(nodes.some((node) => node.text.includes("1091:  return <details />;"))).toBe(false);
  });

  it("renders a short untargeted Read error without disclosure controls", () => {
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
    const frame = nodes.find((node) => node.className?.includes("transcript-disclosure-frame"));

    expect(nodes[0]).toEqual(
      expect.objectContaining({
        type: "div",
        className: expect.stringContaining("read-result-disclosure"),
      }),
    );
    expect(frame?.props?.["data-state"]).toBe("static");
    expect(
      nodes.find(
        (node) => node.className === "transcript-disclosure-title" || node.className === "message-author",
      )?.text,
    ).toContain("Read");
    expect(nodes.find((node) => node.className === "read-result-preview")?.text).toBe(text);
    expect(nodes.filter((node) => node.className === "transcript-disclosure-text")).toHaveLength(1);
    expect(nodes.find((node) => node.className === "tool-output-divider")?.text).toBe("Output");
    expect(nodes.some((node) => node.className === "transcript-disclosure-trigger")).toBe(false);
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

    expect(disclosure.props.category).toBe("read");
    expect(
      textContent(
        nodes.find(
          (node) => node.className === "transcript-disclosure-title" || node.className === "message-author",
        )?.props?.children as ReactNode,
      ),
    ).toContain("Read: index.ts");
    expect(
      nodes.find((node) => node.className === "transcript-disclosure-icon")?.props?.["data-category"],
    ).toBe("read");
    expect(nodes.some((node) => node.className === "transcript-disclosure-trigger")).toBe(false);
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
  ])("renders a short URI-like Read target without disclosure controls: %s", (readTarget) => {
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
    const frame = nodes.find((node) => node.className?.includes("transcript-disclosure-frame"));
    const rawTextNodes = nodes.filter((node) => node.className === "transcript-disclosure-text");

    expect(nodes[0]).toEqual(
      expect.objectContaining({
        type: "div",
        className: expect.stringContaining("read-result-disclosure"),
      }),
    );
    expect(frame?.props?.["data-state"]).toBe("static");
    expect(
      nodes.find(
        (node) => node.className === "transcript-disclosure-title" || node.className === "message-author",
      )?.text,
    ).toContain(`Read ${readTarget}`);
    expect(rawTextNodes.map((node) => node.text)).toEqual([text]);
    expect(nodes.filter((node) => node.type === "a").map((node) => node.props?.href)).toEqual([
      "https://example.com",
    ]);
    expect(nodes.filter((node) => node.type === "a").some((node) => node.props?.href === readTarget)).toBe(
      false,
    );
    expect(
      nodes.some((node) => typeof node.type === "string" && ["strong", "code"].includes(node.type)),
    ).toBe(false);
    expect(nodes.find((node) => node.className === "tool-output-divider")?.text).toBe("Output");
    expect(nodes.some((node) => node.className === "transcript-disclosure-trigger")).toBe(false);
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
    expect(
      nodes.find(
        (node) => node.className === "transcript-disclosure-title" || node.className === "message-author",
      )?.text,
    ).toContain(`Read ${readTarget}`);
    expect(
      nodes.filter((node) => node.className === "transcript-disclosure-text").map((node) => node.text),
    ).toEqual([text]);
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

    expect(
      nodes.find(
        (node) => node.className === "transcript-disclosure-title" || node.className === "message-author",
      )?.text,
    ).toContain("Read diagram.png");
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
  });

  it("renders short edit output without disclosure controls", () => {
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

    const frame = nodes.find((node) => node.className?.includes("transcript-disclosure-frame"));
    expect(frame?.props?.["data-state"]).toBe("static");
    expect(frame?.className).toContain("tool-message-disclosure");
    expect(frame?.className).toContain("transcript-disclosure-frame");
    expect(frame?.className).toContain("tool-output-disclosure");
    expect(nodes.find((node) => node.className === "tool-output-divider")?.text).toBe("Output");
    expect(nodes.some((node) => node.className === "transcript-disclosure-trigger")).toBe(false);
    expect(nodes.some((node) => node.className === "transcript-disclosure-panel")).toBe(false);
    expect(
      textContent(
        nodes.find(
          (node) => node.className === "transcript-disclosure-title" || node.className === "message-author",
        )?.props?.children as ReactNode,
      ),
    ).toContain("Edit: 🟦 src/dashboard.tsx ⟦+1⟧ ⟦−1⟧");
  });

  it("renders short write output directly in the shared static frame", () => {
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

    const frame = nodes.find((node) => node.className?.includes("transcript-disclosure-frame"));
    expect(frame?.props?.["data-state"]).toBe("static");
    expect(frame?.className).toContain("tool-message-disclosure");
    expect(frame?.className).toContain("transcript-disclosure-frame");
    expect(frame?.className).toContain("tool-output-disclosure");
    expect(nodes.some((node) => node.className === "transcript-disclosure-trigger")).toBe(false);
    expect(
      textContent(
        nodes.find(
          (node) => node.className === "transcript-disclosure-title" || node.className === "message-author",
        )?.props?.children as ReactNode,
      ),
    ).toContain("Write: packages/features/sessions/src/components/dashboard.tsx");
    expect(nodes.find((node) => node.className === "tool-output-divider")?.text).toBe("Output");
    expect(nodes.find((node) => node.className === "transcript-disclosure-text")?.text).toBe(text);
    expect(nodes.some((node) => node.className === "transcript-disclosure-panel")).toBe(false);
  });

  it.each(["", " \n\t "])("labels empty write output without disclosure controls: %j", (text) => {
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
    const nodes = renderTranscriptNodes(disclosure);
    expect(nodes.find((node) => node.className === "transcript-disclosure-text")?.text).toBe(
      "No tool output",
    );
    expect(nodes.some((node) => node.className === "transcript-disclosure-trigger")).toBe(false);
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
    const disclosureNodes = renderTranscriptNodes(disclosure);
    const frame = disclosureNodes.find((node) => node.className?.includes("transcript-disclosure-frame"));
    expect(frame?.props?.["data-state"]).toBe("closed");
    expect(frame?.className).toContain("tool-message-disclosure");
    expect(frame?.className).toContain("transcript-disclosure-frame");
    expect(frame?.className).toContain("todo-tool-disclosure");
    expect(nodes.find((node) => node.className === "tool-output-divider")?.text).toBe("Output");
    expect(nodes.findIndex((node) => node.className === "tool-output-divider")).toBeLessThan(
      nodes.findIndex((node) => node.className === "todo-tool-summary"),
    );
    expect(nodes.filter((node) => node.type === "ul")).toHaveLength(3);
    const progress = findElements(disclosure, (element) => element.type === "progress")[0];
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
    expect(droppedNodes.find((node) => node.className === "todo-state-marker")?.props?.["data-state"]).toBe(
      "dropped",
    );

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
    expect(completedNodes.find((node) => node.className === "todo-state-marker")?.props?.["data-state"]).toBe(
      "completed",
    );
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
    const frame = renderTranscriptNodes(block).find((node) =>
      node.className?.includes("transcript-disclosure-frame"),
    );
    expect(frame?.className).toContain("tool-message-disclosure");
    expect(frame?.className).toContain("transcript-disclosure-frame");
    expect(frame?.className).toContain("tool-output-disclosure");
    expect(
      renderTranscriptNodes(block).find((node) => node.className === "transcript-disclosure-text")?.text,
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

    const frame = renderTranscriptNodes(block).find((node) =>
      node.className?.includes("transcript-disclosure-frame"),
    );
    expect(frame?.className).toContain("tool-message-disclosure");
    expect(frame?.className).toContain("transcript-disclosure-frame");
    expect(frame?.className).toContain("tool-output-disclosure");
    expect(
      renderTranscriptNodes(block).find((node) => node.className === "transcript-disclosure-text")?.text,
    ).toBe(formatToolTextPreview(text));
    expect(renderTranscriptNodes(block).some((node) => node.className === "tool-output-divider")).toBe(true);
  });

  it("labels an empty tool result", () => {
    expect(formatToolTextPreview("")).toBe("No tool output");
  });
});
