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
});
