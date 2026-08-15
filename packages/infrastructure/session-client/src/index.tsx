import {
  type AskRequest,
  type AskResponse,
  type BrowserCommand,
  type CommandResult,
  compareSessionsByCreation,
  type Effort,
  type NotificationEvent,
  type PushSubscriptionRegistration,
  type PushSubscriptionRemoval,
  type PushSubscriptionUpdate,
  ServerFrameSchema,
  type Session,
  type SessionBranchTopology,
  SessionBranchTopologySchema,
  SessionCatalogPageSchema,
  type SessionCostResponse,
  SessionCostResponseSchema,
  type SessionFileChangesResponse,
  SessionFileChangesResponseSchema,
  type SessionPatch,
  SessionSchema,
  type SessionTranscriptResponse,
  SessionTranscriptResponseSchema,
} from "@omp-remote/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const RECONNECT_DELAY_MS = 1_500;
const INITIAL_SNAPSHOT_DEADLINE_MS = 10_000;
const CATALOG_PAGE_SIZE = 100;
const SWITCH_BRANCH_TIMEOUT_MS = 30_000;
const PUSH_COMMAND_TIMEOUT_MS = 10_000;
const MAX_SERVER_ERROR_LENGTH = 500;

type ConnectionState = "connecting" | "connected" | "disconnected";
type SuccessfulCommandValue = Extract<CommandResult["outcome"], { status: "ok" }>["value"];
type PendingCommand = {
  commandType: BrowserCommand["type"];
  resolve: (value: SuccessfulCommandValue) => void;
  reject: (error: Error) => void;
  timeoutId?: ReturnType<typeof globalThis.setTimeout>;
};
export type NotificationEventListener = (event: NotificationEvent) => void;
export interface QueuedUserMessage {
  id: string;
  sessionId: string;
  text: string;
  createdAt: string;
  status: "queued" | "failed";
  error?: string;
}

export function createConnectionFreshnessTracker() {
  let snapshotReceived = false;
  let recoveryInFlight = false;
  return {
    markConnectionStarted(): void {
      snapshotReceived = false;
    },
    hasSnapshot(): boolean {
      return snapshotReceived;
    },
    markSnapshotReceived(): void {
      snapshotReceived = true;
      recoveryInFlight = false;
    },
    beginRecovery(): boolean {
      if (recoveryInFlight) return false;
      recoveryInFlight = true;
      snapshotReceived = false;
      return true;
    },
  };
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
  loadSession(sessionId: string): Promise<void>;
  pushVapidPublicKey(): Promise<string>;
  registerPushSubscription(registration: PushSubscriptionRegistration): Promise<void>;
  updatePushSubscription(update: PushSubscriptionUpdate): Promise<void>;
  removePushSubscription(removal: PushSubscriptionRemoval): Promise<void>;
}

function clearPendingCommandTimeout(pending: PendingCommand): void {
  if (pending.timeoutId !== undefined) globalThis.clearTimeout(pending.timeoutId);
}

export function sendBrowserCommand(
  socket: WebSocket | null,
  pendingCommands: Map<string, PendingCommand>,
  frame: Exclude<BrowserCommand, { type: "ask_activity" }>,
  timeoutMs?: number,
): Promise<SuccessfulCommandValue> {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error("The host is not connected"));
  }
  return new Promise<SuccessfulCommandValue>((resolve, reject) => {
    const pending: PendingCommand = { commandType: frame.type, resolve, reject };
    pendingCommands.set(frame.requestId, pending);
    if (timeoutMs !== undefined) {
      pending.timeoutId = globalThis.setTimeout(() => {
        if (pendingCommands.get(frame.requestId) !== pending) return;
        pendingCommands.delete(frame.requestId);
        reject(new Error("The host did not respond before the command timed out"));
      }, timeoutMs);
    }
    try {
      socket.send(JSON.stringify(frame));
    } catch (failure) {
      clearPendingCommandTimeout(pending);
      pendingCommands.delete(frame.requestId);
      reject(failure instanceof Error ? failure : new Error("The command could not be sent"));
    }
  });
}

export function boundedServerError(message: string | null | undefined, fallback: string): string {
  const normalized = message?.trim();
  if (!normalized) return fallback;
  return normalized.length <= MAX_SERVER_ERROR_LENGTH
    ? normalized
    : `${normalized.slice(0, MAX_SERVER_ERROR_LENGTH - 1)}…`;
}
export function resolvePendingCommand(
  pendingCommands: Map<string, PendingCommand>,
  result: CommandResult,
): boolean {
  const pending = pendingCommands.get(result.requestId);
  if (!pending) return false;
  clearPendingCommandTimeout(pending);
  pendingCommands.delete(result.requestId);
  if (result.outcome.status === "error") {
    pending.reject(new Error(boundedServerError(result.outcome.error, "The host rejected the command")));
    return true;
  }
  try {
    pending.resolve(commandResultValue(pending.commandType, result.outcome.value));
  } catch (error) {
    pending.reject(error instanceof Error ? error : new Error("The host returned an invalid command result"));
  }
  return true;
}

export function rejectPendingCommands(
  pendingCommands: Map<string, PendingCommand>,
  message = "Dashboard disconnected",
): void {
  for (const pending of pendingCommands.values()) {
    clearPendingCommandTimeout(pending);
    pending.reject(new Error(message));
  }
  pendingCommands.clear();
}
export function dispatchNotificationEvent(
  listeners: ReadonlySet<NotificationEventListener>,
  event: NotificationEvent,
): void {
  for (const listener of listeners) listener(event);
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
  const detailsAbortRef = useRef<AbortController | null>(null);
  const costAbortRef = useRef<AbortController | null>(null);
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
          setAskRequests((current) => current.filter((request) => request.sessionId !== frame.sessionId));
        } else if (frame.type === "saved_working_directories") {
          setSavedWorkingDirectories(frame.savedWorkingDirectories);
        } else if (frame.type === "command_result") {
          resolvePendingCommand(pendingRef.current, frame);
        } else if (frame.type === "notification_event") {
          dispatchNotificationEvent(notificationListenersRef.current, frame);
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
    const requestNumber = ++transcriptRequestRef.current;
    transcriptAbortRef.current?.abort();
    const abortController = new AbortController();
    transcriptAbortRef.current = abortController;
    setHistoryError(null);
    try {
      const transcript = await loadSessionTranscript(sessionId, abortController.signal);
      if (requestNumber !== transcriptRequestRef.current || abortController.signal.aborted) return;
      setHistorySessions((sessions) => applyTranscriptToSessions(sessions, transcript));
      setLiveSessions((sessions) => applyTranscriptToSessions(sessions, transcript));
    } catch (error) {
      if (abortController.signal.aborted || requestNumber !== transcriptRequestRef.current) return;
      const message = error instanceof Error ? error.message : "Session transcript could not be loaded";
      setHistoryError(message);
      throw error;
    } finally {
      if (transcriptAbortRef.current === abortController) transcriptAbortRef.current = null;
    }
  }, []);

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
      send({ type: "launch", requestId: crypto.randomUUID(), cwd, resume }).then((value) => {
        if (value.type !== "launch") throw new Error("The host did not identify the launched session");
        return value.sessionId;
      }),
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
      return sendVoid({
        type: "session_command",
        requestId: crypto.randomUUID(),
        sessionId,
        command: commandName,
        text,
      });
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
    void sendVoid({
      type: "session_command",
      requestId: crypto.randomUUID(),
      sessionId: dispatchable.sessionId,
      command: "prompt",
      text: dispatchable.text,
    }).catch((failure: unknown) => {
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
      sendVoid({ type: "session_command", requestId: crypto.randomUUID(), sessionId, command: "abort" }),
    [sendVoid],
  );
  const kill = useCallback(
    (sessionId: string) =>
      sendVoid({ type: "session_command", requestId: crypto.randomUUID(), sessionId, command: "kill" }),
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
    loadSession,
    loadCost,
    loadSessionFileChanges: loadSessionFileChangesCallback,
    loadSessionBranchTopology: loadSessionBranchTopologyCallback,
    switchBranch,
    pushVapidPublicKey,
    registerPushSubscription,
    updatePushSubscription,
    removePushSubscription,
  };
}
export async function loadSessionDetails(
  sessionId: string,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<Session> {
  const response = await fetcher(`/api/sessions/${encodeURIComponent(sessionId)}`, signal ? { signal } : {});
  if (!response.ok) throw new Error(`Session details request failed (${response.status})`);
  const result = SessionSchema.parse(await response.json());
  if (result.id !== sessionId) throw new Error("Session details response did not match the request");
  return result;
}

export async function loadSessionTranscript(
  sessionId: string,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<SessionTranscriptResponse> {
  const response = await fetcher(
    `/api/sessions/${encodeURIComponent(sessionId)}/transcript`,
    signal ? { signal } : {},
  );
  if (!response.ok) throw new Error(`Session transcript request failed (${response.status})`);
  const result = SessionTranscriptResponseSchema.parse(await response.json());
  if (result.sessionId !== sessionId)
    throw new Error("Session transcript response did not match the request");
  return result;
}

export async function loadSessionCost(
  sessionId: string,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<SessionCostResponse> {
  const response = await fetcher(
    `/api/sessions/${encodeURIComponent(sessionId)}/cost`,
    signal ? { signal } : {},
  );
  if (!response.ok) throw new Error(`Session cost request failed (${response.status})`);
  const result = SessionCostResponseSchema.parse(await response.json());
  if (result.sessionId !== sessionId) throw new Error("Session cost response did not match the request");
  return result;
}
export async function loadSessionBranchTopology(
  sessionId: string,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<SessionBranchTopology> {
  const response = await fetcher(
    `/api/sessions/${encodeURIComponent(sessionId)}/branches`,
    signal ? { signal } : {},
  );
  if (!response.ok) {
    let hostError: string | null = null;
    try {
      const body: unknown = await response.json();
      hostError =
        typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
          ? body.error
          : null;
    } catch (failure) {
      const isAbortError =
        typeof failure === "object" && failure !== null && "name" in failure && failure.name === "AbortError";
      if (signal?.aborted || isAbortError) throw failure;
    }
    throw new Error(hostError ?? `Session branch topology request failed (${response.status})`);
  }
  return SessionBranchTopologySchema.parse(await response.json());
}

export async function loadSessionFileChanges(
  sessionId: string,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<SessionFileChangesResponse> {
  const response = await fetcher(
    `/api/sessions/${encodeURIComponent(sessionId)}/changes`,
    signal ? { signal } : {},
  );
  if (!response.ok) {
    let hostError: string | null = null;
    try {
      const body: unknown = await response.json();
      hostError =
        typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
          ? body.error
          : null;
    } catch (failure) {
      const isAbortError =
        typeof failure === "object" && failure !== null && "name" in failure && failure.name === "AbortError";
      if (signal?.aborted || isAbortError) throw failure;
      // The status fallback remains useful when a proxy or interrupted response does not return JSON.
    }
    throw new Error(hostError ?? `Session file changes request failed (${response.status})`);
  }
  return SessionFileChangesResponseSchema.parse(await response.json());
}

export function commandResultValue(
  commandType: BrowserCommand["type"],
  value: SuccessfulCommandValue,
): SuccessfulCommandValue {
  if (commandType === "launch") {
    if (value.type !== "launch") throw new Error("The host did not identify the launched session");
    return value;
  }
  if (commandType === "push_vapid_public_key") {
    if (value.type !== "push_vapid_public_key") {
      throw new Error("The host did not return its push public key");
    }
    return value;
  }
  if (value.type !== "void") throw new Error("The host returned a result for a different command");
  return value;
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

export function mergeSessions(base: Session[], overrides: Session[]): Session[] {
  const sessions = new Map(base.map((session) => [session.id, session]));
  for (const session of overrides) {
    const current = sessions.get(session.id);
    sessions.set(
      session.id,
      current
        ? {
            ...current,
            ...session,
            messages: mergeTranscriptMessages(current.messages, session.messages),
          }
        : session,
    );
  }
  return [...sessions.values()].sort(compareSessionsByCreation);
}

export function upsertLoadedSession(sessions: Session[], loaded: Session): Session[] {
  const index = sessions.findIndex((session) => session.id === loaded.id);
  const current = sessions[index];
  if (!current) return mergeSessions(sessions, [loaded]);

  const messages = mergeTranscriptMessages(loaded.messages, current.messages);
  const currentIsLive = current.source !== "history";
  const topology =
    !currentIsLive && loaded.parentSessionId === undefined && current.parentSessionId !== undefined
      ? { parentSessionId: current.parentSessionId }
      : {};
  const merged = currentIsLive
    ? { ...loaded, ...current, messages }
    : { ...current, ...loaded, ...topology, messages };
  const next = [...sessions];
  next[index] = merged;
  return next.sort(compareSessionsByCreation);
}

export function overlaySessionCosts(
  sessions: Session[],
  costs: ReadonlyMap<string, Session["costSummary"] | null>,
): Session[] {
  let updated: Session[] | undefined;
  for (const [index, session] of sessions.entries()) {
    const costSummary = costs.get(session.id);
    if (costSummary === undefined || session.costSummary === costSummary) continue;
    let nextSession: Session;
    if (costSummary) {
      nextSession = { ...session, costSummary };
    } else {
      if (session.costSummary === undefined) continue;
      const { costSummary: _ignoredCostSummary, ...withoutCostSummary } = session;
      void _ignoredCostSummary;
      nextSession = withoutCostSummary;
    }
    updated ??= [...sessions];
    updated[index] = nextSession;
  }
  return updated ?? sessions;
}

function sessionMatchesQuery(session: Session, query: string): boolean {
  const normalizedQuery = query.toLocaleLowerCase();
  return [session.id, session.name, session.cwd, session.sessionPath]
    .filter((value): value is string => typeof value === "string")
    .some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
}
export function snapshotSessionsWithCurrentMessages(
  snapshotSessions: Session[],
  currentSessions: Session[],
): Session[] {
  const currentMessagesById = new Map(
    currentSessions
      .filter((session) => session.messages.length > 0)
      .map((session) => [session.id, session.messages]),
  );
  return snapshotSessions.map((session) => ({
    ...session,
    messages: currentMessagesById.get(session.id) ?? session.messages,
  }));
}

export function applyTranscriptToSessions(
  sessions: Session[],
  transcript: SessionTranscriptResponse,
): Session[] {
  return sessions.map((session) => {
    if (session.id === transcript.sessionId) {
      return { ...session, messages: mergeTranscriptMessages(transcript.messages, session.messages) };
    }
    return session.source === "history" && session.parentSessionId == null && session.messages.length > 0
      ? { ...session, messages: [] }
      : session;
  });
}

export function mergeTranscriptMessages(
  serverMessages: Session["messages"],
  currentMessages: Session["messages"],
): Session["messages"] {
  const currentById = new Map(currentMessages.map((message) => [message.id, message]));
  const merged = serverMessages.map((message) => currentById.get(message.id) ?? message);
  const serverIds = new Set(serverMessages.map((message) => message.id));
  for (const message of currentMessages) {
    if (!serverIds.has(message.id)) merged.push(message);
  }
  return merged.slice(-200);
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
  if (patch.parentSessionId !== undefined) updated.parentSessionId = patch.parentSessionId;
  if (patch.activeSubagents !== undefined) updated.activeSubagents = patch.activeSubagents;
  if (patch.skillCommands !== undefined) updated.skillCommands = patch.skillCommands;
  if (patch.costSummary !== undefined) updated.costSummary = patch.costSummary;
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
