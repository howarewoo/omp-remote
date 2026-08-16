import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { setTimeout as wait } from "node:timers/promises";
import { TextDecoder } from "node:util";
import { z } from "zod";

const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_REASSEMBLED_BYTES = 64 * 1024 * 1024;
const TERMINATION_GRACE_MS = 1_000;
const RpcObjectSchema = z.record(z.string(), z.unknown());

export type RpcFrame = Record<string, unknown>;

type PendingRequest = {
  resolve: (frame: RpcFrame) => void;
  reject: (error: Error) => void;
};

type ChunkSequence = {
  chunkId: string;
  count: number;
  byteLength: number;
  parts: Buffer[];
};

export class RpcFrameDecoder {
  #sequence: ChunkSequence | undefined;

  decode(line: string): RpcFrame | undefined {
    if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) throw new Error("OMP RPC frame exceeds 1 MiB");
    const parsed = RpcObjectSchema.parse(JSON.parse(line));
    if (parsed.type !== "rpc_chunk") {
      if (this.#sequence) throw new Error("OMP RPC chunk sequence was interrupted");
      return parsed;
    }

    const chunkId = parsed.chunkId;
    const index = parsed.index;
    const count = parsed.count;
    const byteLength = parsed.byteLength;
    const data = parsed.data;
    if (
      typeof chunkId !== "string" ||
      !Number.isInteger(index) ||
      !Number.isInteger(count) ||
      !Number.isInteger(byteLength) ||
      typeof data !== "string" ||
      typeof index !== "number" ||
      typeof count !== "number" ||
      typeof byteLength !== "number" ||
      index < 0 ||
      count < 1 ||
      index >= count ||
      byteLength < 1 ||
      byteLength > MAX_REASSEMBLED_BYTES
    ) {
      throw new Error("Invalid OMP RPC chunk metadata");
    }

    if (index === 0) {
      if (this.#sequence) throw new Error("OMP RPC chunk sequence was interleaved");
      this.#sequence = { chunkId, count, byteLength, parts: [] };
    }
    const sequence = this.#sequence;
    if (
      !sequence ||
      sequence.chunkId !== chunkId ||
      sequence.count !== count ||
      sequence.parts.length !== index
    ) {
      throw new Error("OMP RPC chunks are out of order");
    }
    sequence.parts.push(Buffer.from(data, "base64"));
    if (index + 1 < count) return undefined;

    this.#sequence = undefined;
    const bytes = Buffer.concat(sequence.parts);
    if (bytes.byteLength !== sequence.byteLength) throw new Error("OMP RPC chunk byte length mismatch");
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return RpcObjectSchema.parse(JSON.parse(decoded));
  }
}

export interface RpcSessionOptions {
  cwd: string;
  ompPath: string;
  resume: string | null;
  onStderr: (text: string) => void;
}

export type RpcUiResponse = { value: string } | { cancelled: true; timedOut?: boolean | undefined };

export class RpcSession {
  readonly #decoder = new RpcFrameDecoder();
  readonly #listeners = new Set<(frame: RpcFrame) => void>();
  readonly #pending = new Map<string, PendingRequest>();
  readonly #options: RpcSessionOptions;
  #child: ChildProcessWithoutNullStreams | undefined;
  #nextRequest = 1;
  #stdoutBuffer = "";

  constructor(options: RpcSessionOptions) {
    this.#options = options;
  }

  async start(): Promise<RpcFrame> {
    if (this.#child) throw new Error("OMP RPC session is already running");
    const args = ["--mode", "rpc-ui", "--cwd", this.#options.cwd];
    if (this.#options.resume) args.push("--resume", this.#options.resume);
    const child = spawn(this.#options.ompPath, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.#child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.#consume(chunk));
    child.stderr.on("data", (chunk: string) => this.#options.onStderr(chunk));
    child.on("error", (error) => this.#fail(error));
    child.on("exit", (code, signal) => {
      this.#child = undefined;
      this.#fail(new Error(`OMP RPC process exited (${signal ?? code ?? "unknown"})`));
      this.#emit({ type: "process_exit", code, signal });
    });

    const ready = await new Promise<RpcFrame>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        unsubscribe();
        child.off("error", onError);
      };
      const onError = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const unsubscribe = this.subscribe((frame) => {
        if (settled) return;
        if (frame.type === "ready") {
          settled = true;
          cleanup();
          resolve(frame);
        } else if (frame.type === "process_exit") {
          settled = true;
          cleanup();
          reject(new Error(`OMP RPC process exited (${frame.signal ?? frame.code ?? "unknown"})`));
        }
      });
      child.once("error", onError);
    });
    const supported = ready.supportedProtocolVersions;
    if (Array.isArray(supported) && supported.includes(2)) {
      await this.request({ type: "negotiate_protocol", protocolVersion: 2 });
    }
    return this.request({ type: "get_state" });
  }

  request(command: RpcFrame, options: { timeoutMs?: number } = {}): Promise<RpcFrame> {
    const child = this.#child;
    if (!child?.stdin.writable) return Promise.reject(new Error("OMP RPC session is not connected"));
    const timeoutMs = options.timeoutMs;
    if (
      timeoutMs !== undefined &&
      (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647)
    ) {
      return Promise.reject(new Error("OMP RPC request timeout is out of range"));
    }
    const id = `remote_${this.#nextRequest++}`;
    return new Promise<RpcFrame>((resolve, reject) => {
      let timeout: NodeJS.Timeout | undefined;
      const pending: PendingRequest = {
        resolve: (frame) => {
          clearTimeout(timeout);
          resolve(frame);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      };
      this.#pending.set(id, pending);
      if (timeoutMs !== undefined) {
        timeout = setTimeout(() => {
          if (this.#pending.get(id) !== pending) return;
          this.#pending.delete(id);
          reject(new Error("OMP RPC request timed out"));
        }, timeoutMs);
        timeout.unref();
      }
      child.stdin.write(`${JSON.stringify({ ...command, id })}\n`, (error) => {
        if (!error || this.#pending.get(id) !== pending) return;
        this.#pending.delete(id);
        pending.reject(error);
      });
    });
  }

  respondToUiRequest(requestId: string, response: RpcUiResponse): Promise<void> {
    const child = this.#child;
    if (!child?.stdin.writable) return Promise.reject(new Error("OMP RPC session is not connected"));
    return new Promise<void>((resolve, reject) => {
      child.stdin.write(
        `${JSON.stringify({ type: "extension_ui_response", id: requestId, ...response })}\n`,
        (error) => {
          if (error) reject(error);
          else resolve();
        },
      );
    });
  }

  subscribe(listener: (frame: RpcFrame) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async terminate(): Promise<void> {
    const child = this.#child;
    if (!child) throw new Error("OMP RPC session is not connected");

    const exitPromise = once(child, "exit").then(() => undefined);
    if (!child.kill("SIGTERM")) throw new Error("OMP RPC process could not be terminated");

    await Promise.race([exitPromise, wait(TERMINATION_GRACE_MS, undefined, { ref: false })]);
    if (child.exitCode === null && child.signalCode === null) {
      if (!child.kill("SIGKILL")) throw new Error("OMP RPC process could not be force-terminated");
      await exitPromise;
    }
  }

  #consume(chunk: string): void {
    this.#stdoutBuffer += chunk;
    while (true) {
      const newline = this.#stdoutBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.#stdoutBuffer.slice(0, newline).trim();
      this.#stdoutBuffer = this.#stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      try {
        const frame = this.#decoder.decode(line);
        if (frame) this.#handle(frame);
      } catch (error) {
        this.#fail(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  #handle(frame: RpcFrame): void {
    const id = frame.id;
    if (frame.type === "response" && typeof id === "string") {
      const pending = this.#pending.get(id);
      if (pending) {
        this.#pending.delete(id);
        if (frame.success === false)
          pending.reject(new Error(typeof frame.error === "string" ? frame.error : "OMP RPC command failed"));
        else pending.resolve(frame);
      }
    }
    this.#emit(frame);
  }

  #emit(frame: RpcFrame): void {
    for (const listener of this.#listeners) listener(frame);
  }

  #fail(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}
