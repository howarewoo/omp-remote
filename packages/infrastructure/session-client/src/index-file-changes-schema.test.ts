import { describe, expect, it, vi } from "vitest";
import { loadSessionFileChanges } from "./index.js";

const availableResponse = {
  sessionId: "session/a",
  state: "available",
  sources: [],
  fileCount: 0,
  operationCount: 0,
  additions: 0,
  deletions: 0,
  changedLines: 0,
  message: null,
};

describe("loadSessionFileChanges schema", () => {
  it("rejects a successful response that violates the changes schema", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ ...availableResponse, operationCount: 1 }), { status: 200 }),
      );

    await expect(loadSessionFileChanges("session-1", undefined, fetcher)).rejects.toThrow();
  });
});
