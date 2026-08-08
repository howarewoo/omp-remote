import { createHash } from "node:crypto";
import {
  closeSync,
  createReadStream,
  type Dir,
  constants as fsConstants,
  fstatSync,
  openSync,
  readSync,
} from "node:fs";
import { type FileHandle, open, opendir, readdir, stat } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import {
  boundTranscriptImageBudget,
  compareSessionsByCreation,
  getTranscriptImageByteLength,
  type Session,
  type SessionCostAgent,
  type SessionCostSummary,
  TRANSCRIPT_IMAGE_MAX_BYTES,
  TRANSCRIPT_IMAGE_SESSION_MAX_BYTES,
  type TranscriptImage,
  type TranscriptImageMimeType,
  type TranscriptMessage,
  truncateTranscriptText,
  validateTranscriptImageBytes,
} from "@omp-remote/protocol";
import { materializeReadImages, normalizeRawMessage, ToolCallTracker } from "./message-normalizer.js";

const METADATA_READ_BYTES = 16 * 1024;
const MAX_TRANSCRIPT_MESSAGES = 200;
const METADATA_READ_CONCURRENCY = 32;
const COST_HYDRATION_CONCURRENCY = 4;
const MAX_FILE_CHANGE_SOURCES = 256;

export interface SessionFileChangeSourceDescriptor {
  sessionId: string;
  root: string;
  sessionPath: string;
}

export interface SessionFileChangeSourceSelection {
  sources: SessionFileChangeSourceDescriptor[];
  truncated: boolean;
}

interface SessionCostData {
  totalUsd: number;
  exact: boolean;
}

interface SessionMetadata {
  exited: boolean;
  session: Session;
}

interface CatalogEntry {
  fingerprint: string;
  path: string;
  session: Session;
  exited: boolean;
  cost?: SessionCostData;
}

interface CostCacheEntry {
  fingerprint: string;
  cost: SessionCostData | null;
}

interface SessionCatalogOptions {
  onDiff?: (diff: CatalogDiff) => void;
  beforeHydration?: () => Promise<void>;
  startHydrationImmediately?: boolean;
  beforeRefreshCommit?: () => Promise<void>;
}

interface HydrationTask {
  path: string;
  fingerprint: string;
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
  #onDiff: ((diff: CatalogDiff) => void) | undefined;
  #beforeHydration: (() => Promise<void>) | undefined;
  #beforeRefreshCommit: (() => Promise<void>) | undefined;
  #entriesByPath = new Map<string, CatalogEntry>();
  #entriesBySessionId = new Map<string, CatalogEntry>();
  #rootEntriesBySessionId = new Map<string, CatalogEntry>();
  #sortedSessions: Session[] = [];
  #costCache = new Map<string, CostCacheEntry>();
  #hydrationQueue = new Map<string, HydrationTask>();
  #hydrating = new Map<string, string>();
  #activeHydrations = 0;
  #hydrationStarted: boolean;
  #hydrationWaiters: Array<() => void> = [];

  constructor(roots: string[], options: SessionCatalogOptions = {}) {
    this.#roots = [...new Set(roots)];
    this.#onDiff = options.onDiff;
    this.#beforeHydration = options.beforeHydration;
    this.#hydrationStarted = options.startHydrationImmediately ?? true;
    this.#beforeRefreshCommit = options.beforeRefreshCommit;
  }

  setDiffListener(listener: ((diff: CatalogDiff) => void) | undefined): void {
    this.#onDiff = listener;
  }

  async refresh(): Promise<CatalogDiff> {
    const paths = await findSessionFiles(this.#roots);
    const candidates: Array<{ fingerprint: string; path: string }> = [];
    for (const path of paths) {
      try {
        const fileStats = await stat(path);
        candidates.push({ path, fingerprint: `${fileStats.size}:${fileStats.mtimeMs}` });
      } catch (error) {
        if (!isMissingPathError(error)) throw error;
      }
    }

    const parsedEntries = await mapWithConcurrency(
      candidates,
      METADATA_READ_CONCURRENCY,
      async ({ fingerprint, path }) => {
        const costCache = this.#costCache.get(path);
        const cost = costCache?.fingerprint === fingerprint ? (costCache.cost ?? undefined) : undefined;
        const cached = this.#entriesByPath.get(path);
        const withCost = cost ? { cost } : {};
        if (cached?.fingerprint === fingerprint) return { ...cached, ...withCost };
        const metadata = await readSessionMetadata(path);
        return metadata ? { fingerprint, path, ...metadata, ...withCost } : null;
      },
    );
    await this.#beforeRefreshCommit?.();
    const nextEntriesByPath = new Map<string, CatalogEntry>();
    const hydrationPaths: HydrationTask[] = [];
    for (const entry of parsedEntries) {
      if (!entry) continue;
      const cached = this.#costCache.get(entry.path);
      const latestCost = cached?.fingerprint === entry.fingerprint ? (cached.cost ?? undefined) : undefined;
      if (latestCost) {
        nextEntriesByPath.set(entry.path, { ...entry, cost: latestCost });
      } else {
        const { cost: _ignoredCost, ...withoutCost } = entry;
        void _ignoredCost;
        nextEntriesByPath.set(entry.path, withoutCost);
      }
      if (cached?.fingerprint !== entry.fingerprint) {
        hydrationPaths.push({ path: entry.path, fingerprint: entry.fingerprint });
      }
    }

    for (const path of this.#costCache.keys()) {
      if (!nextEntriesByPath.has(path)) this.#costCache.delete(path);
    }

    const diff = this.#commitEntries(nextEntriesByPath);
    for (const task of hydrationPaths) this.#scheduleHydration(task);
    return diff;
  }
  startHydration(): void {
    if (this.#hydrationStarted) return;
    this.#hydrationStarted = true;
    this.#pumpHydrationQueue();
  }

  async waitForHydration(): Promise<void> {
    if (this.#activeHydrations === 0 && this.#hydrationQueue.size === 0) return;
    await new Promise<void>((resolve) => this.#hydrationWaiters.push(resolve));
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
    const entry = this.#entriesBySessionId.get(sessionId);
    if (!entry) throw new Error("Session history was not found");
    return readTranscript(entry.path, findOwningBlobDirectory(entry.path, this.#roots));
  }

  fileChangeSources(sessionId: string): SessionFileChangeSourceSelection | undefined {
    const selectedRoot = this.#rootEntriesBySessionId.get(sessionId);
    if (!selectedRoot) return undefined;
    const sessionPaths = new Set(this.#entriesByPath.keys());
    const matching = [...this.#entriesByPath.values()]
      .filter((entry) => findRootSessionPath(entry.path, sessionPaths) === selectedRoot.path)
      .sort((left, right) => left.path.localeCompare(right.path));
    const sources = matching.slice(0, MAX_FILE_CHANGE_SOURCES).map((entry) => ({
      sessionId: entry.session.id,
      root: resolve(entry.session.cwd),
      sessionPath: entry.path,
    }));
    return { sources, truncated: matching.length > sources.length };
  }

  #commitEntries(entriesByPath: Map<string, CatalogEntry>): CatalogDiff {
    const sessionPaths = new Set(entriesByPath.keys());
    const rootPaths = new Set<string>();
    const activeSubagentsByRoot = new Map<string, Session["activeSubagents"]>();
    for (const entry of entriesByPath.values()) {
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
      const entry = entriesByPath.get(rootPath);
      if (!entry) continue;
      const activeSubagents = (activeSubagentsByRoot.get(rootPath) ?? []).sort((left, right) =>
        right.lastActivity.localeCompare(left.lastActivity),
      );
      const session = { ...entry.session, activeSubagents };
      const costSummary = buildCostSummary(rootPath, entriesByPath, sessionPaths);
      if (costSummary) {
        entriesByPath.set(rootPath, { ...entry, session: { ...session, costSummary } });
      } else {
        const { costSummary: _ignoredCostSummary, ...withoutCostSummary } = session;
        void _ignoredCostSummary;
        entriesByPath.set(rootPath, { ...entry, session: withoutCostSummary });
      }
    }

    const nextEntriesBySessionId = new Map<string, CatalogEntry>();
    const nextRootEntriesBySessionId = new Map<string, CatalogEntry>();
    for (const entry of entriesByPath.values()) {
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
        previous?.fingerprint !== entry.fingerprint ||
        !sessionsEqual(previous.session, entry.session)
      ) {
        upserted.push(cloneSession(entry.session));
      }
    }
    const removed = [...this.#rootEntriesBySessionId.keys()].filter(
      (sessionId) => !nextRootEntriesBySessionId.has(sessionId),
    );

    this.#entriesByPath = entriesByPath;
    this.#entriesBySessionId = nextEntriesBySessionId;
    this.#rootEntriesBySessionId = nextRootEntriesBySessionId;
    this.#sortedSessions = [...nextRootEntriesBySessionId.values()]
      .map((entry) => entry.session)
      .sort(compareSessionsByCreation);
    const diff = { upserted, removed };
    if (upserted.length || removed.length) {
      try {
        this.#onDiff?.(diff);
      } catch {
        // A listener failure must not poison hydration or future refreshes.
      }
    }
    return diff;
  }

  #scheduleHydration(task: HydrationTask): void {
    if (this.#hydrating.get(task.path) === task.fingerprint) return;
    if (this.#hydrationQueue.get(task.path)?.fingerprint === task.fingerprint) return;
    this.#hydrationQueue.set(task.path, task);
    if (this.#hydrationStarted) this.#pumpHydrationQueue();
  }

  #pumpHydrationQueue(): void {
    while (this.#activeHydrations < COST_HYDRATION_CONCURRENCY && this.#hydrationQueue.size) {
      const nextTask = [...this.#hydrationQueue.values()].find(
        (candidate) => !this.#hydrating.has(candidate.path),
      );
      if (!nextTask) return;
      this.#hydrationQueue.delete(nextTask.path);
      this.#activeHydrations += 1;
      this.#hydrating.set(nextTask.path, nextTask.fingerprint);
      void this.#hydrate(nextTask).finally(() => {
        this.#activeHydrations -= 1;
        if (this.#hydrating.get(nextTask.path) === nextTask.fingerprint) {
          this.#hydrating.delete(nextTask.path);
        }
        this.#pumpHydrationQueue();
        if (this.#activeHydrations === 0 && this.#hydrationQueue.size === 0) {
          const waiters = this.#hydrationWaiters.splice(0);
          for (const resolve of waiters) resolve();
        }
      });
    }
  }

  async #hydrate(task: HydrationTask): Promise<void> {
    let cost: SessionCostData | null;
    await this.#beforeHydration?.();
    try {
      cost = await readSessionCost(task.path);
    } catch (error) {
      if (isMissingPathError(error)) return;
      cost = null;
    }
    const current = this.#entriesByPath.get(task.path);
    if (!current || current.fingerprint !== task.fingerprint) return;
    this.#costCache.set(task.path, { fingerprint: task.fingerprint, cost });
    const nextEntries = new Map(this.#entriesByPath);
    if (cost) {
      nextEntries.set(task.path, { ...current, cost });
    } else {
      const { cost: _ignoredCost, ...withoutCost } = current;
      void _ignoredCost;
      nextEntries.set(task.path, withoutCost);
    }
    this.#commitEntries(nextEntries);
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
        skillCommands: [],
      },
    };
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  } finally {
    await handle?.close();
  }
}
async function readSessionCost(path: string): Promise<SessionCostData> {
  let totalUsd = 0;
  let exact = true;
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of lines) {
    const record = parseRecord(line);
    if (record?.type !== "message" || !isRecord(record.message) || record.message.role !== "assistant")
      continue;
    const usage = isRecord(record.message.usage) ? record.message.usage : null;
    const cost = usage && isRecord(usage.cost) ? usage.cost : null;
    const value = cost?.total;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      exact = false;
      continue;
    }
    const nextTotal = totalUsd + value;
    if (!Number.isFinite(nextTotal)) {
      exact = false;
      continue;
    }
    totalUsd = nextTotal;
  }
  return { totalUsd, exact };
}

async function readTranscript(path: string, blobDirectory?: string): Promise<TranscriptMessage[]> {
  const ring = new Array<{ record: Record<string, unknown>; message: TranscriptMessage }>(
    MAX_TRANSCRIPT_MESSAGES,
  );
  let messageCount = 0;
  const toolCallTracker = new ToolCallTracker();
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of lines) {
    const record = parseRecord(line);
    const message = record ? normalizeTranscriptMessage(record, toolCallTracker) : null;
    if (!message || !record) continue;
    ring[messageCount % MAX_TRANSCRIPT_MESSAGES] = { record, message };
    messageCount += 1;
  }
  const retained =
    messageCount <= MAX_TRANSCRIPT_MESSAGES
      ? ring.slice(0, messageCount)
      : (() => {
          const start = messageCount % MAX_TRANSCRIPT_MESSAGES;
          return [...ring.slice(start), ...ring.slice(0, start)];
        })();
  if (!blobDirectory) return boundTranscriptImageBudget(retained.map(({ message }) => message));
  const resolveImage = createReadImageResolver(blobDirectory);
  return boundTranscriptImageBudget(
    retained.map(({ record, message }) => materializeReadImages(message, record.message, resolveImage)),
  );
}

function normalizeTranscriptMessage(
  record: Record<string, unknown>,
  toolCallTracker: ToolCallTracker,
): TranscriptMessage | null {
  if (record.type !== "message" || !isRecord(record.message)) return null;
  const timestamp = normalizeTimestamp(record.timestamp ?? record.message.timestamp);
  const message = normalizeRawMessage(
    record.message,
    false,
    typeof record.id === "string" ? record.id : (text) => `${timestamp}-${messageHash(text)}`,
    {
      timestamp,
      omitEmptyText: true,
      ignoreRawId: true,
      toolCallTracker,
    },
  );
  return message ? { ...message, text: truncateTranscriptText(message.text) } : null;
}

function normalizeTimestamp(value: unknown, fallback?: Date): string {
  if (typeof value === "number" || typeof value === "string") {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return (fallback ?? new Date()).toISOString();
}

export function resolveAgentBlobDirectory(sessionPath: string): string | undefined {
  const marker = "/sessions/";
  const markerIndex = sessionPath.lastIndexOf(marker);
  return markerIndex >= 0 ? join(sessionPath.slice(0, markerIndex), "blobs") : undefined;
}

function findOwningBlobDirectory(path: string, roots: readonly string[]): string | undefined {
  const owningRoot = roots.find((root) => path === root || path.startsWith(`${root}/`));
  return owningRoot ? join(dirname(owningRoot), "blobs") : undefined;
}

function resolveReadImage(
  blobDirectory: string,
  reference: string,
  mimeType: string,
  maxBytes = TRANSCRIPT_IMAGE_MAX_BYTES,
): TranscriptImage {
  const match = /^blob:sha256:([a-f0-9]{64})$/.exec(reference);
  const hash = match?.[1];
  if (!hash) return { status: "unavailable", reason: "invalid_reference" };
  let handle: number | undefined;
  try {
    const blobPath = join(blobDirectory, hash);
    handle = openSync(blobPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const fileStats = fstatSync(handle);
    if (!fileStats.isFile()) return { status: "unavailable", reason: "invalid_reference" };
    if (fileStats.size > TRANSCRIPT_IMAGE_MAX_BYTES) return { status: "unavailable", reason: "oversized" };
    if (fileStats.size > maxBytes) return { status: "unavailable", reason: "budget_exceeded" };
    const buffer = Buffer.allocUnsafe(Math.min(TRANSCRIPT_IMAGE_MAX_BYTES, maxBytes) + 1);
    const bytesRead = readSync(handle, buffer, 0, buffer.length, 0);
    if (bytesRead > TRANSCRIPT_IMAGE_MAX_BYTES) return { status: "unavailable", reason: "oversized" };
    if (bytesRead > maxBytes) return { status: "unavailable", reason: "budget_exceeded" };
    const bytes = buffer.subarray(0, bytesRead);
    if (createHash("sha256").update(bytes).digest("hex") !== hash) {
      return { status: "unavailable", reason: "invalid_reference" };
    }
    const reason = validateTranscriptImageBytes(bytes, mimeType);
    if (reason) return { status: "unavailable", reason };
    return {
      status: "available",
      mimeType: mimeType as TranscriptImageMimeType,
      data: bytes.toString("base64"),
    };
  } catch {
    return { status: "unavailable", reason: "missing" };
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
}
export function createReadImageResolver(
  blobDirectory: string,
): (data: string, mimeType: string) => TranscriptImage {
  let retainedBytes = 0;
  return (data, mimeType) => {
    const remainingBytes = TRANSCRIPT_IMAGE_SESSION_MAX_BYTES - retainedBytes;
    if (remainingBytes <= 0) return { status: "unavailable", reason: "budget_exceeded" };
    const image = resolveReadImage(blobDirectory, data, mimeType, remainingBytes);
    if (image.status !== "available") return image;
    const imageBytes = getTranscriptImageByteLength(image);
    if (retainedBytes + imageBytes > TRANSCRIPT_IMAGE_SESSION_MAX_BYTES) {
      return { status: "unavailable", reason: "budget_exceeded" };
    }
    retainedBytes += imageBytes;
    return image;
  };
}

function fallbackSessionName(path: string, id: string, cwd: string, rawTimestamp: unknown): string | null {
  const stem = basename(path, extname(path));
  if (typeof rawTimestamp !== "string" && typeof rawTimestamp !== "number") return stem;
  const timestamp = new Date(rawTimestamp);
  if (Number.isNaN(timestamp.getTime())) return stem;
  const generatedStem = `${timestamp.toISOString().replace(/[:.]/g, "-")}_${id}`;
  return stem === generatedStem ? basename(cwd) || null : stem;
}

function findRootSessionPath(path: string, sessionPaths: ReadonlySet<string>): string {
  let rootPath = path;
  while (true) {
    const parentPath = `${dirname(rootPath)}.jsonl`;
    if (!sessionPaths.has(parentPath)) return rootPath;
    rootPath = parentPath;
  }
}
function buildCostSummary(
  rootPath: string,
  entriesByPath: ReadonlyMap<string, CatalogEntry>,
  sessionPaths: ReadonlySet<string>,
): SessionCostSummary | undefined {
  const children = new Map<string, string[]>();
  const descendants = [...entriesByPath.values()].filter(
    (entry) => findRootSessionPath(entry.path, sessionPaths) === rootPath,
  );
  for (const entry of descendants) {
    if (entry.path === rootPath) continue;
    const parentPath = findNearestParentSessionPath(entry.path, sessionPaths) ?? rootPath;
    const siblings = children.get(parentPath) ?? [];
    siblings.push(entry.path);
    children.set(parentPath, siblings);
  }
  for (const paths of children.values()) paths.sort((left, right) => left.localeCompare(right));

  const orderedPaths: string[] = [];
  const append = (path: string): void => {
    orderedPaths.push(path);
    for (const child of children.get(path) ?? []) append(child);
  };
  append(rootPath);

  let totalUsd = 0;
  const agents: SessionCostAgent[] = [];
  for (const path of orderedPaths) {
    const entry = entriesByPath.get(path);
    if (!entry?.cost?.exact) return undefined;
    const parentPath =
      path === rootPath ? null : (findNearestParentSessionPath(path, sessionPaths) ?? rootPath);
    const nextTotal = totalUsd + entry.cost.totalUsd;
    if (!Number.isFinite(nextTotal)) return undefined;
    totalUsd = nextTotal;
    agents.push({
      sessionId: entry.session.id,
      name: entry.session.name ?? basename(path, extname(path)),
      parentSessionId: parentPath ? (entriesByPath.get(parentPath)?.session.id ?? null) : null,
      totalUsd: entry.cost.totalUsd,
      available: true,
    });
  }
  return { totalUsd, partial: false, agents };
}

function findNearestParentSessionPath(path: string, sessionPaths: ReadonlySet<string>): string | null {
  let separatorIndex = path.lastIndexOf("/");
  while (separatorIndex > 0) {
    const parentPath = `${path.slice(0, separatorIndex)}.jsonl`;
    if (sessionPaths.has(parentPath)) return parentPath;
    separatorIndex = path.lastIndexOf("/", separatorIndex - 1);
  }
  return null;
}

function sessionsEqual(left: Session, right: Session): boolean {
  if ((left.costSummary === undefined) !== (right.costSummary === undefined)) return false;
  if (left.costSummary && right.costSummary) {
    if (
      left.costSummary.totalUsd !== right.costSummary.totalUsd ||
      left.costSummary.partial !== right.costSummary.partial ||
      left.costSummary.agents.length !== right.costSummary.agents.length ||
      !left.costSummary.agents.every((agent, index) => {
        const other = right.costSummary?.agents[index];
        return (
          agent.sessionId === other?.sessionId &&
          agent.name === other.name &&
          agent.parentSessionId === other.parentSessionId &&
          agent.totalUsd === other.totalUsd &&
          agent.available === other.available
        );
      })
    ) {
      return false;
    }
  }
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
    ...(session.costSummary
      ? {
          costSummary: {
            ...session.costSummary,
            agents: session.costSummary.agents.map((agent) => ({ ...agent })),
          },
        }
      : {}),
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
