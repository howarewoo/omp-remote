import { describe, expect, it } from "vitest";
import {
  ExtensionCommandSchema,
  ExtensionFrameSchema,
  ExtensionHeartbeatSchema,
  ExtensionRegisterSchema,
  ExtensionMetadataSchema,
  filterMainSessions,
  ServerFrameSchema,
  SessionCatalogPageSchema,
  SessionCostResponseSchema,
  SessionFileChangesResponseSchema,
  SessionFileWriteOperationSchema,
  SessionPatchSchema,
  SessionSchema,
  SessionTranscriptResponseSchema,
} from "./index.js";

describe("historical session schemas", () => {
  const historicalSession = {
    id: "session-history",
    source: "history",
    name: "Saved investigation",
    cwd: "/workspace/project",
    branch: "feature/session-header",
    status: "history",
    connected: false,
    model: null,
    contextPercent: null,
    createdAt: "2026-07-28T09:00:00.000Z",
    lastActivity: "2026-07-28T10:00:00.000Z",
    capabilities: ["resume"],
    messages: [],
    sessionPath: "/home/user/.omp/agent/sessions/project/session.jsonl",
    activeSubagents: [],
    skillCommands: [],
    costSummary: { totalUsd: 0, partial: true, agents: [] },
  };
  it("preserves legacy sessions without a cost summary", () => {
    const { costSummary: ignoredCostSummary, ...legacy } = historicalSession;
    void ignoredCostSummary;
    expect(SessionSchema.parse(legacy).costSummary).toBeUndefined();
  });

  it("accepts resumable historical sessions", () => {
    expect(SessionSchema.parse(historicalSession)).toEqual(historicalSession);
  });

  it("preserves discovered skill command metadata", () => {
    expect(
      SessionSchema.parse({
        ...historicalSession,
        skillCommands: [{ name: "skill:seo", description: "Audit search visibility" }],
      }).skillCommands,
    ).toEqual([{ name: "skill:seo", description: "Audit search visibility" }]);
  });

  it("preserves model choices and the active effort", () => {
    expect(
      SessionSchema.parse({
        ...historicalSession,
        source: "rpc",
        connected: true,
        status: "idle",
        model: "openai/gpt-5.6",
        effort: "high",
        capabilities: ["prompt", "model", "effort"],
        availableModels: [
          {
            provider: "openai",
            id: "gpt-5.6",
            name: "GPT-5.6",
            efforts: ["low", "medium", "high", "xhigh"],
            roles: ["default", "slow"],
            roleEfforts: { default: "high", slow: "xhigh" },
          },
        ],
      }),
    ).toMatchObject({
      effort: "high",
      availableModels: [
        {
          provider: "openai",
          id: "gpt-5.6",
          efforts: ["low", "medium", "high", "xhigh"],
          roles: ["default", "slow"],
          roleEfforts: { default: "high", slow: "xhigh" },
        },
      ],
    });
  });

  it("accepts active subagent activity on the main session", () => {
    expect(
      SessionSchema.parse({
        ...historicalSession,
        activeSubagents: [
          {
            id: "session-worker",
            name: "ResearchAgent",
            lastActivity: "2026-07-28T10:05:00.000Z",
          },
        ],
      }).activeSubagents,
    ).toEqual([
      {
        id: "session-worker",
        name: "ResearchAgent",
        lastActivity: "2026-07-28T10:05:00.000Z",
      },
    ]);
  });

  it("excludes sessions nested under a main agent", () => {
    const mainSession = SessionSchema.parse({
      ...historicalSession,
      id: "session-main",
      activeSubagents: [
        {
          id: "session-worker",
          name: "ResearchAgent",
          lastActivity: "2026-07-28T10:05:00.000Z",
        },
      ],
    });
    const workerSession = SessionSchema.parse({
      ...historicalSession,
      id: "session-worker",
      name: "ResearchAgent",
    });
    const unrelatedSession = SessionSchema.parse({
      ...historicalSession,
      id: "session-unrelated",
    });

    expect(
      filterMainSessions([mainSession, workerSession, unrelatedSession]).map((session) => session.id),
    ).toEqual(["session-main", "session-unrelated"]);
  });

  it("excludes active, historical, and recursively nested workers by session path", () => {
    const rootSession = SessionSchema.parse({
      ...historicalSession,
      id: "session-root",
      sessionPath: "/home/user/.omp/agent/sessions/project/root.jsonl",
      activeSubagents: [],
    });
    const activeWorker = SessionSchema.parse({
      ...historicalSession,
      id: "session-active-worker",
      source: "extension",
      status: "running",
      connected: true,
      sessionPath: "/home/user/.omp/agent/sessions/project/root/ActiveWorker.jsonl",
    });
    const historicalWorker = SessionSchema.parse({
      ...historicalSession,
      id: "session-historical-worker",
      sessionPath: "/home/user/.omp/agent/sessions/project/root/HistoricalWorker.jsonl",
    });
    const recursiveWorker = SessionSchema.parse({
      ...historicalSession,
      id: "session-recursive-worker",
      source: "extension",
      status: "idle",
      connected: true,
      sessionPath: "/home/user/.omp/agent/sessions/project/root/ActiveWorker/RecursiveWorker.jsonl",
    });
    const unrelatedSession = SessionSchema.parse({
      ...historicalSession,
      id: "session-unrelated",
      sessionPath: "/home/user/.omp/agent/sessions/project/unrelated.jsonl",
    });

    expect(
      filterMainSessions([
        rootSession,
        activeWorker,
        historicalWorker,
        recursiveWorker,
        unrelatedSession,
      ]).map((session) => session.id),
    ).toEqual(["session-root", "session-unrelated"]);
  });

  it("requires an exact nesting boundary and falls back to active IDs for null paths", () => {
    const rootSession = SessionSchema.parse({
      ...historicalSession,
      id: "session-root",
      sessionPath: "/home/user/.omp/agent/sessions/project/root.jsonl",
      activeSubagents: [
        {
          id: "session-null-path-worker",
          name: "LegacyWorker",
          lastActivity: "2026-07-28T10:05:00.000Z",
        },
      ],
    });
    const sharedPrefixSession = SessionSchema.parse({
      ...historicalSession,
      id: "session-shared-prefix",
      sessionPath: "/home/user/.omp/agent/sessions/project/root-worker/Worker.jsonl",
    });
    const unrelatedDirectorySession = SessionSchema.parse({
      ...historicalSession,
      id: "session-unrelated-directory",
      sessionPath: "/home/user/.omp/agent/sessions/other/root/Worker.jsonl",
    });
    const nullPathWorker = SessionSchema.parse({
      ...historicalSession,
      id: "session-null-path-worker",
      sessionPath: null,
    });
    const nullPathRoot = SessionSchema.parse({
      ...historicalSession,
      id: "session-null-path-root",
      sessionPath: null,
      activeSubagents: [
        {
          id: "session-path-worker",
          name: "PathWorker",
          lastActivity: "2026-07-28T10:05:00.000Z",
        },
      ],
    });
    const pathWorker = SessionSchema.parse({
      ...historicalSession,
      id: "session-path-worker",
      sessionPath: "/home/user/.omp/agent/sessions/legacy/PathWorker.jsonl",
    });

    expect(
      filterMainSessions([
        rootSession,
        sharedPrefixSession,
        unrelatedDirectorySession,
        nullPathWorker,
        nullPathRoot,
        pathWorker,
      ]).map((session) => session.id),
    ).toEqual([
      "session-root",
      "session-shared-prefix",
      "session-unrelated-directory",
      "session-null-path-root",
    ]);
  });

  it("uses explicit child topology even when the parent object is absent", () => {
    const connectedChild = SessionSchema.parse({
      ...historicalSession,
      id: "session-child",
      source: "extension",
      status: "waiting",
      connected: true,
      parentSessionId: "session-parent",
      sessionPath: null,
    });
    const explicitRoot = SessionSchema.parse({
      ...historicalSession,
      id: "session-root",
      parentSessionId: null,
    });

    expect(filterMainSessions([connectedChild]).map((session) => session.id)).toEqual([]);
    expect(filterMainSessions([explicitRoot, connectedChild]).map((session) => session.id)).toEqual([
      "session-root",
    ]);
  });

  it("uses canonical direct parent IDs for grandchildren", () => {
    const grandchild = SessionSchema.parse({
      ...historicalSession,
      id: "session-grandchild",
      parentSessionId: "session-child",
      sessionPath: null,
    });

    expect(filterMainSessions([grandchild]).map((session) => session.id)).toEqual([]);
  });

  it("lets explicit topology override the legacy loaded-set fallback", () => {
    const explicitRoot = SessionSchema.parse({
      ...historicalSession,
      id: "session-explicit-root",
      parentSessionId: null,
      activeSubagents: [
        {
          id: "session-explicit-child",
          name: "Child",
          lastActivity: historicalSession.lastActivity,
        },
      ],
    });
    const explicitChild = SessionSchema.parse({
      ...historicalSession,
      id: "session-explicit-child",
      parentSessionId: "session-explicit-root",
      sessionPath: "/home/user/.omp/agent/sessions/project/child.jsonl",
    });
    const pathRoot = SessionSchema.parse({
      ...historicalSession,
      id: "session-path-root",
      parentSessionId: null,
      sessionPath: "/home/user/.omp/agent/sessions/project/path-root.jsonl",
    });
    const pathChild = SessionSchema.parse({
      ...historicalSession,
      id: "session-path-child",
      parentSessionId: "session-path-root",
      sessionPath: "/home/user/.omp/agent/sessions/project/path-root/child.jsonl",
    });

    expect(
      filterMainSessions([explicitRoot, explicitChild, pathRoot, pathChild]).map((session) => session.id),
    ).toEqual(["session-explicit-root", "session-path-root"]);
  });

  it("validates bounded catalog pages", () => {
    expect(
      SessionCatalogPageSchema.parse({
        sessions: [historicalSession],
        total: 2,
        nextOffset: 1,
      }),
    ).toMatchObject({ total: 2, nextOffset: 1 });
  });

  it("validates on-demand transcript responses", () => {
    expect(
      SessionTranscriptResponseSchema.parse({
        sessionId: "session-history",
        messages: [
          {
            id: "message-1",
            role: "user",
            text: "Recover this session",
            timestamp: "2026-07-28T10:01:00.000Z",
            streaming: false,
          },
        ],
      }),
    ).toMatchObject({ sessionId: "session-history" });
  });

  it("validates exact and unavailable on-demand cost responses", () => {
    const exact = SessionCostResponseSchema.parse({
      sessionId: "session-history",
      costSummary: historicalSession.costSummary,
    });
    expect(exact.costSummary?.totalUsd).toBe(0);
    expect(
      SessionCostResponseSchema.parse({
        sessionId: "session-history",
        costSummary: null,
      }),
    ).toEqual({ sessionId: "session-history", costSummary: null });
    expect(() =>
      SessionCostResponseSchema.parse({
        sessionId: "session-history",
        costSummary: null,
        pending: true,
      }),
    ).toThrow();
  });
});

describe("ExtensionRegisterSchema", () => {
  const previousExtensionSession = {
    id: "session-extension",
    source: "extension",
    name: "Active investigation",
    cwd: "/workspace/project",
    status: "running",
    connected: true,
    model: "anthropic/claude-sonnet-4",
    contextPercent: 42,
    lastActivity: "2026-07-29T10:00:00.000Z",
    capabilities: ["prompt", "steer", "follow_up", "abort"],
    messages: [],
  };
  const currentExtensionSession = {
    ...previousExtensionSession,
    branch: "feature/session-header",
    createdAt: "2026-07-29T09:00:00.000Z",
  };

  it("normalizes the previous extension register without synthesizing resume", () => {
    expect(
      ExtensionRegisterSchema.parse({
        type: "register",
        session: previousExtensionSession,
      }),
    ).toEqual({
      type: "register",
      session: {
        ...previousExtensionSession,
        branch: null,
        activeSubagents: [],
        sessionPath: null,
        skillCommands: [],
      },
    });
  });

  it("preserves a current extension register with a nonempty sessionPath", () => {
    const sessionPath = "/home/user/.omp/agent/sessions/project/session.jsonl";

    expect(
      ExtensionRegisterSchema.parse({
        type: "register",
        session: { ...currentExtensionSession, sessionPath },
      }),
    ).toEqual({
      type: "register",
      session: { ...currentExtensionSession, activeSubagents: [], sessionPath, skillCommands: [] },
    });
  });

  it.each([
    ["an empty string", ""],
    ["the wrong type", 42],
  ])("rejects sessionPath with %s", (_label, sessionPath) => {
    const result = ExtensionRegisterSchema.safeParse({
      type: "register",
      session: { ...previousExtensionSession, sessionPath },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path)).toEqual([["session", "sessionPath"]]);
    }
  });

  it("keeps canonical sessions strict about omitted sessionPath", () => {
    const result = SessionSchema.safeParse(currentExtensionSession);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path)).toEqual([["sessionPath"]]);
    }
  });
  it("accepts skill command refreshes from extension heartbeats", () => {
    expect(
      ExtensionHeartbeatSchema.parse({
        type: "heartbeat",
        sessionId: "session-extension",
        name: "Active investigation",
        model: "anthropic/claude-sonnet-4",
        contextPercent: 42,
        idle: true,
        skillCommands: [{ name: "skill:seo", description: "Audit search visibility" }],
      }).skillCommands,
    ).toEqual([{ name: "skill:seo", description: "Audit search visibility" }]);
  });
});

describe("ExtensionMetadataSchema", () => {
  const valid = {
    type: "metadata",
    sessionId: "session-rpc-1",
    availableModels: [
      {
        provider: "openai",
        id: "gpt-5.6",
        name: "GPT-5.6",
        efforts: ["high"] as const,
        roles: ["default"],
        roleEfforts: { default: "high" as const },
      },
    ],
  };

  it("validates valid and invalid metadata frames", () => {
    expect(ExtensionMetadataSchema.parse(valid)).toEqual(valid);
    expect(ExtensionFrameSchema.parse(valid)).toEqual(valid);
    for (const frame of [
      { ...valid, sessionId: "" },
      { type: "metadata", availableModels: [] },
      { ...valid, availableModels: "invalid" },
      { ...valid, availableModels: [{ provider: "", id: "gpt-5.6", name: "GPT-5.6", efforts: [] }] },
      { ...valid, availableModels: [{ provider: "openai", id: "", name: "GPT-5.6", efforts: [] }] },
      { ...valid, availableModels: [{ provider: "openai", id: "gpt-5.6", name: "", efforts: [] }] },
      { ...valid, extra: true },
    ]) {
      expect(ExtensionMetadataSchema.safeParse(frame).success).toBe(false);
    }
  });
});

describe("ServerFrameSchema", () => {
  it("defaults saved working directories for legacy snapshots", () => {
    expect(
      ServerFrameSchema.parse({
        type: "snapshot",
        sessions: [],
      }),
    ).toEqual({
      type: "snapshot",
      sessions: [],
      askRequests: [],
      savedWorkingDirectories: [],
    });
  });

  it("accepts authoritative saved working directory updates", () => {
    expect(
      ServerFrameSchema.parse({
        type: "saved_working_directories",
        savedWorkingDirectories: ["/workspace/one", "  /workspace/two  "],
      }),
    ).toEqual({
      type: "saved_working_directories",
      savedWorkingDirectories: ["/workspace/one", "/workspace/two"],
    });
  });

  it("requires the created session ID in successful launch results", () => {
    expect(
      ServerFrameSchema.parse({
        type: "command_result",
        requestId: "launch-1",
        outcome: {
          status: "ok",
          value: { type: "launch", sessionId: "created-session" },
        },
      }),
    ).toEqual({
      type: "command_result",
      requestId: "launch-1",
      outcome: {
        status: "ok",
        value: { type: "launch", sessionId: "created-session" },
      },
    });

    expect(() =>
      ServerFrameSchema.parse({
        type: "command_result",
        requestId: "launch-1",
        outcome: { status: "ok", value: { type: "launch" } },
      }),
    ).toThrow();
  });

  it("represents successful commands without return values explicitly", () => {
    expect(
      ServerFrameSchema.parse({
        type: "command_result",
        requestId: "command-1",
        outcome: { status: "ok", value: { type: "void" } },
      }),
    ).toMatchObject({
      outcome: { status: "ok", value: { type: "void" } },
    });
  });

  it("accepts incremental transcript updates", () => {
    expect(
      ServerFrameSchema.parse({
        type: "transcript_upsert",
        sessionId: "session-1",
        message: {
          id: "message-1",
          role: "assistant",
          text: "Streaming now",
          timestamp: "2026-07-28T22:30:00.000Z",
          streaming: true,
        },
      }),
    ).toMatchObject({
      type: "transcript_upsert",
      sessionId: "session-1",
      message: { text: "Streaming now", streaming: true },
    });
  });

  it("accepts compact session metadata updates", () => {
    expect(
      ServerFrameSchema.parse({
        type: "session_update",
        sessionId: "session-1",
        patch: {
          status: "running",
          capabilities: ["prompt", "abort"],
        },
      }),
    ).toEqual({
      type: "session_update",
      sessionId: "session-1",
      patch: {
        status: "running",
        capabilities: ["prompt", "abort"],
      },
    });
  });

  it("accepts a remote ask request with an optional deadline", () => {
    expect(
      ServerFrameSchema.parse({
        type: "ask_request",
        request: {
          sessionId: "session-1",
          requestId: "ask-1",
          kind: "select",
          title: "Which database?",
          options: ["SQLite", "PostgreSQL"],
          initialValue: null,
          expiresAt: "2026-07-30T10:00:30.000Z",
        },
      }),
    ).toMatchObject({
      type: "ask_request",
      request: {
        kind: "select",
        options: ["SQLite", "PostgreSQL"],
      },
    });
  });

  it("accepts only the canonical extension ask activity shape", () => {
    expect(
      ExtensionFrameSchema.parse({
        type: "ask_activity",
        sessionId: "session-1",
        requestId: "ask-1",
      }),
    ).toEqual({
      type: "ask_activity",
      sessionId: "session-1",
      requestId: "ask-1",
    });
    expect(() =>
      ExtensionFrameSchema.parse({
        type: "ask_activity",
        sessionId: "session-1",
        askRequestId: "ask-1",
      }),
    ).toThrow();
  });

  it("preserves every native rich ask field across extension and browser frames", () => {
    const request = {
      sessionId: "session-1",
      requestId: "rich-ask-1",
      kind: "rich",
      questions: [
        {
          id: "database",
          question: "",
          header: "Storage",
          options: [
            { label: "SQLite", description: "Embedded", preview: "file:local.db" },
            { label: "PostgreSQL", description: "Server", preview: "postgres://…" },
          ],
          multi: true,
          recommended: 1,
        },
      ],
      expiresAt: "2026-07-30T10:00:30.000Z",
    };
    expect(ExtensionFrameSchema.parse({ type: "ask_request", request })).toEqual({
      type: "ask_request",
      request,
    });
    expect(ServerFrameSchema.parse({ type: "ask_request", request })).toEqual({
      type: "ask_request",
      request,
    });
    expect(
      ExtensionCommandSchema.parse({
        command: "ask_response",
        requestId: "rich-ask-1",
        response: {
          kind: "submit",
          results: [
            {
              id: "database",
              question: "",
              options: ["SQLite", "PostgreSQL"],
              multi: true,
              selectedOptions: ["PostgreSQL"],
              customInput: "CockroachDB",
              note: "Needs horizontal scaling",
            },
          ],
        },
      }),
    ).toMatchObject({ command: "ask_response", requestId: "rich-ask-1" });
  });

  it("rejects a recommended rich option outside the option list", () => {
    expect(() =>
      ServerFrameSchema.parse({
        type: "ask_request",
        request: {
          sessionId: "session-1",
          requestId: "rich-ask-1",
          kind: "rich",
          questions: [{ id: "q1", question: "Choose", options: [], recommended: 0 }],
          expiresAt: null,
        },
      }),
    ).toThrow();
  });

  it("accepts ask cancellation frames", () => {
    expect(
      ServerFrameSchema.parse({
        type: "ask_cancelled",
        sessionId: "session-1",
        requestId: "ask-1",
      }),
    ).toEqual({
      type: "ask_cancelled",
      sessionId: "session-1",
      requestId: "ask-1",
    });
  });
});

describe("SessionPatchSchema", () => {
  it.each([
    ["id", { id: "replacement-session" }],
    ["messages", { messages: [] }],
  ])("rejects an own %s key instead of stripping it", (_key, forbiddenField) => {
    expect(
      SessionPatchSchema.safeParse({
        status: "running",
        ...forbiddenField,
      }).success,
    ).toBe(false);
  });
});

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
