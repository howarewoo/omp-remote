import type { AskRequest, Session } from "@omp-remote/protocol";
import type * as ReactModule from "react";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, vi } from "vitest";
import { Dashboard, type DashboardProps } from "../dashboard.js";

interface ReactHarness {
  callbackIndex: number;
  callbackValues: {
    callback: (...args: never[]) => unknown;
    dependencies: readonly unknown[];
  }[];
  effectsEnabled: boolean;
  effectIndex: number;
  effectValues: {
    cleanup?: () => void;
    dependencies: readonly unknown[] | undefined;
  }[];
  lifecycleEffects: boolean;
  isMobile: boolean;
  setOpenMobile(open: boolean): void;
  stateIndex: number;
  refIndex: number;
  refValues: { current: unknown }[];
  stateValues: unknown[];
}

const reactHarness: ReactHarness = vi.hoisted(() => ({
  callbackIndex: 0,
  callbackValues: [] as {
    callback: (...args: never[]) => unknown;
    dependencies: readonly unknown[];
  }[],
  effectsEnabled: true,
  effectIndex: 0,
  effectValues: [] as {
    cleanup?: () => void;
    dependencies: readonly unknown[] | undefined;
  }[],
  lifecycleEffects: false,
  isMobile: false,
  setOpenMobile: vi.fn(),
  stateIndex: 0,
  refIndex: 0,
  refValues: [] as { current: unknown }[],
  stateValues: [] as unknown[],
}));

const messageScrollerHarness: {
  scrollToEnd: {
    (options: { behavior: "auto" }): void;
    mockReset(): void;
  };
} = vi.hoisted(() => ({
  scrollToEnd: vi.fn<(options: { behavior: "auto" }) => void>(),
}));

export function getReactHarness(): ReactHarness {
  return reactHarness;
}

export function getMessageScrollerHarness() {
  return messageScrollerHarness;
}

vi.mock("../ui/message-scroller.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    useMessageScroller: () => ({ scrollToEnd: messageScrollerHarness.scrollToEnd }),
  };
});

vi.mock("../ui/tooltip.js", () => ({
  Tooltip: ({ children, content }: { children: ReactNode; content: ReactNode }) => (
    <span data-slot="tooltip-wrapper" data-tooltip={typeof content === "string" ? content : undefined}>
      {children}
    </span>
  ),
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipRoot: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipPortal: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipPositioner: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipPopup: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

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
    useCallback: <T extends (...args: never[]) => unknown>(callback: T, dependencies: readonly unknown[]) => {
      const index = reactHarness.callbackIndex++;
      const previous = reactHarness.callbackValues[index];
      if (
        previous &&
        previous.dependencies.length === dependencies.length &&
        dependencies.every((dependency, dependencyIndex) =>
          Object.is(dependency, previous.dependencies[dependencyIndex]),
        )
      ) {
        return previous.callback as T;
      }
      reactHarness.callbackValues[index] = { callback, dependencies };
      return callback;
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

vi.mock("../ui/sidebar.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    useSidebar: () => ({ isMobile: reactHarness.isMobile, setOpenMobile: reactHarness.setOpenMobile }),
  };
});

function cleanupReactHarnessEffects() {
  for (const effect of reactHarness.effectValues) effect.cleanup?.();
  reactHarness.effectIndex = 0;
  reactHarness.effectValues = [];
}

beforeEach(() => {
  if (reactHarness.lifecycleEffects) cleanupReactHarnessEffects();
  reactHarness.callbackIndex = 0;
  reactHarness.callbackValues = [];
  reactHarness.effectsEnabled = true;
  reactHarness.effectIndex = 0;
  reactHarness.effectValues = [];
  reactHarness.isMobile = false;
  reactHarness.lifecycleEffects = false;
  reactHarness.setOpenMobile = vi.fn();
  reactHarness.refIndex = 0;
  reactHarness.refValues = [];
  reactHarness.stateIndex = 0;
  reactHarness.stateValues = [];
  messageScrollerHarness.scrollToEnd.mockReset();
});

export const BASE_SESSION: Session = {
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

export interface RenderedNode {
  className?: string;
  open?: boolean;
  props?: Record<string, unknown>;
  type?: string;
  text: string;
}

export function renderTranscriptNodes(node: ReactNode): RenderedNode[] {
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

export type ControlledDashboardProps = DashboardProps & {
  selectedSessionId: string | null;
  onSelectedSessionChange(sessionId: string): void;
};

export const DASHBOARD_DEFAULTS: DashboardProps = {
  sessions: [],
  queuedMessages: [],
  askRequests: [] as AskRequest[],
  savedWorkingDirectories: [] as string[],
  sessionsReady: false,
  historyLoading: false,
  hasMoreHistory: false,
  connection: "connected",
  error: null,
  notificationState: "unsupported",
  notificationPreferences: { inputRequired: false, sessionIdle: false },
  notificationError: null,
  selectedSessionId: null,
  onSelectedSessionChange: vi.fn(),
  onToggleNotification: vi.fn().mockResolvedValue(undefined),
  onLaunch: vi.fn().mockResolvedValue("created-session"),
  onSaveWorkingDirectory: vi.fn().mockResolvedValue(undefined),
  onRemoveWorkingDirectory: vi.fn().mockResolvedValue(undefined),
  onCommand: vi.fn().mockResolvedValue(undefined),
  onCancelQueuedMessage: vi.fn(),
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

export function renderControlledDashboard(
  props: ControlledDashboardProps,
  options: { preserveState?: boolean; effectsEnabled?: boolean } = {},
): ReactNode {
  if (!options.preserveState) {
    reactHarness.callbackValues = [];
    if (reactHarness.lifecycleEffects) cleanupReactHarnessEffects();
    reactHarness.refValues = [];
    reactHarness.stateValues = [];
  }
  if (reactHarness.lifecycleEffects) reactHarness.effectIndex = 0;
  reactHarness.callbackIndex = 0;
  reactHarness.refIndex = 0;
  reactHarness.stateIndex = 0;
  reactHarness.effectsEnabled = options.effectsEnabled ?? true;
  const dashboard = Dashboard(props) as ReactElement<{
    children: ReactElement<ControlledDashboardProps>;
  }>;
  const content = dashboard.props.children;
  return (content.type as (contentProps: ControlledDashboardProps) => ReactNode)(content.props);
}

export function findHostText(node: ReactNode, hostType: string): string | undefined {
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

export function findElements(
  node: ReactNode,
  predicate: (element: ReactElement<Record<string, unknown>>) => boolean,
): ReactElement<Record<string, unknown>>[] {
  if (node === null || node === undefined || typeof node === "boolean") return [];
  if (Array.isArray(node)) return node.flatMap((child) => findElements(child, predicate));
  if (!isValidElement(node)) return [];
  const element = node as ReactElement<Record<string, unknown> & { children?: ReactNode }>;
  return [...(predicate(element) ? [element] : []), ...findElements(element.props.children, predicate)];
}

export function textContent(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textContent).join("");
  if (!isValidElement(node)) return "";
  return textContent((node as ReactElement<{ children?: ReactNode }>).props.children);
}

export function composerDashboardProps(session: Session = BASE_SESSION): ControlledDashboardProps {
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

export const SELECT_ASK = {
  sessionId: "session-1",
  requestId: "ask-select",
  kind: "select",
  title: "Choose a deployment target",
  options: ["Preview", "Production"],
  initialValue: null,
  expiresAt: null,
} satisfies AskRequest;
