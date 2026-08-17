import type { ApplicationErrorRecord, ApplicationErrorStorageHealth } from "@omp-remote/protocol";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import {
  addApplicationErrorRecord,
  clearApplicationErrorsLedger,
  compareApplicationErrorsNewestFirst,
  deduplicateAndSortApplicationErrors,
  loadApplicationErrorsLedger,
  useSessionClient,
} from "./index.js";

const hookHarness = vi.hoisted(() => ({
  effects: [] as Array<() => undefined | (() => void)>,
  stateSetters: [] as Mock[],
}));

vi.mock("react", () => ({
  useCallback: <T>(callback: T) => callback,
  useEffect: (effect: () => undefined | (() => void)) => {
    hookHarness.effects.push(effect);
  },
  useMemo: <T>(factory: () => T) => factory(),
  useRef: <T>(initialValue: T) => ({ current: initialValue }),
  useState: <T>(initialValue: T) => {
    const setter = vi.fn();
    hookHarness.stateSetters.push(setter);
    return [initialValue, setter] as const;
  },
}));

class FakeWebSocket extends EventTarget {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  readonly send = vi.fn();
  readonly close = vi.fn(() => {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  });

  constructor(readonly url: string) {
    super();
    FakeWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  message(frame: unknown): void {
    const event = new Event("message");
    Object.defineProperty(event, "data", {
      value: typeof frame === "string" ? frame : JSON.stringify(frame),
    });
    this.dispatchEvent(event);
  }
}

class FakeBrowserTarget extends EventTarget {
  readonly location = { protocol: "http:", host: "localhost:4387" };
  visibilityState: DocumentVisibilityState = "visible";
  readonly setTimeout = (callback: TimerHandler, timeout?: number) =>
    globalThis.setTimeout(callback, timeout) as unknown as number;
  readonly clearTimeout = (timer: number) => globalThis.clearTimeout(timer);
}

const ERROR_1: ApplicationErrorRecord = {
  id: "err-1",
  timestamp: "2026-08-16T10:00:00.000Z",
  source: "daemon",
  severity: "error",
  message: "First error",
};

const ERROR_2: ApplicationErrorRecord = {
  id: "err-2",
  timestamp: "2026-08-16T11:00:00.000Z",
  source: "browser",
  severity: "fatal",
  message: "Second error (newer)",
};

const ERROR_3: ApplicationErrorRecord = {
  id: "err-3",
  timestamp: "2026-08-16T12:00:00.000Z",
  source: "browser",
  severity: "error",
  message: "Third error (newest)",
};

const STORAGE_HEALTH: ApplicationErrorStorageHealth = {
  status: "healthy",
  recordCount: 3,
  totalBytes: 512,
  oldestTimestamp: "2026-08-16T10:00:00.000Z",
  newestTimestamp: "2026-08-16T12:00:00.000Z",
  degradedReason: null,
};

describe("application error record sorting and deduplication", () => {
  it("sorts records newest first by ISO timestamp", () => {
    const unsorted = [ERROR_1, ERROR_3, ERROR_2];
    const sorted = deduplicateAndSortApplicationErrors(unsorted);
    expect(sorted).toEqual([ERROR_3, ERROR_2, ERROR_1]);
  });

  it("breaks timestamp ties using record ID", () => {
    const tieA: ApplicationErrorRecord = { ...ERROR_1, id: "err-a" };
    const tieB: ApplicationErrorRecord = { ...ERROR_1, id: "err-b" };
    expect(compareApplicationErrorsNewestFirst(tieA, tieB)).toBeLessThan(0);
    expect(compareApplicationErrorsNewestFirst(tieB, tieA)).toBeGreaterThan(0);
  });

  it("deduplicates records with identical IDs keeping the latest passed", () => {
    const original: ApplicationErrorRecord = { ...ERROR_1, message: "Original message" };
    const updated: ApplicationErrorRecord = { ...ERROR_1, message: "Updated message" };
    const deduplicated = deduplicateAndSortApplicationErrors([original, updated]);
    expect(deduplicated).toHaveLength(1);
    expect(deduplicated[0]?.message).toBe("Updated message");
  });

  it("adds records with newest-first ordering and ID deduplication", () => {
    const initial = [ERROR_2, ERROR_1];
    const added = addApplicationErrorRecord(initial, ERROR_3);
    expect(added).toEqual([ERROR_3, ERROR_2, ERROR_1]);

    const duplicateUpdated: ApplicationErrorRecord = { ...ERROR_2, message: "Re-reported error 2" };
    const withDuplicate = addApplicationErrorRecord(added, duplicateUpdated);
    expect(withDuplicate).toHaveLength(3);
    expect(withDuplicate[1]?.message).toBe("Re-reported error 2");
  });
});

describe("standalone ledger API functions", () => {
  it("loads ledger response from /api/application-errors", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        errors: [ERROR_1, ERROR_2],
        health: STORAGE_HEALTH,
      }),
    });

    const result = await loadApplicationErrorsLedger(undefined, fetcher as unknown as typeof fetch);
    expect(fetcher).toHaveBeenCalledWith("/api/application-errors", {});
    expect(result.errors).toHaveLength(2);
    expect(result.health.status).toBe("healthy");
  });

  it("throws with server error message when ledger load fails", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });

    await expect(loadApplicationErrorsLedger(undefined, fetcher as unknown as typeof fetch)).rejects.toThrow(
      "Application errors request failed (500)",
    );
  });

  it("clears ledger via DELETE /api/application-errors", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, clearedCount: 5 }),
    });

    const result = await clearApplicationErrorsLedger(fetcher as unknown as typeof fetch);
    expect(fetcher).toHaveBeenCalledWith("/api/application-errors", { method: "DELETE" });
    expect(result).toEqual({ ok: true, clearedCount: 5 });
  });

  it("throws with server error when ledger clear fails", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: "Origin is not allowed" }),
    });

    await expect(clearApplicationErrorsLedger(fetcher as unknown as typeof fetch)).rejects.toThrow(
      "Origin is not allowed",
    );
  });
});

describe("useSessionClient application error integration", () => {
  let browserTarget: FakeBrowserTarget;
  let documentTarget: FakeBrowserTarget;

  beforeEach(() => {
    vi.useFakeTimers();
    hookHarness.effects.length = 0;
    hookHarness.stateSetters.length = 0;
    FakeWebSocket.instances = [];
    browserTarget = new FakeBrowserTarget();
    documentTarget = new FakeBrowserTarget();
    vi.stubGlobal("window", browserTarget);
    vi.stubGlobal("document", documentTarget);
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("dispatches report_application_error command frame through open socket", async () => {
    const client = useSessionClient();
    const cleanup = hookHarness.effects[0]?.();
    const socket = FakeWebSocket.instances[0];
    if (!socket) throw new Error("Expected WebSocket instance");
    socket.open();

    const reportPromise = client.reportApplicationError({
      message: "Uncaught ReferenceError: x is not defined",
      errorName: "ReferenceError",
    });

    expect(socket.send).toHaveBeenCalledOnce();
    const rawFrame = socket.send.mock.calls[0]?.[0];
    const parsed = JSON.parse(rawFrame);
    expect(parsed).toMatchObject({
      type: "report_application_error",
      error: {
        source: "browser",
        message: "Uncaught ReferenceError: x is not defined",
        errorName: "ReferenceError",
        severity: "error",
      },
    });

    // Simulate server command_result
    socket.message({
      type: "command_result",
      requestId: parsed.requestId,
      outcome: { status: "ok", value: { type: "void" } },
    });

    await expect(reportPromise).resolves.toBeUndefined();
    cleanup?.();
  });

  it("reduces application_error_added and application_errors_cleared frames", () => {
    useSessionClient();
    const cleanup = hookHarness.effects[0]?.();
    const socket = FakeWebSocket.instances[0];
    if (!socket) throw new Error("Expected WebSocket instance");
    socket.open();

    // Indices for state setters:
    // 14: applicationErrors, 15: applicationErrorsHealth, 16: applicationErrorsLoading, 17: applicationErrorsError
    const applicationErrorsSetter = hookHarness.stateSetters[14];
    const healthSetter = hookHarness.stateSetters[15];
    if (!applicationErrorsSetter || !healthSetter) throw new Error("Expected error state setters");

    // Frame: application_error_added
    socket.message({
      type: "application_error_added",
      error: ERROR_3,
    });

    const addUpdater = applicationErrorsSetter.mock.calls.at(-1)?.[0] as (
      current: ApplicationErrorRecord[],
    ) => ApplicationErrorRecord[];
    expect(addUpdater([])).toEqual([ERROR_3]);

    const healthUpdater = healthSetter.mock.calls.at(-1)?.[0] as (
      current: ApplicationErrorStorageHealth | null,
    ) => ApplicationErrorStorageHealth | null;
    expect(healthUpdater(STORAGE_HEALTH)).toMatchObject({
      recordCount: 4,
      newestTimestamp: ERROR_3.timestamp,
    });

    // Frame: application_errors_cleared
    socket.message({
      type: "application_errors_cleared",
      clearedAt: new Date().toISOString(),
      clearedCount: 4,
    });

    expect(applicationErrorsSetter).toHaveBeenCalledWith([]);
    const clearedHealthUpdater = healthSetter.mock.calls.at(-1)?.[0] as (
      current: ApplicationErrorStorageHealth | null,
    ) => ApplicationErrorStorageHealth | null;
    expect(clearedHealthUpdater(STORAGE_HEALTH)).toMatchObject({
      recordCount: 0,
      totalBytes: 0,
      oldestTimestamp: null,
      newestTimestamp: null,
    });

    cleanup?.();
  });

  it("re-loads application errors upon snapshot arrival on connect or reconnect", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        errors: [ERROR_2, ERROR_1],
        health: STORAGE_HEALTH,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    useSessionClient();
    const cleanup = hookHarness.effects[0]?.();
    const socket = FakeWebSocket.instances[0];
    if (!socket) throw new Error("Expected WebSocket instance");
    socket.open();

    socket.message({
      type: "snapshot",
      sessions: [],
      askRequests: [],
      savedWorkingDirectories: [],
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/application-errors", expect.anything());
    cleanup?.();
  });

  it("performs initial load on mount via useEffect", () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        errors: [ERROR_1],
        health: STORAGE_HEALTH,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    useSessionClient();
    // Mount effect for loadApplicationErrors is index 2
    const mountEffect = hookHarness.effects[2];
    expect(mountEffect).toBeDefined();
    const cleanup = mountEffect?.();

    expect(fetchMock).toHaveBeenCalledWith("/api/application-errors", expect.anything());
    cleanup?.();
  });

  it("performs second-socket reconnect load when connection drops and re-establishes", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        errors: [ERROR_2, ERROR_1],
        health: STORAGE_HEALTH,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    useSessionClient();
    const socketCleanup = hookHarness.effects[0]?.();
    const socket1 = FakeWebSocket.instances[0];
    if (!socket1) throw new Error("Expected initial socket");
    socket1.open();
    socket1.message({
      type: "snapshot",
      sessions: [],
      askRequests: [],
      savedWorkingDirectories: [],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Socket 1 drops
    socket1.close();
    expect(FakeWebSocket.instances.length).toBe(1);

    // Advance reconnect timer (1500ms)
    await vi.advanceTimersByTimeAsync(1500);
    expect(FakeWebSocket.instances.length).toBe(2);
    const socket2 = FakeWebSocket.instances[1];
    if (!socket2) throw new Error("Expected second socket");
    socket2.open();
    socket2.message({
      type: "snapshot",
      sessions: [],
      askRequests: [],
      savedWorkingDirectories: [],
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    socketCleanup?.();
  });

  it("prevents stale in-flight GET from overwriting or erasing a concurrent error add", async () => {
    let resolveGet: (value: { ok: boolean; json: () => Promise<unknown> }) => void = () => undefined;
    const pendingGet = new Promise<{ ok: boolean; json: () => Promise<unknown> }>((resolve) => {
      resolveGet = resolve;
    });
    const fetchMock = vi.fn().mockReturnValue(pendingGet);
    vi.stubGlobal("fetch", fetchMock);

    const client = useSessionClient();
    const socketCleanup = hookHarness.effects[0]?.();
    const socket = FakeWebSocket.instances[0];
    if (!socket) throw new Error("Expected socket");
    socket.open();

    const applicationErrorsSetter = hookHarness.stateSetters[14];
    const healthSetter = hookHarness.stateSetters[15];
    if (!applicationErrorsSetter || !healthSetter) throw new Error("Expected error state setters");

    // Trigger initial GET load
    const loadPromise = client.loadApplicationErrors();

    // While GET is pending, an added frame arrives
    socket.message({
      type: "application_error_added",
      error: ERROR_3,
    });

    // Now resolve the GET with older records (ERROR_1, ERROR_2)
    resolveGet({
      ok: true,
      json: async () => ({
        errors: [ERROR_2, ERROR_1],
        health: STORAGE_HEALTH,
      }),
    });

    await loadPromise;

    // Verify state updater preserves both concurrent added error and loaded errors
    const mergeUpdater = applicationErrorsSetter.mock.calls.at(-1)?.[0] as (
      current: ApplicationErrorRecord[],
    ) => ApplicationErrorRecord[];
    expect(typeof mergeUpdater).toBe("function");
    const merged = mergeUpdater([ERROR_3]);
    expect(merged.map((e) => e.id)).toEqual(["err-3", "err-2", "err-1"]);

    socketCleanup?.();
  });

  it("prevents stale in-flight GET from repopulating cleared state when clear occurs concurrently", async () => {
    let resolveGet: (value: { ok: boolean; json: () => Promise<unknown> }) => void = () => undefined;
    const pendingGet = new Promise<{ ok: boolean; json: () => Promise<unknown> }>((resolve) => {
      resolveGet = resolve;
    });
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/api/application-errors") && !url.includes("DELETE")) {
        return pendingGet;
      }
      return Promise.resolve({ ok: true, json: async () => ({ ok: true, clearedCount: 2 }) });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = useSessionClient();
    const socketCleanup = hookHarness.effects[0]?.();
    const socket = FakeWebSocket.instances[0];
    if (!socket) throw new Error("Expected socket");
    socket.open();

    const applicationErrorsSetter = hookHarness.stateSetters[14];
    if (!applicationErrorsSetter) throw new Error("Expected error state setter");

    // Start GET load
    const loadPromise = client.loadApplicationErrors();

    // While GET is pending, clear occurs
    socket.message({
      type: "application_errors_cleared",
      clearedAt: new Date().toISOString(),
      clearedCount: 2,
    });

    expect(applicationErrorsSetter).toHaveBeenCalledWith([]);
    const callsBeforeResolve = applicationErrorsSetter.mock.calls.length;

    // Now resolve the stale GET with old pre-clear records
    resolveGet({
      ok: true,
      json: async () => ({
        errors: [ERROR_2, ERROR_1],
        health: STORAGE_HEALTH,
      }),
    });

    await loadPromise;

    // Stale GET must NOT have invoked a state updater to restore old records
    expect(applicationErrorsSetter.mock.calls.length).toBe(callsBeforeResolve);

    socketCleanup?.();
  });

  it("reconciles authoritative bounded health from daemon response", async () => {
    const authoritativeHealth: ApplicationErrorStorageHealth = {
      recordCount: 1,
      totalBytes: 512,
      oldestTimestamp: "2026-08-16T12:00:00.000Z",
      newestTimestamp: "2026-08-16T12:00:00.000Z",
      status: "healthy",
      degradedReason: null,
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        errors: [ERROR_1],
        health: authoritativeHealth,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = useSessionClient();
    const healthSetter = hookHarness.stateSetters[15];
    if (!healthSetter) throw new Error("Expected health setter");

    await client.loadApplicationErrors();

    expect(healthSetter).toHaveBeenCalledWith(authoritativeHealth);
  });
});
