import type * as ReactModule from "react";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DisclosureCategoryIcon,
  DisclosureChevronIcon,
  TranscriptDisclosure,
} from "./transcript-disclosure.js";

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
  type?: unknown;
  text: string;
}

function renderNodes(node: ReactNode): RenderedNode[] {
  if (node === null || node === undefined || typeof node === "boolean") return [];
  if (typeof node === "string" || typeof node === "number") return [{ text: String(node) }];
  if (Array.isArray(node)) return node.flatMap(renderNodes);
  if (!isValidElement(node)) return [];
  const element = node as { type: unknown; props: Record<string, unknown> };
  if (typeof element.type === "function") {
    try {
      return renderNodes((element.type as (props: Record<string, unknown>) => ReactNode)(element.props));
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
      return renderNodes(
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
      return renderNodes(
        (element.type as { render: (props: Record<string, unknown>, ref: unknown) => ReactNode }).render(
          element.props,
          null,
        ),
      );
    } catch {
      // Fall through
    }
  }
  if (typeof element.type === "symbol") return renderNodes(element.props.children as ReactNode);
  const rawChildren = element.props.children as ReactNode;
  const childGroups = (Array.isArray(rawChildren) ? rawChildren : [rawChildren]).map(renderNodes);
  return [
    {
      type: typeof element.type === "string" ? element.type : undefined,
      ...(typeof element.props.className === "string" ? { className: element.props.className } : {}),
      props: element.props,
      text: childGroups.map((children) => children[0]?.text ?? "").join(""),
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
  const matches = predicate(element) ? [element] : [];
  return [...matches, ...findElements(element.props?.children, predicate)];
}

describe("TranscriptDisclosure", () => {
  it("renders a Base UI collapsible frame with trigger, header, icon, and closed state by default", () => {
    const disclosure = TranscriptDisclosure({
      category: "tool",
      title: "Bash command",
      preview: <span>Command preview</span>,
      children: <div>Command output details</div>,
    });
    const nodes = renderNodes(disclosure);

    const frame = nodes.find((node) => node.className?.includes("transcript-disclosure-frame"));
    const trigger = nodes.find((node) => node.className === "transcript-disclosure-trigger");
    const header = nodes.find((node) => node.className === "transcript-disclosure-header");
    const icon = nodes.find((node) => node.className === "transcript-disclosure-icon");
    const title = nodes.find((node) => node.className === "transcript-disclosure-title");
    const preview = nodes.find((node) => node.className === "transcript-disclosure-preview");
    const panel = nodes.find((node) => node.className === "transcript-disclosure-panel");
    const chevron = nodes.find((node) => node.className === "transcript-disclosure-chevron");

    expect(frame).toBeDefined();
    expect(frame?.props?.["data-state"]).toBe("closed");
    expect(trigger).toBeDefined();
    expect(header).toBeDefined();
    expect(icon?.props?.["data-category"]).toBe("tool");
    expect(title?.text).toBe("Bash command");
    expect(preview?.text).toBe("Command preview");
    expect(panel?.text).toBe("Command output details");
    expect(chevron).toBeDefined();
  });

  it("renders short content as a static icon-led row without disclosure controls", () => {
    const disclosure = TranscriptDisclosure({
      category: "read",
      expandable: false,
      title: "Read: package.json",
      preview: <span>Short output</span>,
      children: <div>Unused expanded output</div>,
    });
    const nodes = renderNodes(disclosure);
    const frame = nodes.find((node) => node.className?.includes("transcript-disclosure-frame"));

    expect(frame?.props?.["data-state"]).toBe("static");
    expect(nodes.find((node) => node.className === "transcript-disclosure-summary")).toBeDefined();
    expect(
      nodes.find((node) => node.className === "transcript-disclosure-icon")?.props?.["data-category"],
    ).toBe("read");
    expect(nodes.find((node) => node.className === "transcript-disclosure-preview")?.text).toBe(
      "Short output",
    );
    expect(nodes.some((node) => node.className === "transcript-disclosure-trigger")).toBe(false);
    expect(nodes.some((node) => node.className === "transcript-disclosure-panel")).toBe(false);
    expect(nodes.some((node) => node.className === "transcript-disclosure-chevron")).toBe(false);
  });

  it("keeps preview as a sibling outside the trigger button to prevent nested interactive content", () => {
    const disclosure = TranscriptDisclosure({
      category: "read",
      title: "Read document",
      preview: <a href="https://example.com">Preview link</a>,
      children: <div>Full document content</div>,
    });
    const triggers = findElements(disclosure, (el) => el.props.className === "transcript-disclosure-trigger");
    const previews = findElements(disclosure, (el) => el.props.className === "transcript-disclosure-preview");

    expect(triggers).toHaveLength(1);
    expect(previews).toHaveLength(1);

    // Verify preview is not inside trigger children
    const triggerLinks = findElements(triggers[0]?.props.children as ReactNode, (el) => el.type === "a");
    expect(triggerLinks).toHaveLength(0);
  });

  it("surfaces non-color lifecycle labels for running, error, waiting, and canceled states", () => {
    const running = renderNodes(
      TranscriptDisclosure({
        category: "tool",
        lifecycle: "running",
        title: "Executing script",
        children: "Output",
      }),
    );
    const failed = renderNodes(
      TranscriptDisclosure({
        category: "tool",
        lifecycle: "error",
        title: "Failed script",
        children: "Error trace",
      }),
    );
    const waiting = renderNodes(
      TranscriptDisclosure({
        category: "tool",
        lifecycle: "waiting",
        title: "Pending approval",
        children: "Prompt",
      }),
    );
    const canceled = renderNodes(
      TranscriptDisclosure({
        category: "tool",
        lifecycle: "canceled",
        title: "Aborted job",
        children: "Log",
      }),
    );

    expect(running.find((node) => node.className === "transcript-disclosure-status")?.text).toBe("Running");
    expect(failed.find((node) => node.className === "transcript-disclosure-status")?.text).toBe("Failed");
    expect(waiting.find((node) => node.className === "transcript-disclosure-status")?.text).toBe("Waiting");
    expect(canceled.find((node) => node.className === "transcript-disclosure-status")?.text).toBe("Canceled");
  });

  it("renders live polite announcement for running, error, waiting, and canceled states", () => {
    const running = renderNodes(
      TranscriptDisclosure({
        category: "tool",
        lifecycle: "running",
        title: "Executing script",
        children: "Output",
      }),
    );
    const failed = renderNodes(
      TranscriptDisclosure({
        category: "tool",
        lifecycle: "error",
        title: "Failed script",
        children: "Error trace",
      }),
    );
    const waiting = renderNodes(
      TranscriptDisclosure({
        category: "tool",
        lifecycle: "waiting",
        title: "Pending approval",
        children: "Prompt",
      }),
    );
    const canceled = renderNodes(
      TranscriptDisclosure({
        category: "tool",
        lifecycle: "canceled",
        title: "Aborted job",
        children: "Log",
      }),
    );

    const getAnnouncement = (nodes: RenderedNode[]) =>
      nodes.find((node) => node.className?.includes("transcript-disclosure-announcement"))?.text;

    expect(getAnnouncement(running)).toBe("Operation running");
    expect(getAnnouncement(failed)).toBe("Operation failed");
    expect(getAnnouncement(waiting)).toBe("Action required");
    expect(getAnnouncement(canceled)).toBe("Operation canceled");
  });
  it("supports controlled open state and forwards toggle events", () => {
    const onOpenChange = vi.fn();
    const disclosure = TranscriptDisclosure({
      category: "tool",
      open: true,
      onOpenChange,
      title: "Controlled disclosure",
      children: <div>Disclosure content</div>,
    });
    const nodes = renderNodes(disclosure);
    const frame = nodes.find((node) => node.className?.includes("transcript-disclosure-frame"));

    expect(frame?.props?.["data-state"]).toBe("open");
  });

  it("renders semantic SVG category icons without emoji or unicode glyphs", () => {
    const categories = [
      "system",
      "tool",
      "read",
      "write",
      "edit",
      "bash",
      "grep",
      "task",
      "todo",
      "yield",
      "code",
    ] as const;

    for (const category of categories) {
      const icon = DisclosureCategoryIcon({ category });
      const nodes = renderNodes(icon);
      expect(nodes.some((node) => node.type === "svg")).toBe(true);
      expect(nodes[0]?.props?.["aria-hidden"]).toBe("true");
    }
  });

  it("renders chevron SVG with aria-hidden", () => {
    const chevron = DisclosureChevronIcon();
    const nodes = renderNodes(chevron);
    expect(nodes.some((node) => node.type === "svg")).toBe(true);
    expect(nodes[0]?.props?.["aria-hidden"]).toBe("true");
  });
});
