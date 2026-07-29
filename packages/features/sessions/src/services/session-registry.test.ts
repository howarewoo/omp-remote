import type { Session } from "@omp-remote/protocol";
import { describe, expect, it } from "vitest";
import { SessionRegistry } from "./session-registry.js";

const BASE_SESSION: Session = {
  id: "session-1",
  source: "rpc",
  name: "Bootstrap",
  cwd: "/work/omp-remote",
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
    const activeSubagent = snapshot?.activeSubagents[0];
    if (activeSubagent) activeSubagent.name = "mutated";

    expect(registry.get("session-1")?.messages).toHaveLength(0);
    expect(registry.get("session-1")?.activeSubagents[0]?.name).toBe("ResearchAgent");
  });
});
