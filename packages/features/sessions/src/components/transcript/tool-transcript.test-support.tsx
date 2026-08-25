import type { Session } from "@omp-remote/protocol";
import type * as ReactModule from "react";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
// Load render targets after Vitest registers the React and Collapsible mocks above.
const { parseTodoResult } = await import("../todo-parser.js");
const { MessageScrollerItem } = await import("../ui/message-scroller.js");
const { renderTranscriptMessageItems } = await import("./transcript-entry.js");
const { TodoToolTranscript } = await import("./todo-tool-transcript.js");
const { formatToolTextPreview, ToolTranscriptText } = await import("./tool-transcript.js");

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

export {
  cleanupReactHarnessEffects,
  findElements,
  formatToolTextPreview,
  parseTodoResult,
  reactHarness,
  renderToolTranscriptWithHooks,
  renderTranscriptMessageItems,
  renderTranscriptNodes,
  textContent,
  TODO_RESULT_TEXT,
  TodoToolTranscript,
  ToolTranscriptText,
};
