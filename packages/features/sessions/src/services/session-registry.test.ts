import {
  type Session,
  type SessionPatch,
  TRANSCRIPT_IMAGE_MAX_BYTES,
  TRANSCRIPT_TEXT_LIMIT,
} from "@omp-remote/protocol";
import { describe, expect, it } from "vitest";
import { SessionRegistry } from "./session-registry.js";

const BASE_SESSION: Session = {
  id: "session-1",
  source: "rpc",
  name: "Bootstrap",
  cwd: "/work/omp-remote",
  branch: "feature/session-header",
  status: "idle",
  connected: true,
  model: "openai/gpt-5.6",
  contextPercent: 12,
  createdAt: "2026-07-28T16:00:00.000Z",
  lastActivity: "2026-07-28T17:00:00.000Z",
  capabilities: ["prompt", "steer", "follow_up", "abort", "resume"],
  messages: [],
  sessionPath: "/work/.omp/session.jsonl",
  activeSubagents: [
    {
      id: "subagent-1",
      name: "ResearchAgent",
      lastActivity: "2026-07-28T17:01:00.000Z",
    },
  ],
  costSummary: {
    totalUsd: 0.25,
    partial: false,
    agents: [
      { sessionId: "session-1", name: "Bootstrap", parentSessionId: null, totalUsd: 0.25, available: true },
    ],
  },
  composerCommands: [],
};

describe("SessionRegistry", () => {
  it("keeps newer sessions first when older sessions receive updates", () => {
    const registry = new SessionRegistry();
    registry.upsert({
      ...BASE_SESSION,
      id: "newer-session",
      createdAt: "2026-07-28T17:00:00.000Z",
      lastActivity: "2026-07-28T17:00:00.000Z",
    });
    registry.upsert({
      ...BASE_SESSION,
      id: "older-session",
      createdAt: "2026-07-28T16:00:00.000Z",
      lastActivity: "2026-07-28T18:00:00.000Z",
    });

    expect(registry.list().map((session) => session.id)).toEqual(["newer-session", "older-session"]);

    registry.update("older-session", { lastActivity: "2026-07-28T19:00:00.000Z" });

    expect(registry.list().map((session) => session.id)).toEqual(["newer-session", "older-session"]);
  });

  it("replaces a streaming message without duplicating it", () => {
    const registry = new SessionRegistry();
    registry.upsert(BASE_SESSION);

    registry.appendMessage("session-1", {
      id: "message-1",
      role: "assistant",
      text: "Work",
      timestamp: "2026-07-28T17:01:00.000Z",
      streaming: true,
      presentation: "text",
    });
    registry.appendMessage("session-1", {
      id: "message-1",
      role: "assistant",
      text: "Work complete",
      timestamp: "2026-07-28T17:01:01.000Z",
      streaming: false,
      presentation: "text",
    });

    expect(registry.get("session-1")?.messages).toEqual([
      expect.objectContaining({ id: "message-1", text: "Work complete", streaming: false }),
    ]);
  });

  it("preserves tool presentation metadata when replacing a streaming message", () => {
    const registry = new SessionRegistry();
    registry.upsert(BASE_SESSION);

    registry.appendMessage("session-1", {
      id: "edit-result-1",
      role: "tool",
      text: "-1|before",
      timestamp: "2026-07-29T12:00:00.000Z",
      streaming: true,
      presentation: "diff",
      toolName: "edit",
    });
    registry.appendMessage("session-1", {
      id: "edit-result-1",
      role: "tool",
      text: "-1|before\n+1|after",
      timestamp: "2026-07-29T12:00:01.000Z",
      streaming: false,
      presentation: "diff",
      toolName: "edit",
    });

    expect(registry.get("session-1")?.messages).toEqual([
      expect.objectContaining({
        id: "edit-result-1",
        role: "tool",
        text: "-1|before\n+1|after",
        streaming: false,
        presentation: "diff",
        toolName: "edit",
      }),
    ]);
  });

  it("emits transcript deltas instead of full session snapshots", () => {
    const registry = new SessionRegistry();
    registry.upsert(BASE_SESSION);
    const events: unknown[] = [];
    registry.subscribe((event) => events.push(event));

    registry.appendMessage("session-1", {
      id: "message-1",
      role: "assistant",
      text: "Live text",
      timestamp: "2026-07-28T17:01:00.000Z",
      streaming: true,
      presentation: "text",
    });

    expect(events).toEqual([
      {
        type: "transcript_upsert",
        sessionId: "session-1",
        message: expect.objectContaining({ id: "message-1", text: "Live text", streaming: true }),
      },
    ]);
  });

  it("bounds oversized transcript text on session upserts", () => {
    const registry = new SessionRegistry();
    const events: unknown[] = [];
    registry.subscribe((event) => events.push(event));
    const expectedText = `${"x".repeat(TRANSCRIPT_TEXT_LIMIT)}…`;

    const stored = registry.upsert({
      ...BASE_SESSION,
      messages: [
        {
          id: "oversized-upsert",
          role: "assistant",
          text: "x".repeat(TRANSCRIPT_TEXT_LIMIT + 1),
          timestamp: "2026-07-28T17:02:00.000Z",
          streaming: false,
          presentation: "text",
        },
      ],
    });

    expect(stored.messages[0]?.text).toBe(expectedText);
    expect(registry.get("session-1")?.messages[0]?.text).toBe(expectedText);
    expect(events).toEqual([
      {
        type: "session_upsert",
        session: expect.objectContaining({
          messages: [expect.objectContaining({ id: "oversized-upsert", text: expectedText })],
        }),
      },
    ]);
  });

  it("bounds appended and emitted text without splitting a surrogate pair", () => {
    const registry = new SessionRegistry();
    registry.upsert(BASE_SESSION);
    const events: unknown[] = [];
    registry.subscribe((event) => events.push(event));
    const expectedText = `${"x".repeat(TRANSCRIPT_TEXT_LIMIT - 1)}…`;

    const stored = registry.appendMessage("session-1", {
      id: "oversized-append",
      role: "tool",
      text: `${"x".repeat(TRANSCRIPT_TEXT_LIMIT - 1)}😀tail`,
      timestamp: "2026-07-28T17:03:00.000Z",
      streaming: true,
      presentation: "diff",
      toolName: "edit",
      readTarget: "src/App.tsx",
      readResolvedPath: "/work/omp-remote/src/App.tsx",
      toolTitle: "Edit App",
    });

    expect(stored?.messages).toEqual([
      {
        id: "oversized-append",
        role: "tool",
        text: expectedText,
        timestamp: "2026-07-28T17:03:00.000Z",
        streaming: true,
        presentation: "diff",
        toolName: "edit",
        readTarget: "src/App.tsx",
        readResolvedPath: "/work/omp-remote/src/App.tsx",
        toolTitle: "Edit App",
      },
    ]);
    expect(events).toEqual([
      {
        type: "transcript_upsert",
        sessionId: "session-1",
        message: expect.objectContaining({
          id: "oversized-append",
          text: expectedText,
          streaming: true,
          presentation: "diff",
          toolName: "edit",
        }),
      },
    ]);
    expect(expectedText.charCodeAt(expectedText.length - 2)).not.toBeGreaterThanOrEqual(0xd800);
  });

  it("retains only the latest 200 appended messages", () => {
    const registry = new SessionRegistry();
    registry.upsert(BASE_SESSION);

    for (let index = 0; index <= 200; index += 1) {
      registry.appendMessage("session-1", {
        id: `message-${index}`,
        role: "assistant",
        text: `${index}`,
        timestamp: "2026-07-28T17:04:00.000Z",
        streaming: false,
        presentation: "text",
      });
    }

    const messages = registry.get("session-1")?.messages;
    expect(messages).toHaveLength(200);
    expect(messages?.[0]?.id).toBe("message-1");
    expect(messages?.[199]?.id).toBe("message-200");
  });

  it("marks appended images beyond the retained session budget unavailable", () => {
    const registry = new SessionRegistry();
    const imageData = `${"A".repeat(Math.ceil(TRANSCRIPT_IMAGE_MAX_BYTES / 3) * 4 - 2)}==`;
    registry.upsert({
      ...BASE_SESSION,
      messages: Array.from({ length: 5 }, (_, index) => ({
        id: `retained-image-${index}`,
        role: "tool" as const,
        text: "image",
        timestamp: "2026-07-28T17:04:00.000Z",
        streaming: false,
        presentation: "text" as const,
        images: [{ status: "available" as const, mimeType: "image/png" as const, data: imageData }],
      })),
    });
    const events: unknown[] = [];
    registry.subscribe((event) => events.push(event));
    registry.appendMessage("session-1", {
      id: "overflow-image",
      role: "tool",
      text: "image",
      timestamp: "2026-07-28T17:04:00.000Z",
      streaming: false,
      presentation: "text",
      images: [{ status: "available", mimeType: "image/png", data: imageData }],
    });
    expect(
      registry
        .get("session-1")
        ?.messages.slice(-2)
        .map((message) => message.images?.[0]),
    ).toEqual([
      { status: "available", mimeType: "image/png", data: imageData },
      { status: "unavailable", reason: "budget_exceeded" },
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "transcript_upsert",
      message: { images: [{ status: "unavailable", reason: "budget_exceeded" }] },
    });
  });

  it("emits a detached metadata patch while retaining the complete session", () => {
    const registry = new SessionRegistry();
    const existingMessage: Session["messages"][number] = {
      id: "message-1",
      role: "assistant",
      text: "Keep me",
      timestamp: "2026-07-28T17:01:00.000Z",
      streaming: false,
      presentation: "text",
    };
    registry.upsert({ ...BASE_SESSION, messages: [existingMessage] });
    const events: unknown[] = [];
    let emittedPatch: SessionPatch | undefined;
    registry.subscribe((event) => {
      events.push(event);
      if (event.type === "session_update") emittedPatch = event.patch;
    });
    const capabilities: Session["capabilities"] = ["prompt", "abort"];
    const activeSubagents: Session["activeSubagents"] = [
      {
        id: "subagent-2",
        name: "PatchAgent",
        lastActivity: "2026-07-28T18:00:00.000Z",
      },
    ];
    const composerCommands: Session["composerCommands"] = [
      { name: "skill:seo", description: "Inspect search visibility" },
    ];

    const updated = registry.update("session-1", {
      status: "running",
      capabilities,
      activeSubagents,
      composerCommands,
    });

    const expectedPatch = {
      status: "running",
      capabilities: ["prompt", "abort"],
      activeSubagents: [
        {
          id: "subagent-2",
          name: "PatchAgent",
          lastActivity: "2026-07-28T18:00:00.000Z",
        },
      ],
      composerCommands: [{ name: "skill:seo", description: "Inspect search visibility" }],
    };
    expect(events).toEqual([
      {
        type: "session_update",
        sessionId: "session-1",
        patch: expectedPatch,
      },
    ]);
    expect(registry.get("session-1")).toEqual({
      ...BASE_SESSION,
      ...expectedPatch,
      messages: [existingMessage],
    });

    const callerSubagent = activeSubagents[0];
    const callerComposerCommand = composerCommands[0];
    if (!callerSubagent || !callerComposerCommand) {
      throw new Error("Expected caller-owned mutable metadata");
    }
    capabilities.push("kill");
    callerSubagent.name = "Caller mutation";
    callerComposerCommand.description = "Caller mutation";

    expect(events).toEqual([
      {
        type: "session_update",
        sessionId: "session-1",
        patch: expectedPatch,
      },
    ]);
    expect(registry.get("session-1")).toEqual({
      ...BASE_SESSION,
      ...expectedPatch,
      messages: [existingMessage],
    });

    if (!updated) throw new Error("Expected the updated session");
    const returnedSubagent = updated.activeSubagents[0];
    const returnedComposerCommand = updated.composerCommands[0];
    if (!returnedSubagent || !returnedComposerCommand) {
      throw new Error("Expected returned mutable metadata");
    }
    updated.capabilities.push("resume");
    returnedSubagent.name = "Returned mutation";
    returnedComposerCommand.description = "Returned mutation";

    expect(events).toEqual([
      {
        type: "session_update",
        sessionId: "session-1",
        patch: expectedPatch,
      },
    ]);
    expect(registry.get("session-1")).toEqual({
      ...BASE_SESSION,
      ...expectedPatch,
      messages: [existingMessage],
    });
    expect(capabilities).toEqual(["prompt", "abort", "kill"]);
    expect(activeSubagents[0]?.name).toBe("Caller mutation");
    expect(composerCommands[0]?.description).toBe("Caller mutation");

    if (!emittedPatch?.capabilities || !emittedPatch.activeSubagents || !emittedPatch.composerCommands) {
      throw new Error("Expected a session update with mutable metadata arrays");
    }
    const emittedSubagent = emittedPatch.activeSubagents[0];
    const emittedComposerCommand = emittedPatch.composerCommands[0];
    if (!emittedSubagent || !emittedComposerCommand) {
      throw new Error("Expected emitted mutable metadata");
    }
    emittedPatch.capabilities.push("resume");
    emittedSubagent.name = "Emitted mutation";
    emittedComposerCommand.description = "Emitted mutation";

    expect(registry.get("session-1")).toEqual({
      ...BASE_SESSION,
      ...expectedPatch,
      messages: [existingMessage],
    });

    const snapshot = registry.get("session-1");
    snapshot?.capabilities.push("kill");
    if (snapshot?.activeSubagents[0]) snapshot.activeSubagents[0].name = "Snapshot mutation";
    if (snapshot?.composerCommands[0]) snapshot.composerCommands[0].description = "Snapshot mutation";

    expect(emittedPatch).toEqual({
      ...expectedPatch,
      capabilities: ["prompt", "abort", "resume"],
      activeSubagents: [
        {
          id: "subagent-2",
          name: "Emitted mutation",
          lastActivity: "2026-07-28T18:00:00.000Z",
        },
      ],
      composerCommands: [{ name: "skill:seo", description: "Emitted mutation" }],
    });
    expect(registry.get("session-1")).toEqual({
      ...BASE_SESSION,
      ...expectedPatch,
      messages: [existingMessage],
    });
  });

  it("returns detached snapshots", () => {
    const registry = new SessionRegistry();
    registry.upsert(BASE_SESSION);
    const snapshot = registry.get("session-1");
    snapshot?.messages.push({
      id: "external",
      role: "system",
      text: "mutated",
      timestamp: "2026-07-28T17:02:00.000Z",
      streaming: false,
      presentation: "text",
    });
    const costAgent = snapshot?.costSummary?.agents[0];
    if (costAgent) costAgent.name = "mutated";
    const activeSubagent = snapshot?.activeSubagents[0];
    if (activeSubagent) activeSubagent.name = "mutated";

    expect(registry.get("session-1")?.messages).toHaveLength(0);
    expect(registry.get("session-1")?.activeSubagents[0]?.name).toBe("ResearchAgent");
    expect(registry.get("session-1")?.costSummary?.agents[0]?.name).toBe("Bootstrap");
  });
});
