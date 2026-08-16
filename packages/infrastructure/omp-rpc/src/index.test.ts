import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RpcFrameDecoder, RpcSession } from "./index.js";

describe("RpcFrameDecoder", () => {
  it("reassembles a protocol v2 chunk sequence", () => {
    const decoder = new RpcFrameDecoder();
    const payload = Buffer.from(JSON.stringify({ type: "message_end", message: { role: "assistant" } }));
    const split = Math.floor(payload.length / 2);
    const parts = [payload.subarray(0, split), payload.subarray(split)];

    const first = decoder.decode(
      JSON.stringify({
        type: "rpc_chunk",
        chunkId: "rpc-1",
        index: 0,
        count: 2,
        byteLength: payload.length,
        data: parts[0]?.toString("base64"),
      }),
    );
    const second = decoder.decode(
      JSON.stringify({
        type: "rpc_chunk",
        chunkId: "rpc-1",
        index: 1,
        count: 2,
        byteLength: payload.length,
        data: parts[1]?.toString("base64"),
      }),
    );

    expect(first).toBeUndefined();
    expect(second).toEqual({ type: "message_end", message: { role: "assistant" } });
  });

  it("rejects interrupted chunk sequences", () => {
    const decoder = new RpcFrameDecoder();
    decoder.decode(
      JSON.stringify({
        type: "rpc_chunk",
        chunkId: "rpc-1",
        index: 0,
        count: 2,
        byteLength: 2,
        data: "eA==",
      }),
    );

    expect(() => decoder.decode(JSON.stringify({ type: "agent_start" }))).toThrow("interrupted");
  });
});

describe("RpcSession", () => {
  it("terminates a running RPC process and waits for its exit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "omp-remote-rpc-"));
    const executable = join(directory, "rpc-fixture.cjs");
    await writeFile(
      executable,
      `#!/usr/bin/env node
const readline = require("node:readline");
process.stdout.write(JSON.stringify({ type: "ready", supportedProtocolVersions: [] }) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const frame = JSON.parse(line);
  process.stdout.write(JSON.stringify({
    type: "response",
    id: frame.id,
    success: true,
    data: { sessionId: "fixture-session", isStreaming: false },
  }) + "\\n");
});
`,
    );
    await chmod(executable, 0o755);

    try {
      const rpc = new RpcSession({
        cwd: directory,
        ompPath: executable,
        resume: null,
        onStderr: () => undefined,
      });
      let processExit: Record<string, unknown> | undefined;
      rpc.subscribe((frame) => {
        if (frame.type === "process_exit") processExit = frame;
      });

      await rpc.start();
      await rpc.terminate();

      expect(processExit).toMatchObject({ type: "process_exit", signal: "SIGTERM" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("force-kills an RPC process that ignores graceful termination", async () => {
    const directory = await mkdtemp(join(tmpdir(), "omp-remote-rpc-force-kill-"));
    const executable = join(directory, "rpc-force-kill-fixture.cjs");
    await writeFile(
      executable,
      `#!/usr/bin/env node
const readline = require("node:readline");
process.on("SIGTERM", () => undefined);
process.stdout.write(JSON.stringify({ type: "ready", supportedProtocolVersions: [] }) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const frame = JSON.parse(line);
  process.stdout.write(JSON.stringify({
    type: "response",
    id: frame.id,
    success: true,
    data: { sessionId: "force-kill-session", isStreaming: false },
  }) + "\\n");
});
`,
    );
    await chmod(executable, 0o755);

    let rpc: RpcSession | undefined;
    try {
      rpc = new RpcSession({
        cwd: directory,
        ompPath: executable,
        resume: null,
        onStderr: () => undefined,
      });
      let processExit: Record<string, unknown> | undefined;
      rpc.subscribe((frame) => {
        if (frame.type === "process_exit") processExit = frame;
      });

      await rpc.start();
      await rpc.terminate();

      expect(processExit).toMatchObject({ type: "process_exit", signal: "SIGKILL" });
    } finally {
      await rpc?.terminate().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("times out a request without terminating the RPC session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "omp-remote-rpc-timeout-"));
    const executable = join(directory, "rpc-timeout-fixture.cjs");
    await writeFile(
      executable,
      `#!/usr/bin/env node
const readline = require("node:readline");
process.stdout.write(JSON.stringify({ type: "ready", supportedProtocolVersions: [] }) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const frame = JSON.parse(line);
  if (frame.type === "stall") return;
  process.stdout.write(JSON.stringify({
    type: "response",
    id: frame.id,
    success: true,
    data: { sessionId: "fixture-session", isStreaming: false },
  }) + "\\n");
});
`,
    );
    await chmod(executable, 0o755);

    let rpc: RpcSession | undefined;
    try {
      rpc = new RpcSession({
        cwd: directory,
        ompPath: executable,
        resume: null,
        onStderr: () => undefined,
      });
      await rpc.start();

      await expect(rpc.request({ type: "stall" }, { timeoutMs: 10 })).rejects.toThrow(
        "OMP RPC request timed out",
      );
      await expect(rpc.request({ type: "stall" }, { timeoutMs: 1.5 })).rejects.toThrow(
        "OMP RPC request timeout is out of range",
      );
      await expect(rpc.request({ type: "stall" }, { timeoutMs: 2_147_483_648 })).rejects.toThrow(
        "OMP RPC request timeout is out of range",
      );
      await expect(rpc.request({ type: "get_state" })).resolves.toMatchObject({
        type: "response",
        data: { sessionId: "fixture-session" },
      });
    } finally {
      await rpc?.terminate().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("launches RPC UI mode without disabling extensions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "omp-remote-rpc-"));
    const executable = join(directory, "rpc-fixture.cjs");
    await writeFile(
      executable,
      `#!/usr/bin/env node
const readline = require("node:readline");
process.stdout.write(JSON.stringify({ type: "ready", supportedProtocolVersions: [] }) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const frame = JSON.parse(line);
  process.stdout.write(JSON.stringify({
    type: "response",
    id: frame.id,
    success: true,
    data: {
      sessionId: "fixture-session",
      isStreaming: false,
      argv: process.argv.slice(2),
    },
  }) + "\\n");
});
`,
    );
    await chmod(executable, 0o755);

    let rpc: RpcSession | undefined;
    try {
      rpc = new RpcSession({
        cwd: directory,
        ompPath: executable,
        resume: null,
        onStderr: () => undefined,
      });

      const state = await rpc.start();

      expect(state).toMatchObject({
        type: "response",
        data: { argv: ["--mode", "rpc-ui", "--cwd", directory] },
      });
    } finally {
      await rpc?.terminate().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("writes extension UI responses without wrapping them as RPC commands", async () => {
    const directory = await mkdtemp(join(tmpdir(), "omp-remote-rpc-ui-"));
    const executable = join(directory, "rpc-ui-fixture.cjs");
    await writeFile(
      executable,
      `#!/usr/bin/env node
const readline = require("node:readline");
let sentAsk = false;
process.stdout.write(JSON.stringify({ type: "ready", supportedProtocolVersions: [] }) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const frame = JSON.parse(line);
  if (frame.type === "extension_ui_response") {
    process.stdout.write(JSON.stringify({ type: "ui_response_received", frame }) + "\\n");
    return;
  }
  process.stdout.write(JSON.stringify({
    type: "response",
    id: frame.id,
    success: true,
    data: { sessionId: "fixture-session", isStreaming: false },
  }) + "\\n");
  if (!sentAsk) {
    sentAsk = true;
    process.stdout.write(JSON.stringify({
      type: "extension_ui_request",
      id: "ask-1",
      method: "select",
      title: "Which database?",
      options: ["SQLite", "PostgreSQL"],
    }) + "\\n");
  }
});
`,
    );
    await chmod(executable, 0o755);

    let rpc: RpcSession | undefined;
    try {
      rpc = new RpcSession({
        cwd: directory,
        ompPath: executable,
        resume: null,
        onStderr: () => undefined,
      });
      const askFrame = new Promise<Record<string, unknown>>((resolve) => {
        const unsubscribe = rpc?.subscribe((frame) => {
          if (frame.type !== "extension_ui_request") return;
          unsubscribe?.();
          resolve(frame);
        });
      });

      await rpc.start();
      await expect(askFrame).resolves.toMatchObject({ id: "ask-1", method: "select" });

      const receipt = new Promise<Record<string, unknown>>((resolve) => {
        const unsubscribe = rpc?.subscribe((frame) => {
          if (frame.type !== "ui_response_received") return;
          unsubscribe?.();
          resolve(frame);
        });
      });
      await rpc.respondToUiRequest("ask-1", { value: "PostgreSQL" });

      await expect(receipt).resolves.toMatchObject({
        frame: { type: "extension_ui_response", id: "ask-1", value: "PostgreSQL" },
      });
    } finally {
      await rpc?.terminate().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });
});

it("rejects promptly when the RPC process exits before ready", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-remote-rpc-early-exit-"));
  const executable = join(directory, "rpc-early-exit-fixture.cjs");
  await writeFile(
    executable,
    `#!/usr/bin/env node
process.exit(1);
`,
  );
  await chmod(executable, 0o755);

  try {
    const rpc = new RpcSession({
      cwd: directory,
      ompPath: executable,
      resume: null,
      onStderr: () => undefined,
    });

    await expect(rpc.start()).rejects.toThrow("OMP RPC process exited (1)");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
