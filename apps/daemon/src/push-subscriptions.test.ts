import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createBestEffortPushSender, PushSubscriptionStore } from "./push-subscriptions.js";

const PUBLIC_KEY = "A".repeat(87);
const PRIVATE_KEY = "A".repeat(43);
const subscription = (suffix: string) => ({
  endpoint: `https://push.example.test/send/${suffix}`,
  keys: { p256dh: "A".repeat(87), auth: "A".repeat(22) },
});
const registration = (deviceId: string, inputRequired = true) => ({
  deviceId,
  subscription: subscription(deviceId),
  events: { inputRequired, sessionIdle: !inputRequired },
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "omp-remote-push-"));
  const filePath = join(root, "remote", "push.json");
  return { root, filePath };
}

describe("PushSubscriptionStore", () => {
  it("generates and reuses VAPID keys across restarts", async () => {
    const { root, filePath } = await fixture();
    try {
      const generate = vi.fn(async () => ({ publicKey: PUBLIC_KEY, privateKey: PRIVATE_KEY }));
      const first = await PushSubscriptionStore.load(filePath, generate);
      const second = await PushSubscriptionStore.load(filePath, generate);
      expect(first.publicKey).toBe(PUBLIC_KEY);
      expect(second.publicKey).toBe(PUBLIC_KEY);
      expect(generate).toHaveBeenCalledOnce();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("isolates devices and supports update/removal", async () => {
    const { root, filePath } = await fixture();
    try {
      const store = await PushSubscriptionStore.load(filePath, async () => ({
        publicKey: PUBLIC_KEY,
        privateKey: PRIVATE_KEY,
      }));
      await store.register(registration("one"));
      await store.register(registration("two"));
      await store.update({ ...registration("one"), events: { inputRequired: false, sessionIdle: true } });
      await store.remove({ deviceId: "two" });
      expect(store.list()).toEqual([
        { ...registration("one"), events: { inputRequired: false, sessionIdle: true } },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects malformed state and keeps the prior file when replacement fails", async () => {
    const { root, filePath } = await fixture();
    try {
      const store = await PushSubscriptionStore.load(filePath, async () => ({
        publicKey: PUBLIC_KEY,
        privateKey: PRIVATE_KEY,
      }));
      await store.register(registration("one"));
      const before = await readFile(filePath, "utf8");
      const malformedPath = filePath.replace("push.json", "bad.json");
      await mkdir(join(root, "remote"), { recursive: true });
      await writeFile(malformedPath, "{ malformed persisted state");
      await expect(PushSubscriptionStore.load(malformedPath)).rejects.toThrow();
      let persistCalls = 0;
      const failingPersist = async (path: string, state: unknown) => {
        persistCalls += 1;
        if (persistCalls > 2) throw new Error("simulated atomic replacement failure");
        await writeFile(path, JSON.stringify(state));
      };
      const failureStore = await PushSubscriptionStore.load(
        filePath.replace("push.json", "failure.json"),
        async () => ({ publicKey: PUBLIC_KEY, privateKey: PRIVATE_KEY }),
        failingPersist,
      );
      await failureStore.register(registration("stable"));
      const stableBytes = await readFile(filePath.replace("push.json", "failure.json"), "utf8");
      await expect(failureStore.register(registration("rejected"))).rejects.toThrow(
        "simulated atomic replacement failure",
      );
      expect(await readFile(filePath.replace("push.json", "failure.json"), "utf8")).toBe(stableBytes);
      expect(failureStore.list().map(({ deviceId }) => deviceId)).toEqual(["stable"]);
      await expect(store.register(registration("two"))).resolves.toHaveLength(2);
      expect(await readFile(filePath, "utf8")).not.toBe(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects persisted device ids over the UTF-8 byte limit", async () => {
    const { root, filePath } = await fixture();
    try {
      await PushSubscriptionStore.load(filePath, async () => ({
        publicKey: PUBLIC_KEY,
        privateKey: PRIVATE_KEY,
      }));
      const state = JSON.parse(await readFile(filePath, "utf8")) as {
        devices: unknown[];
        version: number;
        vapid: unknown;
      };
      state.devices = [
        {
          deviceId: "é".repeat(65),
          subscription: subscription("wide"),
          events: { inputRequired: true, sessionIdle: false },
        },
      ];
      await writeFile(filePath, JSON.stringify(state));
      await expect(PushSubscriptionStore.load(filePath)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses owner-only persistence modes", async () => {
    const { root, filePath } = await fixture();
    try {
      await PushSubscriptionStore.load(filePath, async () => ({
        publicKey: PUBLIC_KEY,
        privateKey: PRIVATE_KEY,
      }));
      expect((await stat(filePath)).mode & 0o777).toBe(0o600);
      expect((await stat(join(root, "remote"))).mode & 0o777).toBe(0o700);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("createBestEffortPushSender", () => {
  it("does not remove a refreshed subscription after an old endpoint expires", async () => {
    const { root, filePath } = await fixture();
    try {
      const store = await PushSubscriptionStore.load(filePath, async () => ({
        publicKey: PUBLIC_KEY,
        privateKey: PRIVATE_KEY,
      }));
      await store.register(registration("device"));
      let rejectDelivery!: (error: unknown) => void;
      const delivery = new Promise<unknown>((_, reject) => {
        rejectDelivery = reject;
      });
      const send = createBestEffortPushSender(store, "mailto:test@example.com", () => delivery);
      const pending = send.send("inputRequired", "payload");
      await store.update({ ...registration("device"), subscription: subscription("refreshed") });
      rejectDelivery(Object.assign(new Error("gone"), { statusCode: 410 }));
      await pending;
      expect(store.list()[0]?.subscription.endpoint).toContain("refreshed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes only permanently invalid subscriptions and retains transient failures", async () => {
    const { root, filePath } = await fixture();
    try {
      const store = await PushSubscriptionStore.load(filePath, async () => ({
        publicKey: PUBLIC_KEY,
        privateKey: PRIVATE_KEY,
      }));
      await store.register(registration("gone"));
      await store.register(registration("retry"));
      const send = vi.fn(async (device: { endpoint: string }) => {
        if (device.endpoint.endsWith("gone")) throw Object.assign(new Error("gone"), { statusCode: 410 });
        throw Object.assign(new Error("temporary"), { statusCode: 503 });
      });
      await expect(
        createBestEffortPushSender(store, "mailto:test@example.com", send).send("inputRequired", "payload"),
      ).rejects.toMatchObject({
        name: "PushDeliveryError",
        failures: [{ deviceId: "retry", statusCode: 503 }],
      });
      expect(store.list().map(({ deviceId }) => deviceId)).toEqual(["retry"]);
      expect(send).toHaveBeenCalledTimes(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
