import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { mkdir, mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type CursorPayload,
  createReadImageResolver,
  encodeCursor,
  isValidCursorPayload,
  readTranscriptPage,
} from "./transcript-pagination.js";

const hashSession = (id: string): string => createHash("sha256").update(id).digest("hex");

describe("readTranscriptPage", () => {
  let testDir: string;
  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "omp-trans-test-"));
  });
  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it.each([
    [50, ["complete", null, 50]],
    [51, ["available", "complete", 50, 1]],
    [100, ["available", "complete", 50, 50]],
    [101, ["available", "available", 50, 50, "complete", 1]],
  ])("handles exact multiple boundaries: %i records", async (count, expected) => {
    const sessionPath = join(testDir, `b-${count}.jsonl`);
    const records = [
      { type: "header", ver: 1 },
      ...Array.from({ length: count }, (_, i) => ({
        type: "message",
        id: `m-${i}`,
        message: { role: "user", content: `Msg ${i}` },
      })),
    ];
    await writeFile(sessionPath, records.map((r) => JSON.stringify(r)).join("\n") + "\n");

    const p1 = await readTranscriptPage({ sessionId: "s", sessionPath });
    expect(p1.status).toBe(expected[0]);
    expect(p1.messages).toHaveLength(expected[2] as number);
    if (count === 50) expect(p1.olderCursor).toBeNull();
    if (count >= 51) {
      const p2 = await readTranscriptPage({ sessionId: "s", sessionPath, cursor: p1.olderCursor });
      expect(p2.status).toBe(expected[1]);
      expect(p2.messages).toHaveLength(expected[3] as number);
      if (count === 101) {
        const p3 = await readTranscriptPage({ sessionId: "s", sessionPath, cursor: p2.olderCursor });
        expect(p3.status).toBe(expected[4]);
        expect(p3.messages).toHaveLength(expected[5] as number);
      }
    }
  });

  it("supports arbitrarily long sessionId, bounding cursor <=512 and completing page 2", async () => {
    const longSessionId = "long-session-id-".repeat(50);
    const sessionPath = join(testDir, "long-id.jsonl");
    const records = Array.from({ length: 51 }, (_, i) => ({
      type: "message",
      id: `m-${i}`,
      message: { role: "user", content: `M ${i}` },
    }));
    await writeFile(sessionPath, records.map((r) => JSON.stringify(r)).join("\n") + "\n");

    const p1 = await readTranscriptPage({ sessionId: longSessionId, sessionPath });
    expect(p1.status).toBe("available");
    expect(p1.olderCursor!.length).toBeLessThanOrEqual(512);

    const p2 = await readTranscriptPage({ sessionId: longSessionId, sessionPath, cursor: p1.olderCursor });
    expect(p2.status).toBe("complete");
    expect(p2.messages).toHaveLength(1);
    expect(p2.messages[0]?.id).toBe("m-0");

    const cross = await readTranscriptPage({
      sessionId: "other-session",
      sessionPath,
      cursor: p1.olderCursor,
    });
    expect(cross.status).toBe("invalidated");
  });

  it("supports append-only file growth and invalidates truncation/replacement", async () => {
    const sessionPath = join(testDir, "app-inval.jsonl");
    const initial = Array.from({ length: 60 }, (_, i) => ({
      type: "message",
      id: `msg-${i}`,
      message: { role: "user", content: `M ${i}` },
    }));
    await writeFile(sessionPath, initial.map((r) => JSON.stringify(r)).join("\n") + "\n");

    const p1 = await readTranscriptPage({ sessionId: "s-app", sessionPath });
    const cursor = p1.olderCursor!;

    await writeFile(
      sessionPath,
      JSON.stringify({ type: "message", id: "app-1", message: { role: "user", content: "A" } }) + "\n",
      { flag: "a" },
    );
    const p2 = await readTranscriptPage({ sessionId: "s-app", sessionPath, cursor });
    expect(p2.status).toBe("complete");
    expect(p2.messages).toHaveLength(10);

    await writeFile(sessionPath, JSON.stringify(initial[0]) + "\n");
    expect((await readTranscriptPage({ sessionId: "s-app", sessionPath, cursor })).status).toBe(
      "invalidated",
    );
    await rm(sessionPath);
    await writeFile(sessionPath, initial.map((r) => JSON.stringify(r)).join("\n") + "\n");
    expect((await readTranscriptPage({ sessionId: "s-app", sessionPath, cursor })).status).toBe(
      "invalidated",
    );
  });

  it("authenticates cursor before path and handles ENOENT/ENOTDIR correctly", async () => {
    const sessionPath = join(testDir, "auth.jsonl");
    await writeFile(
      sessionPath,
      JSON.stringify({ type: "message", id: "m1", message: { role: "user", content: "hi" } }) + "\n",
    );

    expect(await readTranscriptPage({ sessionId: "s-auth", sessionPath: null })).toEqual({
      sessionId: "s-auth",
      messages: [],
      olderCursor: null,
      status: "unavailable",
    });
    expect(
      await readTranscriptPage({ sessionId: "s-auth", sessionPath: join(testDir, "missing.jsonl") }),
    ).toEqual({ sessionId: "s-auth", messages: [], olderCursor: null, status: "unavailable" });

    const validSignedCursor = encodeCursor({
      s: hashSession("s-auth"),
      dev: 1,
      ino: 1,
      btime: 1,
      end: 100,
      next: 50,
    });
    for (const [p, s] of [
      [null, "s-auth"],
      [join(testDir, "deleted.jsonl"), "s-auth"],
      [sessionPath, "s-other"],
    ] as const) {
      expect(
        (await readTranscriptPage({ sessionId: s, sessionPath: p, cursor: validSignedCursor })).status,
      ).toBe("invalidated");
    }
  });

  it.each([
    ["oversized >512", "a".repeat(513)],
    ["fractional dev", { s: hashSession("s"), dev: 1.5, ino: 1, btime: 1, end: 10, next: 5 }],
    ["negative ino", { s: hashSession("s"), dev: 1, ino: -1, btime: 1, end: 10, next: 5 }],
    [
      "unsafe int",
      { s: hashSession("s"), dev: Number.MAX_SAFE_INTEGER + 10, ino: 1, btime: 1, end: 10, next: 5 },
    ],
    [
      "tampered HMAC same length",
      (() => {
        const c = encodeCursor({ s: hashSession("s"), dev: 1, ino: 1, btime: 1, end: 10, next: 5 });
        const lastChar = c.slice(-1) === "a" ? "b" : "a";
        return `${c.slice(0, -1)}${lastChar}`;
      })(),
    ],
  ])("rejects malformed/tampered cursor bounds: %s", async (_, val) => {
    if (typeof val === "object") {
      expect(isValidCursorPayload(val)).toBe(false);
      expect(() => encodeCursor(val as unknown as CursorPayload)).toThrow(TypeError);
    }
    const cursor = typeof val === "string" ? val : "invalid";
    const res = await readTranscriptPage({ sessionId: "s", sessionPath: join(testDir, "f.jsonl"), cursor });
    expect(res.status).toBe("invalidated");
  });

  it("fails closed (invalidated) when hasOlder is true but stat identity is unsafe integer", async () => {
    const sessionPath = join(testDir, "unsafe-stat.jsonl");
    await writeFile(
      sessionPath,
      Array.from({ length: 60 }, (_, i) =>
        JSON.stringify({ type: "message", id: `m-${i}`, message: { role: "user", content: `M ${i}` } }),
      ).join("\n") + "\n",
    );

    const res = await readTranscriptPage({
      sessionId: "s-unsafe",
      sessionPath,
      openFile: async (p) => {
        const handle = await open(p, "r");
        const realStat = handle.stat.bind(handle);
        handle.stat = (async () => ({ ...(await realStat()), dev: -1 })) as unknown as FileHandle["stat"];
        return handle;
      },
    });
    expect(res).toEqual({ sessionId: "s-unsafe", messages: [], olderCursor: null, status: "invalidated" });
  });

  it("handles ToolCallTracker precedence, adjacent call-only/result, and >500-distance correlation", async () => {
    const sessionPath = join(testDir, "tools.jsonl");
    const records: Record<string, unknown>[] = [
      {
        type: "message",
        id: "older-alias-call",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "src/deep.ts" } }],
        },
      },
      ...Array.from({ length: 520 }, (_, i) => ({
        type: "message",
        id: `mid-${i}`,
        message: { role: "user", content: `M ${i}` },
      })),
      {
        type: "message",
        id: "nearer-malformed-call",
        message: {
          role: "assistant",
          content: [
            { type: "text", id: "call_1", text: "colliding text" },
            {
              type: "toolCall",
              toolCallId: "",
              id: "call_1",
              toolName: "read",
              arguments: { path: "src/bad.ts" },
            },
            { type: "toolCall", id: "call_2", name: "read", arguments: { path: "src/adj.ts" } },
          ],
        },
      },
      {
        type: "message",
        id: "adj-res",
        message: {
          role: "toolResult",
          toolName: "read",
          toolCallId: "call_2",
          content: [{ type: "text", text: "Adj" }],
        },
      },
      {
        type: "message",
        id: "deep-res",
        message: {
          role: "toolResult",
          toolName: "read",
          toolCallId: "call_1",
          content: [{ type: "text", text: "Deep" }],
        },
      },
    ];
    await writeFile(sessionPath, records.map((r) => JSON.stringify(r)).join("\n") + "\n");

    const p1 = await readTranscriptPage({ sessionId: "s-tool", sessionPath });
    expect(p1.messages.find((m) => m.id === "deep-res")?.readTarget).toBe("src/deep.ts");
    expect(p1.messages.find((m) => m.id === "adj-res")?.readTarget).toBe("src/adj.ts");
  });

  it("handles >100 unrelated sparse prefix lines and deterministic distinct IDs", async () => {
    const sessionPath = join(testDir, "sparse.jsonl");
    const records = [
      ...Array.from({ length: 120 }, (_, i) => ({ type: "file_change", change: i })),
      { type: "message", message: { role: "user", content: "same" } },
      { type: "message", message: { role: "user", content: "same" } },
    ];
    await writeFile(sessionPath, records.map((r) => JSON.stringify(r)).join("\n") + "\n");

    const r1 = await readTranscriptPage({ sessionId: "s-sparse", sessionPath });
    expect(r1.messages).toHaveLength(2);
    expect(r1.messages[0]?.id).not.toBe(r1.messages[1]?.id);
  });

  it("truncates multi-megabyte text, invalidates on RangeError, and rethrows operational errors", async () => {
    const sessionPath = join(testDir, "large.jsonl");
    await writeFile(
      sessionPath,
      JSON.stringify({
        type: "message",
        id: "huge",
        message: { role: "assistant", content: "X".repeat(2 * 1024 * 1024) },
      }) + "\n",
    );

    const res = await readTranscriptPage({ sessionId: "s-lg", sessionPath });
    expect(res.messages[0]?.text.length).toBe(20001);
    expect(res.messages[0]?.text.endsWith("…")).toBe(true);

    const oversized = await readTranscriptPage({ sessionId: "s-lg", sessionPath, maxRecordBytes: 1024 });
    expect(oversized.status).toBe("invalidated");

    await expect(
      readTranscriptPage({
        sessionId: "s-lg",
        sessionPath,
        openFile: async () => {
          throw Object.assign(new Error("disk error"), { code: "EIO" });
        },
      }),
    ).rejects.toThrow();
  });

  it("enforces image safety table and aggregate session budget via injected budget resolver", async () => {
    const blobsDir = join(testDir, "blobs");
    await mkdir(blobsDir, { recursive: true });
    const validPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64",
    );
    const validHash = createHash("sha256").update(validPng).digest("hex");
    await writeFile(join(blobsDir, validHash), validPng);

    const outsidePng = join(testDir, "outside.png");
    await writeFile(outsidePng, validPng);
    const symlinkHash = "a".repeat(64);
    await symlink(outsidePng, join(blobsDir, symlinkHash));

    const corruptedHash = "b".repeat(64);
    await writeFile(join(blobsDir, corruptedHash), Buffer.from("corrupted bytes"));

    const oversizedHash = "c".repeat(64);
    await writeFile(join(blobsDir, oversizedHash), Buffer.alloc(10 * 1024 * 1024 + 100));

    const sessionPath = join(testDir, "sessions", "img-table.jsonl");
    await mkdir(join(testDir, "sessions"), { recursive: true });
    const imgRecords = [
      { id: "img-valid", data: `blob:sha256:${validHash}`, mime: "image/png" },
      { id: "img-symlink", data: `blob:sha256:${symlinkHash}`, mime: "image/png" },
      { id: "img-hash-mismatch", data: `blob:sha256:${corruptedHash}`, mime: "image/png" },
      { id: "img-bad-mime", data: `blob:sha256:${validHash}`, mime: "image/jpeg" },
      { id: "img-oversized", data: `blob:sha256:${oversizedHash}`, mime: "image/png" },
    ].map((item) => ({
      type: "message",
      id: item.id,
      message: {
        role: "toolResult",
        toolName: "read",
        content: [{ type: "image", data: item.data, mimeType: item.mime }],
      },
    }));
    await writeFile(sessionPath, imgRecords.map((r) => JSON.stringify(r)).join("\n") + "\n");

    const res = await readTranscriptPage({ sessionId: "s-img-tbl", sessionPath, blobDirectory: blobsDir });
    const imgMap = new Map(res.messages.map((m) => [m.id, m.images?.[0]]));
    expect(imgMap.get("img-valid")).toEqual({
      status: "available",
      mimeType: "image/png",
      data: validPng.toString("base64"),
    });
    expect(imgMap.get("img-symlink")?.status).toBe("unavailable");
    expect(imgMap.get("img-hash-mismatch")).toEqual({ status: "unavailable", reason: "invalid_reference" });
    expect(imgMap.get("img-bad-mime")).toEqual({ status: "unavailable", reason: "mime_mismatch" });
    expect(imgMap.get("img-oversized")).toEqual({ status: "unavailable", reason: "oversized" });

    const budgetResolver = createReadImageResolver(blobsDir, validPng.length);
    expect(budgetResolver(`blob:sha256:${validHash}`, "image/png").status).toBe("available");
    expect(budgetResolver(`blob:sha256:${validHash}`, "image/png")).toEqual({
      status: "unavailable",
      reason: "budget_exceeded",
    });
  });
  it("retains the earliest valid skill prompt across multiple custom records and preserves evicted boundary messages via cursor", async () => {
    const sessionPath = join(testDir, "multi-prompt-boundary.jsonl");
    const firstPrompt = "Earliest prompt";
    const secondPrompt = "Later prompt";
    const records = [
      { type: "custom_message", customType: "skill-prompt", content: `wrapper\nUser: ${firstPrompt}` },
      { type: "custom_message", customType: "skill-prompt", content: `wrapper\nUser: ${secondPrompt}` },
      ...Array.from({ length: 50 }, (_, i) => ({
        type: "message",
        id: `m-${i}`,
        message: { role: "user", content: `M ${i}` },
      })),
    ];
    await writeFile(sessionPath, records.map((record) => JSON.stringify(record)).join("\n") + "\n");

    const p1 = await readTranscriptPage({ sessionId: "multi-prompt", sessionPath });
    expect(p1.status).toBe("available");
    expect(p1.messages).toHaveLength(50);
    expect(p1.messages[0]).toMatchObject({
      id: `skill-prompt-${createHash("sha256").update(firstPrompt, "utf8").digest("hex")}`,
      role: "user",
      text: firstPrompt,
    });
    expect(p1.messages[1]?.id).toBe("m-1");
    expect(p1.messages.at(-1)?.id).toBe("m-49");
    expect(p1.olderCursor).not.toBeNull();

    const p2 = await readTranscriptPage({ sessionId: "multi-prompt", sessionPath, cursor: p1.olderCursor });
    expect(p2.status).toBe("complete");
    expect(p2.messages.some((m) => m.id === "m-0")).toBe(true);
  });
});
