import type { Session } from "@omp-remote/protocol";
import { describe, expect, it, vi } from "vitest";
import type { CatalogDiff } from "./session-catalog.js";
import {
  createCatalogReconciler,
  createReconciledSessionRegistrar,
  getCatalogSessionMetadataPatch,
} from "./catalog-reconciliation.js";

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

function updateParentActivity(registry: Map<string, Session>, session: Session): void {
  const current = registry.get(session.id);
  if (current) registry.set(session.id, { ...current, activeSubagents: session.activeSubagents });
}

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
    expect(registry.get(WORKER_SESSION.id)?.messages).toEqual(WORKER_SESSION.messages);
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledOnce();
    await reconciliation;

    expect(registry.get(ROOT_SESSION.id)?.activeSubagents).toEqual([ACTIVE_WORKER]);
    expect(registry.get(WORKER_SESSION.id)?.messages).toEqual(WORKER_SESSION.messages);
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
