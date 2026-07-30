import type { Session } from "@omp-remote/protocol";
import { describe, expect, it } from "vitest";
import { findSessionNotifications } from "./session-notifications.js";

const BASE_SESSION: Session = {
  id: "session-1",
  source: "extension",
  name: "Notification work",
  cwd: "/work/omp-remote",
  branch: "change/session-notifications",
  status: "running",
  connected: true,
  model: "openai/gpt-5.6",
  contextPercent: 12,
  createdAt: "2026-07-30T12:00:00.000Z",
  lastActivity: "2026-07-30T12:01:00.000Z",
  capabilities: ["prompt", "steer", "follow_up", "abort"],
  messages: [],
  sessionPath: "/work/.omp/session.jsonl",
  activeSubagents: [],
  skillCommands: [],
};

describe("findSessionNotifications", () => {
  it("notifies when a running session becomes idle", () => {
    expect(findSessionNotifications([BASE_SESSION], [{ ...BASE_SESSION, status: "idle" }])).toEqual([
      {
        title: "Session idle",
        body: "Notification work finished and is idle.",
        tag: "session-session-1-idle",
      },
    ]);
  });

  it("notifies whenever a connected session starts waiting for input", () => {
    expect(findSessionNotifications([BASE_SESSION], [{ ...BASE_SESSION, status: "waiting" }])).toEqual([
      {
        title: "Input required",
        body: "Notification work is waiting for input.",
        tag: "session-session-1-waiting",
      },
    ]);
  });

  it("does not notify for snapshots, repeated states, new sessions, history, or disconnected sessions", () => {
    expect(findSessionNotifications(null, [BASE_SESSION])).toEqual([]);
    expect(findSessionNotifications([BASE_SESSION], [BASE_SESSION])).toEqual([]);
    expect(
      findSessionNotifications([BASE_SESSION], [{ ...BASE_SESSION, id: "new-session", status: "waiting" }]),
    ).toEqual([]);
    expect(
      findSessionNotifications(
        [{ ...BASE_SESSION, source: "history" }],
        [{ ...BASE_SESSION, source: "history", status: "idle" }],
      ),
    ).toEqual([]);
    expect(
      findSessionNotifications(
        [{ ...BASE_SESSION, connected: false }],
        [{ ...BASE_SESSION, connected: false, status: "idle" }],
      ),
    ).toEqual([]);
  });

  it("falls back to the working directory when a session has no name", () => {
    const unnamed = { ...BASE_SESSION, name: null };

    expect(findSessionNotifications([unnamed], [{ ...unnamed, status: "waiting" }])[0]?.body).toBe(
      "/work/omp-remote is waiting for input.",
    );
  });
});
