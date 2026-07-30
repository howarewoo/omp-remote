import { describe, expect, it } from "vitest";
import {
  BrowserCommandSchema,
  ExtensionRegisterSchema,
  ExtensionHeartbeatSchema,
  filterMainSessions,
  SessionCatalogPageSchema,
  SessionPatchSchema,
  SessionSchema,
  SessionTranscriptResponseSchema,
  TranscriptMessageSchema,
  ServerFrameSchema,
} from "./index.js";

describe("BrowserCommandSchema", () => {
  it("accepts RPC launch requests", () => {
    expect(
      BrowserCommandSchema.parse({
        type: "launch",
        requestId: "launch-1",
        cwd: "/workspace/project",
        resume: null,
      }),
    ).toEqual({
      type: "launch",
      requestId: "launch-1",
      cwd: "/workspace/project",
      resume: null,
    });
  });

  it.each([
    { command: "prompt", text: "Run the checks" },
    { command: "steer", text: "Focus on the API" },
    { command: "follow_up", text: "Then summarize" },
  ] as const)("accepts $command session commands", ({ command, text }) => {
    expect(
      BrowserCommandSchema.parse({
        type: "session_command",
        requestId: `${command}-1`,
        sessionId: "session-1",
        command,
        text,
      }),
    ).toMatchObject({ command, text });
  });

  it("accepts abort without command text", () => {
    expect(
      BrowserCommandSchema.parse({
        type: "session_command",
        requestId: "abort-1",
        sessionId: "session-1",
        command: "abort",
      }),
    ).toMatchObject({ command: "abort" });
  });

  it("accepts kill without command text", () => {
    expect(
      BrowserCommandSchema.parse({
        type: "session_command",
        requestId: "kill-1",
        sessionId: "session-1",
        command: "kill",
      }),
    ).toMatchObject({ command: "kill" });
  });

  it.each([
    { response: { value: "PostgreSQL" } },
    { response: { cancelled: true } },
    { response: { cancelled: true, timedOut: true } },
  ] as const)("accepts ask responses", ({ response }) => {
    expect(
      BrowserCommandSchema.parse({
        type: "ask_response",
        requestId: "dashboard-request-1",
        sessionId: "session-1",
        askRequestId: "ask-1",
        response,
      }),
    ).toMatchObject({ type: "ask_response", response });
  });

  it("rejects ambiguous ask responses", () => {
    expect(() =>
      BrowserCommandSchema.parse({
        type: "ask_response",
        requestId: "dashboard-request-1",
        sessionId: "session-1",
        askRequestId: "ask-1",
        response: { value: "PostgreSQL", cancelled: true },
      }),
    ).toThrow();
  });

  it("rejects empty non-abort commands", () => {
    expect(() =>
      BrowserCommandSchema.parse({
        type: "session_command",
        requestId: "prompt-1",
        sessionId: "session-1",
        command: "prompt",
        text: " ",
      }),
    ).toThrow();
  });
});

describe("TranscriptMessageSchema", () => {
  it("preserves structured edit diff presentation and tool identity", () => {
    expect(
      TranscriptMessageSchema.parse({
        id: "edit-result-1",
        role: "tool",
        text: "-1|before\n+1|after",
        timestamp: "2026-07-29T12:00:00.000Z",
        streaming: false,
        presentation: "diff",
        toolName: "edit",
      }),
    ).toEqual({
      id: "edit-result-1",
      role: "tool",
      text: "-1|before\n+1|after",
      timestamp: "2026-07-29T12:00:00.000Z",
      streaming: false,
      presentation: "diff",
      toolName: "edit",
    });
  });

  it("defaults legacy transcript frames to text presentation", () => {
    expect(
      TranscriptMessageSchema.parse({
        id: "legacy-message-1",
        role: "system",
        text: "Legacy extension output",
        timestamp: "2026-07-29T12:00:00.000Z",
        streaming: false,
      }),
    ).toEqual({
      id: "legacy-message-1",
      role: "system",
      text: "Legacy extension output",
      timestamp: "2026-07-29T12:00:00.000Z",
      streaming: false,
      presentation: "text",
    });
  });
});

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
  };

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
      sessionPath:
        "/home/user/.omp/agent/sessions/project/root/ActiveWorker/RecursiveWorker.jsonl",
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

describe("ServerFrameSchema", () => {
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
