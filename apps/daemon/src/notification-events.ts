import {
  getMainSessionIds,
  type AskRequest,
  type NotificationEvent,
  NotificationEventSchema,
  type Session,
} from "@omp-remote/protocol";

const MAX_NOTIFICATION_BODY_NAME = 900;
const MAX_NOTIFICATION_TAG = 256;

type NotificationEventState = {
  sessions: readonly Session[] | null;
  asks: readonly AskRequest[];
  notifiedAskIdentities: ReadonlySet<string>;
};

export function findNotificationEvents(
  previousSessions: readonly Session[] | null,
  sessions: readonly Session[],
  previousAskRequests: readonly AskRequest[] = [],
  askRequests: readonly AskRequest[] = [],
): NotificationEvent[] {
  if (!previousSessions) return [];
  const previousById = new Map(previousSessions.map((session) => [session.id, session]));
  const currentById = new Map(sessions.map((session) => [session.id, session]));
  const rootSessionIds = getMainSessionIds([...previousSessions, ...sessions]);
  const previousAskIdentities = new Set(previousAskRequests.map(askIdentity));
  const notifications: NotificationEvent[] = [];
  const inputRequiredSessionIds = new Set<string>();

  for (const request of askRequests) {
    const session = currentById.get(request.sessionId);
    if (
      !session ||
      !rootSessionIds.has(session.id) ||
      !session.connected ||
      session.source === "history" ||
      session.status === "history"
    )
      continue;
    inputRequiredSessionIds.add(session.id);
    if (previousAskIdentities.has(askIdentity(request))) continue;

    notifications.push(
      NotificationEventSchema.parse({
        type: "notification_event",
        event: "inputRequired",
        title: "Input required",
        body: `${boundedDisplayName(session)} is waiting for input.`,
        tag: boundedNotificationTag(`session-${session.id}-ask-${request.requestId}`),
        url: sessionUrl(session.id),
      }),
    );
  }

  for (const session of sessions) {
    const previous = previousById.get(session.id);
    if (
      !previous ||
      !rootSessionIds.has(session.id) ||
      !session.connected ||
      session.source === "history" ||
      session.status === "history"
    )
      continue;
    const displayName = boundedDisplayName(session);
    if (session.status === "waiting" && previous.status !== "waiting") {
      if (inputRequiredSessionIds.has(session.id)) continue;
      notifications.push(
        NotificationEventSchema.parse({
          type: "notification_event",
          event: "inputRequired",
          title: "Input required",
          body: `${displayName} is waiting for input.`,
          tag: boundedNotificationTag(`session-${session.id}-waiting`),
          url: sessionUrl(session.id),
        }),
      );
    } else if (previous.status === "running" && session.status === "idle") {
      notifications.push(
        NotificationEventSchema.parse({
          type: "notification_event",
          event: "sessionIdle",
          title: "Session idle",
          body: `${displayName} finished and is idle.`,
          tag: boundedNotificationTag(`session-${session.id}-idle`),
          url: sessionUrl(session.id),
        }),
      );
    }
  }

  return notifications;
}

export class NotificationEventTracker {
  #state: NotificationEventState = { sessions: null, asks: [], notifiedAskIdentities: new Set() };

  observeSessions(sessions: readonly Session[]): NotificationEvent[] {
    const previousAskRequests = this.#state.asks.filter((ask) =>
      this.#state.notifiedAskIdentities.has(askIdentity(ask)),
    );
    const notifications = findNotificationEvents(
      this.#state.sessions === null ? [] : this.#state.sessions,
      sessions,
      previousAskRequests,
      this.#state.asks,
    );
    const notifiedAskIdentities = new Set(this.#state.notifiedAskIdentities);
    for (const identity of eligibleAskIdentities(sessions, this.#state.asks))
      notifiedAskIdentities.add(identity);
    this.#state = { sessions, asks: this.#state.asks, notifiedAskIdentities };
    return notifications;
  }

  observeAsk(request: AskRequest): NotificationEvent[] {
    const nextAsks = [...this.#state.asks.filter((ask) => ask.sessionId !== request.sessionId), request];
    const previousAskRequests = this.#state.asks.filter((ask) =>
      this.#state.notifiedAskIdentities.has(askIdentity(ask)),
    );
    const notifications = this.#state.sessions
      ? findNotificationEvents(this.#state.sessions, this.#state.sessions, previousAskRequests, nextAsks)
      : [];
    const notifiedAskIdentities = new Set(this.#state.notifiedAskIdentities);
    if (this.#state.sessions) {
      for (const identity of eligibleAskIdentities(this.#state.sessions, nextAsks)) {
        notifiedAskIdentities.add(identity);
      }
    }
    this.#state = { sessions: this.#state.sessions, asks: nextAsks, notifiedAskIdentities };
    return notifications;
  }

  clearAsk(sessionId: string, requestId?: string): void {
    const asks = this.#state.asks.filter(
      (ask) => ask.sessionId !== sessionId || (requestId !== undefined && ask.requestId !== requestId),
    );
    this.#state = {
      sessions: this.#state.sessions,
      asks,
      notifiedAskIdentities: new Set(
        asks.map(askIdentity).filter((identity) => this.#state.notifiedAskIdentities.has(identity)),
      ),
    };
  }
}
function eligibleAskIdentities(sessions: readonly Session[], asks: readonly AskRequest[]): Set<string> {
  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  const rootSessionIds = getMainSessionIds(sessions);
  const identities = new Set<string>();
  for (const ask of asks) {
    const session = sessionById.get(ask.sessionId);
    if (
      session &&
      rootSessionIds.has(session.id) &&
      session.connected &&
      session.source !== "history" &&
      session.status !== "history"
    ) {
      identities.add(askIdentity(ask));
    }
  }
  return identities;
}

function askIdentity(request: AskRequest): string {
  return `${request.sessionId}:${request.requestId}`;
}

function boundedNotificationTag(value: string): string {
  return value.length <= MAX_NOTIFICATION_TAG ? value : value.slice(0, MAX_NOTIFICATION_TAG);
}

function boundedDisplayName(session: Session): string {
  const displayName = session.name ?? session.cwd;
  return displayName.length <= MAX_NOTIFICATION_BODY_NAME
    ? displayName
    : `${displayName.slice(0, MAX_NOTIFICATION_BODY_NAME - 1)}…`;
}

function sessionUrl(sessionId: string): string {
  return `/?${new URLSearchParams({ session: sessionId })}`;
}
