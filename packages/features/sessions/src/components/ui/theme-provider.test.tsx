import type * as ReactModule from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider, ThemeSelector, ThemeToggle, useTheme } from "./theme-provider.js";

const reactState = {
  theme: "system",
  resolvedTheme: "dark",
  setTheme: vi.fn(),
  toggleTheme: vi.fn(),
  storageState: "system",
};

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>();
  return {
    ...actual,
    createContext: actual.createContext,
    useContext: () => ({
      theme: reactState.theme,
      resolvedTheme: reactState.resolvedTheme,
      setTheme: reactState.setTheme,
      toggleTheme: reactState.toggleTheme,
    }),
    useState: <T,>(initial: T | (() => T)) => {
      const val = typeof initial === "function" ? (initial as () => T)() : initial;
      return [val, vi.fn()] as const;
    },
    useEffect: (effect: () => void | (() => void)) => {
      effect();
    },
    useCallback: <T,>(fn: T) => fn,
    useMemo: <T,>(fn: () => T) => fn(),
  };
});

type NodeLike = {
  type?: unknown;
  props?: {
    children?: unknown;
    onClick?: (...args: unknown[]) => void;
    [key: string]: unknown;
  };
};

function walk(node: unknown, visit: (element: NodeLike) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (!node || typeof node !== "object") return;
  const element = node as NodeLike;
  visit(element);
  if (element.props?.children) {
    const children = element.props.children;
    if (Array.isArray(children)) {
      for (const child of children) walk(child, visit);
    } else {
      walk(children, visit);
    }
  }
}

describe("ThemeProvider & useTheme", () => {
  let mockStorage: Record<string, string> = {};
  let mockAttributes: Record<string, string> = {};
  let mockClasses = new Set<string>();
  let mockStyle: Record<string, string> = {};

  beforeEach(() => {
    mockStorage = {};
    mockAttributes = {};
    mockClasses = new Set<string>();
    mockStyle = {};
    reactState.theme = "system";
    reactState.resolvedTheme = "dark";
    reactState.setTheme = vi.fn();
    reactState.toggleTheme = vi.fn();

    const localStorageMock = {
      getItem: vi.fn((key: string) => mockStorage[key] ?? null),
      setItem: vi.fn((key: string, value: string) => {
        mockStorage[key] = value;
      }),
      removeItem: vi.fn((key: string) => {
        delete mockStorage[key];
      }),
      clear: vi.fn(() => {
        mockStorage = {};
      }),
    };

    const documentElementMock = {
      setAttribute: vi.fn((name: string, value: string) => {
        mockAttributes[name] = value;
      }),
      getAttribute: vi.fn((name: string) => mockAttributes[name] ?? null),
      removeAttribute: vi.fn((name: string) => {
        delete mockAttributes[name];
      }),
      classList: {
        add: vi.fn((cls: string) => {
          mockClasses.add(cls);
        }),
        remove: vi.fn((...classes: string[]) => {
          for (const cls of classes) mockClasses.delete(cls);
        }),
        contains: vi.fn((cls: string) => mockClasses.has(cls)),
      },
      style: mockStyle,
    };

    const documentMock = {
      documentElement: documentElementMock,
      querySelector: vi.fn(() => null),
    };

    const windowMock = {
      localStorage: localStorageMock,
      matchMedia: vi.fn((query: string) => ({
        matches: true,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    };

    vi.stubGlobal("window", windowMock);
    vi.stubGlobal("document", documentMock);
    vi.stubGlobal("localStorage", localStorageMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("useTheme returns context theme and functions", () => {
    const theme = useTheme();
    expect(theme.theme).toBe("system");
    expect(theme.resolvedTheme).toBe("dark");
    expect(typeof theme.setTheme).toBe("function");
    expect(typeof theme.toggleTheme).toBe("function");
  });

  it("renders ThemeProvider with children", () => {
    const provider = ThemeProvider({
      defaultTheme: "dark",
      children: <div id="test-child">Child Content</div>,
    });
    expect(provider).toBeDefined();
    let found = false;
    walk(provider, (el) => {
      if (el.props?.id === "test-child") found = true;
    });
    expect(found).toBe(true);
  });

  it("renders ThemeToggle with accessible attributes and label", () => {
    reactState.theme = "dark";
    reactState.resolvedTheme = "dark";
    const toggle = ThemeToggle({});
    let buttonProps: Record<string, unknown> | undefined;
    walk(toggle, (el) => {
      if (el.props?.["aria-label"]) {
        buttonProps = el.props;
      }
    });

    expect(buttonProps).toBeDefined();
    expect(buttonProps?.["aria-label"]).toBe("Theme: Dark. Click to switch to system mode.");
    expect(buttonProps?.["className"]).toContain("theme-toggle-button");
  });

  it("renders ThemeSelector with System, Light, and Dark options", () => {
    const selector = ThemeSelector({});
    const labels: string[] = [];
    walk(selector, (el) => {
      if (typeof el.props?.["aria-label"] === "string") {
        labels.push(el.props["aria-label"] as string);
      }
    });

    expect(labels).toContain("System theme");
    expect(labels).toContain("Light theme");
    expect(labels).toContain("Dark theme");
  });
});
