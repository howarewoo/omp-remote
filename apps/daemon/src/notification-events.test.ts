import { describe, expect, it } from "vitest";
import { type AskRequest, type Session } from "@omp-remote/protocol";
import { findNotificationEvents, NotificationEventTracker } from "./notification-events.js";

const baseSession: Session = {
  id: "root",
  source: "extension",
  name: "Root session",
  cwd: "/workspace/project",
  branch: null,
  status: "running",
  connected: true,
  model: null,
  effort: null,
  contextPercent: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  lastActivity: "2026-08-01T00:00:00.000Z",
  capabilities: ["prompt"],
  messages: [],
  sessionPath: "/workspace/project/root.jsonl",
  activeSubagents: [],
  skillCommands: [],
};

const askRequest: AskRequest = {
  kind: "text",
  sessionId: "root",
  requestId: "ask-1",
  title: "Which option?",
  options: [],
  initialValue: null,
  expiresAt: null,
};

function session(patch: Partial<Session>): Session {
  return { ...baseSession, ...patch };
}

describe("findNotificationEvents", () => {
  it("emits one rich Ask event with current text, stable tag, and same-origin link", () => {
    const event = findNotificationEvents([baseSession], [baseSession], [], [askRequest]);
    expect(event).toEqual([
      expect.objectContaining({
        event: "inputRequired",
        title: "Input required",
        body: "Root session is waiting for input.",
        tag: "session-root-ask-ask-1",
        url: "/?session=root",
      }),
    ]);
  });

  it("gives a new Ask precedence over the matching waiting transition", () => {
    const waiting = session({ status: "waiting" });
    expect(findNotificationEvents([baseSession], [waiting], [], [askRequest])).toEqual([
      expect.objectContaining({ tag: "session-root-ask-ask-1" }),
    ]);
    expect(findNotificationEvents([baseSession], [waiting], [askRequest], [askRequest])).toEqual([]);
  });

  it("emits running-to-idle exactly once and avoids duplicate Ask identities", () => {
    const idle = session({ status: "idle" });
    expect(findNotificationEvents([baseSession], [idle])).toEqual([
      expect.objectContaining({ event: "sessionIdle", tag: "session-root-idle" }),
    ]);
    expect(findNotificationEvents([baseSession], [baseSession], [askRequest], [askRequest])).toEqual([]);
  });

  it("filters disconnected, history, and non-root sessions", () => {
    const child = session({
      id: "child",
      sessionPath: "/workspace/project/root/child.jsonl",
      activeSubagents: [],
      status: "waiting",
    });
    const rootWithChild = session({
      activeSubagents: [{ id: "child", name: "Child", lastActivity: baseSession.lastActivity }],
    });
    expect(
      findNotificationEvents(
        [rootWithChild, session({ ...child, status: "running" })],
        [rootWithChild, child],
      ),
    ).toEqual([]);
    expect(findNotificationEvents([baseSession], [session({ status: "waiting", connected: false })])).toEqual(
      [],
    );
    expect(
      findNotificationEvents(
        [baseSession],
        [session({ status: "waiting", source: "history", connected: true })],
      ),
    ).toEqual([]);
  });
});

describe("NotificationEventTracker", () => {
  it("retains an Ask observed before its session until a live root appears", () => {
    const tracker = new NotificationEventTracker();
    const unrelatedSession = session({ id: "unrelated", sessionPath: "/workspace/unrelated.jsonl" });
    expect(tracker.observeSessions([unrelatedSession])).toEqual([]);
    expect(tracker.observeAsk(askRequest)).toEqual([]);
    expect(tracker.observeSessions([unrelatedSession, baseSession])).toHaveLength(1);
    expect(tracker.observeSessions([unrelatedSession, baseSession])).toEqual([]);
    expect(tracker.observeAsk(askRequest)).toEqual([]);
    tracker.clearAsk("root", "ask-1");
    expect(tracker.observeAsk(askRequest)).toHaveLength(1);
  });
});
