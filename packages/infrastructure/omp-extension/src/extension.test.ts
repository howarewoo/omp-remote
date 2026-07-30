import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import ompRemoteExtension, { isRpcMode } from "./extension.js";

const originalArgv = [...process.argv];

afterEach(() => {
  process.argv.splice(0, process.argv.length, ...originalArgv);
});

describe("ompRemoteExtension", () => {
  it("recognizes hosted RPC modes without suppressing other modes", () => {
    expect(isRpcMode(["omp", "--mode", "rpc"])).toBe(true);
    expect(isRpcMode(["omp", "--mode=rpc-ui"])).toBe(true);
    expect(isRpcMode(["omp", "--mode", "text"])).toBe(false);
    expect(isRpcMode(["omp", "--mode", "rpc", "--mode=text"])).toBe(false);
    expect(isRpcMode(["omp", "--mode"])).toBe(false);
  });

  it("does not register remote lifecycle handlers inside an RPC child", () => {
    process.argv.splice(0, process.argv.length, "node", "omp", "--mode", "rpc");
    const on = vi.fn();

    ompRemoteExtension({ on } as unknown as ExtensionAPI);

    expect(on).not.toHaveBeenCalled();
  });
});
