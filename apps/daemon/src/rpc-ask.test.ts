import { describe, expect, it, vi } from "vitest";
import {
  clearAskInactivityTimeout,
  createAskInactivityTimeout,
  expireExtensionAsk,
  isAskResponseValid,
  normalizeRpcAskEvent,
  ownsCurrentExtensionSocket,
  releaseCurrentExtensionSocket,
  resetAskInactivityTimeout,
} from "./rpc-ask.js";

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

describe("isAskResponseValid", () => {
  const request = {
    sessionId: "session-1",
    requestId: "ask-1",
    kind: "rich" as const,
    questions: [
      {
        id: "database",
        question: "Which database?",
        options: [{ label: "SQLite" }, { label: "PostgreSQL" }],
        multi: false,
      },
    ],
    expiresAt: null,
  };

  it("accepts correlated rich submit, chat, and cancel responses", () => {
    expect(
      isAskResponseValid(request, {
        kind: "submit",
        results: [
          {
            id: "database",
            question: "Which database?",
            options: ["SQLite", "PostgreSQL"],
            multi: false,
            selectedOptions: ["PostgreSQL"],
            customInput: "",
            note: "For scale",
          },
        ],
      }),
    ).toBe(true);
    expect(isAskResponseValid(request, { kind: "chat" })).toBe(true);
    expect(isAskResponseValid(request, { cancelled: true })).toBe(true);
    expect(isAskResponseValid(request, { cancelled: true, timedOut: true })).toBe(false);
    expect(
      isAskResponseValid(request, {
        kind: "submit",
        results: [
          {
            id: "database",
            question: "Which database?",
            options: ["SQLite", "PostgreSQL"],
            multi: false,
            selectedOptions: [],
            customInput: "CockroachDB",
          },
        ],
      }),
    ).toBe(true);
  });

  it("rejects mismatched questions, option contracts, and single-select multiplicity", () => {
    const result = {
      id: "database",
      question: "Which database?",
      options: ["SQLite", "PostgreSQL"],
      multi: false,
      selectedOptions: ["SQLite"],
    };
    expect(
      isAskResponseValid(request, {
        kind: "submit",
        results: [{ ...result, id: "other" }],
      }),
    ).toBe(false);
    expect(
      isAskResponseValid(request, {
        kind: "submit",
        results: [{ ...result, options: ["SQLite"] }],
      }),
    ).toBe(false);
    expect(
      isAskResponseValid(request, {
        kind: "submit",
        results: [{ ...result, selectedOptions: ["SQLite", "PostgreSQL"] }],
      }),
    ).toBe(false);
    expect(
      isAskResponseValid(request, {
        kind: "submit",
        results: [{ ...result, customInput: "CockroachDB" }],
      }),
    ).toBe(false);
    expect(
      isAskResponseValid(request, {
        kind: "submit",
        results: [{ ...result, selectedOptions: [], customInput: "   " }],
      }),
    ).toBe(false);
    expect(
      isAskResponseValid(request, {
        kind: "submit",
        results: [{ ...result, selectedOptions: [] }],
      }),
    ).toBe(false);
    expect(
      isAskResponseValid(request, {
        kind: "submit",
        results: [{ ...result, selectedOptions: [], timedOut: true }],
      }),
    ).toBe(true);
  });
});

describe("extension ask socket ownership", () => {
  it("rejects a superseded socket and ignores its close without releasing the replacement", () => {
    const staleSocket = { id: "stale" };
    const currentSocket = { id: "current" };
    const sessionBySocket = new Map([
      [staleSocket, "session-1"],
      [currentSocket, "session-1"],
    ]);
    const socketBySession = new Map([["session-1", currentSocket]]);

    expect(ownsCurrentExtensionSocket(staleSocket, "session-1", sessionBySocket, socketBySession)).toBe(
      false,
    );
    expect(ownsCurrentExtensionSocket(currentSocket, "session-1", sessionBySocket, socketBySession)).toBe(
      true,
    );
    expect(releaseCurrentExtensionSocket(staleSocket, sessionBySocket, socketBySession)).toBeNull();
    expect(socketBySession.get("session-1")).toBe(currentSocket);
    expect(sessionBySocket.get(currentSocket)).toBe("session-1");
  });

  it("releases only the current socket", () => {
    const socket = { id: "current" };
    const sessionBySocket = new Map([[socket, "session-1"]]);
    const socketBySession = new Map([["session-1", socket]]);

    expect(releaseCurrentExtensionSocket(socket, sessionBySocket, socketBySession)).toBe("session-1");
    expect(sessionBySocket.size).toBe(0);
    expect(socketBySession.size).toBe(0);
  });
});

describe("ask inactivity timeout", () => {
  it("resets the full original inactivity duration for exact activity", () => {
    vi.useFakeTimers();
    try {
      const onExpire = vi.fn();
      const timeout = createAskInactivityTimeout(
        "session-1",
        "ask-1",
        "1970-01-01T00:00:00.100Z",
        onExpire,
        0,
      );

      vi.advanceTimersByTime(75);
      expect(resetAskInactivityTimeout(timeout, "session-1", "ask-1", onExpire)).toBe(true);
      vi.advanceTimersByTime(75);
      expect(onExpire).not.toHaveBeenCalled();
      vi.advanceTimersByTime(25);
      expect(onExpire).toHaveBeenCalledTimes(1);
      clearAskInactivityTimeout(timeout);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores activity for a different session or request", () => {
    vi.useFakeTimers();
    try {
      const onExpire = vi.fn();
      const timeout = createAskInactivityTimeout(
        "session-1",
        "ask-1",
        "1970-01-01T00:00:00.100Z",
        onExpire,
        0,
      );

      vi.advanceTimersByTime(50);
      expect(resetAskInactivityTimeout(timeout, "session-2", "ask-1", onExpire)).toBe(false);
      expect(resetAskInactivityTimeout(timeout, "session-1", "ask-2", onExpire)).toBe(false);
      vi.advanceTimersByTime(50);
      expect(onExpire).toHaveBeenCalledTimes(1);
      clearAskInactivityTimeout(timeout);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("extension ask expiry", () => {
  it("returns a correlated timed-out response before clearing the pending ask", () => {
    const calls: string[] = [];
    const sendResponse = vi.fn(() => calls.push("response"));
    const clearPending = vi.fn(() => calls.push("clear"));

    expireExtensionAsk("session-1", "ask-1", sendResponse, clearPending);

    expect(sendResponse).toHaveBeenCalledWith("session-1", "ask-1", {
      cancelled: true,
      timedOut: true,
    });
    expect(clearPending).toHaveBeenCalledWith("session-1", "ask-1");
    expect(calls).toEqual(["response", "clear"]);
  });
});
