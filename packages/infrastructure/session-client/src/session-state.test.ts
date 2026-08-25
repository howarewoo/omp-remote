import type {
  ApplicationErrorRecord,
  ApplicationErrorStorageHealth,
  AskRequest,
  Session,
} from "@omp-remote/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  addApplicationErrorRecord,
  clearApplicationErrorsLedger,
  deduplicateAndSortApplicationErrors,
  loadApplicationErrorsLedger,
  overlaySessionCosts,
  patchSession,
  removeAskRequest,
  upsertAskRequest,
} from "./index.js";
const SESSION: Session = {
  id: "session-1",
  source: "rpc",
  name: "Stream test",
  cwd: "/tmp/stream-test",
  branch: "feature/streaming",
  status: "running",
  connected: true,
  model: "openai/gpt-5.6",
  contextPercent: 12,
  createdAt: "2026-07-28T21:00:00.000Z",
  lastActivity: "2026-07-28T22:00:00.000Z",
  capabilities: ["prompt", "steer", "follow_up", "abort", "resume"],
  messages: [],
  sessionPath: "/tmp/session.jsonl",
  activeSubagents: [],
  skillCommands: [],
};

describe("patchSession", () => {
  it("updates only the targeted metadata while preserving stable references", () => {
    const other = {
      ...SESSION,
      id: "session-2",
      name: "Unrelated session",
      messages: [],
    };
    const original = [SESSION, other];

    const sessions = patchSession(original, "session-1", {
      name: "Updated session",
      status: "idle",
    });

    expect(SESSION).toMatchObject({
      name: "Stream test",
      status: "running",
    });
    expect(sessions).not.toBe(original);
    expect(sessions[0]).toEqual({
      ...SESSION,
      name: "Updated session",
      status: "idle",
    });
    expect(sessions[0]).not.toBe(SESSION);
    expect(sessions[0]?.messages).toBe(SESSION.messages);
    expect(sessions[1]).toBe(other);
  });

  it("applies explicit parent topology patches including a proven root", () => {
    const child = patchSession([SESSION], "session-1", { parentSessionId: "parent-session" })[0];
    const root = patchSession([child!], "session-1", { parentSessionId: null })[0];

    expect(child?.parentSessionId).toBe("parent-session");
    expect(root?.parentSessionId).toBeNull();
  });

  it("applies model catalog and effort updates from the host", () => {
    const sessions = patchSession([SESSION], "session-1", {
      model: "anthropic/claude-opus-4.7",
      effort: "max",
      availableModels: [
        {
          provider: "anthropic",
          id: "claude-opus-4.7",
          name: "Claude Opus 4.7",
          efforts: ["low", "medium", "high", "max"],
        },
      ],
    });

    expect(sessions[0]).toMatchObject({
      model: "anthropic/claude-opus-4.7",
      effort: "max",
      availableModels: [{ provider: "anthropic", id: "claude-opus-4.7" }],
    });
  });

  it("propagates live cost summary updates", () => {
    const costSummary = {
      totalUsd: 1.75,
      partial: true,
      agents: [
        {
          sessionId: "session-1",
          name: "Stream test",
          parentSessionId: null,
          totalUsd: 1.75,
          available: true,
        },
      ],
    };
    const sessions = patchSession([SESSION], "session-1", { costSummary });
    expect(sessions[0]?.costSummary).toEqual(costSummary);
  });

  it("returns the original array when the session ID is absent", () => {
    const sessions = [SESSION];

    expect(patchSession(sessions, "missing-session", { status: "idle" })).toBe(sessions);
  });
});

describe("overlaySessionCosts", () => {
  it("restores the selected exact summary after a metadata-only source replacement", () => {
    const costSummary = {
      totalUsd: 2.5,
      partial: false,
      agents: [
        {
          sessionId: SESSION.id,
          name: SESSION.name ?? SESSION.id,
          parentSessionId: null,
          totalUsd: 2.5,
          available: true,
        },
      ],
    };
    const replacement = { ...SESSION };
    const overlaid = overlaySessionCosts([replacement], new Map([[SESSION.id, costSummary]]));

    expect(overlaid[0]).toEqual({ ...replacement, costSummary });
    expect(overlaid[0]).not.toBe(replacement);
  });

  it("removes a stale summary only when the selected response is explicitly unavailable", () => {
    const withCost = {
      ...SESSION,
      costSummary: { totalUsd: 1, partial: false, agents: [] },
    };
    expect(overlaySessionCosts([withCost], new Map([[SESSION.id, null]]))[0]?.costSummary).toBeUndefined();
    const unchanged = [SESSION];
    expect(overlaySessionCosts(unchanged, new Map())).toBe(unchanged);
  });
});

describe("remote ask request state", () => {
  const firstRequest: AskRequest = {
    sessionId: "session-1",
    requestId: "ask-1",
    kind: "select",
    title: "Which database?",
    options: ["SQLite", "PostgreSQL"],
    initialValue: null,
    expiresAt: null,
  };

  it("replaces the active request for a session in place", () => {
    const otherRequest = { ...firstRequest, sessionId: "session-2", requestId: "ask-2" };
    const nextRequest = {
      ...firstRequest,
      requestId: "ask-3",
      kind: "text" as const,
      title: "Type another answer",
      options: [],
    };

    expect(upsertAskRequest([firstRequest, otherRequest], nextRequest)).toEqual([nextRequest, otherRequest]);
  });

  it("removes only the matching request", () => {
    const newerRequest = { ...firstRequest, requestId: "ask-2" };

    expect(removeAskRequest([newerRequest], "session-1", "ask-1")).toEqual([newerRequest]);
    expect(removeAskRequest([newerRequest], "session-1", "ask-2")).toEqual([]);
  });
});

describe("application errors client support", () => {
  const sampleError: ApplicationErrorRecord = {
    id: "err-test-1",
    timestamp: "2026-08-16T12:00:00.000Z",
    source: "browser",
    severity: "error",
    message: "Test browser error",
  };

  const sampleHealth: ApplicationErrorStorageHealth = {
    status: "healthy",
    recordCount: 1,
    totalBytes: 128,
    oldestTimestamp: "2026-08-16T12:00:00.000Z",
    newestTimestamp: "2026-08-16T12:00:00.000Z",
    degradedReason: null,
  };

  it("sorts application errors newest first and deduplicates", () => {
    const older: ApplicationErrorRecord = {
      ...sampleError,
      id: "err-older",
      timestamp: "2026-08-16T11:00:00.000Z",
    };
    const newer: ApplicationErrorRecord = {
      ...sampleError,
      id: "err-newer",
      timestamp: "2026-08-16T13:00:00.000Z",
    };
    const duplicate: ApplicationErrorRecord = { ...newer, message: "Updated newer" };

    const result = deduplicateAndSortApplicationErrors([older, newer, duplicate]);
    expect(result).toHaveLength(2);
    expect(result[0]?.id).toBe("err-newer");
    expect(result[0]?.message).toBe("Updated newer");
    expect(result[1]?.id).toBe("err-older");
  });

  it("adds record preserving deduplication and newest-first order", () => {
    const initial = [sampleError];
    const newer: ApplicationErrorRecord = {
      ...sampleError,
      id: "err-2",
      timestamp: "2026-08-16T13:00:00.000Z",
    };
    const added = addApplicationErrorRecord(initial, newer);
    expect(added).toEqual([newer, sampleError]);
  });

  it("loads and parses application errors ledger", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        errors: [sampleError],
        health: sampleHealth,
      }),
    });
    const ledger = await loadApplicationErrorsLedger(undefined, fetcher as unknown as typeof fetch);
    expect(ledger.errors).toHaveLength(1);
    expect(ledger.health.status).toBe("healthy");
  });

  it("clears application errors ledger via DELETE", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, clearedCount: 1 }),
    });
    const result = await clearApplicationErrorsLedger(fetcher as unknown as typeof fetch);
    expect(result).toEqual({ ok: true, clearedCount: 1 });
  });
});
