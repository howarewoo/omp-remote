import { describe, expect, it } from "vitest";
import { RpcFrameDecoder } from "./index.js";

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
