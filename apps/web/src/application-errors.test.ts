import type * as ReactModule from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ApplicationErrorReporter,
  installBrowserErrorCapture,
  isIgnoredError,
  normalizeErrorEvent,
  normalizeUnhandledRejectionEvent,
  normalizeUnknownError,
  useBrowserErrorCapture,
} from "./application-errors.js";

const hookHarness = vi.hoisted(() => ({
  effects: [] as Array<() => undefined | (() => void)>,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>();
  return {
    ...actual,
    useEffect: (effect: () => undefined | (() => void)) => {
      hookHarness.effects.push(effect);
    },
  };
});

describe("application error normalization", () => {
  it("normalizes standard Error objects with name, message, stack, and bounds", () => {
    const error = new TypeError("Cannot read properties of undefined (reading 'foo')");
    const result = normalizeUnknownError(error);

    expect(result.source).toBe("browser");
    expect(result.severity).toBe("error");
    expect(result.message).toBe("Cannot read properties of undefined (reading 'foo')");
    expect(result.errorName).toBe("TypeError");
    expect(result.stack).toBeDefined();
  });

  it("normalizes plain string errors", () => {
    const result = normalizeUnknownError("Something broke in worker");
    expect(result.message).toBe("Something broke in worker");
    expect(result.errorName).toBeUndefined();
  });

  it("normalizes primitives like numbers, booleans, and null", () => {
    expect(normalizeUnknownError(404).message).toBe("404");
    expect(normalizeUnknownError(false).message).toBe("false");
    expect(normalizeUnknownError(null).message).toBe("Unknown browser error");
    expect(normalizeUnknownError(undefined).message).toBe("Unknown browser error");
    expect(normalizeUnknownError(Symbol("test")).message).toBe("Symbol(test)");
    expect(normalizeUnknownError(100n).message).toBe("100");
  });

  it("normalizes circular objects without throwing or infinite recursion", () => {
    const circular: Record<string, unknown> = { key: "value" };
    circular.self = circular;

    const result = normalizeUnknownError(circular);
    expect(result.message).toBeDefined();
    expect(result.message.length).toBeGreaterThan(0);
    expect(result.source).toBe("browser");
  });

  it("handles objects whose getters or custom toString throw", () => {
    const explodingObject = {
      get message(): string {
        throw new Error("Exploding getter");
      },
      toString() {
        throw new Error("Exploding toString");
      },
    };

    const result = normalizeUnknownError(explodingObject);
    expect(result.message).toBeDefined();
    expect(result.source).toBe("browser");
  });

  it("truncates excessively long messages, names, and stacks", () => {
    const longMessage = "a".repeat(5000);
    const longName = "b".repeat(300);
    const longStack = "c".repeat(40000);

    const result = normalizeUnknownError({
      message: longMessage,
      name: longName,
      stack: longStack,
    });

    expect(result.message.length).toBeLessThanOrEqual(4096);
    expect(result.errorName?.length).toBeLessThanOrEqual(256);
    expect(result.stack?.length).toBeLessThanOrEqual(32768);
  });

  it("extracts context from ErrorEvent including filename, lineno, colno", () => {
    const event = new Event("error") as ErrorEvent;
    Object.defineProperties(event, {
      message: { value: "Script error" },
      filename: { value: "https://example.com/assets/app.js" },
      lineno: { value: 42 },
      colno: { value: 12 },
    });

    const result = normalizeErrorEvent(event);
    expect(result).not.toBeNull();
    expect(result?.context).toMatchObject({
      filePath: "https://example.com/assets/app.js",
      line: 42,
      column: 12,
    });
  });

  it("extracts reason from PromiseRejectionEvent", () => {
    const event = new Event("unhandledrejection") as PromiseRejectionEvent;
    Object.defineProperty(event, "reason", {
      value: new Error("Promise failed"),
    });

    const result = normalizeUnhandledRejectionEvent(event);
    expect(result?.message).toBe("Promise failed");
    expect(result?.errorName).toBe("Error");
  });

  it("identifies benign and ignored errors", () => {
    expect(isIgnoredError(new DOMException("The user aborted a request.", "AbortError"))).toBe(true);
    expect(isIgnoredError(new Error("ResizeObserver loop completed with undelivered notifications."))).toBe(
      true,
    );
    expect(isIgnoredError(new Error("ResizeObserver loop limit exceeded"))).toBe(true);
    expect(isIgnoredError(new Error("signal is aborted without reason"))).toBe(true);
    expect(isIgnoredError(new Error("Real unexpected fatal crash"))).toBe(false);
  });

  it("returns null for ignored ErrorEvent and PromiseRejectionEvent", () => {
    const errorEvent = new Event("error") as ErrorEvent;
    Object.defineProperty(errorEvent, "error", {
      value: new DOMException("Abort", "AbortError"),
    });
    expect(normalizeErrorEvent(errorEvent)).toBeNull();

    const rejectionEvent = new Event("unhandledrejection") as PromiseRejectionEvent;
    Object.defineProperty(rejectionEvent, "reason", {
      value: new DOMException("Abort", "AbortError"),
    });
    expect(normalizeUnhandledRejectionEvent(rejectionEvent)).toBeNull();
  });
  it("handles throwing getter objects through both normalizeErrorEvent and normalizeUnhandledRejectionEvent without dropping them", () => {
    const explodingError = {
      get name(): string {
        throw new Error("Throwing name getter");
      },
      get message(): string {
        throw new Error("Throwing message getter");
      },
      get stack(): string {
        throw new Error("Throwing stack getter");
      },
    };

    const errorEvent = new Event("error") as ErrorEvent;
    Object.defineProperty(errorEvent, "error", {
      value: explodingError,
    });
    const normalizedError = normalizeErrorEvent(errorEvent);
    expect(normalizedError).not.toBeNull();
    expect(normalizedError?.source).toBe("browser");
    expect(normalizedError?.severity).toBe("error");
    expect(normalizedError?.message).toBeDefined();

    const rejectionEvent = new Event("unhandledrejection") as PromiseRejectionEvent;
    Object.defineProperty(rejectionEvent, "reason", {
      value: explodingError,
    });
    const normalizedRejection = normalizeUnhandledRejectionEvent(rejectionEvent);
    expect(normalizedRejection).not.toBeNull();
    expect(normalizedRejection?.source).toBe("browser");
    expect(normalizedRejection?.severity).toBe("error");
    expect(normalizedRejection?.message).toBeDefined();
  });
});

describe("browser error listener lifecycle and failure isolation", () => {
  let target: EventTarget;
  let reporter: ApplicationErrorReporter;

  beforeEach(() => {
    target = new EventTarget();
    reporter = {
      reportApplicationError: vi.fn().mockResolvedValue(undefined),
    };
    hookHarness.effects.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers listeners on target and removes them cleanly upon cleanup", () => {
    const addListenerSpy = vi.spyOn(target, "addEventListener");
    const removeListenerSpy = vi.spyOn(target, "removeEventListener");

    const cleanup = installBrowserErrorCapture(reporter, target);

    expect(addListenerSpy).toHaveBeenCalledWith("error", expect.any(Function));
    expect(addListenerSpy).toHaveBeenCalledWith("unhandledrejection", expect.any(Function));

    cleanup();

    expect(removeListenerSpy).toHaveBeenCalledWith("error", expect.any(Function));
    expect(removeListenerSpy).toHaveBeenCalledWith("unhandledrejection", expect.any(Function));
  });

  it("reports errors to reporter when error event is dispatched", () => {
    installBrowserErrorCapture(reporter, target);

    const event = new Event("error") as ErrorEvent;
    Object.defineProperty(event, "error", {
      value: new Error("Test runtime crash"),
    });

    target.dispatchEvent(event);

    expect(reporter.reportApplicationError).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "browser",
        message: "Test runtime crash",
      }),
    );
  });

  it("reports rejections to reporter when unhandledrejection event is dispatched", () => {
    installBrowserErrorCapture(reporter, target);

    const event = new Event("unhandledrejection") as PromiseRejectionEvent;
    Object.defineProperty(event, "reason", {
      value: "Async network fault",
    });

    target.dispatchEvent(event);

    expect(reporter.reportApplicationError).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "browser",
        message: "Async network fault",
      }),
    );
  });

  it("isolates reporter rejection failures and does not throw or re-report", () => {
    reporter.reportApplicationError = vi.fn().mockRejectedValue(new Error("WebSocket closed"));

    installBrowserErrorCapture(reporter, target);

    const event = new Event("error") as ErrorEvent;
    Object.defineProperty(event, "error", {
      value: new Error("Test crash"),
    });

    expect(() => {
      target.dispatchEvent(event);
    }).not.toThrow();

    expect(reporter.reportApplicationError).toHaveBeenCalledOnce();
  });

  it("isolates synchronous reporter exceptions without throwing", () => {
    reporter.reportApplicationError = vi.fn().mockImplementation(() => {
      throw new Error("Synchronous throw in report");
    });

    installBrowserErrorCapture(reporter, target);

    const event = new Event("error") as ErrorEvent;
    Object.defineProperty(event, "error", {
      value: new Error("Test crash"),
    });

    expect(() => {
      target.dispatchEvent(event);
    }).not.toThrow();
  });

  it("supports React Strict Mode mount -> unmount -> remount cleanly", () => {
    useBrowserErrorCapture(reporter);

    expect(hookHarness.effects).toHaveLength(1);
    const cleanup1 = hookHarness.effects[0]?.();

    // First unmount
    cleanup1?.();

    // Re-mount (Strict Mode)
    useBrowserErrorCapture(reporter);
    expect(hookHarness.effects).toHaveLength(2);
    const cleanup2 = hookHarness.effects[1]?.();

    cleanup2?.();
  });
});
