import {
  type AskRequest,
  type AskResponse,
  type BrowserCommand,
  compareSessionsByCreation,
  type Effort,
  ServerFrameSchema,
  type Session,
  SessionCatalogPageSchema,
  type SessionPatch,
  SessionTranscriptResponseSchema,
} from "@omp-remote/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const RECONNECT_DELAY_MS = 1_500;
const CATALOG_PAGE_SIZE = 100;

type ConnectionState = "connecting" | "connected" | "disconnected";
type PendingCommand = { resolve: () => void; reject: (error: Error) => void };

export interface SessionClient {
  sessions: Session[];
  askRequests: AskRequest[];
  sessionsReady: boolean;
  historyLoading: boolean;
  hasMoreHistory: boolean;
  connection: ConnectionState;
  error: string | null;
  launch(cwd: string, resume: string | null): Promise<void>;
  command(sessionId: string, command: "prompt" | "steer" | "follow_up", text: string): Promise<void>;
  abort(sessionId: string): Promise<void>;
  kill(sessionId: string): Promise<void>;
  setModel(sessionId: string, model: string): Promise<void>;
  setEffort(sessionId: string, effort: Effort): Promise<void>;
  respondToAsk(sessionId: string, askRequestId: string, response: AskResponse): Promise<void>;
  searchHistory(query: string): Promise<void>;
  loadMoreHistory(): Promise<void>;
  loadTranscript(sessionId: string): Promise<void>;
}

export function useSessionClient(): SessionClient {
  const socketRef = useRef<WebSocket | null>(null);
  const pendingRef = useRef(new Map<string, PendingCommand>());
  const catalogRequestRef = useRef(0);
  const catalogAbortRef = useRef<AbortController | null>(null);
  const transcriptAbortRef = useRef<AbortController | null>(null);
  const [liveSessions, setLiveSessions] = useState<Session[]>([]);
  const [askRequests, setAskRequests] = useState<AskRequest[]>([]);
  const [historySessions, setHistorySessions] = useState<Session[]>([]);
  const [liveSessionsReady, setLiveSessionsReady] = useState(false);
  const [historySessionsReady, setHistorySessionsReady] = useState(false);
  const [historyQuery, setHistoryQuery] = useState("");
  const [historyNextOffset, setHistoryNextOffset] = useState<number | null>(0);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let reconnectTimer: number | undefined;

    const connect = () => {
      if (disposed) return;
      setConnection("connecting");
      setLiveSessionsReady(false);
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
      socketRef.current = socket;
      socket.addEventListener("open", () => {
        setConnection("connected");
        setConnectionError(null);
      });
      socket.addEventListener("message", (event) => {
        const frame = (() => {
          try {
            return ServerFrameSchema.parse(JSON.parse(String(event.data)));
          } catch {
            setConnectionError("The host sent an unreadable update. Reconnect to restore the dashboard.");
            return null;
          }
        })();
        if (!frame) return;
        if (frame.type === "snapshot") {
          setLiveSessions(frame.sessions);
          setAskRequests(frame.askRequests);
          setLiveSessionsReady(true);
        } else if (frame.type === "session_upsert") {
          setLiveSessions((current) => upsertSession(current, frame.session));
        } else if (frame.type === "session_update") {
          setLiveSessions((current) => patchSession(current, frame.sessionId, frame.patch));
        } else if (frame.type === "transcript_upsert") {
          setLiveSessions((current) => upsertTranscriptMessage(current, frame.sessionId, frame.message));
        } else if (frame.type === "ask_request") {
          setAskRequests((current) => upsertAskRequest(current, frame.request));
        } else if (frame.type === "ask_cancelled") {
          setAskRequests((current) => removeAskRequest(current, frame.sessionId, frame.requestId));
        } else if (frame.type === "session_removed") {
          setLiveSessions((current) => current.filter((session) => session.id !== frame.sessionId));
        } else if (frame.type === "command_result") {
          const pending = pendingRef.current.get(frame.requestId);
          if (!pending) return;
          pendingRef.current.delete(frame.requestId);
          if (frame.ok) pending.resolve();
          else pending.reject(new Error(frame.error ?? "The host rejected the command"));
        } else if (frame.type === "error") {
          setConnectionError(frame.message);
        }
      });
      socket.addEventListener("close", () => {
        if (socketRef.current === socket) socketRef.current = null;
        if (disposed) return;
        setConnection("disconnected");
        setAskRequests([]);
        reconnectTimer = window.setTimeout(connect, RECONNECT_DELAY_MS);
      });
      socket.addEventListener("error", () => socket.close());
    };

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      socketRef.current?.close();
      for (const pending of pendingRef.current.values()) pending.reject(new Error("Dashboard disconnected"));
      pendingRef.current.clear();
    };
  }, []);

  useEffect(
    () => () => {
      transcriptAbortRef.current?.abort();
    },
    [],
  );

  const loadCatalogPage = useCallback(
    async (query: string, offset: number, append: boolean, baseline = false) => {
      const requestNumber = ++catalogRequestRef.current;
      catalogAbortRef.current?.abort();
      const abortController = new AbortController();
      catalogAbortRef.current = abortController;
      setHistoryLoading(true);
      setHistoryError(null);
      try {
        const search = new URLSearchParams({
          offset: String(offset),
          limit: String(CATALOG_PAGE_SIZE),
          q: query,
        });
        const response = await fetch(`/api/sessions?${search}`, { signal: abortController.signal });
        if (!response.ok) throw new Error(`Session history request failed (${response.status})`);
        const page = SessionCatalogPageSchema.parse(await response.json());
        if (requestNumber !== catalogRequestRef.current) return;
        setHistorySessions((current) => (append ? mergeSessions(current, page.sessions) : page.sessions));
        setHistoryNextOffset(page.nextOffset);
        setHistoryQuery(query);
        if (baseline) setHistorySessionsReady(true);
      } catch (error) {
        if (abortController.signal.aborted) return;
        if (requestNumber !== catalogRequestRef.current) return;
        const message = error instanceof Error ? error.message : "Session history could not be loaded";
        setHistoryError(message);
        throw error;
      } finally {
        if (requestNumber === catalogRequestRef.current) {
          setHistoryLoading(false);
          if (catalogAbortRef.current === abortController) catalogAbortRef.current = null;
        }
      }
    },
    [],
  );

  const catalogLoads = useMemo(
    () => createCatalogLoadCoordinator(() => loadCatalogPage("", 0, false, true)),
    [loadCatalogPage],
  );

  const searchHistory = useCallback(
    (query: string) => catalogLoads.afterBaseline(() => loadCatalogPage(query.trim(), 0, false)),
    [catalogLoads, loadCatalogPage],
  );

  const loadMoreHistory = useCallback(() => {
    if (!historySessionsReady || historyLoading || historyNextOffset === null) {
      return Promise.resolve();
    }
    return loadCatalogPage(historyQuery, historyNextOffset, true);
  }, [historyLoading, historyNextOffset, historyQuery, historySessionsReady, loadCatalogPage]);

  const loadTranscript = useCallback(async (sessionId: string) => {
    transcriptAbortRef.current?.abort();
    const abortController = new AbortController();
    transcriptAbortRef.current = abortController;
    setHistoryError(null);
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/transcript`, {
        signal: abortController.signal,
      });
      if (!response.ok) throw new Error(`Session transcript request failed (${response.status})`);
      const transcript = SessionTranscriptResponseSchema.parse(await response.json());
      const applyTranscript = (sessions: Session[]) =>
        sessions.map((session) => {
          if (session.id === transcript.sessionId) return { ...session, messages: transcript.messages };
          if (session.source === "history" && session.messages.length > 0) {
            return { ...session, messages: [] };
          }
          return session;
        });
      setHistorySessions(applyTranscript);
      setLiveSessions(applyTranscript);
    } catch (error) {
      if (abortController.signal.aborted) return;
      const message = error instanceof Error ? error.message : "Session transcript could not be loaded";
      setHistoryError(message);
      throw error;
    } finally {
      if (transcriptAbortRef.current === abortController) transcriptAbortRef.current = null;
    }
  }, []);

  useEffect(() => {
    const baseline = catalogLoads.loadBaseline();
    void baseline.catch(() => undefined);
    return () => {
      catalogLoads.invalidateBaseline(baseline);
      catalogAbortRef.current?.abort();
    };
  }, [catalogLoads]);

  const send = useCallback((frame: BrowserCommand): Promise<void> => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("The host is not connected"));
    }
    return new Promise<void>((resolve, reject) => {
      pendingRef.current.set(frame.requestId, { resolve, reject });
      socket.send(JSON.stringify(frame));
    });
  }, []);

  const launch = useCallback(
    (cwd: string, resume: string | null) =>
      send({ type: "launch", requestId: crypto.randomUUID(), cwd, resume }),
    [send],
  );
  const command = useCallback(
    (sessionId: string, commandName: "prompt" | "steer" | "follow_up", text: string) =>
      send({
        type: "session_command",
        requestId: crypto.randomUUID(),
        sessionId,
        command: commandName,
        text,
      }),
    [send],
  );
  const abort = useCallback(
    (sessionId: string) =>
      send({ type: "session_command", requestId: crypto.randomUUID(), sessionId, command: "abort" }),
    [send],
  );
  const kill = useCallback(
    (sessionId: string) =>
      send({ type: "session_command", requestId: crypto.randomUUID(), sessionId, command: "kill" }),
    [send],
  );
  const setModel = useCallback(
    (sessionId: string, model: string) =>
      send({
        type: "session_command",
        requestId: crypto.randomUUID(),
        sessionId,
        command: "set_model",
        model,
      }),
    [send],
  );
  const setEffort = useCallback(
    (sessionId: string, effort: Effort) =>
      send({
        type: "session_command",
        requestId: crypto.randomUUID(),
        sessionId,
        command: "set_effort",
        effort,
      }),
    [send],
  );
  const respondToAsk = useCallback(
    (sessionId: string, askRequestId: string, response: AskResponse) =>
      send({
        type: "ask_response",
        requestId: crypto.randomUUID(),
        sessionId,
        askRequestId,
        response,
      }),
    [send],
  );

  const sessions = useMemo(
    () =>
      mergeSessions(
        historySessions,
        historyQuery
          ? liveSessions.filter((session) => sessionMatchesQuery(session, historyQuery))
          : liveSessions,
      ),
    [historyQuery, historySessions, liveSessions],
  );

  return {
    sessions,
    askRequests,
    sessionsReady: sessionSourcesReady(liveSessionsReady, historySessionsReady),
    historyLoading,
    hasMoreHistory: historyNextOffset !== null,
    connection,
    error: historyError ?? connectionError,
    launch,
    command,
    abort,
    kill,
    setModel,
    setEffort,
    respondToAsk,
    searchHistory,
    loadMoreHistory,
    loadTranscript,
  };
}

export function sessionSourcesReady(liveSnapshotReady: boolean, baselineCatalogReady: boolean): boolean {
  return liveSnapshotReady && baselineCatalogReady;
}

export function createCatalogLoadCoordinator(loadBaselinePage: () => Promise<void>) {
  let baselinePromise: Promise<void> | null = null;
  const loadBaseline = () => {
    if (!baselinePromise) {
      let currentPromise: Promise<void>;
      currentPromise = loadBaselinePage().catch((error: unknown) => {
        if (baselinePromise === currentPromise) baselinePromise = null;
        throw error;
      });
      baselinePromise = currentPromise;
    }
    return baselinePromise;
  };

  return {
    loadBaseline,
    invalidateBaseline(attempt: Promise<void>): void {
      if (baselinePromise === attempt) baselinePromise = null;
    },
    afterBaseline(load: () => Promise<void>): Promise<void> {
      return loadBaseline().then(load);
    },
  };
}

function mergeSessions(base: Session[], overrides: Session[]): Session[] {
  const sessions = new Map(base.map((session) => [session.id, session]));
  for (const session of overrides) sessions.set(session.id, session);
  return [...sessions.values()].sort(compareSessionsByCreation);
}

function sessionMatchesQuery(session: Session, query: string): boolean {
  const normalizedQuery = query.toLocaleLowerCase();
  return [session.id, session.name, session.cwd, session.sessionPath]
    .filter((value): value is string => typeof value === "string")
    .some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
}

export function upsertTranscriptMessage(
  sessions: Session[],
  sessionId: string,
  message: Session["messages"][number],
): Session[] {
  return sessions.map((session) => {
    if (session.id !== sessionId) return session;
    const existingIndex = session.messages.findIndex((current) => current.id === message.id);
    const messages = [...session.messages];
    if (existingIndex >= 0) messages[existingIndex] = message;
    else messages.push(message);
    return { ...session, messages: messages.slice(-200), lastActivity: message.timestamp };
  });
}

export function patchSession(sessions: Session[], sessionId: string, patch: SessionPatch): Session[] {
  const index = sessions.findIndex((session) => session.id === sessionId);
  const current = sessions[index];
  if (!current) return sessions;
  const updated: Session = { ...current, messages: current.messages };
  if (patch.source !== undefined) updated.source = patch.source;
  if (patch.name !== undefined) updated.name = patch.name;
  if (patch.cwd !== undefined) updated.cwd = patch.cwd;
  if (patch.branch !== undefined) updated.branch = patch.branch;
  if (patch.status !== undefined) updated.status = patch.status;
  if (patch.connected !== undefined) updated.connected = patch.connected;
  if (patch.model !== undefined) updated.model = patch.model;
  if (patch.effort !== undefined) updated.effort = patch.effort;
  if (patch.availableModels !== undefined) updated.availableModels = patch.availableModels;
  if (patch.contextPercent !== undefined) updated.contextPercent = patch.contextPercent;
  if (patch.createdAt !== undefined) updated.createdAt = patch.createdAt;
  if (patch.lastActivity !== undefined) updated.lastActivity = patch.lastActivity;
  if (patch.capabilities !== undefined) updated.capabilities = patch.capabilities;
  if (patch.sessionPath !== undefined) updated.sessionPath = patch.sessionPath;
  if (patch.activeSubagents !== undefined) updated.activeSubagents = patch.activeSubagents;
  if (patch.skillCommands !== undefined) updated.skillCommands = patch.skillCommands;
  const next = [...sessions];
  next[index] = updated;
  return next;
}

function upsertSession(sessions: Session[], session: Session): Session[] {
  return mergeSessions(
    sessions.filter((current) => current.id !== session.id),
    [session],
  );
}

export function upsertAskRequest(requests: AskRequest[], request: AskRequest): AskRequest[] {
  const existingIndex = requests.findIndex((current) => current.sessionId === request.sessionId);
  if (existingIndex < 0) return [...requests, request];
  const next = [...requests];
  next[existingIndex] = request;
  return next;
}

export function removeAskRequest(requests: AskRequest[], sessionId: string, requestId: string): AskRequest[] {
  const index = requests.findIndex(
    (request) => request.sessionId === sessionId && request.requestId === requestId,
  );
  if (index < 0) return requests;
  return requests.toSpliced(index, 1);
}
