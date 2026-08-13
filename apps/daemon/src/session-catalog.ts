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
import { StringDecoder } from "node:string_decoder";
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
const LIFECYCLE_SCAN_BYTES = 128 * 1024;
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
  assigned: boolean | null;
  exited: boolean;
  session: Session;
}

interface CatalogEntry {
  assigned: boolean | null;
  fingerprint: string;
  path: string;
  parentPath?: string | null;
  session: Session;
  exited: boolean;
}

interface CostCacheEntry {
  fingerprint: string;
  cost: SessionCostData | null;
}

interface SessionCatalogOptions {
  onDiff?: (diff: CatalogDiff) => void;
  beforeCostRead?: () => Promise<void>;
  beforeRefreshCommit?: () => Promise<void>;
}

interface CostLoad {
  fingerprint: string;
  promise: Promise<SessionCostData | null>;
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
  #beforeCostRead: (() => Promise<void>) | undefined;
  #beforeRefreshCommit: (() => Promise<void>) | undefined;
  #entriesByPath = new Map<string, CatalogEntry>();
  #entriesBySessionId = new Map<string, CatalogEntry>();
  #rootEntriesBySessionId = new Map<string, CatalogEntry>();
  #sortedSessions: Session[] = [];
  #costCache = new Map<string, CostCacheEntry>();
  #costLoads = new Map<string, CostLoad>();

  constructor(roots: string[], options: SessionCatalogOptions = {}) {
    this.#roots = [...new Set(roots)];
    this.#onDiff = options.onDiff;
    this.#beforeCostRead = options.beforeCostRead;
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
        const cached = this.#entriesByPath.get(path);
        if (cached?.fingerprint === fingerprint) return cached;
        const metadata = await readSessionMetadata(path);
        return metadata ? { fingerprint, path, ...metadata } : null;
      },
    );
    await this.#beforeRefreshCommit?.();
    const nextEntriesByPath = new Map<string, CatalogEntry>();
    for (const entry of parsedEntries) {
      if (entry) nextEntriesByPath.set(entry.path, entry);
    }

    for (const path of this.#costCache.keys()) {
      if (!nextEntriesByPath.has(path)) this.#costCache.delete(path);
    }

    return this.#commitEntries(nextEntriesByPath);
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

  async costSummary(sessionId: string): Promise<SessionCostSummary | undefined> {
    const selectedRoot = this.#rootEntriesBySessionId.get(sessionId);
    if (!selectedRoot) return undefined;
    const entriesByPath = this.#entriesByPath;
    const sessionPaths = new Set(entriesByPath.keys());
    const matching = [...entriesByPath.values()].filter(
      (entry) => findRootSessionPath(entry.path, sessionPaths) === selectedRoot.path,
    );
    const loaded = await mapWithConcurrency(matching, COST_HYDRATION_CONCURRENCY, async (entry) => ({
      entry,
      cost: await this.#loadCost(entry),
    }));
    const currentRoot = this.#rootEntriesBySessionId.get(sessionId);
    if (currentRoot?.path !== selectedRoot.path || currentRoot.fingerprint !== selectedRoot.fingerprint) {
      return undefined;
    }
    const currentEntriesByPath = this.#entriesByPath;
    const currentSessionPaths = new Set(currentEntriesByPath.keys());
    const currentMatching = [...currentEntriesByPath.values()].filter(
      (entry) => findRootSessionPath(entry.path, currentSessionPaths) === currentRoot.path,
    );
    if (
      currentMatching.length !== matching.length ||
      currentMatching.some((entry) => entriesByPath.get(entry.path)?.fingerprint !== entry.fingerprint)
    ) {
      return undefined;
    }
    return buildCostSummary(
      selectedRoot.path,
      entriesByPath,
      sessionPaths,
      new Map(loaded.map(({ entry, cost }) => [entry.path, cost])),
    );
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
      } else if (entry.assigned !== false && !entry.exited) {
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
      entriesByPath.set(rootPath, {
        ...entry,
        session: { ...entry.session, activeSubagents },
      });
    }

    const entriesWithTopology = new Map<string, CatalogEntry>();
    for (const entry of entriesByPath.values()) {
      const rootPath = findRootSessionPath(entry.path, sessionPaths);
      const parentPath = findNearestParentSessionPath(entry.path, sessionPaths);
      const immediateParentPath = `${dirname(entry.path)}.jsonl`;
      const previousEntry = this.#entriesByPath.get(entry.path);
      const previousParentSessionId = previousEntry?.session.parentSessionId;
      const previousParentPath = previousEntry?.parentPath;
      const session = { ...entry.session };
      delete session.parentSessionId;
      const missingImmediateParent = !sessionPaths.has(immediateParentPath);
      let parentSessionId: string | null | undefined;
      let topologyParentPath: string | null | undefined;
      if (parentPath && !missingImmediateParent) {
        parentSessionId = entriesByPath.get(parentPath)?.session.id;
        topologyParentPath = parentPath;
      } else if (
        missingImmediateParent &&
        previousParentSessionId !== undefined &&
        previousParentSessionId !== null &&
        previousParentPath === immediateParentPath
      ) {
        parentSessionId = previousParentSessionId;
        topologyParentPath = previousParentPath;
      } else if (rootPath === entry.path && parentPath === null) {
        parentSessionId = null;
        topologyParentPath = null;
      }
      entriesWithTopology.set(entry.path, {
        ...entry,
        ...(topologyParentPath === undefined ? {} : { parentPath: topologyParentPath }),
        session: {
          ...session,
          ...(parentSessionId === undefined ? {} : { parentSessionId }),
        },
      });
    }
    entriesByPath = entriesWithTopology;

    const nextEntriesBySessionId = new Map<string, CatalogEntry>();
    for (const entry of entriesByPath.values()) {
      const existing = nextEntriesBySessionId.get(entry.session.id);
      if (!existing || entry.session.lastActivity > existing.session.lastActivity) {
        nextEntriesBySessionId.set(entry.session.id, entry);
      }
    }

    const nextRootEntriesBySessionId = new Map<string, CatalogEntry>();
    for (const entry of nextEntriesBySessionId.values()) {
      if (entry.session.parentSessionId !== null) continue;
      nextRootEntriesBySessionId.set(entry.session.id, entry);
    }
    const upserted: Session[] = [];
    for (const [sessionId, entry] of nextEntriesBySessionId) {
      const previous = this.#entriesBySessionId.get(sessionId);
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
        // A listener failure must not poison future refreshes.
      }
    }
    return diff;
  }

  async #loadCost(entry: CatalogEntry): Promise<SessionCostData | null> {
    const cached = this.#costCache.get(entry.path);
    if (cached?.fingerprint === entry.fingerprint) return cached.cost;
    const existing = this.#costLoads.get(entry.path);
    if (existing?.fingerprint === entry.fingerprint) return existing.promise;

    const load: CostLoad = {
      fingerprint: entry.fingerprint,
      promise: (async () => {
        await this.#beforeCostRead?.();
        let cost: SessionCostData | null;
        try {
          cost = await readSessionCost(entry.path);
        } catch {
          cost = null;
        }
        if (this.#entriesByPath.get(entry.path)?.fingerprint === entry.fingerprint) {
          this.#costCache.set(entry.path, { fingerprint: entry.fingerprint, cost });
        }
        return cost;
      })(),
    };
    this.#costLoads.set(entry.path, load);
    try {
      return await load.promise;
    } finally {
      if (this.#costLoads.get(entry.path) === load) this.#costLoads.delete(entry.path);
    }
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
    const fileStats = await handle.stat();
    const buffer = Buffer.allocUnsafe(METADATA_READ_BYTES);
    const headLength = Math.min(fileStats.size, buffer.length);
    const { bytesRead: headBytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (headBytesRead !== headLength) return null;
    const headText = buffer.subarray(0, headBytesRead).toString("utf8");
    const headLines = headText.split("\n");
    let title: string | null = null;
    let header: Record<string, unknown> | null = null;
    for (const line of headLines) {
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

    const tailOffset = Math.max(0, fileStats.size - buffer.length);
    const tailLength = fileStats.size - tailOffset;
    const tailRead = await handle.read(buffer, 0, tailLength, tailOffset);
    if (tailRead.bytesRead !== tailLength) return null;
    const tailText = buffer.subarray(0, tailRead.bytesRead).toString("utf8");
    const tailLines = tailText.split("\n");
    const headWindow = inspectLifecycleWindow(headLines, headText.endsWith("\n"), false);
    const tailWindow = inspectLifecycleWindow(tailLines, tailText.endsWith("\n"), tailOffset !== 0);
    let lifecycle: SessionLifecycle;
    const trustedAssignmentWindow =
      !headWindow.malformed &&
      !tailWindow.incomplete &&
      !tailWindow.malformed &&
      (headWindow.assigned || tailWindow.assigned);
    if (
      (!tailOffset &&
        !headWindow.incomplete &&
        !tailWindow.incomplete &&
        !headWindow.malformed &&
        !tailWindow.malformed &&
        (headWindow.assigned || tailWindow.assigned || tailWindow.exited)) ||
      trustedAssignmentWindow
    ) {
      lifecycle = {
        assigned: headWindow.assigned || tailWindow.assigned,
        exited: tailWindow.exited,
      };
    } else {
      lifecycle = await scanSessionLifecycle(
        handle,
        fileStats.size,
        headWindow,
        tailWindow,
        tailText.endsWith("\n"),
        tailOffset,
      );
    }
    if ((await handle.stat()).size !== fileStats.size) {
      lifecycle = { assigned: null, exited: false };
    }

    const headerTitle = typeof header.title === "string" ? header.title.trim() : "";
    return {
      assigned: lifecycle.assigned,
      exited: lifecycle.exited,
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

interface SessionLifecycle {
  assigned: boolean | null;
  exited: boolean;
}

interface LifecycleWindow {
  assigned: boolean;
  exited: boolean;
  incomplete: boolean;
  malformed: boolean;
}

function inspectLifecycleWindow(lines: string[], complete: boolean, skipFirst: boolean): LifecycleWindow {
  const lifecycle: LifecycleWindow = {
    assigned: false,
    exited: false,
    incomplete: !complete,
    malformed: false,
  };
  const first = skipFirst ? 1 : 0;
  const last = complete ? lines.length : Math.max(first, lines.length - 1);
  for (let index = first; index < last; index += 1) {
    const line = lines[index];
    if (!line) continue;
    const record = parseRecord(line);
    if (!record) {
      lifecycle.malformed = true;
      continue;
    }
    updateSessionLifecycle(record, lifecycle);
  }
  return lifecycle;
}

async function scanSessionLifecycle(
  handle: FileHandle,
  fileSize: number,
  headWindow: LifecycleWindow,
  tailWindow: LifecycleWindow,
  complete: boolean,
  tailOffset: number,
): Promise<SessionLifecycle> {
  const finish = async (lifecycle: SessionLifecycle): Promise<SessionLifecycle> =>
    (await handle.stat()).size === fileSize ? lifecycle : { assigned: null, exited: false };
  const oversized = fileSize > LIFECYCLE_SCAN_BYTES;
  const lifecycle: LifecycleWindow = {
    assigned: false,
    exited: false,
    incomplete: !complete,
    malformed: headWindow.malformed,
  };
  const chunk = Buffer.allocUnsafe(METADATA_READ_BYTES);
  const decoder = new StringDecoder("utf8");
  let carry = "";
  let lineOffset = 0;
  let offset = 0;
  let assignmentOffset = Number.POSITIVE_INFINITY;
  const limit = Math.min(fileSize, LIFECYCLE_SCAN_BYTES);
  while (offset < limit) {
    const length = Math.min(chunk.length, limit - offset);
    const { bytesRead } = await handle.read(chunk, 0, length, offset);
    if (bytesRead !== length) return finish({ assigned: null, exited: false });
    offset += bytesRead;
    carry += decoder.write(chunk.subarray(0, bytesRead));
    let newline = carry.indexOf("\n");
    while (newline >= 0) {
      const line = carry.slice(0, newline);
      carry = carry.slice(newline + 1);
      const currentOffset = lineOffset;
      lineOffset += Buffer.byteLength(line, "utf8") + 1;
      if (line) {
        const record = parseRecord(line);
        if (!record) lifecycle.malformed = true;
        else {
          updateSessionLifecycle(record, lifecycle);
          if (lifecycle.assigned && assignmentOffset === Number.POSITIVE_INFINITY)
            assignmentOffset = currentOffset;
        }
      }
      newline = carry.indexOf("\n");
    }
  }
  carry += decoder.end();
  if (carry) lifecycle.incomplete = true;
  if (lifecycle.malformed || lifecycle.incomplete) return finish({ assigned: null, exited: false });
  if (!lifecycle.assigned) return finish({ assigned: oversized ? null : false, exited: false });
  if (!oversized) return finish({ assigned: true, exited: lifecycle.exited });
  if (tailWindow.incomplete || tailWindow.malformed) return finish({ assigned: null, exited: false });
  if (assignmentOffset < tailOffset)
    return finish({ assigned: true, exited: lifecycle.exited || tailWindow.exited });
  return finish({ assigned: true, exited: lifecycle.exited });
}
function updateSessionLifecycle(record: Record<string, unknown>, lifecycle: LifecycleWindow): void {
  if (record.type === "session_init") {
    if (typeof record.task !== "string") lifecycle.malformed = true;
    return;
  }
  if (record.type === "custom" && record.customType === "session_exit") {
    lifecycle.exited = true;
    return;
  }
  if (record.type !== "message" || !isRecord(record.message)) return;
  if (record.message.role === "user") {
    if (record.steering === true && record.attribution === "agent") return;
    lifecycle.assigned = true;
    lifecycle.exited = false;
    return;
  }
  if (record.message.role === "assistant" && record.message.stopReason === "aborted") {
    lifecycle.exited = true;
    return;
  }
  if (
    record.message.role === "toolResult" &&
    record.message.toolName === "yield" &&
    record.message.isError !== true &&
    isRecord(record.message.details) &&
    record.message.details.status === "success"
  ) {
    lifecycle.exited = true;
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
  costsByPath: ReadonlyMap<string, SessionCostData | null>,
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
    const cost = costsByPath.get(path);
    if (!entry || !cost?.exact) return undefined;
    const parentPath =
      path === rootPath ? null : (findNearestParentSessionPath(path, sessionPaths) ?? rootPath);
    const nextTotal = totalUsd + cost.totalUsd;
    if (!Number.isFinite(nextTotal)) return undefined;
    totalUsd = nextTotal;
    agents.push({
      sessionId: entry.session.id,
      name: entry.session.name ?? basename(path, extname(path)),
      parentSessionId: parentPath ? (entriesByPath.get(parentPath)?.session.id ?? null) : null,
      totalUsd: cost.totalUsd,
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
  return (
    left.parentSessionId === right.parentSessionId &&
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
