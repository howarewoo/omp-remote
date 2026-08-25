import {
  type ApplicationErrorContext,
  type ApplicationErrorRecord,
  type ApplicationErrorStorageHealth,
  type AskRequest,
  type AskResponse,
  type BrowserCommand,
  type Effort,
  type PushSubscriptionRegistration,
  type PushSubscriptionRemoval,
  type PushSubscriptionUpdate,
  ServerFrameSchema,
  type Session,
  type SessionBranchTopology,
  SessionCatalogPageSchema,
  type SessionFileChangesResponse,
  TRANSCRIPT_PAGE_SIZE,
  type TranscriptHistoryStatus,
} from "@omp-remote/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  addApplicationErrorRecord,
  applyTranscriptToSessions,
  boundedServerError,
  cleanupSessionHistory,
  clearApplicationErrorsLedger,
  createCatalogLoadCoordinator,
  createConnectionFreshnessTracker,
  deduplicateAndSortApplicationErrors,
  dispatchNotificationEvent,
  loadApplicationErrorsLedger,
  loadSessionBranchTopology,
  loadSessionCost,
  loadSessionDetails,
  loadSessionFileChanges,
  loadSessionTranscript,
  mergeSessions,
  overlaySessionCosts,
  patchSession,
  prependTranscriptToSessions,
  rejectPendingCommands,
  removeAskRequest,
  resolvePendingCommand,
  sendBrowserCommand,
  sessionMatchesQuery,
  sessionSourcesReady,
  snapshotSessionsWithCurrentMessages,
  type ConnectionState,
  type NotificationEventListener,
  type PendingCommand,
  type TranscriptProvenance,
  upsertAskRequest,
  upsertLoadedSession,
  upsertSession,
  upsertTranscriptMessage,
} from "./session-client-helpers.js";
export * from "./session-client-helpers.js";

const RECONNECT_DELAY_MS = 1_500;
const INITIAL_SNAPSHOT_DEADLINE_MS = 10_000;
const CATALOG_PAGE_SIZE = 100;
const SWITCH_BRANCH_TIMEOUT_MS = 30_000;
const LAUNCH_COMMAND_TIMEOUT_MS = 20_000;
export const SESSION_COMMAND_TIMEOUT_MS = 20_000;
const PUSH_COMMAND_TIMEOUT_MS = 10_000;
const REPORT_APPLICATION_ERROR_TIMEOUT_MS = 10_000;
export interface QueuedUserMessage {
  id: string;
  sessionId: string;
  text: string;
  createdAt: string;
  status: "queued" | "failed";
  error?: string;
}

export interface TranscriptHistoryState {
  sessionId: string | null;
  initialLoading: boolean;
  olderLoading: boolean;
  status: TranscriptHistoryStatus | null;
  error: string | null;
}

export interface ReportApplicationErrorInput {
  id?: string | undefined;
  timestamp?: string | undefined;
  source?: "browser" | undefined;
  severity?: "error" | "fatal" | undefined;
  message: string;
  errorName?: string | undefined;
  stack?: string | undefined;
  context?: ApplicationErrorContext | undefined;
}

export interface SessionClient {
  sessions: Session[];
  queuedMessages: QueuedUserMessage[];
  askRequests: AskRequest[];
  savedWorkingDirectories: string[];
  sessionsReady: boolean;
  historyLoading: boolean;
  hasMoreHistory: boolean;
  connection: ConnectionState;
  error: string | null;
  transcriptHistory: TranscriptHistoryState;
  applicationErrors: ApplicationErrorRecord[];
  applicationErrorsHealth: ApplicationErrorStorageHealth | null;
  applicationErrorsLoading: boolean;
  applicationErrorsError: string | null;
  clearApplicationErrors(): Promise<void>;
  reportApplicationError(error: ReportApplicationErrorInput): Promise<void>;
  loadApplicationErrors(): Promise<void>;
  subscribeNotificationEvents(listener: NotificationEventListener): () => void;
  launch(cwd: string, resume: string | null): Promise<string>;
  saveWorkingDirectory(cwd: string): Promise<void>;
  removeWorkingDirectory(cwd: string): Promise<void>;
  command(sessionId: string, command: "prompt" | "steer" | "follow_up", text: string): Promise<void>;
  cancelQueuedMessage(messageId: string): void;
  abort(sessionId: string): Promise<void>;
  kill(sessionId: string): Promise<void>;
  setModel(sessionId: string, model: string): Promise<void>;
  setEffort(sessionId: string, effort: Effort): Promise<void>;
  respondToAsk(sessionId: string, askRequestId: string, response: AskResponse): Promise<void>;
  askActivity(sessionId: string, askRequestId: string): Promise<void>;
  searchHistory(query: string): Promise<void>;
  loadMoreHistory(): Promise<void>;
  loadSessionFileChanges(sessionId: string, signal?: AbortSignal): Promise<SessionFileChangesResponse>;
  loadSessionBranchTopology(sessionId: string, signal?: AbortSignal): Promise<SessionBranchTopology>;
  switchBranch(sessionId: string, branch: string): Promise<void>;
  loadCost(sessionId: string): Promise<void>;
  loadTranscript(sessionId: string): Promise<void>;
  loadOlderTranscript(): Promise<void>;
  retryTranscript(): Promise<void>;
  reloadTranscript(): Promise<void>;
  loadSession(sessionId: string): Promise<void>;
  pushVapidPublicKey(): Promise<string>;
  registerPushSubscription(registration: PushSubscriptionRegistration): Promise<void>;
  updatePushSubscription(update: PushSubscriptionUpdate): Promise<void>;
  removePushSubscription(removal: PushSubscriptionRemoval): Promise<void>;
}

export function useSessionClient(): SessionClient {
  const socketRef = useRef<WebSocket | null>(null);
  const pendingRef = useRef(new Map<string, PendingCommand>());
  const notificationListenersRef = useRef(new Set<NotificationEventListener>());
  const catalogRequestRef = useRef(0);
  const costRequestRef = useRef(0);
  const detailsRequestRef = useRef(0);
  const catalogAbortRef = useRef<AbortController | null>(null);
  const transcriptAbortRef = useRef<AbortController | null>(null);
  const transcriptRequestRef = useRef(0);
  const transcriptCursorRef = useRef<string | null>(null);
  const transcriptProvenanceRef = useRef<TranscriptProvenance>(new WeakSet());
  const transcriptLastRequestRef = useRef<"initial" | "older" | null>(null);
  const detailsAbortRef = useRef<AbortController | null>(null);
  const costAbortRef = useRef<AbortController | null>(null);
  const applicationErrorsAbortRef = useRef<AbortController | null>(null);
  const applicationErrorsRequestRef = useRef(0);
  const applicationErrorsMutationTokenRef = useRef(0);
  const applicationErrorsLastClearedTokenRef = useRef(0);

  const bumpLedgerMutation = useCallback(() => {
    applicationErrorsMutationTokenRef.current += 1;
    return applicationErrorsMutationTokenRef.current;
  }, []);
  const costSummaryBySessionRef = useRef(new Map<string, Session["costSummary"] | null>());
  const [liveSessions, setLiveSessions] = useState<Session[]>([]);
  const [askRequests, setAskRequests] = useState<AskRequest[]>([]);
  const [savedWorkingDirectories, setSavedWorkingDirectories] = useState<string[]>([]);
  const [historySessions, setHistorySessions] = useState<Session[]>([]);
  const [liveSessionsReady, setLiveSessionsReady] = useState(false);
  const [historySessionsReady, setHistorySessionsReady] = useState(false);
  const [historyQuery, setHistoryQuery] = useState("");
  const [costRevision, setCostRevision] = useState(0);
  const [historyNextOffset, setHistoryNextOffset] = useState<number | null>(0);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [queuedMessages, setQueuedMessages] = useState<QueuedUserMessage[]>([]);
  const [applicationErrors, setApplicationErrors] = useState<ApplicationErrorRecord[]>([]);
  const [applicationErrorsHealth, setApplicationErrorsHealth] =
    useState<ApplicationErrorStorageHealth | null>(null);
  const [applicationErrorsLoading, setApplicationErrorsLoading] = useState(false);
  const [applicationErrorsError, setApplicationErrorsError] = useState<string | null>(null);
  const transcriptHistoryRef = useRef<TranscriptHistoryState>({
    sessionId: null,
    initialLoading: false,
    olderLoading: false,
    status: null,
    error: null,
  });
  const [transcriptHistory, setTranscriptHistory] = useState<TranscriptHistoryState>(
    transcriptHistoryRef.current,
  );
  const updateTranscriptHistory = useCallback(
    (
      nextOrUpdater: TranscriptHistoryState | ((current: TranscriptHistoryState) => TranscriptHistoryState),
    ) => {
      const next =
        typeof nextOrUpdater === "function" ? nextOrUpdater(transcriptHistoryRef.current) : nextOrUpdater;
      transcriptHistoryRef.current = next;
      setTranscriptHistory(next);
    },
    [],
  );

  useEffect(() => {
    let disposed = false;
    let reconnectTimer: number | undefined;
    let snapshotDeadline: number | undefined;
    let generation = 0;
    let activeSocket: WebSocket | null = null;
    const freshness = createConnectionFreshnessTracker();

    const clearSnapshotDeadline = () => {
      if (snapshotDeadline !== undefined) window.clearTimeout(snapshotDeadline);
      snapshotDeadline = undefined;
    };
    const isCurrent = (socket: WebSocket, socketGeneration: number) =>
      !disposed && generation === socketGeneration && activeSocket === socket;
    const invalidateCurrentSocket = (socket: WebSocket | null) => {
      if (socket !== null && activeSocket !== socket) return;
      activeSocket = null;
      generation += 1;
      clearSnapshotDeadline();
      if (socketRef.current === socket) socketRef.current = null;
    };
    const connect = () => {
      if (disposed) return;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      setConnection("connecting");
      setLiveSessionsReady(false);
      freshness.markConnectionStarted();
      const socketGeneration = ++generation;
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
      activeSocket = socket;
      socketRef.current = socket;
      clearSnapshotDeadline();
      socket.addEventListener("open", () => {
        if (!isCurrent(socket, socketGeneration)) return;
        clearSnapshotDeadline();
        snapshotDeadline = window.setTimeout(() => {
          if (!isCurrent(socket, socketGeneration) || freshness.hasSnapshot()) return;
          setConnectionError(
            "The host did not provide an initial snapshot. Reconnect to restore the dashboard.",
          );
          socket.close();
        }, INITIAL_SNAPSHOT_DEADLINE_MS);
      });
      socket.addEventListener("message", (event) => {
        if (!isCurrent(socket, socketGeneration)) return;
        const frame = (() => {
          try {
            return ServerFrameSchema.parse(JSON.parse(String(event.data)));
          } catch {
            setConnectionError("The host sent an unreadable update. Reconnect to restore the dashboard.");
            socket.close();
            return null;
          }
        })();
        if (!frame) return;
        if (frame.type === "snapshot") {
          clearSnapshotDeadline();
          freshness.markSnapshotReceived();
          setLiveSessions((current) => snapshotSessionsWithCurrentMessages(frame.sessions, current));
          setAskRequests(frame.askRequests);
          setSavedWorkingDirectories(frame.savedWorkingDirectories);
          setLiveSessionsReady(true);
          setConnection("connected");
          setConnectionError(null);
          void loadApplicationErrors().catch(() => undefined);
        } else if (frame.type === "session_upsert") {
          setLiveSessions((current) => upsertSession(current, frame.session));
        } else if (frame.type === "session_update") {
          setLiveSessions((current) => patchSession(current, frame.sessionId, frame.patch));
        } else if (frame.type === "transcript_upsert") {
          const selectedId = transcriptHistoryRef.current.sessionId;
          setLiveSessions((current) =>
            upsertTranscriptMessage(current, frame.sessionId, frame.message).map((s) =>
              s.id === frame.sessionId && s.id !== selectedId
                ? { ...s, messages: s.messages.slice(-TRANSCRIPT_PAGE_SIZE) }
                : s,
            ),
          );
        } else if (frame.type === "ask_request") {
          setAskRequests((current) => upsertAskRequest(current, frame.request));
        } else if (frame.type === "ask_cancelled") {
          setAskRequests((current) => removeAskRequest(current, frame.sessionId, frame.requestId));
        } else if (frame.type === "session_removed") {
          setLiveSessions((current) => current.filter((session) => session.id !== frame.sessionId));
          setAskRequests((current) => current.filter((request) => request.sessionId !== frame.sessionId));
        } else if (frame.type === "saved_working_directories") {
          setSavedWorkingDirectories(frame.savedWorkingDirectories);
        } else if (frame.type === "command_result") {
          resolvePendingCommand(pendingRef.current, frame);
        } else if (frame.type === "notification_event") {
          dispatchNotificationEvent(notificationListenersRef.current, frame);
        } else if (frame.type === "application_error_added") {
          bumpLedgerMutation();
          setApplicationErrors((current) => addApplicationErrorRecord(current, frame.error));
          setApplicationErrorsHealth((current) =>
            current
              ? {
                  ...current,
                  recordCount: current.recordCount + 1,
                  newestTimestamp: frame.error.timestamp,
                  oldestTimestamp: current.oldestTimestamp ?? frame.error.timestamp,
                }
              : null,
          );
          void loadApplicationErrors().catch(() => undefined);
        } else if (frame.type === "application_errors_cleared") {
          applicationErrorsAbortRef.current?.abort();
          applicationErrorsRequestRef.current += 1;
          const token = bumpLedgerMutation();
          applicationErrorsLastClearedTokenRef.current = token;
          setApplicationErrors([]);
          setApplicationErrorsHealth((current) =>
            current
              ? {
                  ...current,
                  recordCount: 0,
                  totalBytes: 0,
                  oldestTimestamp: null,
                  newestTimestamp: null,
                }
              : null,
          );
        } else if (frame.type === "error") {
          setConnectionError(boundedServerError(frame.message, "The host reported an error"));
        }
      });
      socket.addEventListener("close", () => {
        if (!isCurrent(socket, socketGeneration)) return;
        invalidateCurrentSocket(socket);
        rejectPendingCommands(pendingRef.current);
        if (disposed) return;
        freshness.markConnectionStarted();
        setLiveSessionsReady(false);
        setConnection("disconnected");
        setAskRequests([]);
        reconnectTimer = window.setTimeout(connect, RECONNECT_DELAY_MS);
      });
      socket.addEventListener("error", () => {
        if (isCurrent(socket, socketGeneration)) socket.close();
      });
    };
    const replaceWhenFreshnessUnproved = () => {
      if (disposed || !freshness.beginRecovery()) return;
      queueMicrotask(() => {
        if (disposed) return;
        if (freshness.hasSnapshot()) return;
        const previousSocket = activeSocket;
        invalidateCurrentSocket(previousSocket);
        rejectPendingCommands(pendingRef.current);
        previousSocket?.close();
        connect();
      });
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") replaceWhenFreshnessUnproved();
    };
    const onPageShow = () => replaceWhenFreshnessUnproved();
    const onOnline = () => replaceWhenFreshnessUnproved();
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("online", onOnline);
    connect();
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("online", onOnline);
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      const socket = activeSocket;
      invalidateCurrentSocket(socket);
      socket?.close();
      rejectPendingCommands(pendingRef.current);
    };
  }, []);

  useEffect(
    () => () => {
      transcriptRequestRef.current += 1;
      transcriptAbortRef.current?.abort();
      detailsRequestRef.current += 1;
      detailsAbortRef.current?.abort();
      costAbortRef.current?.abort();
      applicationErrorsAbortRef.current?.abort();
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
  const loadApplicationErrors = useCallback(async () => {
    const requestNumber = ++applicationErrorsRequestRef.current;
    const startToken = applicationErrorsMutationTokenRef.current;
    applicationErrorsAbortRef.current?.abort();
    const abortController = new AbortController();
    applicationErrorsAbortRef.current = abortController;
    setApplicationErrorsLoading(true);
    setApplicationErrorsError(null);
    try {
      const ledger = await loadApplicationErrorsLedger(abortController.signal, fetch);
      if (requestNumber !== applicationErrorsRequestRef.current || abortController.signal.aborted) {
        return;
      }
      if (applicationErrorsLastClearedTokenRef.current > startToken) {
        return;
      }
      setApplicationErrors((current) => deduplicateAndSortApplicationErrors([...current, ...ledger.errors]));
      setApplicationErrorsHealth(ledger.health);
    } catch (error) {
      if (abortController.signal.aborted || requestNumber !== applicationErrorsRequestRef.current) {
        return;
      }
      const message = error instanceof Error ? error.message : "Application errors could not be loaded";
      setApplicationErrorsError(message);
      throw error;
    } finally {
      if (requestNumber === applicationErrorsRequestRef.current) {
        setApplicationErrorsLoading(false);
        if (applicationErrorsAbortRef.current === abortController) {
          applicationErrorsAbortRef.current = null;
        }
      }
    }
  }, []);

  useEffect(() => {
    void loadApplicationErrors().catch(() => undefined);
    return () => {
      applicationErrorsAbortRef.current?.abort();
    };
  }, [loadApplicationErrors]);

  const clearApplicationErrors = useCallback(async () => {
    applicationErrorsAbortRef.current?.abort();
    applicationErrorsRequestRef.current += 1;
    const token = bumpLedgerMutation();
    applicationErrorsLastClearedTokenRef.current = token;
    setApplicationErrorsError(null);
    try {
      await clearApplicationErrorsLedger(fetch);
      setApplicationErrors([]);
      setApplicationErrorsHealth((current) =>
        current
          ? {
              ...current,
              recordCount: 0,
              totalBytes: 0,
              oldestTimestamp: null,
              newestTimestamp: null,
            }
          : null,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Application errors could not be cleared";
      setApplicationErrorsError(message);
      throw error;
    }
  }, [bumpLedgerMutation]);

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

  const fetchTranscriptPage = useCallback(
    async (sessionId: string, kind: "initial" | "older", cursor: string | null) => {
      const requestNumber = ++transcriptRequestRef.current;
      transcriptAbortRef.current?.abort();
      const abortController = new AbortController();
      transcriptAbortRef.current = abortController;
      transcriptLastRequestRef.current = kind;
      const liveMessagesAtRequestStart: TranscriptProvenance = new WeakSet();
      if (kind === "initial") {
        setLiveSessions((current) => {
          const session = current.find((candidate) => candidate.id === sessionId);
          for (const message of session?.messages ?? []) liveMessagesAtRequestStart.add(message);
          return current;
        });
      }
      updateTranscriptHistory((current) => ({
        sessionId,
        initialLoading: kind === "initial",
        olderLoading: kind === "older",
        status: kind === "initial" && current.sessionId !== sessionId ? null : current.status,
        error: null,
      }));
      try {
        const transcript = await loadSessionTranscript(sessionId, cursor, abortController.signal);
        if (requestNumber !== transcriptRequestRef.current || abortController.signal.aborted) return;
        transcriptCursorRef.current = transcript.olderCursor;
        updateTranscriptHistory({
          sessionId,
          initialLoading: false,
          olderLoading: false,
          status: transcript.status,
          error: null,
        });
        if (transcript.status !== "invalidated") {
          if (kind === "initial") {
            const nextProvenance: TranscriptProvenance = new WeakSet();
            for (const m of transcript.messages) nextProvenance.add(m);
            transcriptProvenanceRef.current = nextProvenance;
          } else {
            for (const m of transcript.messages) transcriptProvenanceRef.current.add(m);
          }
          if (kind === "initial") {
            setHistorySessions((sessions) => applyTranscriptToSessions(sessions, transcript));
            setLiveSessions((sessions) =>
              applyTranscriptToSessions(
                sessions,
                transcript,
                transcript.status === "unavailable"
                  ? (message) => !liveMessagesAtRequestStart.has(message)
                  : undefined,
              ),
            );
          } else {
            const prepend = (sessions: Session[]) => prependTranscriptToSessions(sessions, transcript);
            setHistorySessions(prepend);
            setLiveSessions(prepend);
          }
        }
      } catch (error) {
        if (abortController.signal.aborted || requestNumber !== transcriptRequestRef.current) return;
        const message = error instanceof Error ? error.message : "Session transcript could not be loaded";
        updateTranscriptHistory((current) =>
          current.sessionId === sessionId
            ? { ...current, initialLoading: false, olderLoading: false, error: message }
            : current,
        );
        throw error;
      } finally {
        if (transcriptAbortRef.current === abortController) transcriptAbortRef.current = null;
      }
    },
    [updateTranscriptHistory],
  );

  const loadTranscript = useCallback(
    async (sessionId: string) => {
      const prevSessionId = transcriptHistoryRef.current.sessionId;
      if (sessionId !== prevSessionId) {
        const prevProvenance = transcriptProvenanceRef.current;
        if (prevSessionId) {
          const cleanup = (s: Session[]) => cleanupSessionHistory(s, prevSessionId, prevProvenance);
          setHistorySessions(cleanup);
          setLiveSessions(cleanup);
        }
        transcriptProvenanceRef.current = new WeakSet();
        transcriptCursorRef.current = null;
      }
      return fetchTranscriptPage(sessionId, "initial", null);
    },
    [fetchTranscriptPage],
  );

  const loadOlderTranscript = useCallback(async () => {
    const state = transcriptHistoryRef.current;
    const cursor = transcriptCursorRef.current;
    if (
      !state.sessionId ||
      state.status !== "available" ||
      !cursor ||
      state.initialLoading ||
      state.olderLoading
    ) {
      return;
    }
    return fetchTranscriptPage(state.sessionId, "older", cursor);
  }, [fetchTranscriptPage]);

  const reloadTranscript = useCallback(async () => {
    const sessionId = transcriptHistoryRef.current.sessionId;
    if (!sessionId) return;
    return fetchTranscriptPage(sessionId, "initial", null);
  }, [fetchTranscriptPage]);

  const retryTranscript = useCallback(async () => {
    const state = transcriptHistoryRef.current;
    if (!state.sessionId || state.error === null) return;
    const kind = transcriptLastRequestRef.current ?? "initial";
    const cursor = kind === "older" ? transcriptCursorRef.current : null;
    if (kind === "older" && !cursor) return;
    return fetchTranscriptPage(state.sessionId, kind, cursor);
  }, [fetchTranscriptPage]);

  const loadSession = useCallback(async (sessionId: string) => {
    const requestNumber = ++detailsRequestRef.current;
    detailsAbortRef.current?.abort();
    const abortController = new AbortController();
    detailsAbortRef.current = abortController;
    try {
      const session = await loadSessionDetails(sessionId, abortController.signal);
      if (requestNumber !== detailsRequestRef.current || abortController.signal.aborted) return;
      setHistorySessions((current) => upsertLoadedSession(current, session));
    } finally {
      if (detailsAbortRef.current === abortController) detailsAbortRef.current = null;
    }
  }, []);

  const loadCost = useCallback(async (sessionId: string) => {
    const requestNumber = ++costRequestRef.current;
    costAbortRef.current?.abort();
    const abortController = new AbortController();
    costAbortRef.current = abortController;
    setHistoryError(null);
    try {
      const result = await loadSessionCost(sessionId, abortController.signal);
      if (requestNumber !== costRequestRef.current) return;
      costSummaryBySessionRef.current.clear();
      costSummaryBySessionRef.current.set(result.sessionId, result.costSummary);
      setCostRevision((revision) => revision + 1);
    } catch (error) {
      if (abortController.signal.aborted || requestNumber !== costRequestRef.current) return;
      const message = error instanceof Error ? error.message : "Session cost could not be loaded";
      setHistoryError(message);
      throw error;
    } finally {
      if (costAbortRef.current === abortController) costAbortRef.current = null;
    }
  }, []);

  const loadSessionFileChangesCallback = useCallback(
    (sessionId: string, signal?: AbortSignal) => loadSessionFileChanges(sessionId, signal),
    [],
  );
  const loadSessionBranchTopologyCallback = useCallback(
    (sessionId: string, signal?: AbortSignal) => loadSessionBranchTopology(sessionId, signal),
    [],
  );

  useEffect(() => {
    const baseline = catalogLoads.loadBaseline();
    void baseline.catch(() => undefined);
    return () => {
      catalogLoads.invalidateBaseline(baseline);
      catalogAbortRef.current?.abort();
    };
  }, [catalogLoads]);

  const send = useCallback(
    (frame: Exclude<BrowserCommand, { type: "ask_activity" }>, timeoutMs?: number) =>
      sendBrowserCommand(socketRef.current, pendingRef.current, frame, timeoutMs),
    [],
  );

  const sendVoid = useCallback(
    (frame: Exclude<BrowserCommand, { type: "ask_activity" }>, timeoutMs?: number): Promise<void> =>
      send(frame, timeoutMs).then(() => undefined),
    [send],
  );
  const switchBranch = useCallback(
    (sessionId: string, branch: string) =>
      sendVoid(
        {
          type: "switch_branch",
          requestId: crypto.randomUUID(),
          sessionId,
          branch,
        },
        SWITCH_BRANCH_TIMEOUT_MS,
      ),
    [sendVoid],
  );
  const launch = useCallback(
    (cwd: string, resume: string | null) =>
      send({ type: "launch", requestId: crypto.randomUUID(), cwd, resume }, LAUNCH_COMMAND_TIMEOUT_MS).then(
        (value) => {
          if (value.type !== "launch") throw new Error("The host did not identify the launched session");
          return value.sessionId;
        },
      ),
    [send],
  );
  const saveWorkingDirectory = useCallback(
    (cwd: string) => sendVoid({ type: "save_working_directory", requestId: crypto.randomUUID(), cwd }),
    [sendVoid],
  );
  const removeWorkingDirectory = useCallback(
    (cwd: string) => sendVoid({ type: "remove_working_directory", requestId: crypto.randomUUID(), cwd }),
    [sendVoid],
  );
  const command = useCallback(
    (sessionId: string, commandName: "prompt" | "steer" | "follow_up", text: string) => {
      if (commandName === "follow_up") {
        setQueuedMessages((current) => [
          ...current,
          {
            id: crypto.randomUUID(),
            sessionId,
            text,
            createdAt: new Date().toISOString(),
            status: "queued",
          },
        ]);
        return Promise.resolve();
      }
      return sendVoid(
        {
          type: "session_command",
          requestId: crypto.randomUUID(),
          sessionId,
          command: commandName,
          text,
        },
        SESSION_COMMAND_TIMEOUT_MS,
      );
    },
    [sendVoid],
  );
  const cancelQueuedMessage = useCallback((messageId: string) => {
    setQueuedMessages((current) => current.filter((message) => message.id !== messageId));
  }, []);
  useEffect(() => {
    if (connection !== "connected") return;
    const dispatchable = queuedMessages.find(
      (message) =>
        message.status === "queued" &&
        liveSessions.some(
          (session) => session.id === message.sessionId && session.connected && session.status === "idle",
        ),
    );
    if (!dispatchable) return;

    setQueuedMessages((current) => current.filter((message) => message.id !== dispatchable.id));
    void sendVoid(
      {
        type: "session_command",
        requestId: crypto.randomUUID(),
        sessionId: dispatchable.sessionId,
        command: "prompt",
        text: dispatchable.text,
      },
      SESSION_COMMAND_TIMEOUT_MS,
    ).catch((failure: unknown) => {
      setQueuedMessages((current) => [
        {
          ...dispatchable,
          status: "failed",
          error: failure instanceof Error ? failure.message : "The queued message could not be sent",
        },
        ...current,
      ]);
    });
  }, [connection, liveSessions, queuedMessages, sendVoid]);
  const abort = useCallback(
    (sessionId: string) =>
      sendVoid(
        { type: "session_command", requestId: crypto.randomUUID(), sessionId, command: "abort" },
        SESSION_COMMAND_TIMEOUT_MS,
      ),
    [sendVoid],
  );
  const kill = useCallback(
    (sessionId: string) =>
      sendVoid(
        { type: "session_command", requestId: crypto.randomUUID(), sessionId, command: "kill" },
        SESSION_COMMAND_TIMEOUT_MS,
      ),
    [sendVoid],
  );
  const setModel = useCallback(
    (sessionId: string, model: string) =>
      sendVoid({
        type: "session_command",
        requestId: crypto.randomUUID(),
        sessionId,
        command: "set_model",
        model,
      }),
    [sendVoid],
  );
  const setEffort = useCallback(
    (sessionId: string, effort: Effort) =>
      sendVoid({
        type: "session_command",
        requestId: crypto.randomUUID(),
        sessionId,
        command: "set_effort",
        effort,
      }),
    [sendVoid],
  );
  const respondToAsk = useCallback(
    (sessionId: string, askRequestId: string, response: AskResponse) =>
      sendVoid({
        type: "ask_response",
        requestId: crypto.randomUUID(),
        sessionId,
        askRequestId,
        response,
      }),
    [sendVoid],
  );
  const askActivity = useCallback((sessionId: string, askRequestId: string): Promise<void> => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "ask_activity", sessionId, askRequestId }));
    }
    return Promise.resolve();
  }, []);
  const subscribeNotificationEvents = useCallback((listener: NotificationEventListener) => {
    notificationListenersRef.current.add(listener);
    return () => notificationListenersRef.current.delete(listener);
  }, []);
  const pushVapidPublicKey = useCallback(
    () =>
      send({ type: "push_vapid_public_key", requestId: crypto.randomUUID() }, PUSH_COMMAND_TIMEOUT_MS).then(
        (value) => {
          if (value.type !== "push_vapid_public_key") {
            throw new Error("The host did not return its push public key");
          }
          return value.publicKey;
        },
      ),
    [send],
  );
  const registerPushSubscription = useCallback(
    (registration: PushSubscriptionRegistration) =>
      sendVoid(
        {
          type: "push_subscription_register",
          requestId: crypto.randomUUID(),
          ...registration,
        },
        PUSH_COMMAND_TIMEOUT_MS,
      ),
    [sendVoid],
  );
  const updatePushSubscription = useCallback(
    (update: PushSubscriptionUpdate) =>
      sendVoid(
        {
          type: "push_subscription_update",
          requestId: crypto.randomUUID(),
          ...update,
        },
        PUSH_COMMAND_TIMEOUT_MS,
      ),
    [sendVoid],
  );
  const removePushSubscription = useCallback(
    (removal: PushSubscriptionRemoval) =>
      sendVoid(
        {
          type: "push_subscription_remove",
          requestId: crypto.randomUUID(),
          ...removal,
        },
        PUSH_COMMAND_TIMEOUT_MS,
      ),
    [sendVoid],
  );
  const reportApplicationError = useCallback(
    (error: ReportApplicationErrorInput): Promise<void> => {
      const input = {
        source: "browser" as const,
        severity: error.severity ?? ("error" as const),
        message: error.message,
        ...(error.errorName ? { errorName: error.errorName } : {}),
        ...(error.stack ? { stack: error.stack } : {}),
        ...(error.context ? { context: error.context } : {}),
        ...(error.id ? { id: error.id } : {}),
        ...(error.timestamp ? { timestamp: error.timestamp } : {}),
      };
      return sendVoid(
        {
          type: "report_application_error",
          requestId: crypto.randomUUID(),
          error: input,
        },
        REPORT_APPLICATION_ERROR_TIMEOUT_MS,
      );
    },
    [sendVoid],
  );

  const sessions = useMemo(() => {
    const merged = mergeSessions(
      historySessions,
      historyQuery
        ? liveSessions.filter((session) => sessionMatchesQuery(session, historyQuery))
        : liveSessions,
    );
    return overlaySessionCosts(merged, costSummaryBySessionRef.current);
  }, [costRevision, historyQuery, historySessions, liveSessions]);

  return {
    sessions,
    queuedMessages,
    askRequests,
    savedWorkingDirectories,
    sessionsReady: sessionSourcesReady(liveSessionsReady, historySessionsReady),
    historyLoading,
    hasMoreHistory: historyNextOffset !== null,
    connection,
    error: historyError ?? connectionError,
    transcriptHistory,
    subscribeNotificationEvents,
    launch,
    saveWorkingDirectory,
    removeWorkingDirectory,
    command,
    abort,
    cancelQueuedMessage,
    kill,
    setModel,
    setEffort,
    respondToAsk,
    askActivity,
    searchHistory,
    loadMoreHistory,
    loadTranscript,
    loadOlderTranscript,
    retryTranscript,
    reloadTranscript,
    loadSession,
    loadCost,
    loadSessionFileChanges: loadSessionFileChangesCallback,
    loadSessionBranchTopology: loadSessionBranchTopologyCallback,
    switchBranch,
    pushVapidPublicKey,
    registerPushSubscription,
    updatePushSubscription,
    removePushSubscription,
    applicationErrors,
    applicationErrorsHealth,
    applicationErrorsLoading,
    applicationErrorsError,
    clearApplicationErrors,
    reportApplicationError,
    loadApplicationErrors,
  };
}
