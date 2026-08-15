import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  THEME_OPTIONS,
  THEME_STORAGE_KEY,
  applyThemeToDocument,
  getStoredTheme,
  getSystemTheme,
  isTheme,
  resolveTheme,
  setStoredTheme,
} from "./theme.js";

describe("theme utilities", () => {
  let mockStorage: Record<string, string> = {};
  let mockAttributes: Record<string, string> = {};
  let mockClasses = new Set<string>();
  let mockStyle: Record<string, string> = {};

  beforeEach(() => {
    mockStorage = {};
    mockAttributes = {};
    mockClasses = new Set<string>();
    mockStyle = {};

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
        matches: false,
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

  it("identifies valid theme strings", () => {
    expect(isTheme("system")).toBe(true);
    expect(isTheme("light")).toBe(true);
    expect(isTheme("dark")).toBe(true);
    expect(isTheme("auto")).toBe(false);
    expect(isTheme("")).toBe(false);
    expect(isTheme(null)).toBe(false);
    expect(isTheme(123)).toBe(false);
  });

  it("lists system, light, and dark options", () => {
    expect(THEME_OPTIONS.map((o) => o.value)).toEqual(["system", "light", "dark"]);
  });

  it("retrieves and sets stored theme in localStorage", () => {
    expect(getStoredTheme()).toBe("system");

    setStoredTheme("light");
    expect(mockStorage[THEME_STORAGE_KEY]).toBe("light");
    expect(getStoredTheme()).toBe("light");

    setStoredTheme("dark");
    expect(mockStorage[THEME_STORAGE_KEY]).toBe("dark");
    expect(getStoredTheme()).toBe("dark");

    mockStorage[THEME_STORAGE_KEY] = "invalid";
    expect(getStoredTheme()).toBe("system");
  });

  it("resolves system theme based on matchMedia", () => {
    vi.mocked(window.matchMedia).mockReturnValue({
      matches: true,
      media: "(prefers-color-scheme: dark)",
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    } as unknown as MediaQueryList);

    expect(getSystemTheme()).toBe("dark");
    expect(resolveTheme("system")).toBe("dark");
    expect(resolveTheme("light")).toBe("light");
    expect(resolveTheme("dark")).toBe("dark");

    vi.mocked(window.matchMedia).mockReturnValue({
      matches: false,
      media: "(prefers-color-scheme: dark)",
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    } as unknown as MediaQueryList);

    expect(getSystemTheme()).toBe("light");
    expect(resolveTheme("system")).toBe("light");
  });

  it("applies theme attributes and classes to documentElement", () => {
    applyThemeToDocument("system", "dark");
    expect(mockAttributes["data-theme"]).toBe("dark");
    expect(mockAttributes["data-theme-setting"]).toBe("system");
    expect(mockStyle.colorScheme).toBe("dark");
    expect(mockClasses.has("dark")).toBe(true);
    expect(mockClasses.has("light")).toBe(false);

    applyThemeToDocument("light", "light");
    expect(mockAttributes["data-theme"]).toBe("light");
    expect(mockAttributes["data-theme-setting"]).toBe("light");
    expect(mockStyle.colorScheme).toBe("light");
    expect(mockClasses.has("light")).toBe(true);
    expect(mockClasses.has("dark")).toBe(false);
  });
});
