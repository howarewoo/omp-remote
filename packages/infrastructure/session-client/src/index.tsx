import {
  compareSessionsByCreation,
  type BrowserCommand,
  type Session,
  SessionCatalogPageSchema,
  ServerFrameSchema,
  SessionTranscriptResponseSchema,
} from "@omp-remote/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const RECONNECT_DELAY_MS = 1_500;
const CATALOG_PAGE_SIZE = 100;

type ConnectionState = "connecting" | "connected" | "disconnected";
type PendingCommand = { resolve: () => void; reject: (error: Error) => void };

export interface SessionClient {
  sessions: Session[];
  totalSessions: number;
  historyLoading: boolean;
  hasMoreHistory: boolean;
  connection: ConnectionState;
  error: string | null;
  launch(cwd: string, resume: string | null): Promise<void>;
  command(sessionId: string, command: "prompt" | "steer" | "follow_up", text: string): Promise<void>;
  abort(sessionId: string): Promise<void>;
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
  const [historySessions, setHistorySessions] = useState<Session[]>([]);
  const [historyQuery, setHistoryQuery] = useState("");
  const [historyTotal, setHistoryTotal] = useState(0);
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
        if (frame.type === "snapshot") setLiveSessions(frame.sessions);
        else if (frame.type === "session_upsert") {
          setLiveSessions((current) => upsertSession(current, frame.session));
        } else if (frame.type === "transcript_upsert") {
          setLiveSessions((current) => upsertTranscriptMessage(current, frame.sessionId, frame.message));
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
      catalogAbortRef.current?.abort();
      transcriptAbortRef.current?.abort();
    },
    [],
  );

  const loadCatalogPage = useCallback(async (query: string, offset: number, append: boolean) => {
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
      setHistoryTotal(page.total);
      setHistoryNextOffset(page.nextOffset);
      setHistoryQuery(query);
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
  }, []);

  const searchHistory = useCallback(
    (query: string) => loadCatalogPage(query.trim(), 0, false),
    [loadCatalogPage],
  );

  const loadMoreHistory = useCallback(() => {
    if (historyLoading || historyNextOffset === null) return Promise.resolve();
    return loadCatalogPage(historyQuery, historyNextOffset, true);
  }, [historyLoading, historyNextOffset, historyQuery, loadCatalogPage]);

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
    void searchHistory("").catch(() => undefined);
  }, [searchHistory]);

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
    totalSessions: Math.max(historyTotal, sessions.length),
    historyLoading,
    hasMoreHistory: historyNextOffset !== null,
    connection,
    error: historyError ?? connectionError,
    launch,
    command,
    abort,
    searchHistory,
    loadMoreHistory,
    loadTranscript,
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

function upsertSession(sessions: Session[], session: Session): Session[] {
  return mergeSessions(
    sessions.filter((current) => current.id !== session.id),
    [session],
  );
}
