import type { Session, SessionPatch } from "@omp-remote/protocol";
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
  skillCommands: [],
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
    const skillCommands: Session["skillCommands"] = [
      { name: "skill:seo", description: "Inspect search visibility" },
    ];

    const updated = registry.update("session-1", {
      status: "running",
      capabilities,
      activeSubagents,
      skillCommands,
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
      skillCommands: [{ name: "skill:seo", description: "Inspect search visibility" }],
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
    const callerSkillCommand = skillCommands[0];
    if (!callerSubagent || !callerSkillCommand) {
      throw new Error("Expected caller-owned mutable metadata");
    }
    capabilities.push("kill");
    callerSubagent.name = "Caller mutation";
    callerSkillCommand.description = "Caller mutation";

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
    const returnedSkillCommand = updated.skillCommands[0];
    if (!returnedSubagent || !returnedSkillCommand) {
      throw new Error("Expected returned mutable metadata");
    }
    updated.capabilities.push("resume");
    returnedSubagent.name = "Returned mutation";
    returnedSkillCommand.description = "Returned mutation";

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
    expect(skillCommands[0]?.description).toBe("Caller mutation");

    if (!emittedPatch?.capabilities || !emittedPatch.activeSubagents || !emittedPatch.skillCommands) {
      throw new Error("Expected a session update with mutable metadata arrays");
    }
    const emittedSubagent = emittedPatch.activeSubagents[0];
    const emittedSkillCommand = emittedPatch.skillCommands[0];
    if (!emittedSubagent || !emittedSkillCommand) {
      throw new Error("Expected emitted mutable metadata");
    }
    emittedPatch.capabilities.push("resume");
    emittedSubagent.name = "Emitted mutation";
    emittedSkillCommand.description = "Emitted mutation";

    expect(registry.get("session-1")).toEqual({
      ...BASE_SESSION,
      ...expectedPatch,
      messages: [existingMessage],
    });

    const snapshot = registry.get("session-1");
    snapshot?.capabilities.push("kill");
    if (snapshot?.activeSubagents[0]) snapshot.activeSubagents[0].name = "Snapshot mutation";
    if (snapshot?.skillCommands[0]) snapshot.skillCommands[0].description = "Snapshot mutation";

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
      skillCommands: [{ name: "skill:seo", description: "Emitted mutation" }],
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
    const activeSubagent = snapshot?.activeSubagents[0];
    if (activeSubagent) activeSubagent.name = "mutated";

    expect(registry.get("session-1")?.messages).toHaveLength(0);
    expect(registry.get("session-1")?.activeSubagents[0]?.name).toBe("ResearchAgent");
  });
});
