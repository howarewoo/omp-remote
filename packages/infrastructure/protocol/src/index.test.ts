import { describe, expect, it } from "vitest";
import {
  BrowserCommandSchema,
  ExtensionRegisterSchema,
  SessionCatalogPageSchema,
  SessionSchema,
  SessionTranscriptResponseSchema,
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

describe("historical session schemas", () => {
  const historicalSession = {
    id: "session-history",
    source: "history",
    name: "Saved investigation",
    cwd: "/workspace/project",
    status: "history",
    connected: false,
    model: null,
    contextPercent: null,
    lastActivity: "2026-07-28T10:00:00.000Z",
    capabilities: ["resume"],
    messages: [],
    sessionPath: "/home/user/.omp/agent/sessions/project/session.jsonl",
  };

  it("accepts resumable historical sessions", () => {
    expect(SessionSchema.parse(historicalSession)).toEqual(historicalSession);
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
        sessionPath: null,
      },
    });
  });

  it("preserves a current extension register with a nonempty sessionPath", () => {
    const sessionPath = "/home/user/.omp/agent/sessions/project/session.jsonl";

    expect(
      ExtensionRegisterSchema.parse({
        type: "register",
        session: { ...previousExtensionSession, sessionPath },
      }),
    ).toEqual({
      type: "register",
      session: { ...previousExtensionSession, sessionPath },
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
    const result = SessionSchema.safeParse(previousExtensionSession);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path)).toEqual([["sessionPath"]]);
    }
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
});
