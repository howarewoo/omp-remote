import {
  type ApplicationErrorLedgerResponse,
  ApplicationErrorLedgerResponseSchema,
  type ApplicationErrorRecord,
  type AskRequest,
  type BrowserCommand,
  type CommandResult,
  compareSessionsByCreation,
  type NotificationEvent,
  type Session,
  type SessionBranchTopology,
  SessionBranchTopologySchema,
  type SessionCostResponse,
  SessionCostResponseSchema,
  type SessionFileChangesResponse,
  SessionFileChangesResponseSchema,
  type SessionPatch,
  SessionSchema,
  type SessionTranscriptResponse,
  TRANSCRIPT_PAGE_SIZE,
  SessionTranscriptResponseSchema,
} from "@omp-remote/protocol";

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
  cursor?: string | null,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<SessionTranscriptResponse> {
  if (cursor === "") throw new Error("Transcript cursor cannot be empty");
  const url = cursor
    ? `/api/sessions/${encodeURIComponent(sessionId)}/transcript?cursor=${encodeURIComponent(cursor)}`
    : `/api/sessions/${encodeURIComponent(sessionId)}/transcript`;
  const response = await fetcher(url, signal ? { signal } : {});
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

export function sessionMatchesQuery(session: Session, query: string): boolean {
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

export type TranscriptProvenance = WeakSet<Session["messages"][number]>;

export function cleanupSessionHistory(
  sessions: Session[],
  sessionId: string,
  provenance: TranscriptProvenance,
): Session[] {
  return sessions.map((s) =>
    s.id === sessionId
      ? {
          ...s,
          messages: (provenance ? s.messages.filter((m) => !provenance.has(m)) : s.messages).slice(
            -TRANSCRIPT_PAGE_SIZE,
          ),
        }
      : s,
  );
}

export function applyTranscriptToSessions(
  sessions: Session[],
  transcript: SessionTranscriptResponse,
  preserveUnavailableMessage?: (message: Session["messages"][number]) => boolean,
): Session[] {
  const canonicalIds = new Set(transcript.messages.map((m) => m.id));
  return sessions.map((session) => {
    if (session.id === transcript.sessionId) {
      if (transcript.status === "unavailable" && preserveUnavailableMessage) {
        const currentById = new Map(session.messages.map((message) => [message.id, message]));
        const messages = transcript.messages.map((serverMessage) => {
          const currentMessage = currentById.get(serverMessage.id);
          if (!currentMessage) return serverMessage;
          if (currentMessage.streaming === true && serverMessage.streaming !== true) return serverMessage;
          if (currentMessage.streaming !== true && serverMessage.streaming === true) return currentMessage;
          return preserveUnavailableMessage(currentMessage) ? currentMessage : serverMessage;
        });
        for (const currentMessage of session.messages) {
          if (!canonicalIds.has(currentMessage.id) && preserveUnavailableMessage(currentMessage)) {
            messages.push(currentMessage);
          }
        }
        return { ...session, messages };
      }
      const activeStreamingTail = session.messages.filter(
        (m) => m.streaming === true && !canonicalIds.has(m.id),
      );
      return { ...session, messages: [...transcript.messages, ...activeStreamingTail] };
    }
    return session.source === "history" && session.parentSessionId == null && session.messages.length > 0
      ? { ...session, messages: [] }
      : session;
  });
}

export function prependTranscriptMessages(
  olderMessages: Session["messages"],
  currentMessages: Session["messages"],
): Session["messages"] {
  const currentIds = new Set(currentMessages.map((message) => message.id));
  const seen = new Set<string>();
  const toPrepend: Session["messages"] = [];
  for (const message of olderMessages) {
    if (!currentIds.has(message.id) && !seen.has(message.id)) {
      seen.add(message.id);
      toPrepend.push(message);
    }
  }
  return [...toPrepend, ...currentMessages];
}

export function prependTranscriptToSessions(
  sessions: Session[],
  transcript: SessionTranscriptResponse,
): Session[] {
  return sessions.map((s) =>
    s.id === transcript.sessionId
      ? { ...s, messages: prependTranscriptMessages(transcript.messages, s.messages) }
      : s,
  );
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
  return merged;
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
    return { ...session, messages, lastActivity: message.timestamp };
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

export function upsertSession(sessions: Session[], session: Session): Session[] {
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

export function compareApplicationErrorsNewestFirst(
  left: ApplicationErrorRecord,
  right: ApplicationErrorRecord,
): number {
  return right.timestamp.localeCompare(left.timestamp) || left.id.localeCompare(right.id);
}

export function deduplicateAndSortApplicationErrors(
  records: readonly ApplicationErrorRecord[],
): ApplicationErrorRecord[] {
  const byId = new Map<string, ApplicationErrorRecord>();
  for (const record of records) {
    byId.set(record.id, record);
  }
  return [...byId.values()].sort(compareApplicationErrorsNewestFirst);
}

export function addApplicationErrorRecord(
  current: readonly ApplicationErrorRecord[],
  newRecord: ApplicationErrorRecord,
): ApplicationErrorRecord[] {
  const byId = new Map<string, ApplicationErrorRecord>();
  for (const record of current) {
    byId.set(record.id, record);
  }
  byId.set(newRecord.id, newRecord);
  return [...byId.values()].sort(compareApplicationErrorsNewestFirst);
}

export async function loadApplicationErrorsLedger(
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<ApplicationErrorLedgerResponse> {
  const response = await fetcher("/api/application-errors", signal ? { signal } : {});
  if (!response.ok) throw new Error(`Application errors request failed (${response.status})`);
  return ApplicationErrorLedgerResponseSchema.parse(await response.json());
}

export async function clearApplicationErrorsLedger(
  fetcher: typeof fetch = fetch,
): Promise<{ ok: boolean; clearedCount?: number }> {
  const response = await fetcher("/api/application-errors", { method: "DELETE" });
  if (!response.ok) {
    let hostError: string | null = null;
    try {
      const body: unknown = await response.json();
      hostError =
        typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
          ? body.error
          : null;
    } catch {
      // ignore JSON parse failure
    }
    throw new Error(hostError ?? `Application errors could not be cleared (${response.status})`);
  }
  const body = (await response.json()) as { ok?: boolean; clearedCount?: number };
  const result: { ok: boolean; clearedCount?: number } = { ok: body.ok ?? true };
  if (typeof body.clearedCount === "number") {
    result.clearedCount = body.clearedCount;
  }
  return result;
}
const MAX_SERVER_ERROR_LENGTH = 500;

export type ConnectionState = "connecting" | "connected" | "disconnected";
type SuccessfulCommandValue = Extract<CommandResult["outcome"], { status: "ok" }>["value"];
export type PendingCommand = {
  commandType: BrowserCommand["type"];
  resolve: (value: SuccessfulCommandValue) => void;
  reject: (error: Error) => void;
  timeoutId?: ReturnType<typeof globalThis.setTimeout>;
};
export type NotificationEventListener = (event: NotificationEvent) => void;
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
