import type { Session } from "@omp-remote/protocol";
import { describe, expect, it } from "vitest";
import { formatSubagentActivityLabel, groupSessionsByConnection } from "./dashboard.js";

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
  activeSubagents: [],
};

describe("groupSessionsByConnection", () => {
  it("lists connected sessions before disconnected sessions while preserving their order", () => {
    const sessions = [
      { ...BASE_SESSION, id: "disconnected-new", connected: false, status: "disconnected" as const },
      { ...BASE_SESSION, id: "connected-new" },
      { ...BASE_SESSION, id: "connected-old" },
      { ...BASE_SESSION, id: "disconnected-old", connected: false, status: "history" as const },
    ];

    expect(groupSessionsByConnection(sessions)).toEqual([
      {
        id: "connected",
        label: "Connected",
        sessions: [sessions[1], sessions[2]],
      },
      {
        id: "disconnected",
        label: "Disconnected",
        sessions: [sessions[0], sessions[3]],
      },
    ]);
  });

  it("omits empty connection sections", () => {
    expect(groupSessionsByConnection([BASE_SESSION])).toEqual([
      {
        id: "connected",
        label: "Connected",
        sessions: [BASE_SESSION],
      },
    ]);
  });
});

describe("formatSubagentActivityLabel", () => {
  it.each([
    [1, "1 subagent running"],
    [3, "3 subagents running"],
  ])("formats %i active subagents", (count, expected) => {
    expect(formatSubagentActivityLabel(count)).toBe(expected);
  });
});
