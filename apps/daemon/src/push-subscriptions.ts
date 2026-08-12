import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import webpush from "web-push";
import {
  PushEventPreferencesSchema,
  PushSubscriptionRegistrationSchema,
  PushSubscriptionRemovalSchema,
  PushSubscriptionSchema,
  PushVapidPublicKeySchema,
  type PushEventPreferences,
  type PushSubscription,
  type PushSubscriptionRegistration,
  type PushSubscriptionRemoval,
} from "@omp-remote/protocol";
import { z } from "zod";

export const DEFAULT_PUSH_SUBSCRIPTIONS_PATH = resolve(homedir(), ".omp/remote/push-subscriptions.json");
export const PUSH_VAPID_SUBJECT = "mailto:omp-remote@localhost";
const PUSH_STATE_VERSION = 1;
const MAX_DEVICES = 100;
const MAX_PAYLOAD_BYTES = 64 * 1024;

const Base64UrlPrivateKeySchema = z
  .string()
  .length(43)
  .regex(/^[A-Za-z0-9_-]+$/, "Expected unpadded base64url")
  .refine((value) => {
    try {
      const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(44, "=");
      return atob(padded).length === 32;
    } catch {
      return false;
    }
  }, "Expected a 32-byte base64url key");

const PersistedDeviceSchema = PushSubscriptionRegistrationSchema;

const PushStateSchema = z
  .object({
    version: z.literal(PUSH_STATE_VERSION),
    vapid: z
      .object({
        publicKey: PushVapidPublicKeySchema,
        privateKey: Base64UrlPrivateKeySchema,
      })
      .strict(),
    devices: z.array(PersistedDeviceSchema).max(MAX_DEVICES),
  })
  .strict()
  .superRefine((state, context) => {
    const ids = new Set<string>();
    for (const device of state.devices) {
      if (ids.has(device.deviceId)) {
        context.addIssue({ code: "custom", path: ["devices"], message: "Device ids must be unique" });
      }
      ids.add(device.deviceId);
    }
  });

type PushState = z.infer<typeof PushStateSchema>;
export type PushDevice = PushState["devices"][number];
export type PushEvent = keyof PushEventPreferences;

type VapidKeyGenerator = () => Promise<{ publicKey: string; privateKey: string }>;
type VapidConfigurator = (subject: string, publicKey: string, privateKey: string) => void;
type NotificationSender = (subscription: PushSubscription, payload: string) => Promise<unknown>;
type Persistence = (filePath: string, state: PushState) => Promise<void>;
export type PushDeliveryFailure = { deviceId: string; statusCode?: number };

export class PushSubscriptionStore {
  readonly #filePath: string;
  #state: PushState;
  #mutationQueue = Promise.resolve();
  readonly #persist: Persistence;

  private constructor(filePath: string, state: PushState, persist: Persistence) {
    this.#filePath = filePath;
    this.#state = state;
    this.#persist = persist;
  }

  static async load(
    filePath: string = DEFAULT_PUSH_SUBSCRIPTIONS_PATH,
    generateVapidKeys: VapidKeyGenerator = () => Promise.resolve(webpush.generateVAPIDKeys()),
    persist: Persistence = persistAtomically,
  ): Promise<PushSubscriptionStore> {
    const parent = dirname(filePath);
    await ensurePrivateDirectory(parent);
    let contents: string;
    try {
      contents = await readFile(filePath, "utf8");
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      const keys = await generateVapidKeys();
      const state = PushStateSchema.parse({ version: PUSH_STATE_VERSION, vapid: keys, devices: [] });
      await persist(filePath, state);
      return new PushSubscriptionStore(filePath, state, persist);
    }
    const state = PushStateSchema.parse(JSON.parse(contents));
    await chmod(filePath, 0o600);
    return new PushSubscriptionStore(filePath, state, persist);
  }

  get publicKey(): string {
    return this.#state.vapid.publicKey;
  }

  list(): PushDevice[] {
    return this.#state.devices.map((device) => ({
      deviceId: device.deviceId,
      subscription: { endpoint: device.subscription.endpoint, keys: { ...device.subscription.keys } },
      events: { ...device.events },
    }));
  }

  configureWebPush(subject: string, configure: VapidConfigurator = webpush.setVapidDetails): void {
    configure(subject, this.#state.vapid.publicKey, this.#state.vapid.privateKey);
  }

  register(input: PushSubscriptionRegistration): Promise<PushDevice[]> {
    const registration = PushSubscriptionRegistrationSchema.parse(input);
    return this.#mutate((current) => {
      const nextDevice = cloneDevice(registration);
      const index = current.findIndex((device) => device.deviceId === registration.deviceId);
      if (index >= 0) {
        const next = [...current];
        next[index] = nextDevice;
        return next;
      }
      if (current.length >= MAX_DEVICES) throw new Error("The push device limit has been reached");
      return [...current, nextDevice];
    });
  }

  update(input: PushSubscriptionRegistration): Promise<PushDevice[]> {
    const registration = PushSubscriptionRegistrationSchema.parse(input);
    return this.#mutate((current) => {
      const index = current.findIndex((device) => device.deviceId === registration.deviceId);
      if (index < 0) throw new Error("The push device was not registered");
      const next = [...current];
      next[index] = cloneDevice(registration);
      return next;
    });
  }

  remove(input: PushSubscriptionRemoval): Promise<PushDevice[]> {
    const removal = PushSubscriptionRemovalSchema.parse(input);
    return this.#mutate((current) => current.filter((device) => device.deviceId !== removal.deviceId));
  }

  removeDevice(deviceId: string): Promise<PushDevice[]> {
    return this.remove({ deviceId });
  }

  removeIfCurrent(deviceId: string, expectedSubscription: PushSubscription): Promise<boolean> {
    const expected = PushSubscriptionSchema.parse(expectedSubscription);
    let removed = false;
    return this.#mutate((current) => {
      const currentDevice = current.find((device) => device.deviceId === deviceId);
      if (!currentDevice || !sameSubscription(currentDevice.subscription, expected)) return [...current];
      removed = true;
      return current.filter((device) => device.deviceId !== deviceId);
    }).then(() => removed);
  }

  #mutate(update: (current: readonly PushDevice[]) => PushDevice[]): Promise<PushDevice[]> {
    const mutation = this.#mutationQueue.then(async () => {
      const nextDevices = update(this.#state.devices);
      if (sameDevices(this.#state.devices, nextDevices)) return this.list();
      const nextState: PushState = { ...this.#state, devices: nextDevices };
      await this.#persist(this.#filePath, nextState);
      this.#state = nextState;
      return this.list();
    });
    this.#mutationQueue = mutation.then(
      () => undefined,
      () => undefined,
    );
    return mutation;
  }
}

export function createBestEffortPushSender(
  store: PushSubscriptionStore,
  subject: string = PUSH_VAPID_SUBJECT,
  sendNotification: NotificationSender = (subscription, payload) =>
    webpush.sendNotification(subscription, payload),
): { send: (event: PushEvent, payload: string) => Promise<{ attempted: number; removed: number }> } {
  store.configureWebPush(subject);
  return {
    async send(event, payload) {
      if (new TextEncoder().encode(payload).byteLength > MAX_PAYLOAD_BYTES) {
        throw new Error("Push payload exceeds the supported size");
      }
      const failures: PushDeliveryFailure[] = [];
      let attempted = 0;
      let removed = 0;
      await Promise.all(
        store.list().map(async (device) => {
          if (!device.events[event]) return;
          attempted += 1;
          try {
            await sendNotification(device.subscription, payload);
          } catch (error) {
            const statusCode = getStatusCode(error);
            if (statusCode === 404 || statusCode === 410) {
              if (await store.removeIfCurrent(device.deviceId, device.subscription)) removed += 1;
            } else {
              failures.push({
                deviceId: device.deviceId,
                ...(statusCode === undefined ? {} : { statusCode }),
              });
            }
          }
        }),
      );
      if (failures.length > 0) throw new PushDeliveryError(failures);
      return { attempted, removed };
    },
  };
}

export class PushDeliveryError extends Error {
  readonly failures: readonly PushDeliveryFailure[];
  constructor(failures: readonly PushDeliveryFailure[]) {
    super("One or more push deliveries failed");
    this.name = "PushDeliveryError";
    this.failures = failures;
  }
}

function cloneDevice(device: PushSubscriptionRegistration): PushDevice {
  return {
    deviceId: device.deviceId,
    subscription: { endpoint: device.subscription.endpoint, keys: { ...device.subscription.keys } },
    events: { ...device.events },
  };
}

function sameDevices(left: readonly PushDevice[], right: readonly PushDevice[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameSubscription(left: PushSubscription, right: PushSubscription): boolean {
  return (
    left.endpoint === right.endpoint &&
    left.keys.p256dh === right.keys.p256dh &&
    left.keys.auth === right.keys.auth
  );
}

function getStatusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) return undefined;
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return typeof statusCode === "number" ? statusCode : undefined;
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}

async function persistAtomically(filePath: string, state: PushState): Promise<void> {
  const parent = dirname(filePath);
  await ensurePrivateDirectory(parent);
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, filePath);
    await chmod(filePath, 0o600);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
