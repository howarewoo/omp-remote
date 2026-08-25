import type { Session, SessionTranscriptResponse } from "@omp-remote/protocol";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { upsertTranscriptMessage, useSessionClient } from "./index.js";

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
  messages: [],
  sessionPath: "/tmp/session.jsonl",
  activeSubagents: [],
  skillCommands: [],
};

const makeMsg = (id: string, text = id, streaming = false): Session["messages"][number] => ({
  id,
  role: "user",
  text,
  timestamp: "2026-08-01T00:00:00.000Z",
  streaming,
  presentation: "text",
});

const makePage = (
  sessionId: string,
  messages: Session["messages"] = [],
  status: "available" | "complete" | "unavailable" | "invalidated" = "complete",
  olderCursor: string | null = null,
): SessionTranscriptResponse =>
  (status === "available"
    ? { sessionId, messages, status: "available", olderCursor: olderCursor ?? "cursor" }
    : { sessionId, messages, status, olderCursor: null }) as SessionTranscriptResponse;
describe("session client transcript pagination", () => {
  let requests: Map<
    string,
    { resolve(response: Response): void; reject(error: Error): void; signal?: AbortSignal | null }
  >;
  const jsonRes = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });
  const respond = (url: string, data: unknown) => requests.get(url)?.resolve(jsonRes(data));
  const evalSetter = <T>(setter: Mock | undefined, index = -1, initial?: T): T => {
    const call = setter?.mock.calls.at(index)?.[0];
    if (call === undefined) throw new Error(`Setter call not found at ${index}`);
    return typeof call === "function" ? call(initial) : call;
  };

  beforeEach(() => {
    hookHarness.effects.length = 0;
    hookHarness.stateSetters.length = 0;
    requests = new Map();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(
        (input, init) =>
          new Promise<Response>((resolve, reject) => {
            requests.set(String(input), {
              resolve,
              reject,
              ...(init?.signal ? { signal: init.signal } : {}),
            });
          }),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("progressively paginates backwards, prepends chronologically, and stops at terminal state", async () => {
    const client = useSessionClient();
    const transcriptHistorySetter = hookHarness.stateSetters[18];
    const p1 = client.loadTranscript("s1");
    expect(evalSetter(transcriptHistorySetter, 0)).toMatchObject({
      sessionId: "s1",
      initialLoading: true,
    });
    respond("/api/sessions/s1/transcript", makePage("s1", [makeMsg("m2")], "available", "c1"));
    await p1;
    expect(evalSetter(transcriptHistorySetter)).toEqual({
      sessionId: "s1",
      initialLoading: false,
      olderLoading: false,
      status: "available",
      error: null,
    });

    const p2 = client.loadOlderTranscript();
    expect(requests.has("/api/sessions/s1/transcript?cursor=c1")).toBe(true);
    respond("/api/sessions/s1/transcript?cursor=c1", makePage("s1", [makeMsg("m1")], "complete", null));
    await p2;

    const calls = (fetch as unknown as Mock).mock.calls.length;
    await client.loadOlderTranscript();
    expect((fetch as unknown as Mock).mock.calls.length).toBe(calls);
  });

  it.each([
    ["complete", false],
    ["unavailable", false],
    ["invalidated", true],
  ] as const)("handles terminal status %s", async (status, needsReload) => {
    const client = useSessionClient();
    const p = client.loadTranscript("s1");
    respond("/api/sessions/s1/transcript", makePage("s1", [], status, null));
    await p;
    const calls = (fetch as unknown as Mock).mock.calls.length;
    await client.loadOlderTranscript();
    expect((fetch as unknown as Mock).mock.calls.length).toBe(calls);
    if (needsReload) {
      const reloadPromise = client.reloadTranscript();
      expect((fetch as unknown as Mock).mock.calls.length).toBe(calls + 1);
      respond("/api/sessions/s1/transcript", makePage("s1", [makeMsg("m1")]));
      await reloadPromise;
    }
  });

  it("handles initial and older request errors with retry", async () => {
    const client = useSessionClient();
    const transcriptHistorySetter = hookHarness.stateSetters[18];
    const failInitial = client.loadTranscript("s1");
    requests.get("/api/sessions/s1/transcript")?.reject(new Error("Net error"));
    await expect(failInitial).rejects.toThrow("Net error");
    expect(evalSetter(transcriptHistorySetter)).toMatchObject({
      initialLoading: false,
      error: "Net error",
    });
    const retryInitial = client.retryTranscript();
    respond("/api/sessions/s1/transcript", makePage("s1", [makeMsg("m2")], "available", "c-abc"));
    await retryInitial;

    const failOlder = client.loadOlderTranscript();
    requests.get("/api/sessions/s1/transcript?cursor=c-abc")?.reject(new Error("500 Error"));
    await expect(failOlder).rejects.toThrow("500 Error");
    const retryOlder = client.retryTranscript();
    expect(requests.has("/api/sessions/s1/transcript?cursor=c-abc")).toBe(true);
    respond("/api/sessions/s1/transcript?cursor=c-abc", makePage("s1", [makeMsg("m1")], "complete", null));
    await retryOlder;
  });

  it("aborts active request when switching sessions and drops late response", async () => {
    const client = useSessionClient();
    const historySetter = hookHarness.stateSetters[3];
    const pA = client.loadTranscript("sA");
    const pB = client.loadTranscript("sB");
    expect(requests.get("/api/sessions/sA/transcript")?.signal?.aborted).toBe(true);
    expect(requests.get("/api/sessions/sB/transcript")?.signal?.aborted).toBe(false);
    respond("/api/sessions/sA/transcript", makePage("sA", [makeMsg("mA")]));
    respond("/api/sessions/sB/transcript", makePage("sB", [makeMsg("mB")]));
    await Promise.all([pA, pB]);
    const result = evalSetter<Session[]>(historySetter, -1, [
      { ...SESSION, id: "sA", source: "history", messages: [] },
      { ...SESSION, id: "sB", source: "history", messages: [] },
    ]);
    expect(result.find((s) => s.id === "sB")?.messages[0]?.id).toBe("mB");
  });

  it("reloads page 1 replacing loaded history while preserving live tail, and state-only on invalidated reload/older", async () => {
    const client = useSessionClient();
    const historySetter = hookHarness.stateSetters[3];
    const transcriptHistorySetter = hookHarness.stateSetters[18];
    const p1 = client.loadTranscript("s1");
    respond("/api/sessions/s1/transcript", makePage("s1", [makeMsg("m2")], "available", "c1"));
    await p1;
    let sessions = evalSetter<Session[]>(historySetter, -1, [
      { ...SESSION, id: "s1", source: "history", messages: [] },
    ]);
    const pOlder = client.loadOlderTranscript();
    respond("/api/sessions/s1/transcript?cursor=c1", makePage("s1", [makeMsg("m1")], "complete", null));
    await pOlder;
    sessions = evalSetter(historySetter, -1, sessions);

    sessions = upsertTranscriptMessage(sessions, "s1", makeMsg("m1", "live text"));
    sessions = upsertTranscriptMessage(sessions, "s1", makeMsg("m-live", "m-live", true));

    const pReloadInv = client.reloadTranscript();
    respond("/api/sessions/s1/transcript", makePage("s1", [], "invalidated", null));
    await pReloadInv;
    expect(evalSetter(transcriptHistorySetter)).toMatchObject({
      status: "invalidated",
      initialLoading: false,
    });
    expect(sessions[0]?.messages.map((m) => m.id)).toEqual(["m1", "m2", "m-live"]);
    expect(sessions[0]?.messages[0]?.text).toBe("live text");

    const fetchCount = (fetch as unknown as Mock).mock.calls.length;
    await client.loadOlderTranscript();
    expect((fetch as unknown as Mock).mock.calls.length).toBe(fetchCount);

    const pFresh = client.reloadTranscript();
    respond("/api/sessions/s1/transcript", makePage("s1", [makeMsg("m2-fresh")], "available", "c2"));
    await pFresh;
    sessions = evalSetter(historySetter, -1, sessions);
    expect(sessions[0]?.messages.map((m) => m.id)).toEqual(["m2-fresh", "m-live"]);
  });

  it("preserves a same-ID WebSocket completion that wins an unavailable transcript race", async () => {
    const client = useSessionClient();
    const liveSetter = hookHarness.stateSetters[0];
    const stale = makeMsg("m1", "partial", true);
    const request = client.loadTranscript("s1");
    const initial: Session[] = [{ ...SESSION, id: "s1", source: "extension", messages: [stale] }];
    evalSetter<Session[]>(liveSetter, -1, initial);

    respond("/api/sessions/s1/transcript", makePage("s1", [stale], "unavailable", null));
    await request;

    const completed = makeMsg("m1", "complete", false);
    const sessions = evalSetter<Session[]>(
      liveSetter,
      -1,
      initial.map((session) => ({ ...session, messages: [completed] })),
    );

    expect(sessions[0]?.messages).toEqual([completed]);
  });

  it("accepts a fresher unavailable transcript over a same-ID message stale before the request", async () => {
    const client = useSessionClient();
    const liveSetter = hookHarness.stateSetters[0];
    const stale = makeMsg("m1", "partial", true);
    const initial: Session[] = [{ ...SESSION, id: "s1", source: "extension", messages: [stale] }];
    const request = client.loadTranscript("s1");
    evalSetter<Session[]>(liveSetter, -1, initial);

    const completed = makeMsg("m1", "complete", false);
    respond("/api/sessions/s1/transcript", makePage("s1", [completed], "unavailable", null));
    await request;
    const sessions = evalSetter<Session[]>(liveSetter, -1, initial);

    expect(sessions[0]?.messages).toEqual([completed]);
  });

  it("keeps a completed unavailable transcript over a later partial WebSocket update", async () => {
    const client = useSessionClient();
    const liveSetter = hookHarness.stateSetters[0];
    const initial: Session[] = [{ ...SESSION, id: "s1", source: "extension", messages: [] }];
    const request = client.loadTranscript("s1");
    evalSetter<Session[]>(liveSetter, -1, initial);

    const completed = makeMsg("m1", "complete", false);
    respond("/api/sessions/s1/transcript", makePage("s1", [completed], "unavailable", null));
    await request;
    const partial = makeMsg("m1", "partial", true);
    const sessions = evalSetter<Session[]>(
      liveSetter,
      -1,
      initial.map((session) => ({ ...session, messages: [partial] })),
    );

    expect(sessions[0]?.messages).toEqual([completed]);
  });

  it("cleans up hydrated HTTP history on session switch while retaining completed live tail with fewer than 50 messages", async () => {
    const client = useSessionClient();
    const historySetter = hookHarness.stateSetters[3];
    const pA = client.loadTranscript("sA");
    const httpA = makeMsg("mA-http");
    respond("/api/sessions/sA/transcript", makePage("sA", [httpA]));
    await pA;

    const liveA = makeMsg("mA-live", "completed live message", false);
    let sessions: Session[] = evalSetter<Session[]>(historySetter, -1, [
      { ...SESSION, id: "sA", source: "extension", messages: [] },
      { ...SESSION, id: "sB", source: "history", messages: [] },
    ]);
    sessions = sessions.map((s) => (s.id === "sA" ? { ...s, messages: [...s.messages, liveA] } : s));

    const pB = client.loadTranscript("sB");
    sessions = evalSetter(historySetter, -1, sessions);
    const sA = sessions.find((s) => s.id === "sA");
    expect(sA?.messages.map((m) => m.id)).toEqual(["mA-live"]);

    respond("/api/sessions/sB/transcript", makePage("sB", [makeMsg("mB1")]));
    await pB;
  });

  it("bounds nonselected live session retention to TRANSCRIPT_PAGE_SIZE and cleans up HTTP history on session switch", async () => {
    const client = useSessionClient();
    const historySetter = hookHarness.stateSetters[3];
    const pA = client.loadTranscript("sA");
    const httpA = makeMsg("mA-http");
    respond("/api/sessions/sA/transcript", makePage("sA", [httpA]));
    await pA;

    const liveTailA = Array.from({ length: 60 }, (_, i) => makeMsg(`mA-live-${i}`));
    let sessions: Session[] = evalSetter<Session[]>(historySetter, -1, [
      { ...SESSION, id: "sA", source: "history", messages: [] },
      { ...SESSION, id: "sB", source: "history", messages: [] },
    ]);
    sessions = sessions.map((s) => (s.id === "sA" ? { ...s, messages: [...s.messages, ...liveTailA] } : s));

    const pB = client.loadTranscript("sB");
    sessions = evalSetter(historySetter, -1, sessions);
    const sA = sessions.find((s) => s.id === "sA");
    expect(sA?.messages).toHaveLength(50);
    expect(sA?.messages[0]?.id).toBe("mA-live-10");

    respond("/api/sessions/sB/transcript", makePage("sB", [makeMsg("mB1")]));
    await pB;
  });
});
