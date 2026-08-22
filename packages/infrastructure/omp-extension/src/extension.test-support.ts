import { rm } from "node:fs/promises";
import { afterEach, vi } from "vitest";
import { z } from "zod";

export const compatibilityZ = { ...z };
Reflect.deleteProperty(compatibilityZ, "discriminatedUnion");

const originalArgv = [...process.argv];
export const temporaryDirectories: string[] = [];

type Listener = (event: { data?: string }) => void | Promise<void>;

export class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly instances: FakeWebSocket[] = [];
  readonly sent: string[] = [];
  readonly listeners = new Map<string, Listener[]>();
  readyState = FakeWebSocket.OPEN;

  constructor() {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {}

  async emit(type: string, event: { data?: string } = {}) {
    for (const listener of this.listeners.get(type) ?? []) await listener(event);
  }
}

afterEach(async () => {
  process.argv.splice(0, process.argv.length, ...originalArgv);
  vi.unstubAllGlobals();
  vi.useRealTimers();
  FakeWebSocket.instances.length = 0;
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});
