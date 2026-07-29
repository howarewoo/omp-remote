import type { Session, TranscriptMessage } from "@omp-remote/protocol";

const MAX_TRANSCRIPT_MESSAGES = 200;

export type SessionRegistryEvent =
  | { type: "session_upsert"; session: Session }
  | { type: "transcript_upsert"; sessionId: string; message: TranscriptMessage };

export class SessionRegistry {
  readonly #sessions = new Map<string, Session>();
  readonly #listeners = new Set<(event: SessionRegistryEvent) => void>();

  list(): Session[] {
    return [...this.#sessions.values()]
      .map(cloneSession)
      .sort((left, right) => right.lastActivity.localeCompare(left.lastActivity));
  }

  get(sessionId: string): Session | undefined {
    const session = this.#sessions.get(sessionId);
    return session ? cloneSession(session) : undefined;
  }

  upsert(session: Session): Session {
    const next = cloneSession(session);
    this.#sessions.set(session.id, next);
    this.#emit({ type: "session_upsert", session: next });
    return cloneSession(next);
  }

  update(sessionId: string, patch: Partial<Omit<Session, "id" | "messages">>): Session | undefined {
    const current = this.#sessions.get(sessionId);
    if (!current) return undefined;
    const next = cloneSession({ ...current, ...patch, messages: current.messages });
    this.#sessions.set(sessionId, next);
    this.#emit({ type: "session_upsert", session: next });
    return cloneSession(next);
  }

  appendMessage(sessionId: string, message: TranscriptMessage): Session | undefined {
    const current = this.#sessions.get(sessionId);
    if (!current) return undefined;
    const messages = [...current.messages];
    const existingIndex = messages.findIndex((item) => item.id === message.id);
    if (existingIndex >= 0) messages[existingIndex] = { ...message };
    else messages.push({ ...message });
    const boundedMessages = messages.slice(-MAX_TRANSCRIPT_MESSAGES);
    const next = { ...current, messages: boundedMessages, lastActivity: message.timestamp };
    this.#sessions.set(sessionId, next);
    this.#emit({ type: "transcript_upsert", sessionId, message });
    return cloneSession(next);
  }

  remove(sessionId: string): boolean {
    return this.#sessions.delete(sessionId);
  }

  subscribe(listener: (event: SessionRegistryEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(event: SessionRegistryEvent): void {
    for (const listener of this.#listeners) {
      listener(
        event.type === "session_upsert"
          ? { type: event.type, session: cloneSession(event.session) }
          : { type: event.type, sessionId: event.sessionId, message: { ...event.message } },
      );
    }
  }
}

function cloneSession(session: Session): Session {
  return {
    ...session,
    capabilities: [...session.capabilities],
    messages: session.messages.map((message) => ({ ...message })),
    activeSubagents: session.activeSubagents.map((subagent) => ({ ...subagent })),
  };
}
