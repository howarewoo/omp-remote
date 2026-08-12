import type { RpcFrame } from "@omp-remote/omp-rpc";
import type { Session } from "@omp-remote/protocol";
import { SessionRegistry } from "@omp-remote/sessions/services";
import { describe, expect, it, vi } from "vitest";
import {
  createCatalogReconciler,
  createDeferredRegistrationReplay,
  createReconciledSessionRegistrar,
  createRegistrationGenerationQueue,
  getCatalogSessionMetadataPatch,
  registerDeferredSession,
  resolveReconciledSession,
  waitForCatalogTopology,
} from "./catalog-reconciliation.js";
import { createDeferredRpcFrameReplay } from "./rpc-session-runtime.js";
import type { CatalogDiff } from "./session-catalog.js";

const ROOT_SESSION: Session = {
  id: "session-root",
  source: "extension",
  name: "Root session",
  cwd: "/work/omp-remote",
  branch: "fix/subagent-session-classification",
  status: "running",
  connected: true,
  model: "openai/gpt-5.6",
  contextPercent: 12,
  createdAt: "2026-07-30T12:00:00.000Z",
  lastActivity: "2026-07-30T12:01:00.000Z",
  capabilities: ["prompt", "steer", "follow_up", "abort"],
  messages: [],
  sessionPath: "/work/.omp/session.jsonl",
  activeSubagents: [],
  skillCommands: [],
};

const WORKER_SESSION: Session = {
  ...ROOT_SESSION,
  id: "session-worker",
  name: "RegistrationWorker",
  sessionPath: "/work/.omp/session/RegistrationWorker.jsonl",
  messages: [
    {
      id: "worker-message",
      role: "assistant",
      text: "Worker transcript remains available",
      timestamp: "2026-07-30T12:01:00.000Z",
      streaming: false,
      presentation: "text",
    },
  ],
};

const ACTIVE_WORKER = {
  id: WORKER_SESSION.id,
  name: "RegistrationWorker",
  lastActivity: WORKER_SESSION.lastActivity,
};

function catalogDiff(activeSubagents: Session["activeSubagents"]): CatalogDiff {
  return {
    upserted: [{ ...ROOT_SESSION, activeSubagents }],
    removed: [],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function replayRpcFrames(frames: readonly RpcFrame[], hydratedRawMessages: readonly unknown[]): RpcFrame[] {
  const applied: RpcFrame[] = [];
  const replay = createDeferredRpcFrameReplay((frame) => applied.push(frame));
  for (const frame of frames) replay.accept(frame);
  replay.register(hydratedRawMessages);
  return applied;
}

function updateParentActivity(registry: Map<string, Session>, session: Session): void {
  const current = registry.get(session.id);
  if (current) registry.set(session.id, { ...current, activeSubagents: session.activeSubagents });
}

describe("createRegistrationGenerationQueue", () => {
  it("lets a newer session registration supersede an unresolved predecessor", async () => {
    const firstRegistration = deferred<boolean>();
    const secondRegistration = deferred<boolean>();
    const currentChecks = new Map<string, () => boolean>();
    const applied: string[] = [];
    const queue = createRegistrationGenerationQueue<string, string>(
      async (sessionId, isCurrent) => {
        currentChecks.set(sessionId, isCurrent);
        return sessionId === "session-old"
          ? await firstRegistration.promise
          : await secondRegistration.promise;
      },
      (frame) => {
        applied.push(frame);
      },
    );

    const oldResult = queue.register("session-old");
    const oldFrame = queue.accept("old-heartbeat");
    const newResult = queue.register("session-new");
    const newFrame = queue.accept("new-heartbeat");

    expect(currentChecks.get("session-old")?.()).toBe(false);
    secondRegistration.resolve(true);
    await expect(newResult).resolves.toBe(true);
    await newFrame;
    expect(applied).toEqual(["new-heartbeat"]);

    firstRegistration.resolve(true);
    await expect(oldResult).resolves.toBe(false);
    await oldFrame;
    expect(applied).toEqual(["new-heartbeat"]);
  });

  it("discards application frames queued behind registration after close", async () => {
    const registration = deferred<boolean>();
    const applied: string[] = [];
    const queue = createRegistrationGenerationQueue<string, string>(
      async () => await registration.promise,
      (frame) => {
        applied.push(frame);
      },
    );

    const registrationResult = queue.register("session-closing");
    const queuedFrame = queue.accept("event-after-close");
    queue.close();
    registration.resolve(true);

    await expect(registrationResult).resolves.toBe(false);
    await queuedFrame;
    expect(applied).toEqual([]);
  });
});

describe("deferred RPC frame replay", () => {
  it("retains pre-registration frames and replays them once in arrival order", () => {
    const applied: string[] = [];
    const replay = createDeferredRegistrationReplay<string>((frame) => applied.push(frame));

    replay.accept("agent_start");
    replay.accept("message_start");
    replay.accept("message_end");
    expect(applied).toEqual([]);

    replay.register();
    expect(applied).toEqual(["agent_start", "message_start", "message_end"]);

    replay.accept("agent_end");
    replay.register();
    expect(applied).toEqual(["agent_start", "message_start", "message_end", "agent_end"]);
  });

  it("drops a complete start/update/end history overlap as one unit", () => {
    const overlap = {
      role: "assistant",
      content: "Hydrated exactly once",
      timestamp: "2026-07-30T12:00:00.000Z",
    };
    const processFrame = { type: "agent_start" };
    const stateFrame = { type: "available_commands_update", commands: [] };
    const frames = [
      { type: "message_start", message: { ...overlap, content: "" } },
      processFrame,
      { type: "message_update", message: { ...overlap, content: "Hydrated" } },
      stateFrame,
      { type: "message_end", message: overlap },
    ];

    expect(replayRpcFrames(frames, [overlap])).toEqual([processFrame, stateFrame]);
  });

  it("consumes one hydrated occurrence and retains an identical later message", () => {
    const overlap = {
      role: "assistant",
      content: "Repeated",
      timestamp: "2026-07-30T12:00:00.000Z",
    };
    const first = { type: "message_end", message: overlap, occurrence: 1 };
    const second = { type: "message_end", message: { ...overlap }, occurrence: 2 };

    expect(replayRpcFrames([first, second], [overlap])).toEqual([second]);
  });

  it("retains distinct messages newer than the hydrated transcript", () => {
    const overlap = {
      role: "assistant",
      content: "Hydrated exactly once",
      timestamp: "2026-07-30T12:00:00.000Z",
    };
    const newer = {
      role: "assistant",
      content: "Arrived after the history snapshot",
      timestamp: "2026-07-30T12:00:01.000Z",
    };
    const overlapFrame = { type: "message_end", message: overlap };
    const newerFrame = { type: "message_end", message: newer };

    expect(replayRpcFrames([overlapFrame, newerFrame], [overlap])).toEqual([newerFrame]);
  });

  it("replays every buffered frame when transcript hydration fails", () => {
    const message = {
      role: "assistant",
      content: "Available only from buffered frames",
      timestamp: "2026-07-30T12:00:00.000Z",
    };
    const frames = [
      { type: "message_start", message: { ...message, content: "" } },
      { type: "message_update", message: { ...message, content: "Available" } },
      { type: "message_end", message },
    ];

    expect(replayRpcFrames(frames, [])).toEqual(frames);
  });

  it("replays incomplete message sequences without consuming hydrated overlap", () => {
    const message = {
      role: "assistant",
      content: "Hydrated message",
      timestamp: "2026-07-30T12:00:00.000Z",
    };
    const startedOnly = [
      { type: "message_start", message: { ...message, content: "" } },
      { type: "message_update", message },
      { type: "agent_end" },
    ];
    const endedOnly = [
      { type: "message_update", message },
      { type: "message_end", message },
    ];

    expect(replayRpcFrames(startedOnly, [message])).toEqual(startedOnly);
    expect(replayRpcFrames(endedOnly, [message])).toEqual(endedOnly);
  });

  it("discards retained frames when an unregistered transport is disposed", () => {
    const applied: string[] = [];
    const replay = createDeferredRegistrationReplay<string>((frame) => applied.push(frame));

    replay.accept("process_exit");
    replay.dispose();
    replay.register();

    expect(applied).toEqual([]);
  });
});

describe("resolveReconciledSession", () => {
  it("defers an explicit live payload while the catalog entry remains topologically unknown", () => {
    const liveSession = { ...WORKER_SESSION, parentSessionId: ROOT_SESSION.id };
    const catalogSession = { ...WORKER_SESSION };

    expect(resolveReconciledSession(liveSession, catalogSession)).toBeUndefined();
  });

  it("constructs registration metadata only from explicit catalog topology", () => {
    const liveSession = {
      ...WORKER_SESSION,
      createdAt: "2026-07-30T12:05:00.000Z",
      activeSubagents: [],
    };
    const catalogSession = {
      ...WORKER_SESSION,
      createdAt: ROOT_SESSION.createdAt,
      parentSessionId: ROOT_SESSION.id,
      activeSubagents: [ACTIVE_WORKER],
    };

    expect(resolveReconciledSession(liveSession, catalogSession)).toEqual({
      ...liveSession,
      createdAt: ROOT_SESSION.createdAt,
      parentSessionId: ROOT_SESSION.id,
      activeSubagents: [ACTIVE_WORKER],
    });
  });
});

describe("registration lifecycle", () => {
  it("stops retrying when the extension socket closes", async () => {
    let current = true;
    const socketClosed = deferred<void>();
    const registerSession = vi.fn(async () => false);
    const registration = registerDeferredSession(
      WORKER_SESSION,
      registerSession,
      () => current,
      () => socketClosed.promise,
    );
    await Promise.resolve();

    current = false;
    socketClosed.resolve();

    await expect(registration).resolves.toBe(false);
    expect(registerSession).toHaveBeenCalledOnce();
  });

  it("does not publish a payload closed during reconciliation", async () => {
    let current = true;
    const reconciliation = deferred<void>();
    const registerSession = vi.fn();
    const register = createReconciledSessionRegistrar({
      registerSession,
      requestCatalogReconciliation: () => reconciliation.promise,
      resolveSession: (session) => ({ ...session, parentSessionId: ROOT_SESSION.id }),
    });
    const registration = register(WORKER_SESSION, () => current);

    current = false;
    reconciliation.resolve();

    await expect(registration).resolves.toBe(false);
    expect(registerSession).not.toHaveBeenCalled();
  });
});

describe("waitForCatalogTopology", () => {
  it("terminates a pending topology wait when the RPC process exits", async () => {
    let exited = false;
    const reconciliation = deferred<void>();
    const processExited = deferred<void>();
    const wait = waitForCatalogTopology(
      () => reconciliation.promise,
      () => undefined,
      processExited.promise,
      () => Promise.resolve(),
      () => exited,
    );

    exited = true;
    processExited.resolve();

    await expect(wait).resolves.toBeUndefined();
  });
});

describe("getCatalogSessionMetadataPatch", () => {
  it.each([null, "Stale RPC title"])(
    "synchronizes a changed catalog title for an RPC session from %s",
    (name) => {
      const liveSession: Session = { ...ROOT_SESSION, source: "rpc", name };
      const catalogSession: Session = { ...liveSession, name: "Current catalog title" };

      expect(getCatalogSessionMetadataPatch(liveSession, catalogSession)).toEqual({
        name: "Current catalog title",
      });
    },
  );

  it("preserves an extension-provided title while synchronizing other catalog metadata", () => {
    const liveSession: Session = {
      ...ROOT_SESSION,
      name: "Extension title",
      createdAt: "2026-07-30T12:05:00.000Z",
    };
    const catalogSession: Session = {
      ...ROOT_SESSION,
      name: "Catalog title",
      activeSubagents: [ACTIVE_WORKER],
    };

    expect(getCatalogSessionMetadataPatch(liveSession, catalogSession)).toEqual({
      createdAt: ROOT_SESSION.createdAt,
      activeSubagents: [ACTIVE_WORKER],
    });
  });

  it("avoids a patch when reconciled metadata is unchanged", () => {
    expect(getCatalogSessionMetadataPatch(ROOT_SESSION, { ...ROOT_SESSION })).toBeNull();
  });

  it("reconciles explicit child topology without changing extension metadata ownership", () => {
    const liveChild: Session = {
      ...ROOT_SESSION,
      id: "session-child",
      name: "Extension child",
      sessionPath: "/work/.omp/session/Child.jsonl",
    };
    const catalogChild: Session = {
      ...liveChild,
      parentSessionId: "session-parent",
      name: "Catalog child",
    };

    expect(getCatalogSessionMetadataPatch(liveChild, catalogChild)).toEqual({
      parentSessionId: "session-parent",
    });
  });
});

describe("createCatalogReconciler", () => {
  it("reconciles parent activity when registration requests a refresh without waiting for the timer", async () => {
    const registry = new Map<string, Session>([[ROOT_SESSION.id, ROOT_SESSION]]);
    const refresh = vi.fn(async () => catalogDiff([ACTIVE_WORKER]));
    const reconcile = createCatalogReconciler({
      refresh,
      syncCatalogSession: (session) => updateParentActivity(registry, session),
      onError: vi.fn(),
    });
    const register = createReconciledSessionRegistrar({
      registerSession: (session) => registry.set(session.id, session),
      requestCatalogReconciliation: reconcile,
    });

    const reconciliation = register(WORKER_SESSION);
    expect(registry.get(WORKER_SESSION.id)).toBeUndefined();
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledOnce();
    await reconciliation;

    expect(registry.get(ROOT_SESSION.id)?.activeSubagents).toEqual([ACTIVE_WORKER]);
    expect(registry.get(WORKER_SESSION.id)?.messages).toEqual(WORKER_SESSION.messages);
  });

  it("replays deferred registration with the original live payload once topology is proven", async () => {
    const registerSession = vi.fn();
    let parentSessionId: string | undefined;
    const register = createReconciledSessionRegistrar({
      registerSession,
      requestCatalogReconciliation: vi.fn(async () => {}),
      resolveSession: (session) => (parentSessionId ? { ...session, parentSessionId } : undefined),
    });

    expect(await register(WORKER_SESSION)).toBe(false);
    expect(registerSession).not.toHaveBeenCalled();

    parentSessionId = ROOT_SESSION.id;
    expect(await register(WORKER_SESSION)).toBe(true);
    expect(registerSession).toHaveBeenCalledOnce();
    expect(registerSession).toHaveBeenCalledWith({
      ...WORKER_SESSION,
      parentSessionId: ROOT_SESSION.id,
    });
  });

  it("coalesces overlapping requests while preserving ordered trailing refreshes", async () => {
    const registry = new Map<string, Session>([[ROOT_SESSION.id, ROOT_SESSION]]);
    const firstRefresh = deferred<CatalogDiff>();
    const secondRefresh = deferred<CatalogDiff>();
    const thirdRefresh = deferred<CatalogDiff>();
    const secondRefreshStarted = deferred<void>();
    const thirdRefreshStarted = deferred<void>();
    const refresh = vi
      .fn<() => Promise<CatalogDiff>>()
      .mockImplementationOnce(() => firstRefresh.promise)
      .mockImplementationOnce(() => {
        secondRefreshStarted.resolve();
        return secondRefresh.promise;
      })
      .mockImplementationOnce(() => {
        thirdRefreshStarted.resolve();
        return thirdRefresh.promise;
      });
    const appliedActivity: string[][] = [];
    const reconcile = createCatalogReconciler({
      refresh,
      syncCatalogSession: (session) => {
        updateParentActivity(registry, session);
        appliedActivity.push(session.activeSubagents.map(({ id }) => id));
      },
      onError: vi.fn(),
    });

    const firstRequest = reconcile();
    const secondRequest = reconcile();
    const duplicateSecondRequest = reconcile();

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(secondRequest).toBe(firstRequest);
    expect(duplicateSecondRequest).toBe(firstRequest);

    firstRefresh.resolve(
      catalogDiff([
        { id: "session-older-worker", name: "OlderWorker", lastActivity: "2026-07-30T12:02:00.000Z" },
      ]),
    );
    await secondRefreshStarted.promise;

    expect(refresh).toHaveBeenCalledTimes(2);

    const thirdRequest = reconcile();
    const duplicateThirdRequest = reconcile();
    expect(thirdRequest).toBe(firstRequest);
    expect(duplicateThirdRequest).toBe(firstRequest);

    secondRefresh.resolve(catalogDiff([ACTIVE_WORKER]));
    await thirdRefreshStarted.promise;

    expect(refresh).toHaveBeenCalledTimes(3);

    const latestWorker = {
      id: "session-latest-worker",
      name: "LatestWorker",
      lastActivity: "2026-07-30T12:03:00.000Z",
    };
    thirdRefresh.resolve(catalogDiff([latestWorker]));
    await Promise.all([
      firstRequest,
      secondRequest,
      duplicateSecondRequest,
      thirdRequest,
      duplicateThirdRequest,
    ]);

    expect(appliedActivity).toEqual([
      ["session-older-worker"],
      ["session-worker"],
      ["session-latest-worker"],
    ]);
    expect(registry.get(ROOT_SESSION.id)?.activeSubagents).toEqual([latestWorker]);
  });

  it("continues after refresh and error-reporting failures", async () => {
    const refreshError = new Error("refresh failed");
    const reportingError = new Error("reporting failed");
    const refresh = vi
      .fn<() => Promise<CatalogDiff>>()
      .mockRejectedValueOnce(refreshError)
      .mockResolvedValueOnce(catalogDiff([ACTIVE_WORKER]));
    const syncCatalogSession = vi.fn();
    const onError = vi.fn(() => {
      throw reportingError;
    });
    const reconcile = createCatalogReconciler({ refresh, syncCatalogSession, onError });

    await expect(reconcile()).resolves.toBeUndefined();
    await expect(reconcile()).resolves.toBeUndefined();

    expect(refresh).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledWith(refreshError);
    expect(syncCatalogSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: ROOT_SESSION.id, activeSubagents: [ACTIVE_WORKER] }),
    );
  });
});

describe("session branch registry updates", () => {
  it("emits the normal session patch when checkout changes the branch", () => {
    const registry = new SessionRegistry();
    const events: unknown[] = [];
    registry.subscribe((event) => events.push(event));
    registry.upsert({ ...ROOT_SESSION, source: "rpc", status: "idle", branch: "main" });
    events.length = 0;

    expect(registry.update(ROOT_SESSION.id, { branch: "feature/target" })?.branch).toBe("feature/target");
    expect(events).toEqual([
      {
        type: "session_update",
        sessionId: ROOT_SESSION.id,
        patch: { branch: "feature/target" },
      },
    ]);
  });
});
