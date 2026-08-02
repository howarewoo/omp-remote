import type * as ReactModule from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StartupSplash } from "./startup-splash.js";

const hooks = vi.hoisted(() => ({
  cleanups: [] as Array<(() => void) | undefined>,
  cursor: 0,
  dependencies: [] as Array<readonly unknown[] | undefined>,
  dirty: false,
  states: [] as unknown[],
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>();
  return {
    ...actual,
    useEffect: (effect: () => void | (() => void), dependencies?: readonly unknown[]) => {
      const index = hooks.cursor++;
      const previous = hooks.dependencies[index];
      const changed =
        dependencies === undefined ||
        previous === undefined ||
        dependencies.length !== previous.length ||
        dependencies.some((dependency, dependencyIndex) => dependency !== previous[dependencyIndex]);
      if (!changed) return;
      hooks.cleanups[index]?.();
      hooks.dependencies[index] = dependencies ? [...dependencies] : undefined;
      const cleanup = effect();
      hooks.cleanups[index] = typeof cleanup === "function" ? cleanup : undefined;
    },
    useState: <T,>(initial: T | (() => T)) => {
      const index = hooks.cursor++;
      if (!(index in hooks.states)) {
        hooks.states[index] = typeof initial === "function" ? (initial as () => T)() : initial;
      }
      const setState = (next: T | ((previous: T) => T)) => {
        const previous = hooks.states[index] as T;
        const updated = typeof next === "function" ? (next as (previous: T) => T)(previous) : next;
        if (Object.is(previous, updated)) return;
        hooks.states[index] = updated;
        hooks.dirty = true;
      };
      return [hooks.states[index] as T, setState] as const;
    },
  };
});

function resetHookHarness(): void {
  for (const cleanup of hooks.cleanups) cleanup?.();
  hooks.cleanups.length = 0;
  hooks.cursor = 0;
  hooks.dependencies.length = 0;
  hooks.dirty = false;
  hooks.states.length = 0;
}

function renderSplash(ready: boolean): string {
  let output = "";
  let renderCount = 0;
  do {
    hooks.cursor = 0;
    hooks.dirty = false;
    output = renderToStaticMarkup(StartupSplash({ ready }));
    renderCount += 1;
    if (renderCount > 10) throw new Error("StartupSplash did not settle");
  } while (hooks.dirty);
  return output;
}

describe("StartupSplash", () => {
  beforeEach(() => {
    resetHookHarness();
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
  });

  afterEach(() => {
    resetHookHarness();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("announces startup while the session catalog loads", () => {
    const output = renderSplash(false);

    expect(output).toContain('data-state="loading"');
    expect(output).toContain('role="status"');
    expect(output).toContain('src="/icon.svg"');
    expect(output).toContain("Connecting to your host");
  });

  it("stays visible on the first render even when startup is already ready", () => {
    const output = renderSplash(true);

    expect(output).toContain(
      '<div class="startup-splash" data-state="loading" role="status" aria-live="polite">',
    );
  });

  it("dismisses after the minimum duration when startup is ready", () => {
    expect(renderSplash(true)).toContain('data-state="loading"');

    vi.advanceTimersByTime(599);
    expect(renderSplash(true)).toContain('data-state="loading"');

    vi.advanceTimersByTime(1);
    const output = renderSplash(true);
    expect(output).toContain('data-state="ready"');
    expect(output).toContain('aria-hidden="true"');
    expect(output).not.toContain('role="status"');
  });

  it("fails safe after five seconds when readiness never arrives", () => {
    expect(renderSplash(false)).toContain('data-state="loading"');

    vi.advanceTimersByTime(4_999);
    expect(renderSplash(false)).toContain('data-state="loading"');

    vi.advanceTimersByTime(1);
    expect(renderSplash(false)).toContain('data-state="ready"');
  });

  it("never reappears when reconnect resets readiness", () => {
    expect(renderSplash(false)).toContain('data-state="loading"');
    vi.advanceTimersByTime(600);
    expect(renderSplash(false)).toContain('data-state="loading"');

    expect(renderSplash(true)).toContain('data-state="ready"');
    expect(renderSplash(false)).toContain('data-state="ready"');
  });
});
