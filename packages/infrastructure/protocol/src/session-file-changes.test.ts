import { describe, expect, it } from "vitest";
import { SessionFileChangesResponseSchema, SessionFileWriteOperationSchema } from "./index.js";
describe("SessionFileChangesResponseSchema", () => {
  const response = {
    sessionId: "root-session",
    state: "available" as const,
    sources: [
      {
        sessionId: "root-session",
        root: "/worktree/a",
        files: [
          {
            path: "/worktree/a/src/app.ts",
            operations: [
              {
                type: "edit" as const,
                timestamp: "2026-08-01T10:00:00.000Z",
                op: "update" as const,
                sessionId: "root-session",
                patch: "@@ -1 +1 @@\n-old\n+new",
                additions: 1,
                deletions: 1,
              },
              {
                type: "write" as const,
                timestamp: "2026-08-01T10:01:00.000Z",
                sessionId: "root-session",
                resolvedPath: "/worktree/a/src/app.ts",
                byteCount: 12,
                additions: 0,
              },
            ],
          },
        ],
      },
      {
        sessionId: "child-session",
        root: "/worktree/b",
        files: [
          {
            path: "/worktree/b/src/app.ts",
            operations: [
              {
                type: "edit" as const,
                timestamp: "2026-08-01T10:02:00.000Z",
                sessionId: "child-session",
                additions: 0,
                deletions: 0,
              },
            ],
          },
        ],
      },
    ],
    fileCount: 2,
    operationCount: 3,
    additions: 1,
    deletions: 1,
    changedLines: 2,
    message: null,
  };

  it("retains separate session/worktree identities and write byte metadata", () => {
    const parsed = SessionFileChangesResponseSchema.parse(response);
    expect(parsed.sources.map((source) => [source.sessionId, source.root])).toEqual([
      ["root-session", "/worktree/a"],
      ["child-session", "/worktree/b"],
    ]);
    expect(parsed.sources[0]?.files[0]?.operations[1]).toEqual({
      type: "write",
      timestamp: "2026-08-01T10:01:00.000Z",
      sessionId: "root-session",
      resolvedPath: "/worktree/a/src/app.ts",
      byteCount: 12,
      additions: 0,
    });
  });
  it("validates retained write snapshots with exact line and UTF-8 byte counts", () => {
    const source = response.sources[0]!;
    const file = source.files[0]!;
    const write = {
      type: "write" as const,
      timestamp: "2026-08-01T10:01:00.000Z",
      sessionId: "root-session",
      resolvedPath: "/worktree/a/src/app.ts",
      byteCount: 3,
      snapshot: "é\n",
      additions: 1,
    };
    const valid = {
      ...response,
      sources: [
        { ...source, files: [{ ...file, operations: [file.operations[0], write] }] },
        response.sources[1],
      ],
      operationCount: 3,
      additions: 2,
      changedLines: 3,
    };
    expect(
      SessionFileChangesResponseSchema.safeParse({
        ...valid,
        sources: [
          {
            ...valid.sources[0],
            files: [
              {
                ...valid.sources[0]!.files[0],
                operations: [{ ...write, byteCount: 0, snapshot: "", additions: 0 }],
              },
            ],
          },
          valid.sources[1],
        ],
        additions: 0,
        deletions: 0,
        operationCount: 2,
        changedLines: 0,
      }).success,
    ).toBe(true);
    expect(SessionFileChangesResponseSchema.safeParse(valid).success).toBe(true);

    const emptyLineMismatch = SessionFileWriteOperationSchema.safeParse({
      ...write,
      byteCount: 0,
      snapshot: "",
      additions: 1,
    });
    expect(emptyLineMismatch.success).toBe(false);
    if (!emptyLineMismatch.success) {
      expect(emptyLineMismatch.error.issues.map((issue) => issue.message)).toEqual([
        "Write additions must match the retained snapshot",
      ]);
    }

    const omittedLineMismatch = SessionFileWriteOperationSchema.safeParse({
      ...write,
      snapshot: undefined,
      additions: 1,
    });
    expect(omittedLineMismatch.success).toBe(false);
    if (!omittedLineMismatch.success) {
      expect(omittedLineMismatch.error.issues.map((issue) => issue.message)).toEqual([
        "Write additions must match the retained snapshot",
      ]);
    }

    const byteCountMismatch = SessionFileWriteOperationSchema.safeParse({
      ...write,
      byteCount: 2,
    });
    expect(byteCountMismatch.success).toBe(false);
    if (!byteCountMismatch.success) {
      expect(byteCountMismatch.error.issues.map((issue) => issue.message)).toEqual([
        "Write byteCount must match the retained snapshot",
      ]);
    }
  });

  it("compares operation timestamps chronologically rather than lexically", () => {
    const firstFile = response.sources[0]!.files[0]!;
    const invalid = {
      ...response,
      sources: [
        {
          ...response.sources[0],
          files: [
            {
              ...firstFile,
              operations: [
                { ...firstFile.operations[0], timestamp: "2026-08-01T10:00:00.1Z" },
                { ...firstFile.operations[1], timestamp: "2026-08-01T10:00:00Z" },
              ],
            },
          ],
        },
        response.sources[1],
      ],
    };

    expect(SessionFileChangesResponseSchema.safeParse(invalid).success).toBe(false);
  });

  it.each([
    ["incorrect totals", { ...response, operationCount: 2 }],
    [
      "internal session history paths",
      {
        ...response,
        sources: [{ ...response.sources[0], sessionPath: "/host/.omp/agent/sessions/root.jsonl" }],
        fileCount: 1,
        operationCount: 2,
      },
    ],
    [
      "duplicate source identities",
      {
        ...response,
        sources: [...response.sources, { ...response.sources[0] }],
        fileCount: 3,
        operationCount: 5,
      },
    ],
    [
      "non-chronological operations",
      {
        ...response,
        sources: [
          {
            ...response.sources[0],
            files: [
              {
                ...response.sources[0]!.files[0],
                operations: [...response.sources[0]!.files[0]!.operations].reverse(),
              },
            ],
          },
          response.sources[1],
        ],
      },
    ],
    [
      "line totals without a retained patch",
      {
        ...response,
        sources: [
          {
            ...response.sources[0],
            files: [
              {
                ...response.sources[0]!.files[0],
                operations: [
                  {
                    type: "edit",
                    timestamp: "2026-08-01T10:00:00.000Z",
                    sessionId: "root-session",
                    additions: 1,
                    deletions: 1,
                  },
                ],
              },
            ],
          },
        ],
        fileCount: 1,
        operationCount: 1,
      },
    ],
    ["files in an unavailable response", { ...response, state: "unavailable", message: "unreadable" }],
    [
      "write content",
      {
        ...response,
        sources: [
          {
            ...response.sources[0],
            files: [
              {
                ...response.sources[0]!.files[0],
                operations: [
                  {
                    ...response.sources[0]!.files[0]!.operations[1],
                    content: "secret",
                  },
                ],
              },
            ],
          },
        ],
        fileCount: 1,
        operationCount: 1,
        additions: 0,
        deletions: 0,
        changedLines: 0,
      },
    ],
  ])("rejects %s", (_name, invalid) => {
    expect(SessionFileChangesResponseSchema.safeParse(invalid).success).toBe(false);
  });
});
