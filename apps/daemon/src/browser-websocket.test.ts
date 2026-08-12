import { type AskRequest, ServerFrameSchema, type Session } from "@omp-remote/protocol";
import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { MAX_BROWSER_BUFFERED_BYTES } from "./browser-broadcast.js";
import {
  browserSnapshotSessions,
  pendingAskRequestsForBrowserSnapshot,
  removeBrowserSocket,
  respondToPendingAsk,
} from "./browser-websocket.js";

const pendingAsk: AskRequest = {
  kind: "text",
  sessionId: "root",
  requestId: "ask-1",
  title: "Which option?",
  options: [],
  initialValue: null,
  expiresAt: null,
};

describe("browser WebSocket snapshot", () => {
  it("sends only connected sessions with bounded metadata", () => {
    const base: Session = {
      id: "live",
      source: "extension",
      name: "Live",
      cwd: "/tmp/live",
      branch: "main",
      status: "idle",
      connected: true,
      model: null,
      contextPercent: null,
      createdAt: "2026-08-01T00:00:00.000Z",
      lastActivity: "2026-08-01T00:00:00.000Z",
      capabilities: [],
      messages: [
        {
          id: "message",
          role: "user",
          text: "private",
          timestamp: "2026-08-01T00:00:00.000Z",
          streaming: false,
          presentation: "text",
        },
      ],
      sessionPath: null,
      activeSubagents: [],
      skillCommands: [],
    };

    const child = { ...base, id: "child", parentSessionId: "missing-parent" };
    expect(browserSnapshotSessions([base, child, { ...base, id: "offline", connected: false }])).toEqual([
      { ...base, messages: [] },
      { ...child, messages: [] },
    ]);
  });

  it("turns an oversized transcript snapshot into a parseable bounded frame without dropping other state", () => {
    const oversizedSession: Session = {
      id: "oversized",
      source: "extension",
      name: "Oversized",
      cwd: "/tmp/oversized",
      branch: "main",
      status: "running",
      connected: true,
      model: null,
      contextPercent: null,
      createdAt: "2026-08-01T00:00:00.000Z",
      lastActivity: "2026-08-01T00:00:00.000Z",
      capabilities: [],
      messages: [
        {
          id: "large-message",
          role: "assistant",
          text: "x".repeat(MAX_BROWSER_BUFFERED_BYTES + 1),
          timestamp: "2026-08-01T00:00:00.000Z",
          streaming: false,
          presentation: "text",
        },
      ],
      sessionPath: null,
      activeSubagents: [],
      skillCommands: [],
    };
    const original = JSON.stringify({
      type: "snapshot",
      sessions: [oversizedSession],
      askRequests: [pendingAsk],
      savedWorkingDirectories: ["/tmp/work"],
    });
    const bounded = JSON.stringify({
      type: "snapshot",
      sessions: browserSnapshotSessions([oversizedSession]),
      askRequests: [pendingAsk],
      savedWorkingDirectories: ["/tmp/work"],
    });

    expect(Buffer.byteLength(original, "utf8")).toBeGreaterThan(MAX_BROWSER_BUFFERED_BYTES);
    expect(Buffer.byteLength(bounded, "utf8")).toBeLessThan(MAX_BROWSER_BUFFERED_BYTES);
    expect(ServerFrameSchema.parse(JSON.parse(bounded))).toMatchObject({
      sessions: [{ id: oversizedSession.id, messages: [] }],
      askRequests: [pendingAsk],
      savedWorkingDirectories: ["/tmp/work"],
    });
  });
});

describe("browser WebSocket Ask lifecycle", () => {
  it("retains an admitted extension Ask when the last browser disconnects for reconnect", () => {
    const socket = {};
    const browserSockets = new Set([socket]);
    const pendingAskBySession = new Map([
      [pendingAsk.sessionId, { request: pendingAsk, source: "extension" as const, timeout: undefined }],
    ]);
    removeBrowserSocket(browserSockets, socket);

    expect(browserSockets).toEqual(new Set());
    expect(pendingAskRequestsForBrowserSnapshot(pendingAskBySession)).toEqual([pendingAsk]);
  });

  it("answers the retained extension Ask from a later browser response exactly once", async () => {
    const send = vi.fn();
    const extensionSocket = { readyState: 1, send } as unknown as WebSocket;
    const pendingAskBySession = new Map([
      [pendingAsk.sessionId, { request: pendingAsk, source: "extension" as const, timeout: undefined }],
    ]);
    const clearPendingAsk = vi.fn((sessionId: string, requestId?: string) => {
      if (pendingAskBySession.get(sessionId)?.request.requestId === requestId) {
        pendingAskBySession.delete(sessionId);
      }
    });
    const response = await respondToPendingAsk(
      {
        type: "ask_response",
        requestId: "browser-response-1",
        sessionId: pendingAsk.sessionId,
        askRequestId: pendingAsk.requestId,
        response: { value: "PostgreSQL" },
      },
      {
        pendingAskBySession,
        rpcSessions: new Map(),
        extensionSockets: new Map([[pendingAsk.sessionId, extensionSocket]]),
        clearPendingAsk,
      },
    );

    expect(response).toEqual({ ok: true });
    expect(send).toHaveBeenCalledOnce();
    expect(JSON.parse(send.mock.calls[0]?.[0] as string)).toEqual({
      command: "ask_response",
      requestId: pendingAsk.requestId,
      response: { value: "PostgreSQL" },
    });
    expect(clearPendingAsk).toHaveBeenCalledOnce();
    expect(pendingAskBySession).toEqual(new Map());
  });
});
