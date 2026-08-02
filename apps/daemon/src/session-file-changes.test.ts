import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectSessionFileChanges } from "./session-file-changes.js";
import type { SessionFileChangeSourceDescriptor } from "./session-catalog.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "omp-remote-changes-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeJsonl(path: string, records: unknown[], suffix = ""): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n${suffix}`, "utf8");
}

function call(
  toolCallId: string,
  name: string,
  args: Record<string, unknown>,
  timestamp: string,
  legacy = false,
) {
  return {
    type: "message",
    timestamp,
    message: {
      role: "assistant",
      content: [
        { type: "toolCall", ...(legacy ? { toolCallId } : { id: toolCallId }), name, arguments: args },
      ],
    },
  };
}

function result(
  toolCallId: string,
  toolName: string,
  details: Record<string, unknown>,
  timestamp: string,
  isError = false,
) {
  return {
    type: "message",
    timestamp,
    message: { role: "toolResult", toolCallId, toolName, details, isError },
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("collectSessionFileChanges", () => {
  it("collects successful per-file edits, one unambiguous legacy edit, and metadata-only writes", async () => {
    const directory = await temporaryDirectory();
    const worktree = join(directory, "not-a-git-worktree");
    const sessionPath = join(directory, "history", "root.jsonl");
    const secret = "private write content";
    await writeJsonl(sessionPath, [
      call("modern", "edit", { input: "[src/a.ts#ABCD]\nPUT >1:\n+new" }, "2026-08-01T10:00:00.000Z"),
      result(
        "modern",
        "edit",
        {
          perFileResults: [
            { path: "src/a.ts", op: "update", patch: "@@ -1 +1 @@\n-old\n+new" },
            { resolvedPath: join(worktree, "src/b.ts"), op: "create", diff: "@@ -0,0 +1 @@\n+created" },
          ],
        },
        "2026-08-01T10:00:01.000Z",
      ),
      call("legacy", "edit", { input: "[src/a.ts#DCBA]\nPUT >1:\n+again" }, "2026-08-01T10:00:02.000Z", true),
      result("legacy", "edit", { diff: "@@ -1 +1 @@\n-new\n+again" }, "2026-08-01T10:00:03.000Z"),
      call("write", "write", { path: "src/data.txt", content: secret }, "2026-08-01T10:00:04.000Z"),
      result("write", "write", { resolvedPath: join(worktree, "src/data.txt") }, "2026-08-01T10:00:05.000Z"),
    ]);

    const response = await collectSessionFileChanges({
      sessionId: "root",
      sources: [{ sessionId: "root", root: worktree, sessionPath }],
    });

    expect(response).toMatchObject({
      state: "available",
      fileCount: 3,
      operationCount: 4,
      additions: 3,
      deletions: 2,
      changedLines: 5,
    });
    expect(response.sources[0]?.files[0]?.operations.map((operation) => operation.timestamp)).toEqual([
      "2026-08-01T10:00:01.000Z",
      "2026-08-01T10:00:03.000Z",
    ]);
    const write = response.sources[0]?.files.find((file) => file.path.endsWith("data.txt"))?.operations[0];
    expect(write).toEqual({
      type: "write",
      timestamp: "2026-08-01T10:00:05.000Z",
      sessionId: "root",
      resolvedPath: join(worktree, "src/data.txt"),
      byteCount: Buffer.byteLength(secret),
    });
    expect(response.sources[0]?.files[0]?.operations[0]).toMatchObject({ type: "edit", op: "update" });
    expect(JSON.stringify(response)).not.toContain(secret);
  });

  it("uses canonical tool-call fields before compatible aliases", async () => {
    const directory = await temporaryDirectory();
    const worktree = join(directory, "worktree");
    const sessionPath = join(directory, "root.jsonl");
    await writeJsonl(sessionPath, [
      {
        type: "message",
        timestamp: "2026-08-01T10:00:00.000Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              toolCallId: "canonical-id",
              id: "alias-id",
              toolName: "edit",
              name: "write",
              arguments: { input: "[src/a.ts#ABCD]\nPUT >1:\n+new" },
            },
          ],
        },
      },
      result("canonical-id", "edit", { diff: "+new" }, "2026-08-01T10:00:01.000Z"),
    ]);

    const response = await collectSessionFileChanges({
      sessionId: "root",
      sources: [{ sessionId: "root", root: worktree, sessionPath }],
    });

    expect(response).toMatchObject({ state: "available", fileCount: 1, operationCount: 1 });
  });

  it("marks successful tracked mutations partial when their result cannot be represented", async () => {
    const directory = await temporaryDirectory();
    const worktree = join(directory, "worktree");
    const sessionPath = join(directory, "root.jsonl");
    await writeJsonl(sessionPath, [
      call(
        "ambiguous",
        "edit",
        { input: "[a.ts#ABCD]\nPUT >1:\n+x\n[b.ts#ABCD]\nPUT >1:\n+y" },
        "2026-08-01T10:00:00.000Z",
      ),
      result("ambiguous", "edit", { diff: "+unknown" }, "2026-08-01T10:00:01.000Z"),
    ]);

    await expect(
      collectSessionFileChanges({
        sessionId: "root",
        sources: [{ sessionId: "root", root: worktree, sessionPath }],
      }),
    ).resolves.toMatchObject({ state: "partial", fileCount: 0, operationCount: 0 });
  });

  it("counts source lines beginning with diff header prefixes inside unified-diff hunks", async () => {
    const directory = await temporaryDirectory();
    const worktree = join(directory, "worktree");
    const sessionPath = join(directory, "root.jsonl");
    const patch = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,2 +1,2 @@",
      "---removed-prefix",
      "+++added-prefix",
      " context",
    ].join("\n");
    await writeJsonl(sessionPath, [
      call("edit", "edit", { input: "[src/a.ts#ABCD]\nPUT >1:\n+new" }, "2026-08-01T10:00:00.000Z"),
      result("edit", "edit", { diff: patch }, "2026-08-01T10:00:01.000Z"),
    ]);

    const response = await collectSessionFileChanges({
      sessionId: "root",
      sources: [{ sessionId: "root", root: worktree, sessionPath }],
    });

    expect(response).toMatchObject({ additions: 1, deletions: 1, changedLines: 2 });
  });

  it("keeps identical paths separate across originating session/worktree identities", async () => {
    const directory = await temporaryDirectory();
    const sourceA: SessionFileChangeSourceDescriptor = {
      sessionId: "root",
      root: join(directory, "worktree-a"),
      sessionPath: join(directory, "history", "root.jsonl"),
    };
    const sourceB: SessionFileChangeSourceDescriptor = {
      sessionId: "child",
      root: join(directory, "worktree-b"),
      sessionPath: join(directory, "history", "root", "child.jsonl"),
    };
    for (const source of [sourceA, sourceB]) {
      await writeJsonl(source.sessionPath, [
        call("edit", "edit", { input: "[src/shared.ts#ABCD]\nPUT >1:\n+line" }, "2026-08-01T10:00:00.000Z"),
        result("edit", "edit", { diff: "+line" }, "2026-08-01T10:00:01.000Z"),
      ]);
    }

    const response = await collectSessionFileChanges({ sessionId: "root", sources: [sourceA, sourceB] });

    expect(response.sources.map(({ sessionId, root, files }) => [sessionId, root, files[0]?.path])).toEqual([
      ["root", sourceA.root, join(sourceA.root, "src/shared.ts")],
      ["child", sourceB.root, join(sourceB.root, "src/shared.ts")],
    ]);
    expect(response.fileCount).toBe(2);
  });

  it("stable-sorts each file's operations by timestamp", async () => {
    const directory = await temporaryDirectory();
    const worktree = join(directory, "worktree");
    const sessionPath = join(directory, "root.jsonl");
    await writeJsonl(sessionPath, [
      call("later", "edit", { input: "[src/a.ts#ABCD]\nPUT >1:\n+later" }, "2026-08-01T10:00:00.000Z"),
      result("later", "edit", { op: "update", diff: "+later" }, "2026-08-01T10:00:00.1Z"),
      call("earlier", "edit", { input: "[src/a.ts#ABCD]\nPUT >1:\n+earlier" }, "2026-08-01T10:00:04.000Z"),
      result("earlier", "edit", { op: "update", diff: "+earlier" }, "2026-08-01T10:00:00Z"),
      call("equal", "edit", { input: "[src/a.ts#ABCD]\nPUT >1:\n+equal" }, "2026-08-01T10:00:05.000Z"),
      result("equal", "edit", { op: "update", diff: "+equal" }, "2026-08-01T10:00:00.100Z"),
    ]);

    const response = await collectSessionFileChanges({
      sessionId: "root",
      sources: [{ sessionId: "root", root: worktree, sessionPath }],
    });

    expect(
      response.sources[0]?.files[0]?.operations.map((operation) => [
        operation.timestamp,
        operation.type === "edit" ? operation.patch : null,
      ]),
    ).toEqual([
      ["2026-08-01T10:00:00.000Z", "+earlier"],
      ["2026-08-01T10:00:00.100Z", "+later"],
      ["2026-08-01T10:00:00.100Z", "+equal"],
    ]);
  });

  it("does not guess failed, ambiguous, opaque, device, or unattributable mutations", async () => {
    const directory = await temporaryDirectory();
    const worktree = join(directory, "worktree");
    const sessionPath = join(directory, "root.jsonl");
    await writeJsonl(
      sessionPath,
      [
        call("failed", "edit", { input: "[failed.ts#ABCD]\nPUT >1:\n+x" }, "2026-08-01T10:00:00.000Z"),
        result("failed", "edit", { diff: "+x" }, "2026-08-01T10:00:01.000Z", true),
        call(
          "ambiguous",
          "edit",
          { input: "[a.ts#ABCD]\nPUT >1:\n+x\n[b.ts#ABCD]\nPUT >1:\n+y" },
          "2026-08-01T10:00:02.000Z",
        ),
        result("ambiguous", "edit", { diff: "+unknown" }, "2026-08-01T10:00:03.000Z"),
        call("shell", "bash", { command: "printf secret > guessed.ts" }, "2026-08-01T10:00:04.000Z"),
        result("shell", "bash", { path: "guessed.ts" }, "2026-08-01T10:00:05.000Z"),
        call("device", "write", { path: "xd://lsp", content: "payload" }, "2026-08-01T10:00:06.000Z"),
        result("device", "write", {}, "2026-08-01T10:00:07.000Z"),
        result("orphan", "edit", { path: "orphan.ts", diff: "+x" }, "2026-08-01T10:00:08.000Z"),
      ],
      "{malformed json\n",
    );

    const response = await collectSessionFileChanges({
      sessionId: "root",
      sources: [{ sessionId: "root", root: worktree, sessionPath }],
    });

    expect(response).toMatchObject({ state: "partial", fileCount: 0, operationCount: 0 });
  });

  it("admits device mutations only from explicit canonical per-file result metadata", async () => {
    const directory = await temporaryDirectory();
    const worktree = join(directory, "worktree");
    const sessionPath = join(directory, "root.jsonl");
    await writeJsonl(sessionPath, [
      call("device", "write", { path: "xd://ast_edit", content: '{"ops":[]}' }, "2026-08-01T10:00:00.000Z"),
      result(
        "device",
        "write",
        {
          perFileResults: [{ path: "src/affected.ts", op: "update", patch: "@@ -1 +1 @@\n-before\n+after" }],
        },
        "2026-08-01T10:00:01.000Z",
      ),
    ]);

    const response = await collectSessionFileChanges({
      sessionId: "root",
      sources: [{ sessionId: "root", root: worktree, sessionPath }],
    });

    expect(response).toMatchObject({ state: "available", fileCount: 1, operationCount: 1 });
    expect(response.sources[0]?.files[0]).toEqual({
      path: join(worktree, "src/affected.ts"),
      operations: [
        {
          type: "edit",
          op: "update",
          timestamp: "2026-08-01T10:00:01.000Z",
          sessionId: "root",
          patch: "@@ -1 +1 @@\n-before\n+after",
          additions: 1,
          deletions: 1,
        },
      ],
    });
  });

  it("marks tracked-call eviction as partial instead of silently suppressing a result", async () => {
    const directory = await temporaryDirectory();
    const worktree = join(directory, "worktree");
    const sessionPath = join(directory, "root.jsonl");
    const records: unknown[] = Array.from({ length: 1025 }, (_, index) =>
      call(
        `edit-${index}`,
        "edit",
        { input: `[file-${index}.ts#ABCD]\nPUT >1:\n+x` },
        "2026-08-01T10:00:00.000Z",
      ),
    );
    records.push(result("edit-0", "edit", { op: "update", diff: "+x" }, "2026-08-01T10:00:01.000Z"));
    await writeJsonl(sessionPath, records);

    await expect(
      collectSessionFileChanges({
        sessionId: "root",
        sources: [{ sessionId: "root", root: worktree, sessionPath }],
      }),
    ).resolves.toMatchObject({ state: "partial", operationCount: 0 });
  });

  it("replaces a tracked call at capacity without evicting another call", async () => {
    const directory = await temporaryDirectory();
    const worktree = join(directory, "worktree");
    const sessionPath = join(directory, "root.jsonl");
    const records: unknown[] = Array.from({ length: 1024 }, (_, index) =>
      call(
        `edit-${index}`,
        "edit",
        { input: `[original-${index}.ts#ABCD]\nPUT >1:\n+x` },
        "2026-08-01T10:00:00.000Z",
      ),
    );
    records.push(
      call("edit-0", "edit", { input: "[replacement.ts#ABCD]\nPUT >1:\n+x" }, "2026-08-01T10:00:00.000Z"),
      result("edit-0", "edit", { op: "update", diff: "+x" }, "2026-08-01T10:00:01.000Z"),
    );
    await writeJsonl(sessionPath, records);

    const response = await collectSessionFileChanges({
      sessionId: "root",
      sources: [{ sessionId: "root", root: worktree, sessionPath }],
    });
    expect(response).toMatchObject({ state: "available", operationCount: 1 });
    expect(response.sources[0]?.files[0]?.path).toBe(join(worktree, "replacement.ts"));
  });

  it("marks unreadable root unavailable and unreadable descendants partial", async () => {
    const directory = await temporaryDirectory();
    const root: SessionFileChangeSourceDescriptor = {
      sessionId: "root",
      root: join(directory, "worktree"),
      sessionPath: join(directory, "missing-root.jsonl"),
    };
    await expect(collectSessionFileChanges({ sessionId: "root", sources: [root] })).resolves.toMatchObject({
      state: "unavailable",
      sources: [],
    });
    await writeJsonl(root.sessionPath, [
      call("edit", "edit", { input: "[ok.ts#ABCD]\nPUT >1:\n+x" }, "2026-08-01T10:00:00.000Z"),
      result("edit", "edit", { diff: "+x" }, "2026-08-01T10:00:01.000Z"),
    ]);
    const descendant = { ...root, sessionId: "child", sessionPath: join(directory, "missing-child.jsonl") };

    await expect(
      collectSessionFileChanges({ sessionId: "root", sources: [root, descendant] }),
    ).resolves.toMatchObject({ state: "partial", fileCount: 1, operationCount: 1 });
  });

  it("bounds full-response serialization while trimming aggregate metadata", async () => {
    const directory = await temporaryDirectory();
    const worktree = join(directory, "worktree");
    const sessionPath = join(directory, "root.jsonl");
    const records: unknown[] = [];
    for (let index = 0; index < 500; index += 1) {
      const id = `write-${index}`;
      const path = `src/${index}-${"x".repeat(4_000)}.txt`;
      const timestamp = new Date(Date.UTC(2026, 7, 1, 10, 0, 0, index)).toISOString();
      records.push(call(id, "write", { path, content: "x" }, timestamp), result(id, "write", {}, timestamp));
    }
    await writeJsonl(sessionPath, records);
    const stringify = vi.spyOn(JSON, "stringify");

    const response = await collectSessionFileChanges({
      sessionId: "root",
      sources: [{ sessionId: "root", root: worktree, sessionPath }],
    });

    const fullResponseSerializations = stringify.mock.calls.filter(([value]) => {
      return typeof value === "object" && value !== null && "sources" in value && "operationCount" in value;
    });
    expect(fullResponseSerializations).toHaveLength(2);
    expect(response.state).toBe("partial");
    expect(response.operationCount).toBeLessThan(500);
    expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(4 * 1024 * 1024);
  });

  it("stops before mutations beyond the aggregate history byte budget", async () => {
    const directory = await temporaryDirectory();
    const worktree = join(directory, "worktree");
    const sessionPath = join(directory, "root.jsonl");
    const trackedCall = call(
      "late",
      "edit",
      { input: "[late.ts#ABCD]\nPUT >1:\n+x" },
      "2026-08-01T10:00:00.000Z",
    );
    const lateResult = result("late", "edit", { diff: "+x" }, "2026-08-01T10:00:01.000Z");
    await writeFile(
      sessionPath,
      `${JSON.stringify(trackedCall)}\n${"x".repeat(17 * 1024 * 1024)}\n${JSON.stringify(lateResult)}\n`,
      "utf8",
    );

    await expect(
      collectSessionFileChanges({
        sessionId: "root",
        sources: [{ sessionId: "root", root: worktree, sessionPath }],
      }),
    ).resolves.toMatchObject({ state: "partial", operationCount: 0 });
  });

  it("keeps a complete history available when it exactly fills the aggregate history byte budget", async () => {
    const directory = await temporaryDirectory();
    const worktree = join(directory, "worktree");
    const sessionPath = join(directory, "root.jsonl");
    const descendantPath = join(directory, "descendant.jsonl");
    const records = [
      call("write", "write", { path: "exact.txt", content: "x" }, "2026-08-01T10:00:00.000Z"),
      result("write", "write", { resolvedPath: join(worktree, "exact.txt") }, "2026-08-01T10:00:01.000Z"),
    ];
    const prefix = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
    const historyBudgetBytes = 16 * 1024 * 1024;
    const maximumPaddingLineBytes = 1024 * 1024;
    const paddingFrame = '{"padding":""}\n';
    const chunks = [prefix];
    let remainingBytes = historyBudgetBytes - Buffer.byteLength(prefix);
    while (remainingBytes > 0) {
      const lineBytes = Math.min(remainingBytes, maximumPaddingLineBytes);
      chunks.push(`{"padding":"${"x".repeat(lineBytes - Buffer.byteLength(paddingFrame))}"}\n`);
      remainingBytes -= lineBytes;
    }
    const history = chunks.join("");
    expect(Buffer.byteLength(history)).toBe(historyBudgetBytes);
    await writeFile(sessionPath, history, "utf8");
    await writeFile(descendantPath, "", "utf8");

    await expect(
      collectSessionFileChanges({
        sessionId: "root",
        sources: [
          { sessionId: "root", root: worktree, sessionPath },
          { sessionId: "descendant", root: worktree, sessionPath: descendantPath },
        ],
      }),
    ).resolves.toMatchObject({ state: "available", operationCount: 1 });
  });

  it("omits oversized patches while retaining operation metadata and bounds the aggregate response", async () => {
    const directory = await temporaryDirectory();
    const worktree = join(directory, "worktree");
    const sessionPath = join(directory, "root.jsonl");
    const individuallyOversized = `+${"x".repeat(256 * 1024)}`;
    const aggregatePatch = `+${"y".repeat(240 * 1024)}`;
    const records: unknown[] = [
      call("huge", "edit", { input: "[huge.ts#ABCD]\nPUT >1:\n+x" }, "2026-08-01T10:00:00.000Z"),
      result("huge", "edit", { diff: individuallyOversized }, "2026-08-01T10:00:01.000Z"),
    ];
    for (let index = 0; index < 18; index += 1) {
      records.push(
        call(
          `edit-${index}`,
          "edit",
          { input: `[file-${index}.ts#ABCD]\nPUT >1:\n+y` },
          `2026-08-01T10:01:${String(index).padStart(2, "0")}.000Z`,
        ),
        result(
          `edit-${index}`,
          "edit",
          { diff: aggregatePatch },
          `2026-08-01T10:02:${String(index).padStart(2, "0")}.000Z`,
        ),
      );
    }
    await writeJsonl(sessionPath, records);

    const response = await collectSessionFileChanges({
      sessionId: "root",
      sources: [{ sessionId: "root", root: worktree, sessionPath }],
    });

    expect(response.state).toBe("partial");
    expect(response.operationCount).toBe(19);
    expect(response.sources[0]?.files.find((file) => file.path.endsWith("huge.ts"))?.operations[0]).toEqual(
      expect.objectContaining({ type: "edit", additions: 0, deletions: 0 }),
    );
    expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(
      response.sources[0]?.files
        .flatMap((file) => file.operations)
        .some((operation) => (operation.type === "edit" ? operation.patch === undefined : false)),
    ).toBe(true);
  });

  it("shares operation and retained-patch budgets across sources", async () => {
    const directory = await temporaryDirectory();
    const patch = `+${"bounded".repeat(114)}`;
    const sources: SessionFileChangeSourceDescriptor[] = [];
    for (let sourceIndex = 0; sourceIndex < 2; sourceIndex += 1) {
      const root = join(directory, `worktree-${sourceIndex}`);
      const sessionPath = join(directory, `session-${sourceIndex}.jsonl`);
      const records: unknown[] = [];
      for (let index = 0; index < 2001; index += 1) {
        const id = `edit-${sourceIndex}-${index}`;
        const timestamp = new Date(Date.UTC(2026, 7, 1, 10, 0, 0, index)).toISOString();
        records.push(
          call(id, "edit", { input: `[file-${index}.ts#ABCD]\nPUT >1:\n+x` }, timestamp),
          result(id, "edit", { op: "update", diff: patch }, timestamp),
        );
      }
      await writeJsonl(sessionPath, records);
      sources.push({ sessionId: `session-${sourceIndex}`, root, sessionPath });
    }

    const response = await collectSessionFileChanges({ sessionId: "session-0", sources });

    expect(response).toMatchObject({ state: "partial", operationCount: 4000 });
    expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(
      response.sources
        .flatMap((source) => source.files)
        .flatMap((file) => file.operations)
        .some((operation) => operation.type === "edit" && operation.patch === undefined),
    ).toBe(true);
  });

  it("drops overlong JSONL records without unbounded retention", async () => {
    const directory = await temporaryDirectory();
    const sessionPath = join(directory, "root.jsonl");
    await writeFile(sessionPath, `${"x".repeat(1024 * 1024 + 1)}\n`, "utf8");

    await expect(
      collectSessionFileChanges({
        sessionId: "root",
        sources: [{ sessionId: "root", root: directory, sessionPath }],
      }),
    ).resolves.toMatchObject({ state: "partial", operationCount: 0 });
  });
});
