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
  lastActivity: "2026-07-28T17:00:00.000Z",
  capabilities: ["prompt", "steer", "follow_up", "abort", "resume"],
  messages: [],
  sessionPath: "/work/.omp/session.jsonl",
};

describe("SessionRegistry", () => {
  it("replaces a streaming message without duplicating it", () => {
    const registry = new SessionRegistry();
    registry.upsert(BASE_SESSION);

    registry.appendMessage("session-1", {
      id: "message-1",
      role: "assistant",
      text: "Work",
      timestamp: "2026-07-28T17:01:00.000Z",
      streaming: true,
    });
    registry.appendMessage("session-1", {
      id: "message-1",
      role: "assistant",
      text: "Work complete",
      timestamp: "2026-07-28T17:01:01.000Z",
      streaming: false,
    });

    expect(registry.get("session-1")?.messages).toEqual([
      expect.objectContaining({ id: "message-1", text: "Work complete", streaming: false }),
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
    });

    expect(registry.get("session-1")?.messages).toHaveLength(0);
  });
});
