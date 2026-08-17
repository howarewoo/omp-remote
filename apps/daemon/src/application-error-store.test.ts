import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createLogger, type ErrorLogEntry } from "@omp-remote/observability";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApplicationErrorStore } from "./application-error-store.js";

const temporaryDirectories: string[] = [];

async function createStorePath(): Promise<{ root: string; filePath: string }> {
  const root = await mkdtemp(join(tmpdir(), "omp-remote-app-errors-"));
  temporaryDirectories.push(root);
  return { root, filePath: join(root, "remote", "errors.json") };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("ApplicationErrorStore", () => {
  describe("initialization and permissions", () => {
    it("loads cleanly when file does not exist, starts healthy, and uses 0700/0600 modes", async () => {
      const { root, filePath } = await createStorePath();
      const store = await ApplicationErrorStore.load(filePath);

      expect(store.status).toBe("healthy");
      expect(store.degradedReason).toBeNull();
      expect(store.list()).toEqual([]);

      const recorded = await store.record({
        source: "daemon",
        severity: "error",
        message: "First error",
      });

      expect(recorded.message).toBe("First error");
      expect(recorded.source).toBe("daemon");
      expect(recorded.severity).toBe("error");
      expect(typeof recorded.id).toBe("string");
      expect(typeof recorded.timestamp).toBe("string");

      const fileStats = await stat(filePath);
      expect(fileStats.mode & 0o777).toBe(0o600);

      const parentStats = await stat(join(root, "remote"));
      expect(parentStats.mode & 0o777).toBe(0o700);
    });

    it("persists records across store reloads", async () => {
      const { filePath } = await createStorePath();
      const store = await ApplicationErrorStore.load(filePath);

      await store.record({
        id: "err-1",
        timestamp: "2026-08-16T10:00:00.000Z",
        source: "daemon",
        severity: "error",
        message: "Daemon startup issue",
        context: { attempt: 1 },
      });

      await store.record({
        id: "err-2",
        timestamp: "2026-08-16T10:01:00.000Z",
        source: "browser",
        severity: "fatal",
        message: "UI crash",
        errorName: "RenderError",
      });

      const reloaded = await ApplicationErrorStore.load(filePath);
      expect(reloaded.status).toBe("healthy");
      expect(reloaded.list()).toHaveLength(2);
      expect(reloaded.list()[0]?.id).toBe("err-1");
      expect(reloaded.list()[1]?.id).toBe("err-2");
      expect(reloaded.list()[1]?.severity).toBe("fatal");

      const ledger = reloaded.getLedger();
      expect(ledger.health.recordCount).toBe(2);
      expect(ledger.health.status).toBe("healthy");
      expect(ledger.health.oldestTimestamp).toBe("2026-08-16T10:00:00.000Z");
      expect(ledger.health.newestTimestamp).toBe("2026-08-16T10:01:00.000Z");
    });
  });

  describe("retention caps and eviction", () => {
    it("evicts oldest records when record count exceeds 1000", async () => {
      const { filePath } = await createStorePath();
      await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
      const seeded = {
        version: 1,
        errors: Array.from({ length: 1000 }, (_, i) => ({
          id: `seed-${i + 1}`,
          timestamp: new Date(1700000000000 + (i + 1) * 1000).toISOString(),
          source: "daemon" as const,
          severity: "error" as const,
          message: `Seed message ${i + 1}`,
        })),
      };
      await writeFile(filePath, `${JSON.stringify(seeded, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      const store = await ApplicationErrorStore.load(filePath);

      await store.record({
        id: "err-1001",
        timestamp: "2026-08-16T16:00:00.000Z",
        source: "daemon",
        severity: "error",
        message: "New message 1001",
      });

      const list = store.list();
      expect(list).toHaveLength(1000);
      expect(list[0]?.id).toBe("seed-2");
      expect(list[list.length - 1]?.id).toBe("err-1001");
      expect(list.some((r) => r.id === "seed-1")).toBe(false);
    });

    it("enforces exact 5 MiB serialized UTF-8 byte cap with oldest-first eviction using multibyte content", async () => {
      const { filePath } = await createStorePath();
      await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });

      // Multibyte string: '🔥' is 4 UTF-8 bytes and 2 JS UTF-16 code units.
      // 2000 fire emojis = 8,000 UTF-8 bytes per message (string length = 4,000 <= 4,096 max).
      const multibytePayload = "🔥".repeat(2000);

      // 670 valid records * ~8,150 bytes ≈ 5.46 MiB in aggregate (> 5 MiB = 5,242,880 bytes cap, <= 1000 records)
      const seededState = {
        version: 1,
        errors: Array.from({ length: 670 }, (_, i) => ({
          id: `seed-${i + 1}`,
          timestamp: new Date(1700000000000 + (i + 1) * 1000).toISOString(),
          source: "daemon" as const,
          severity: "error" as const,
          message: `${i + 1}-${multibytePayload}`,
          context: { attempt: i + 1 },
        })),
      };

      await writeFile(filePath, `${JSON.stringify(seededState, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });

      const store = await ApplicationErrorStore.load(filePath);

      // Perform one mutation to trigger bounded persistence and oldest-first eviction
      await store.record({
        id: "err-newest",
        timestamp: "2026-08-16T15:00:00.000Z",
        source: "daemon",
        severity: "error",
        message: `newest-${multibytePayload}`,
        context: { attempt: 9999 },
      });

      const fileContent = await readFile(filePath, "utf8");
      const exactByteLength = Buffer.byteLength(fileContent, "utf8");

      // 1. Proves persisted file byte length is strictly within the 5 MiB cap
      expect(exactByteLength).toBeLessThanOrEqual(5 * 1024 * 1024);
      // 2. Proves test reached the 5 MiB boundary
      expect(exactByteLength).toBeGreaterThan(5 * 1024 * 1024 - 50_000);
      // 3. Proves character count is significantly smaller than UTF-8 byte count (multibyte guarantee)
      expect(fileContent.length).toBeLessThan(exactByteLength);

      const records = store.list();
      // 4. Proves oldest-first eviction: oldest seeded records evicted, newest record survives
      expect(records.some((r) => r.id === "seed-1")).toBe(false);
      expect(records[records.length - 1]?.id).toBe("err-newest");
      expect(records.length).toBeLessThan(671);

      // 5. Reload confirms state integrity across restart
      const reloaded = await ApplicationErrorStore.load(filePath);
      expect(reloaded.status).toBe("healthy");
      expect(reloaded.getHealth().totalBytes).toBe(exactByteLength);
      expect(reloaded.getHealth().totalBytes).toBeLessThanOrEqual(5 * 1024 * 1024);
      expect(reloaded.list().some((r) => r.id === "seed-1")).toBe(false);
      expect(reloaded.list()[reloaded.list().length - 1]?.id).toBe("err-newest");
    });
  });

  describe("mutation queue concurrency and clear semantics", () => {
    it("serializes concurrent record mutations without race conditions or lost writes", async () => {
      const { filePath } = await createStorePath();
      const store = await ApplicationErrorStore.load(filePath);

      const promises = Array.from({ length: 20 }, (_, index) =>
        store.record({
          id: `concurrent-${index}`,
          source: "daemon",
          severity: "error",
          message: `Concurrent error ${index}`,
        }),
      );

      await Promise.all(promises);

      expect(store.list()).toHaveLength(20);
      const reloaded = await ApplicationErrorStore.load(filePath);
      expect(reloaded.list()).toHaveLength(20);
    });

    it("enforces queued clear-snapshot semantics where clear empties prior snapshot and later writes survive", async () => {
      const { filePath } = await createStorePath();
      const store = await ApplicationErrorStore.load(filePath);

      const p1 = store.record({ id: "err-before-1", source: "daemon", severity: "error", message: "Before 1" });
      const p2 = store.record({ id: "err-before-2", source: "daemon", severity: "error", message: "Before 2" });
      const pClear = store.clear();
      const p3 = store.record({ id: "err-after-1", source: "daemon", severity: "error", message: "After 1" });

      const [, , clearResult, afterRecord] = await Promise.all([p1, p2, pClear, p3]);

      expect(clearResult.clearedCount).toBe(2);
      expect(afterRecord.id).toBe("err-after-1");

      expect(store.list()).toHaveLength(1);
      expect(store.list()[0]?.id).toBe("err-after-1");

      const reloaded = await ApplicationErrorStore.load(filePath);
      expect(reloaded.list()).toHaveLength(1);
      expect(reloaded.list()[0]?.id).toBe("err-after-1");
    });
  });

  describe("corruption preservation and degraded state", () => {
    it("preserves corrupted files on disk without overwriting or deleting them and marks storage degraded", async () => {
      const { filePath } = await createStorePath();
      await mkdir(dirname(filePath), { recursive: true });
      const corruptContent = "{ this is invalid json content ]";
      await writeFile(filePath, corruptContent, "utf8");

      const store = await ApplicationErrorStore.load(filePath);
      expect(store.status).toBe("degraded");
      expect(store.degradedReason).toContain("Corrupted application errors file");
      expect(store.list()).toEqual([]);

      // File on disk MUST remain untouched
      const fileOnDisk = await readFile(filePath, "utf8");
      expect(fileOnDisk).toBe(corruptContent);

      // Clearing or recording restores healthy status
      await store.clear();
      expect(store.status).toBe("healthy");
      expect(store.degradedReason).toBeNull();
      const restoredFile = await readFile(filePath, "utf8");
      expect(restoredFile).toContain('"errors": []');
    });

    it("marks storage degraded when persistence fails and does not claim false durability", async () => {
      const { filePath } = await createStorePath();
      const failingPersist = vi.fn().mockRejectedValue(new Error("Disk I/O error"));

      const store = await ApplicationErrorStore.load(filePath, failingPersist);

      await expect(
        store.record({
          source: "daemon",
          severity: "error",
          message: "Failed write attempt",
        }),
      ).rejects.toThrow("Disk I/O error");

      expect(store.status).toBe("degraded");
      expect(store.degradedReason).toContain("Persistence failed: Disk I/O error");
    });
  });

  describe("logger observer integration and secret redaction", () => {
    it("records errors from createLogger, sanitizing secret keys in context", async () => {
      const { filePath } = await createStorePath();
      const store = await ApplicationErrorStore.load(filePath);

      const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

      try {
        const { promise, resolve } = Promise.withResolvers<void>();
        const observer = (entry: ErrorLogEntry) => {
          store.recordFromLogEntry(entry).then(() => resolve());
        };

        const logger = createLogger("daemon-service", { onError: observer });

        // Info and warn should not trigger store recording
        logger.info("info msg", { count: 1 });
        logger.warn("warn msg", { count: 2 });

        // Error should trigger store recording
        logger.error("DB connection timeout", new Error("ETIMEDOUT"), {
          queryId: "q-42",
          jwt: "SUPER_SECRET_JWT",
          authToken: "SUPER_SECRET_TOKEN",
          password: "password123",
          apiKey: "secret-key",
          retryCount: 3,
        });

        // Await the deterministic promise resolution
        await promise;

        const records = store.list();
        expect(records).toHaveLength(1);
        const record = records[0];
        expect(record).toBeDefined();
        if (!record) throw new Error("Expected record");

        expect(record.source).toBe("daemon");
        expect(record.message).toBe("DB connection timeout");
        expect(record.errorName).toBe("Error");
        expect(record.context).toBeDefined();
        expect(record.context).toEqual({
          queryId: "q-42",
          retryCount: 3,
        });
        expect(record.context).not.toHaveProperty("jwt");
        expect(record.context).not.toHaveProperty("authToken");
        expect(record.context).not.toHaveProperty("password");
        expect(record.context).not.toHaveProperty("apiKey");
      } finally {
        stderrSpy.mockRestore();
        stdoutSpy.mockRestore();
      }
    });
  });
});
