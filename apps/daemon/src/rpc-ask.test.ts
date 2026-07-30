import { describe, expect, it } from "vitest";
import { normalizeRpcAskEvent } from "./rpc-ask.js";

describe("normalizeRpcAskEvent", () => {
  it("normalizes a selector request and computes its deadline", () => {
    expect(
      normalizeRpcAskEvent(
        "session-1",
        {
          type: "extension_ui_request",
          id: "ask-1",
          method: "select",
          title: "Which database?",
          options: ["SQLite", "PostgreSQL"],
          timeout: 30_000,
        },
        Date.parse("2026-07-30T10:00:00.000Z"),
      ),
    ).toEqual({
      type: "request",
      request: {
        sessionId: "session-1",
        requestId: "ask-1",
        kind: "select",
        title: "Which database?",
        options: ["SQLite", "PostgreSQL"],
        initialValue: null,
        expiresAt: "2026-07-30T10:00:30.000Z",
      },
    });
  });

  it("normalizes the ask tool's custom editor request", () => {
    expect(
      normalizeRpcAskEvent("session-1", {
        type: "extension_ui_request",
        id: "ask-2",
        method: "editor",
        title: "Type another answer",
        prefill: "Existing answer",
        promptStyle: true,
      }),
    ).toEqual({
      type: "request",
      request: {
        sessionId: "session-1",
        requestId: "ask-2",
        kind: "text",
        title: "Type another answer",
        options: [],
        initialValue: "Existing answer",
        expiresAt: null,
      },
    });
  });

  it("normalizes cancellation and ignores unrelated RPC UI methods", () => {
    expect(
      normalizeRpcAskEvent("session-1", {
        type: "extension_ui_request",
        id: "cancel-1",
        method: "cancel",
        targetId: "ask-1",
      }),
    ).toEqual({ type: "cancel", requestId: "ask-1" });
    expect(
      normalizeRpcAskEvent("session-1", {
        type: "extension_ui_request",
        id: "notify-1",
        method: "notify",
        message: "Waiting",
      }),
    ).toBeNull();
  });
});
