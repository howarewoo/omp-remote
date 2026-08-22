import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "@omp-remote/observability";
import { ApplicationErrorLedgerResponseSchema, type ServerFrame } from "@omp-remote/protocol";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { ApplicationErrorStore, installUncaughtExceptionMonitor } from "./application-error-store.js";

const daemonDirectory = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

describe("Application Errors HTTP API and Transport", () => {
  let temporaryDirectory: string;
  let storagePath: string;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "omp-daemon-errors-test-"));
    storagePath = join(temporaryDirectory, "errors.json");
  });

  afterEach(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  function createTestServer(options?: {
    errorStore?: ApplicationErrorStore;
    originAllowed?: (origin: string | undefined, host: string | undefined) => boolean;
  }) {
    const errorStore = options?.errorStore;
    const originAllowed =
      options?.originAllowed ??
      ((origin: string | undefined, host: string | undefined): boolean => {
        if (!origin) return false;
        try {
          const originUrl = new URL(origin);
          const { hostname } = originUrl;
          if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]") return true;
          return (
            originUrl.protocol === "https:" &&
            hostname.endsWith(".ts.net") &&
            originUrl.host === host?.toLowerCase()
          );
        } catch {
          return false;
        }
      });

    const browserSockets = new Set<WebSocket>();
    const broadcastFrames: ServerFrame[] = [];
    const broadcast = (frame: ServerFrame): void => {
      broadcastFrames.push(frame);
    };

    const app = Fastify({ logger: false });

    if (errorStore) {
      app.get("/api/application-errors", async (request, reply) => {
        if (request.headers.origin && !originAllowed(request.headers.origin, request.headers.host)) {
          return reply.code(403).send({ error: "Origin is not allowed" });
        }
        return ApplicationErrorLedgerResponseSchema.parse(errorStore.getLedger());
      });

      app.delete("/api/application-errors", async (request, reply) => {
        if (request.headers.origin && !originAllowed(request.headers.origin, request.headers.host)) {
          return reply.code(403).send({ error: "Origin is not allowed" });
        }
        try {
          const result = await errorStore.clear();
          broadcast({
            type: "application_errors_cleared",
            clearedAt: new Date().toISOString(),
            clearedCount: result.clearedCount,
          });
          return reply.code(200).send({ ok: true, clearedCount: result.clearedCount });
        } catch (error) {
          return reply.code(500).send({ error: "Application errors could not be cleared" });
        }
      });
    }

    return { app, broadcastFrames, browserSockets, broadcast };
  }

  describe("GET /api/application-errors", () => {
    it("returns empty ledger with healthy storage status", async () => {
      const store = await ApplicationErrorStore.load(storagePath);
      const { app } = createTestServer({ errorStore: store });

      const response = await app.inject({
        method: "GET",
        url: "/api/application-errors",
        headers: {
          host: "127.0.0.1:3000",
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.errors).toEqual([]);
      expect(body.health).toMatchObject({
        status: "healthy",
        recordCount: 0,
        totalBytes: expect.any(Number),
        oldestTimestamp: null,
        newestTimestamp: null,
        degradedReason: null,
      });
    });

    it("returns persisted records with ledger response schema", async () => {
      const store = await ApplicationErrorStore.load(storagePath);
      await store.record({
        source: "daemon",
        severity: "error",
        message: "Failed to connect to agent",
        context: { route: "/sessions", retryCount: 2 },
      });

      const { app } = createTestServer({ errorStore: store });
      const response = await app.inject({
        method: "GET",
        url: "/api/application-errors",
        headers: {
          origin: "http://127.0.0.1:5173",
          host: "127.0.0.1:3000",
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.errors).toHaveLength(1);
      expect(body.errors[0]).toMatchObject({
        source: "daemon",
        severity: "error",
        message: "Failed to connect to agent",
        context: { route: "/sessions", retryCount: 2 },
      });
      expect(body.health.recordCount).toBe(1);
      expect(body.health.status).toBe("healthy");
    });

    it("returns degraded health with explicit reason when storage is degraded", async () => {
      const failingPersist = vi.fn().mockRejectedValue(new Error("Disk quota exceeded"));
      const store = await ApplicationErrorStore.load(storagePath, failingPersist);

      try {
        await store.record({
          source: "daemon",
          severity: "error",
          message: "Will fail persistence",
        });
      } catch {
        // Expected mutation failure to degrade store
      }

      const { app } = createTestServer({ errorStore: store });
      const response = await app.inject({
        method: "GET",
        url: "/api/application-errors",
        headers: {
          origin: "http://localhost:3000",
          host: "localhost:3000",
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.health.status).toBe("degraded");
      expect(body.health.degradedReason).toContain("Disk quota exceeded");
    });

    it("rejects cross-origin request with disallowed origin", async () => {
      const store = await ApplicationErrorStore.load(storagePath);
      const { app } = createTestServer({ errorStore: store });

      const response = await app.inject({
        method: "GET",
        url: "/api/application-errors",
        headers: {
          origin: "https://malicious-site.com",
          host: "127.0.0.1:3000",
        },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: "Origin is not allowed" });
    });

    it("accepts valid Tailscale origin matching host", async () => {
      const store = await ApplicationErrorStore.load(storagePath);
      const { app } = createTestServer({ errorStore: store });

      const response = await app.inject({
        method: "GET",
        url: "/api/application-errors",
        headers: {
          origin: "https://my-host.ts.net",
          host: "my-host.ts.net",
        },
      });

      expect(response.statusCode).toBe(200);
    });
  });

  describe("DELETE /api/application-errors", () => {
    it("clears ledger, persists state, broadcasts cleared frame, and returns clearedCount", async () => {
      const store = await ApplicationErrorStore.load(storagePath);
      await store.record({ source: "daemon", severity: "error", message: "Error 1" });
      await store.record({ source: "browser", severity: "error", message: "Error 2" });

      const { app, broadcastFrames } = createTestServer({ errorStore: store });

      const response = await app.inject({
        method: "DELETE",
        url: "/api/application-errors",
        headers: {
          origin: "http://127.0.0.1:5173",
          host: "127.0.0.1:3000",
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true, clearedCount: 2 });
      expect(store.list()).toEqual([]);
      expect(broadcastFrames).toEqual([
        expect.objectContaining({
          type: "application_errors_cleared",
          clearedCount: 2,
        }),
      ]);
    });

    it("rejects DELETE from disallowed origin", async () => {
      const store = await ApplicationErrorStore.load(storagePath);
      const { app, broadcastFrames } = createTestServer({ errorStore: store });

      const response = await app.inject({
        method: "DELETE",
        url: "/api/application-errors",
        headers: {
          origin: "https://attacker.ts.net",
          host: "victim.ts.net",
        },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: "Origin is not allowed" });
      expect(broadcastFrames).toHaveLength(0);
    });

    it("returns 500 and does NOT broadcast when clear persistence fails", async () => {
      let persistShouldFail = false;
      const store = await ApplicationErrorStore.load(storagePath, async () => {
        if (persistShouldFail) throw new Error("Disk full");
      });
      await store.record({ source: "daemon", severity: "error", message: "Error 1" });

      persistShouldFail = true;
      const { app, broadcastFrames } = createTestServer({ errorStore: store });

      const response = await app.inject({
        method: "DELETE",
        url: "/api/application-errors",
        headers: {
          origin: "http://localhost:3000",
          host: "localhost:3000",
        },
      });

      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ error: "Application errors could not be cleared" });
      expect(broadcastFrames).toHaveLength(0);
    });
  });

  describe("Logger error observer integration and broadcast", () => {
    it("persists error on logger.error and broadcasts application_error_added on commit", async () => {
      const store = await ApplicationErrorStore.load(storagePath);
      const broadcastFrames: ServerFrame[] = [];
      const broadcast = (frame: ServerFrame): void => {
        broadcastFrames.push(frame);
      };

      const latch = Promise.withResolvers<void>();

      const logger = createLogger("omp-remote-daemon", {
        onError: async (entry) => {
          try {
            const record = await store.recordFromLogEntry(entry);
            if (record) {
              broadcast({ type: "application_error_added", error: record });
            }
          } catch {
            // Observer errors must never throw
          } finally {
            latch.resolve();
          }
        },
      });

      logger.error("Database connection lost", new Error("Connection timed out"), {
        route: "/sessions",
        retryCount: 3,
      });

      await latch.promise;

      const records = store.list();
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        source: "daemon",
        severity: "error",
        message: "Database connection lost",
        errorName: "Error",
        context: { route: "/sessions", retryCount: 3 },
      });

      expect(broadcastFrames).toEqual([
        {
          type: "application_error_added",
          error: records[0],
        },
      ]);
    });

    it("does NOT broadcast when logger error persistence fails", async () => {
      const failingPersist = vi.fn().mockRejectedValue(new Error("Write error"));
      const store = await ApplicationErrorStore.load(storagePath, failingPersist);
      const broadcastFrames: ServerFrame[] = [];
      const broadcast = (frame: ServerFrame): void => {
        broadcastFrames.push(frame);
      };

      const latch = Promise.withResolvers<void>();

      const logger = createLogger("omp-remote-daemon", {
        onError: async (entry) => {
          try {
            const record = await store.recordFromLogEntry(entry);
            if (record) {
              broadcast({ type: "application_error_added", error: record });
            }
          } catch {
            // Observer errors must never throw
          } finally {
            latch.resolve();
          }
        },
      });

      logger.error("Transient error", new Error("Transient"));
      await latch.promise;

      expect(broadcastFrames).toHaveLength(0);
    });

    it("skips errors scoped to individual OMP sessions (bearing sessionId)", async () => {
      const store = await ApplicationErrorStore.load(storagePath);
      const broadcastFrames: ServerFrame[] = [];
      const broadcast = (frame: ServerFrame): void => {
        broadcastFrames.push(frame);
      };

      const latch = Promise.withResolvers<void>();

      const logger = createLogger("omp-remote-daemon", {
        onError: async (entry) => {
          try {
            const record = await store.recordFromLogEntry(entry);
            if (record) {
              broadcast({ type: "application_error_added", error: record });
            }
          } catch {
            // Observer errors must never throw
          } finally {
            latch.resolve();
          }
        },
      });

      logger.error("Could not read OMP session details", new Error("Session not found"), {
        sessionId: "session-xyz",
        route: "/sessions",
      });
      await latch.promise;

      const records = store.list();
      expect(records).toHaveLength(0);
      expect(broadcastFrames).toHaveLength(0);
    });

    it("skips errors explicitly marked as expected command failures (scope: command)", async () => {
      const store = await ApplicationErrorStore.load(storagePath);
      const broadcastFrames: ServerFrame[] = [];
      const broadcast = (frame: ServerFrame): void => {
        broadcastFrames.push(frame);
      };

      const latch = Promise.withResolvers<void>();

      const logger = createLogger("omp-remote-daemon", {
        onError: async (entry) => {
          try {
            const record = await store.recordFromLogEntry(entry);
            if (record) {
              broadcast({ type: "application_error_added", error: record });
            }
          } catch {
            // Observer errors must never throw
          } finally {
            latch.resolve();
          }
        },
      });

      logger.error("Failed to launch OMP RPC session", new Error("No model specified"), {
        scope: "command",
        cwd: "/workspace/project",
      });
      await latch.promise;

      const records = store.list();
      expect(records).toHaveLength(0);
      expect(broadcastFrames).toHaveLength(0);
    });
  });

  describe("Node capture boundary for uncaughtExceptionMonitor and synchronous crash persistence", () => {
    it("synchronously persists fatal error with bounded caps and private permissions", async () => {
      const store = await ApplicationErrorStore.load(storagePath);
      const record = store.recordFatalSynchronously({
        source: "daemon",
        severity: "fatal",
        message: "Synchronous crash record",
        errorName: "FatalError",
        stack: "FatalError: Synchronous crash record\n  at main (daemon.ts:1:1)",
        context: { event: "uncaughtException" },
      });

      expect(record).toMatchObject({
        source: "daemon",
        severity: "fatal",
        message: "Synchronous crash record",
        errorName: "FatalError",
        context: { event: "uncaughtException" },
      });

      const fileStats = await stat(storagePath);
      expect(fileStats.mode & 0o777).toBe(0o600);

      const health = store.getHealth();
      expect(health.status).toBe("healthy");
      expect(health.recordCount).toBe(1);
    });

    it("captures fatal daemon record and broadcasts synchronously via installUncaughtExceptionMonitor", async () => {
      const store = await ApplicationErrorStore.load(storagePath);
      const broadcastFrames: ServerFrame[] = [];
      const broadcast = (frame: ServerFrame): void => {
        broadcastFrames.push(frame);
      };

      const dispose = installUncaughtExceptionMonitor(store, broadcast);
      try {
        const processEmitter = process as unknown as {
          emit(event: "uncaughtExceptionMonitor", error: Error, origin: string): boolean;
        };
        processEmitter.emit(
          "uncaughtExceptionMonitor",
          new TypeError("Fatal panic in daemon worker"),
          "uncaughtException",
        );

        const records = store.list();
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
          source: "daemon",
          severity: "fatal",
          message: "Fatal panic in daemon worker",
          errorName: "TypeError",
          context: { event: "uncaughtException" },
        });
        expect(broadcastFrames).toEqual([
          {
            type: "application_error_added",
            error: records[0],
          },
        ]);
      } finally {
        dispose();
      }
    });

    it("child process exits nonzero and synchronously persists fatal record on uncaught exception", async () => {
      const childStoragePath = join(temporaryDirectory, "child-uncaught-errors.json");
      const script = `
        import { ApplicationErrorStore, installUncaughtExceptionMonitor } from "./src/application-error-store.ts";
        const store = await ApplicationErrorStore.load(${JSON.stringify(childStoragePath)});
        installUncaughtExceptionMonitor(store);
        setTimeout(() => {
          throw new TypeError("Simulated uncaught exception in child");
        }, 10);
      `;
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
        cwd: daemonDirectory,
        stdio: "ignore",
      });
      const [exitCode] = await once(child, "exit");
      expect(exitCode).not.toBe(0);

      const store = await ApplicationErrorStore.load(childStoragePath);
      const records = store.list();
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        source: "daemon",
        severity: "fatal",
        message: "Simulated uncaught exception in child",
        errorName: "TypeError",
        context: { event: "uncaughtException" },
      });
    });

    it("child process exits nonzero and synchronously persists fatal record on unhandled rejection", async () => {
      const childStoragePath = join(temporaryDirectory, "child-unhandled-errors.json");
      const script = `
        import { ApplicationErrorStore, installUncaughtExceptionMonitor } from "./src/application-error-store.ts";
        const store = await ApplicationErrorStore.load(${JSON.stringify(childStoragePath)});
        installUncaughtExceptionMonitor(store);
        setTimeout(() => {
          Promise.reject(new Error("Simulated unhandled rejection in child"));
        }, 10);
      `;
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
        cwd: daemonDirectory,
        stdio: "ignore",
      });
      const [exitCode] = await once(child, "exit");
      expect(exitCode).not.toBe(0);

      const store = await ApplicationErrorStore.load(childStoragePath);
      const records = store.list();
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        source: "daemon",
        severity: "fatal",
        message: "Simulated unhandled rejection in child",
        errorName: "Error",
        context: { event: "unhandledRejection" },
      });
    });
  });
});
