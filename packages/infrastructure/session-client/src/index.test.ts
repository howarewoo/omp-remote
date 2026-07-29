import type { Session } from "@omp-remote/protocol";
import { describe, expect, it } from "vitest";
import { upsertTranscriptMessage } from "./index.js";

const SESSION: Session = {
  id: "session-1",
  source: "rpc",
  name: "Stream test",
  cwd: "/tmp/stream-test",
  status: "running",
  connected: true,
  model: "openai/gpt-5.6",
  contextPercent: 12,
  createdAt: "2026-07-28T21:00:00.000Z",
  lastActivity: "2026-07-28T22:00:00.000Z",
  capabilities: ["prompt", "steer", "follow_up", "abort", "resume"],
  messages: [
    {
      id: "message-1",
      role: "assistant",
      text: "Starting",
      timestamp: "2026-07-28T22:01:00.000Z",
      streaming: true,
    },
  ],
  sessionPath: "/tmp/session.jsonl",
  activeSubagents: [],
};

describe("upsertTranscriptMessage", () => {
  it("replaces a streaming message in place and advances session activity", () => {
    const sessions = upsertTranscriptMessage([SESSION], "session-1", {
      id: "message-1",
      role: "assistant",
      text: "Streaming complete",
      timestamp: "2026-07-28T22:01:02.000Z",
      streaming: false,
    });

    expect(sessions[0]).toMatchObject({
      lastActivity: "2026-07-28T22:01:02.000Z",
      messages: [{ id: "message-1", text: "Streaming complete", streaming: false }],
    });
    expect(SESSION.messages[0]?.text).toBe("Starting");
  });

  it("leaves unrelated sessions referentially stable", () => {
    const other = { ...SESSION, id: "session-2" };
    const sessions = upsertTranscriptMessage([SESSION, other], "session-1", {
      id: "message-2",
      role: "assistant",
      text: "Next chunk",
      timestamp: "2026-07-28T22:01:03.000Z",
      streaming: true,
    });

    expect(sessions[1]).toBe(other);
    expect(sessions[0]?.messages).toHaveLength(2);
  });
});
