import type { Session } from "@omp-remote/protocol";
import { describe, expect, it, type Mock, vi } from "vitest";
import {
  loadSessionBranchTopology,
  loadSessionCost,
  loadSessionDetails,
  loadSessionFileChanges,
  loadSessionTranscript,
  upsertLoadedSession,
  useSessionClient,
} from "./index.js";

const hookHarness = vi.hoisted(() => ({
  effects: [] as Array<() => undefined | (() => void)>,
  stateSetters: [] as Mock[],
}));

vi.mock("react", () => ({
  useCallback: <T>(callback: T) => callback,
  useEffect: (effect: () => undefined | (() => void)) => {
    hookHarness.effects.push(effect);
  },
  useMemo: <T>(factory: () => T) => factory(),
  useRef: <T>(initialValue: T) => ({ current: initialValue }),
  useState: <T>(initialValue: T) => {
    const setter = vi.fn();
    hookHarness.stateSetters.push(setter);
    return [initialValue, setter] as const;
  },
}));

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
  messages: [
    {
      id: "message-1",
      role: "assistant",
      text: "Starting",
      timestamp: "2026-07-28T22:01:00.000Z",
      streaming: true,
      presentation: "text",
    },
  ],
  sessionPath: "/tmp/session.jsonl",
  activeSubagents: [],
  skillCommands: [],
};

describe("exact session details", () => {
  it("requests the encoded exact ID and validates response identity and failures", async () => {
    const loaded = {
      ...SESSION,
      id: "child/a",
      source: "history" as const,
      parentSessionId: "parent",
      messages: [],
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(loaded), {
        status: 200,
      }),
    );

    await expect(loadSessionDetails("child/a", undefined, fetcher)).resolves.toEqual(loaded);
    expect(fetcher).toHaveBeenCalledWith("/api/sessions/child%2Fa", {});

    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ ...loaded, id: "other" }), { status: 200 }));
    await expect(loadSessionDetails("child/a", undefined, fetcher)).rejects.toThrow(
      "Session details response did not match the request",
    );

    fetcher.mockResolvedValueOnce(new Response(null, { status: 404 }));
    await expect(loadSessionDetails("child/a", undefined, fetcher)).rejects.toThrow(
      "Session details request failed (404)",
    );
  });

  it("inserts saved sessions without losing topology, live metadata, or newer messages", () => {
    const currentHistory = {
      ...SESSION,
      id: "saved-child",
      source: "history" as const,
      parentSessionId: "parent",
      name: "Catalog summary",
      messages: [
        {
          ...SESSION.messages[0]!,
          id: "stream",
          text: "new streamed text",
          timestamp: "2026-08-02T00:00:02.000Z",
        },
      ],
    };
    const { parentSessionId: _ignoredParentSessionId, ...loadedMetadata } = currentHistory;
    void _ignoredParentSessionId;
    const loadedHistory = {
      ...loadedMetadata,
      name: "Exact saved child",
      messages: [
        {
          ...SESSION.messages[0]!,
          id: "saved",
          text: "saved text",
          timestamp: "2026-08-02T00:00:00.000Z",
          streaming: false,
        },
        {
          ...SESSION.messages[0]!,
          id: "stream",
          text: "stale streamed text",
          timestamp: "2026-08-02T00:00:01.000Z",
        },
      ],
    };

    expect(upsertLoadedSession([currentHistory], loadedHistory)[0]).toMatchObject({
      source: "history",
      name: "Exact saved child",
      parentSessionId: "parent",
      messages: [
        { id: "saved", text: "saved text" },
        { id: "stream", text: "new streamed text" },
      ],
    });

    const currentLive = {
      ...currentHistory,
      source: "extension" as const,
      name: "Live child",
      connected: true,
    };
    expect(upsertLoadedSession([currentLive], loadedHistory)[0]).toMatchObject({
      source: "extension",
      name: "Live child",
      connected: true,
      parentSessionId: "parent",
      messages: [
        { id: "saved", text: "saved text" },
        { id: "stream", text: "new streamed text" },
      ],
    });
  });

  it("owns cancellation independently from transcript loading and ignores a stale completion", async () => {
    hookHarness.effects.length = 0;
    hookHarness.stateSetters.length = 0;
    const requests = new Map<
      string,
      {
        resolve(response: Response): void;
        signal: AbortSignal | undefined;
      }
    >();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>((input, init) => {
        let resolve!: (response: Response) => void;
        const promise = new Promise<Response>((settle) => {
          resolve = settle;
        });
        requests.set(String(input), { resolve, signal: init?.signal ?? undefined });
        return promise;
      }),
    );

    try {
      const client = useSessionClient();
      const firstDetails = client.loadSession("child-a");
      const transcript = client.loadTranscript("root");
      const secondDetails = client.loadSession("child-b");

      expect(requests.get("/api/sessions/child-a")?.signal?.aborted).toBe(true);
      expect(requests.get("/api/sessions/root/transcript")?.signal?.aborted).toBe(false);
      expect(requests.get("/api/sessions/child-b")?.signal?.aborted).toBe(false);

      requests
        .get("/api/sessions/child-b")
        ?.resolve(
          new Response(
            JSON.stringify({ ...SESSION, id: "child-b", source: "history", parentSessionId: "root" }),
            { status: 200 },
          ),
        );
      await secondDetails;
      const historySetter = hookHarness.stateSetters[3];
      expect(historySetter).toHaveBeenCalledOnce();
      const insert = historySetter?.mock.calls[0]?.[0] as ((sessions: Session[]) => Session[]) | undefined;
      expect(insert?.([])).toEqual([
        expect.objectContaining({ id: "child-b", source: "history", parentSessionId: "root" }),
      ]);

      requests
        .get("/api/sessions/child-a")
        ?.resolve(
          new Response(
            JSON.stringify({ ...SESSION, id: "child-a", source: "history", parentSessionId: "root" }),
            { status: 200 },
          ),
        );
      await firstDetails;
      expect(historySetter).toHaveBeenCalledOnce();

      requests
        .get("/api/sessions/root/transcript")
        ?.resolve(new Response(JSON.stringify({ sessionId: "root", messages: [], status: "complete", olderCursor: null }), { status: 200 }));

      const cleanupDetails = client.loadSession("child-c");
      const cleanupTranscript = client.loadTranscript("cleanup-root");
      const cleanup = hookHarness.effects[1]?.();
      cleanup?.();
      expect(requests.get("/api/sessions/child-c")?.signal?.aborted).toBe(true);
      expect(requests.get("/api/sessions/cleanup-root/transcript")?.signal?.aborted).toBe(true);
      requests
        .get("/api/sessions/child-c")
        ?.resolve(
          new Response(
            JSON.stringify({ ...SESSION, id: "child-c", source: "history", parentSessionId: "root" }),
            { status: 200 },
          ),
        );
      requests.get("/api/sessions/cleanup-root/transcript")?.resolve(
        new Response(JSON.stringify({ sessionId: "cleanup-root", messages: [], status: "complete", olderCursor: null }), {
          status: 200,
        }),
      );
      await Promise.all([cleanupDetails, cleanupTranscript]);
      await transcript;
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("loadSessionTranscript", () => {
  it("validates response identity, cursor presence, and encodes query params", async () => {
    await expect(loadSessionTranscript("s1", "")).rejects.toThrow("Transcript cursor cannot be empty");
    const page = { messages: [], status: "complete", olderCursor: null };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ sessionId: "session-2", ...page })));
    await expect(loadSessionTranscript("session-1", undefined, undefined, fetcher)).rejects.toThrow(
      "Session transcript response did not match the request",
    );
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ sessionId: "s/a", ...page })));
    await loadSessionTranscript("s/a", "c+1", undefined, fetcher);
    expect(fetcher).toHaveBeenLastCalledWith("/api/sessions/s%2Fa/transcript?cursor=c%2B1", {});
  });
});

describe("loadSessionCost", () => {
  it("requests only the encoded selected session and validates the exact summary", async () => {
    const costSummary = {
      totalUsd: 1.25,
      partial: false,
      agents: [
        {
          sessionId: "session/a",
          name: "Selected",
          parentSessionId: null,
          totalUsd: 1.25,
          available: true,
        },
      ],
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ sessionId: "session/a", costSummary }), { status: 200 }),
      );

    await expect(loadSessionCost("session/a", undefined, fetcher)).resolves.toEqual({
      sessionId: "session/a",
      costSummary,
    });
    expect(fetcher).toHaveBeenCalledWith("/api/sessions/session%2Fa/cost", {});
  });

  it("preserves an explicit unavailable summary and reports request failures", async () => {
    const unavailableFetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ sessionId: "session-1", costSummary: null }), { status: 200 }),
      );
    await expect(loadSessionCost("session-1", undefined, unavailableFetcher)).resolves.toEqual({
      sessionId: "session-1",
      costSummary: null,
    });

    const failedFetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 500 }));
    await expect(loadSessionCost("session-1", undefined, failedFetcher)).rejects.toThrow(
      "Session cost request failed (500)",
    );
  });

  it("rejects a response for a different session", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ sessionId: "session-2", costSummary: null }), { status: 200 }),
      );
    await expect(loadSessionCost("session-1", undefined, fetcher)).rejects.toThrow(
      "Session cost response did not match the request",
    );
  });
});

describe("loadSessionBranchTopology", () => {
  const availableResponse = {
    sessionId: "session/a",
    branches: [{ name: "main" }, { name: "feature/child", parent: "main" }],
    currentBranch: "feature/child",
  };

  it("requests the encoded branches route and validates its schema", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(availableResponse), { status: 200 }));

    await expect(loadSessionBranchTopology("session/a", undefined, fetcher)).resolves.toEqual(
      availableResponse,
    );
    expect(fetcher).toHaveBeenCalledWith("/api/sessions/session%2Fa/branches", {});
  });

  it("passes the cancellation signal to fetch", async () => {
    const controller = new AbortController();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(availableResponse), { status: 200 }));

    await loadSessionBranchTopology("session/a", controller.signal, fetcher);
    expect(fetcher).toHaveBeenCalledWith("/api/sessions/session%2Fa/branches", {
      signal: controller.signal,
    });
  });

  it("propagates the exact host error text", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: "Cannot switch branches while the session is running." }), {
        status: 409,
      }),
    );

    await expect(loadSessionBranchTopology("session-1", undefined, fetcher)).rejects.toThrow(
      "Cannot switch branches while the session is running.",
    );
  });
  it("preserves an abort raised while reading a failed response", async () => {
    const controller = new AbortController();
    const abortFailure = new Error("Topology response read aborted");
    abortFailure.name = "AbortError";
    const response = {
      ok: false,
      status: 503,
      json: vi.fn().mockImplementation(async () => {
        controller.abort();
        throw abortFailure;
      }),
    } as unknown as Response;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);

    await expect(loadSessionBranchTopology("session-1", controller.signal, fetcher)).rejects.toBe(
      abortFailure,
    );
  });

  it("rejects a successful response that violates the topology schema", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ ...availableResponse, unexpected: true }), { status: 200 }),
      );

    await expect(loadSessionBranchTopology("session-1", undefined, fetcher)).rejects.toThrow();
  });
});

describe("loadSessionFileChanges", () => {
  const availableResponse = {
    sessionId: "session/a",
    state: "available",
    sources: [],
    fileCount: 0,
    operationCount: 0,
    additions: 0,
    deletions: 0,
    changedLines: 0,
    message: null,
  };

  it("requests the encoded changes route and validates its schema", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(availableResponse), { status: 200 }));

    await expect(loadSessionFileChanges("session/a", undefined, fetcher)).resolves.toEqual(availableResponse);
    expect(fetcher).toHaveBeenCalledWith("/api/sessions/session%2Fa/changes", {});
  });

  it("passes the cancellation signal to fetch", async () => {
    const controller = new AbortController();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(availableResponse), { status: 200 }));

    await loadSessionFileChanges("session/a", controller.signal, fetcher);
    expect(fetcher).toHaveBeenCalledWith("/api/sessions/session%2Fa/changes", {
      signal: controller.signal,
    });
  });

  it("propagates host errors before parsing an error body as a response", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: "Session file changes could not be read" }), {
        status: 500,
      }),
    );

    await expect(loadSessionFileChanges("session-1", undefined, fetcher)).rejects.toThrow(
      "Session file changes could not be read",
    );
  });

  it.each([
    ["non-JSON", new Response("<html>Bad gateway</html>", { status: 502 }), 502],
    [
      "unreadable",
      {
        ok: false,
        status: 503,
        json: vi.fn().mockRejectedValue(new Error("Response body is unavailable")),
      } as unknown as Response,
      503,
    ],
  ])("uses the status fallback for a %s non-OK response", async (_kind, response, status) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);

    await expect(loadSessionFileChanges("session-1", undefined, fetcher)).rejects.toThrow(
      `Session file changes request failed (${status})`,
    );
  });

  it("preserves cancellation when a non-OK response body read aborts", async () => {
    const controller = new AbortController();
    const abortFailure = new Error("Response body read aborted");
    abortFailure.name = "AbortError";
    const response = {
      ok: false,
      status: 503,
      json: vi.fn().mockImplementation(async () => {
        controller.abort();
        throw abortFailure;
      }),
    } as unknown as Response;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);

    await expect(loadSessionFileChanges("session-1", controller.signal, fetcher)).rejects.toBe(abortFailure);
  });
});
