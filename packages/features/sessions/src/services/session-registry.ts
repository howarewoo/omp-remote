import {
  boundTranscriptImageBudget,
  compareSessionsByCreation,
  type Session,
  type SessionPatch,
  type TranscriptMessage,
  truncateTranscriptText,
} from "@omp-remote/protocol";

const MAX_TRANSCRIPT_MESSAGES = 200;

export type SessionRegistryEvent =
  | { type: "session_upsert"; session: Session }
  | { type: "session_update"; sessionId: string; patch: SessionPatch }
  | { type: "transcript_upsert"; sessionId: string; message: TranscriptMessage };

export class SessionRegistry {
  readonly #sessions = new Map<string, Session>();
  readonly #listeners = new Set<(event: SessionRegistryEvent) => void>();

  list(): Session[] {
    return [...this.#sessions.values()].map(cloneSession).sort(compareSessionsByCreation);
  }

  get(sessionId: string): Session | undefined {
    const session = this.#sessions.get(sessionId);
    return session ? cloneSession(session) : undefined;
  }
  upsert(session: Session): Session {
    const next = cloneSession({
      ...session,
      messages: boundTranscriptImageBudget(session.messages),
    });
    this.#sessions.set(session.id, next);
    this.#emit({ type: "session_upsert", session: next });
    return cloneSession(next);
  }

  update(sessionId: string, patch: SessionPatch): Session | undefined {
    const current = this.#sessions.get(sessionId);
    if (!current) return undefined;
    const detachedPatch = cloneSessionPatch(patch);
    const next = cloneSession({ ...current, ...detachedPatch, messages: current.messages });
    this.#sessions.set(sessionId, next);
    this.#emit({ type: "session_update", sessionId, patch: detachedPatch });
    return cloneSession(next);
  }

  appendMessage(sessionId: string, message: TranscriptMessage): Session | undefined {
    const current = this.#sessions.get(sessionId);
    if (!current) return undefined;
    const messageCopy = cloneTranscriptMessage(message);
    const messages = [...current.messages];
    const existingIndex = messages.findIndex((item) => item.id === messageCopy.id);
    if (existingIndex >= 0) messages[existingIndex] = messageCopy;
    else messages.push(messageCopy);
    const boundedMessages = boundTranscriptImageBudget(messages.slice(-MAX_TRANSCRIPT_MESSAGES));
    const boundedMessage = boundedMessages.find((item) => item.id === messageCopy.id) ?? messageCopy;
    const next = { ...current, messages: boundedMessages, lastActivity: boundedMessage.timestamp };
    this.#sessions.set(sessionId, next);
    const changedMessages = boundedMessages.filter((candidate) => {
      const previous = current.messages.find((item) => item.id === candidate.id);
      return candidate.id === messageCopy.id || !previous || !transcriptImagesEqual(previous, candidate);
    });
    for (const changedMessage of changedMessages) {
      this.#emit({ type: "transcript_upsert", sessionId, message: changedMessage });
    }
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
      if (event.type === "session_upsert") {
        listener({ type: event.type, session: cloneSession(event.session) });
      } else if (event.type === "session_update") {
        listener({
          type: event.type,
          sessionId: event.sessionId,
          patch: cloneSessionPatch(event.patch),
        });
      } else {
        listener({
          type: event.type,
          sessionId: event.sessionId,
          message: cloneTranscriptMessage(event.message),
        });
      }
    }
  }
}

function transcriptImagesEqual(left: TranscriptMessage, right: TranscriptMessage): boolean {
  if (left.images?.length !== right.images?.length) return false;
  for (let index = 0; index < (left.images?.length ?? 0); index += 1) {
    const leftImage = left.images?.[index];
    const rightImage = right.images?.[index];
    if (!leftImage || !rightImage || leftImage.status !== rightImage.status) return false;
    if (leftImage.status === "unavailable" && rightImage.status === "unavailable") {
      if (leftImage.reason !== rightImage.reason) return false;
      continue;
    }
    if (leftImage.status !== "available" || rightImage.status !== "available") return false;
    if (leftImage.mimeType !== rightImage.mimeType || leftImage.data !== rightImage.data) return false;
  }
  return true;
}

function cloneSession(session: Session): Session {
  return {
    ...session,
    capabilities: [...session.capabilities],
    ...(session.availableModels
      ? {
          availableModels: session.availableModels.map((model) => ({
            ...model,
            efforts: [...model.efforts],
          })),
        }
      : {}),
    messages: session.messages.map(cloneTranscriptMessage),
    ...(session.costSummary
      ? {
          costSummary: {
            ...session.costSummary,
            agents: session.costSummary.agents.map((agent) => ({ ...agent })),
          },
        }
      : {}),
    activeSubagents: session.activeSubagents.map((subagent) => ({ ...subagent })),
    skillCommands: session.skillCommands.map((command) => ({ ...command })),
  };
}

function cloneTranscriptMessage(message: TranscriptMessage): TranscriptMessage {
  return {
    ...message,
    text: truncateTranscriptText(message.text),
    ...(message.images ? { images: message.images.map((image) => ({ ...image })) } : {}),
    ...(message.lifecycle ? { lifecycle: { ...message.lifecycle } } : {}),
  };
}

function cloneSessionPatch(patch: SessionPatch): Partial<Omit<Session, "id" | "messages">> {
  const clone: Partial<Omit<Session, "id" | "messages">> = {};
  if (patch.source !== undefined) clone.source = patch.source;
  if (patch.name !== undefined) clone.name = patch.name;
  if (patch.cwd !== undefined) clone.cwd = patch.cwd;
  if (patch.branch !== undefined) clone.branch = patch.branch;
  if (patch.status !== undefined) clone.status = patch.status;
  if (patch.connected !== undefined) clone.connected = patch.connected;
  if (patch.model !== undefined) clone.model = patch.model;
  if (patch.effort !== undefined) clone.effort = patch.effort;
  if (patch.availableModels !== undefined) {
    clone.availableModels = patch.availableModels.map((model) => ({
      ...model,
      efforts: [...model.efforts],
    }));
  }
  if (patch.contextPercent !== undefined) clone.contextPercent = patch.contextPercent;
  if (patch.createdAt !== undefined) clone.createdAt = patch.createdAt;
  if (patch.lastActivity !== undefined) clone.lastActivity = patch.lastActivity;
  if (patch.capabilities !== undefined) clone.capabilities = [...patch.capabilities];
  if (patch.sessionPath !== undefined) clone.sessionPath = patch.sessionPath;
  if (patch.parentSessionId !== undefined) clone.parentSessionId = patch.parentSessionId;
  if (patch.activeSubagents !== undefined) {
    clone.activeSubagents = patch.activeSubagents.map((subagent) => ({ ...subagent }));
  }
  if (patch.skillCommands !== undefined) {
    clone.skillCommands = patch.skillCommands.map((command) => ({ ...command }));
  }
  if (patch.costSummary !== undefined) {
    clone.costSummary = {
      ...patch.costSummary,
      agents: patch.costSummary.agents.map((agent) => ({ ...agent })),
    };
  }
  return clone;
}
