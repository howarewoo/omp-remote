import { createReadStream, type Dir } from "node:fs";
import { type FileHandle, open, opendir, readdir, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { createInterface } from "node:readline";
import { compareSessionsByCreation, type Session, type TranscriptMessage } from "@omp-remote/protocol";
import { normalizeRawMessage } from "./message-normalizer.js";

const METADATA_READ_BYTES = 16 * 1024;
const MAX_TRANSCRIPT_MESSAGES = 200;
const MAX_TRANSCRIPT_TEXT = 20_000;
const METADATA_READ_CONCURRENCY = 32;

interface SessionMetadata {
  exited: boolean;
  session: Session;
}

interface CatalogEntry {
  fingerprint: string;
  path: string;
  session: Session;
  exited: boolean;
}

export interface CatalogDiff {
  upserted: Session[];
  removed: string[];
}

export interface CatalogQuery {
  offset: number;
  limit: number;
  query: string;
}

export interface CatalogPage {
  sessions: Session[];
  total: number;
  nextOffset: number | null;
}

export async function resolveSessionRoots(homeDirectory: string, agentDirectory?: string): Promise<string[]> {
  const roots = new Set<string>();
  roots.add(join(agentDirectory ?? join(homeDirectory, ".omp", "agent"), "sessions"));
  const profilesDirectory = join(homeDirectory, ".omp", "profiles");
  try {
    const profiles = await readdir(profilesDirectory, { withFileTypes: true });
    for (const profile of profiles
      .filter((entry) => entry.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name))) {
      roots.add(join(profilesDirectory, profile.name, "agent", "sessions"));
    }
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }
  return [...roots];
}

export class SessionCatalog {
  readonly #roots: string[];
  #entriesByPath = new Map<string, CatalogEntry>();
  #entriesBySessionId = new Map<string, CatalogEntry>();
  #rootEntriesBySessionId = new Map<string, CatalogEntry>();
  #sortedSessions: Session[] = [];

  constructor(roots: string[]) {
    this.#roots = [...new Set(roots)];
  }

  async refresh(): Promise<CatalogDiff> {
    const paths = await findSessionFiles(this.#roots);
    const nextEntriesByPath = new Map<string, CatalogEntry>();
    const uncachedPaths: Array<{ fingerprint: string; path: string }> = [];

    for (const path of paths) {
      try {
        const fileStats = await stat(path);
        const fingerprint = `${fileStats.size}:${fileStats.mtimeMs}`;
        const cached = this.#entriesByPath.get(path);
        if (cached?.fingerprint === fingerprint) nextEntriesByPath.set(path, cached);
        else uncachedPaths.push({ fingerprint, path });
      } catch (error) {
        if (!isMissingPathError(error)) throw error;
      }
    }

    const parsedEntries = await mapWithConcurrency(
      uncachedPaths,
      METADATA_READ_CONCURRENCY,
      async ({ fingerprint, path }) => {
        const metadata = await readSessionMetadata(path);
        return metadata ? { fingerprint, path, ...metadata } : null;
      },
    );
    for (const entry of parsedEntries) {
      if (entry) nextEntriesByPath.set(entry.path, entry);
    }

    const sessionPaths = new Set(nextEntriesByPath.keys());
    const rootPaths = new Set<string>();
    const activeSubagentsByRoot = new Map<string, Session["activeSubagents"]>();
    for (const entry of nextEntriesByPath.values()) {
      const rootPath = findRootSessionPath(entry.path, sessionPaths);
      if (rootPath === entry.path) {
        rootPaths.add(rootPath);
      } else if (!entry.exited) {
        const activeSubagents = activeSubagentsByRoot.get(rootPath) ?? [];
        activeSubagents.push({
          id: entry.session.id,
          name: entry.session.name ?? basename(entry.path, extname(entry.path)),
          lastActivity: entry.session.lastActivity,
        });
        activeSubagentsByRoot.set(rootPath, activeSubagents);
      }
    }

    for (const rootPath of rootPaths) {
      const entry = nextEntriesByPath.get(rootPath);
      if (!entry) continue;
      const activeSubagents = (activeSubagentsByRoot.get(rootPath) ?? []).sort((left, right) =>
        right.lastActivity.localeCompare(left.lastActivity),
      );
      nextEntriesByPath.set(rootPath, {
        ...entry,
        session: { ...entry.session, activeSubagents },
      });
    }

    const nextEntriesBySessionId = new Map<string, CatalogEntry>();
    const nextRootEntriesBySessionId = new Map<string, CatalogEntry>();
    for (const entry of nextEntriesByPath.values()) {
      const existing = nextEntriesBySessionId.get(entry.session.id);
      if (!existing || entry.session.lastActivity > existing.session.lastActivity) {
        nextEntriesBySessionId.set(entry.session.id, entry);
      }
      if (!rootPaths.has(entry.path)) continue;
      const existingRoot = nextRootEntriesBySessionId.get(entry.session.id);
      if (!existingRoot || entry.session.lastActivity > existingRoot.session.lastActivity) {
        nextRootEntriesBySessionId.set(entry.session.id, entry);
      }
    }

    const upserted: Session[] = [];
    for (const [sessionId, entry] of nextRootEntriesBySessionId) {
      const previous = this.#rootEntriesBySessionId.get(sessionId);
      if (
        previous?.path !== entry.path ||
        previous.fingerprint !== entry.fingerprint ||
        !sessionsEqual(previous.session, entry.session)
      ) {
        upserted.push(cloneSession(entry.session));
      }
    }
    const removed = [...this.#rootEntriesBySessionId.keys()].filter(
      (sessionId) => !nextRootEntriesBySessionId.has(sessionId),
    );

    this.#entriesByPath = nextEntriesByPath;
    this.#entriesBySessionId = nextEntriesBySessionId;
    this.#rootEntriesBySessionId = nextRootEntriesBySessionId;
    this.#sortedSessions = [...nextRootEntriesBySessionId.values()]
      .map((entry) => entry.session)
      .sort(compareSessionsByCreation);

    return { upserted, removed };
  }

  list({ offset, limit, query }: CatalogQuery): CatalogPage {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const matches = normalizedQuery
      ? this.#sortedSessions.filter((session) => sessionMatches(session, normalizedQuery))
      : this.#sortedSessions;
    const sessions = matches.slice(offset, offset + limit).map(cloneSession);
    const nextOffset = offset + sessions.length < matches.length ? offset + sessions.length : null;
    return { sessions, total: matches.length, nextOffset };
  }

  get(sessionId: string): Session | undefined {
    const session = this.#entriesBySessionId.get(sessionId)?.session;
    return session ? cloneSession(session) : undefined;
  }

  async transcript(sessionId: string): Promise<TranscriptMessage[]> {
    const path = this.#entriesBySessionId.get(sessionId)?.path;
    if (!path) throw new Error("Session history was not found");
    return readTranscript(path);
  }
}

async function findSessionFiles(roots: string[]): Promise<string[]> {
  const paths: string[] = [];
  for (const root of roots) await collectSessionFiles(root, paths);
  return paths;
}

async function collectSessionFiles(directory: string, paths: string[]): Promise<void> {
  let entries: Dir;
  try {
    entries = await opendir(directory);
  } catch (error) {
    if (isMissingPathError(error)) return;
    throw error;
  }
  for await (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collectSessionFiles(path, paths);
    else if (entry.isFile() && extname(entry.name) === ".jsonl") paths.push(path);
  }
}

async function readSessionMetadata(path: string): Promise<SessionMetadata | null> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, "r");
    const buffer = Buffer.allocUnsafe(METADATA_READ_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
    let title: string | null = null;
    let header: Record<string, unknown> | null = null;
    for (const line of lines) {
      const record = parseRecord(line);
      if (!record) continue;
      if (record.type === "title" && typeof record.title === "string") title = record.title.trim() || null;
      else if (record.type === "session") {
        header = record;
        break;
      }
    }
    if (!header || typeof header.id !== "string" || typeof header.cwd !== "string" || !header.cwd)
      return null;
    const fileStats = await handle.stat();
    const tailOffset = Math.max(0, fileStats.size - buffer.length);
    const tailLength = fileStats.size - tailOffset;
    const tailRead = await handle.read(buffer, 0, tailLength, tailOffset);
    const tailRecords = buffer
      .subarray(0, tailRead.bytesRead)
      .toString("utf8")
      .split("\n")
      .map(parseRecord)
      .filter((record): record is Record<string, unknown> => record !== null);
    const exited = sessionHasEnded(tailRecords);
    const headerTitle = typeof header.title === "string" ? header.title.trim() : "";
    return {
      exited,
      session: {
        id: header.id,
        source: "history",
        name: title ?? (headerTitle || fallbackSessionName(path, header.id, header.cwd, header.timestamp)),
        cwd: header.cwd,
        branch: null,
        status: "history",
        connected: false,
        model: null,
        contextPercent: null,
        createdAt: normalizeTimestamp(
          header.timestamp,
          fileStats.birthtimeMs > 0 ? fileStats.birthtime : fileStats.mtime,
        ),
        lastActivity: fileStats.mtime.toISOString(),
        capabilities: ["resume"],
        messages: [],
        sessionPath: path,
        activeSubagents: [],
      },
    };
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  } finally {
    await handle?.close();
  }
}

async function readTranscript(path: string): Promise<TranscriptMessage[]> {
  const ring = new Array<TranscriptMessage>(MAX_TRANSCRIPT_MESSAGES);
  let messageCount = 0;
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of lines) {
    const record = parseRecord(line);
    const message = record ? normalizeTranscriptMessage(record) : null;
    if (!message) continue;
    ring[messageCount % MAX_TRANSCRIPT_MESSAGES] = message;
    messageCount += 1;
  }
  if (messageCount <= MAX_TRANSCRIPT_MESSAGES) return ring.slice(0, messageCount);
  const start = messageCount % MAX_TRANSCRIPT_MESSAGES;
  return [...ring.slice(start), ...ring.slice(0, start)];
}

function normalizeTranscriptMessage(record: Record<string, unknown>): TranscriptMessage | null {
  if (record.type !== "message" || !isRecord(record.message)) return null;
  const timestamp = normalizeTimestamp(record.timestamp ?? record.message.timestamp);
  return normalizeRawMessage(
    record.message,
    false,
    typeof record.id === "string" ? record.id : (text) => `${timestamp}-${messageHash(text)}`,
    {
      timestamp,
      omitEmptyText: true,
      maxTextLength: MAX_TRANSCRIPT_TEXT,
      ignoreRawId: true,
    },
  );
}

function normalizeTimestamp(value: unknown, fallback?: Date): string {
  if (typeof value === "number" || typeof value === "string") {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return (fallback ?? new Date()).toISOString();
}

function fallbackSessionName(path: string, id: string, cwd: string, rawTimestamp: unknown): string | null {
  const stem = basename(path, extname(path));
  if (typeof rawTimestamp !== "string" && typeof rawTimestamp !== "number") return stem;
  const timestamp = new Date(rawTimestamp);
  if (Number.isNaN(timestamp.getTime())) return stem;
  const generatedStem = `${timestamp.toISOString().replace(/[:.]/g, "-")}_${id}`;
  return stem === generatedStem ? basename(cwd) || null : stem;
}

function findRootSessionPath(path: string, sessionPaths: Set<string>): string {
  let rootPath = path;
  while (true) {
    const parentPath = `${dirname(rootPath)}.jsonl`;
    if (!sessionPaths.has(parentPath)) return rootPath;
    rootPath = parentPath;
  }
}

function sessionsEqual(left: Session, right: Session): boolean {
  return (
    left.activeSubagents.length === right.activeSubagents.length &&
    left.activeSubagents.every((subagent, index) => {
      const other = right.activeSubagents[index];
      return (
        subagent.id === other?.id &&
        subagent.name === other.name &&
        subagent.lastActivity === other.lastActivity
      );
    })
  );
}

function sessionMatches(session: Session, query: string): boolean {
  return [
    session.id,
    session.name,
    session.cwd,
    session.sessionPath,
    ...session.activeSubagents.flatMap((subagent) => [subagent.id, subagent.name]),
  ]
    .filter((value): value is string => typeof value === "string")
    .some((value) => value.toLocaleLowerCase().includes(query));
}

function parseRecord(line: string): Record<string, unknown> | null {
  if (!line) return null;
  try {
    const value: unknown = JSON.parse(line);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function sessionHasEnded(records: Record<string, unknown>[]): boolean {
  let ended = false;
  for (const record of records) {
    if (record.type === "custom" && record.customType === "session_exit") {
      ended = true;
      continue;
    }
    if (record.type !== "message" || !isRecord(record.message)) continue;
    if (record.message.role === "user") {
      ended = false;
      continue;
    }
    if (
      record.message.role === "toolResult" &&
      record.message.toolName === "yield" &&
      record.message.isError !== true &&
      isRecord(record.message.details) &&
      record.message.details.status === "success"
    ) {
      ended = true;
    }
  }
  return ended;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingPathError(error: unknown): boolean {
  return isRecord(error) && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function cloneSession(session: Session): Session {
  return {
    ...session,
    capabilities: [...session.capabilities],
    messages: [],
    activeSubagents: session.activeSubagents.map((subagent) => ({ ...subagent })),
  };
}

function messageHash(text: string): string {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  return hash.toString(16);
}

async function mapWithConcurrency<Input, Output>(
  values: Input[],
  concurrency: number,
  callback: (value: Input) => Promise<Output>,
): Promise<Output[]> {
  const results = new Array<Output>(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await callback(values[index] as Input);
    }
  });
  await Promise.all(workers);
  return results;
}
