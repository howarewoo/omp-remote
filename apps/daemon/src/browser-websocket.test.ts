import { describe, expect, it, vi } from "vitest";
import { type AskRequest } from "@omp-remote/protocol";
import { type WebSocket } from "ws";
import {
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
