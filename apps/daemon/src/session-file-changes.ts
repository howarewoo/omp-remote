import { createReadStream } from "node:fs";
import { resolve } from "node:path";
import {
  SessionFileChangesResponseSchema,
  type SessionFileChangesResponse,
  type SessionFileOperation,
} from "@omp-remote/protocol";
import { z } from "zod";
import type { SessionFileChangeSourceDescriptor } from "./session-catalog.js";

const MAX_JSONL_LINE_BYTES = 1024 * 1024;
const MAX_RETAINED_PATCH_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_RETAINED_PATCH_BYTES_TOTAL = 3 * 1024 * 1024;
const MAX_TRACKED_CALLS = 1024;
const MAX_OPERATIONS = 4_000;
const READ_CONCURRENCY = 4;
const MAX_SCANNED_HISTORY_BYTES = 16 * 1024 * 1024;
const RESPONSE_COLLECTION_BUDGET = MAX_RESPONSE_BYTES - MAX_RETAINED_PATCH_BYTES_TOTAL;
const UnknownObjectSchema = z.record(z.string(), z.unknown());
const MAX_PATH_LENGTH = 4_096;

type TrackedCall =
  | { type: "edit"; toolName: "edit"; paths: string[] }
  | { type: "write"; toolName: "write"; path: string; byteCount: number }
  | { type: "device"; toolName: "write" };

type CollectedFile = { path: string; operations: SessionFileOperation[] };
type CollectedSource = { sessionId: string; root: string; files: CollectedFile[] };
type SourceResult = { source: CollectedSource; partial: boolean; unavailable: boolean };
type ResultOperations = {
  operations: Array<{ path: string; operation: SessionFileOperation }>;
  omitted: boolean;
};
type BoundedLine = { value: string | null; budgetExhausted: boolean };
interface CollectionBudget {
  remainingOperations: number;
  remainingPatchBytes: number;
  remainingHistoryBytes: number;
  remainingResponseBytes: number;
}

export interface CollectSessionFileChangesOptions {
  sessionId: string;
  sources: SessionFileChangeSourceDescriptor[];
  truncated?: boolean;
}

export async function collectSessionFileChanges({
  sessionId,
  sources,
  truncated = false,
}: CollectSessionFileChangesOptions): Promise<SessionFileChangesResponse> {
  if (sources.length === 0) return emptyResponse(sessionId, "unavailable", "Session history is unavailable");

  const budget: CollectionBudget = {
    remainingOperations: MAX_OPERATIONS,
    remainingPatchBytes: MAX_RETAINED_PATCH_BYTES_TOTAL,
    remainingHistoryBytes: MAX_SCANNED_HISTORY_BYTES,
    remainingResponseBytes: RESPONSE_COLLECTION_BUDGET,
  };
  const rootResult = await collectSource(sources[0]!, budget);
  if (rootResult.unavailable) {
    return emptyResponse(sessionId, "unavailable", "Session history is unavailable");
  }
  const descendantResults = await mapWithConcurrency(sources.slice(1), READ_CONCURRENCY, (source) =>
    collectSource(source, budget),
  );
  const results = [rootResult, ...descendantResults];

  let partial = truncated || results.some((result) => result.partial || result.unavailable);
  const collected = results.filter((result) => !result.unavailable).map((result) => result.source);
  let response = makeResponse(sessionId, partial ? "partial" : "available", collected, partial);
  const excessBytes = responseSize(response) - MAX_RESPONSE_BYTES;
  if (excessBytes > 0) {
    partial = true;
    trimResponse(response.sources, excessBytes + 1024);
    response = makeResponse(sessionId, "partial", response.sources, true);
  }
  if (responseSize(response) > MAX_RESPONSE_BYTES) {
    return emptyResponse(sessionId, "partial", "Some session changes could not be read");
  }
  return SessionFileChangesResponseSchema.parse(response);
}

async function collectSource(
  descriptor: SessionFileChangeSourceDescriptor,
  budget: CollectionBudget,
): Promise<SourceResult> {
  const calls = new Map<string, TrackedCall>();
  const files = new Map<string, SessionFileOperation[]>();
  let partial = false;
  try {
    for await (const boundedLine of boundedLines(descriptor.sessionPath, budget)) {
      if (boundedLine.budgetExhausted) {
        partial = true;
        break;
      }
      const line = boundedLine.value;
      if (line === null) {
        partial = true;
        continue;
      }
      let record: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(line);
        const object = parseObject(parsed);
        if (!object) {
          partial = true;
          continue;
        }
        record = object;
      } catch {
        partial = true;
        continue;
      }
      const message = parseObject(record.message);
      if (record.type !== "message" || !message) continue;
      if (message.role === "assistant") {
        if (captureCalls(message.content, descriptor.root, calls)) partial = true;
        continue;
      }
      if (message.role !== "toolResult") continue;
      const toolCallId = boundedString(message.toolCallId);
      const call = toolCallId ? calls.get(toolCallId) : undefined;
      if (toolCallId) calls.delete(toolCallId);
      if (!call || message.isError === true) continue;
      const timestamp = timestampOf(record.timestamp ?? message.timestamp);
      if (!timestamp) {
        partial = true;
        continue;
      }
      const result = operationsFromResult(call, message, descriptor, timestamp);
      if (result.omitted) partial = true;
      for (const { path, operation } of result.operations) {
        if (budget.remainingOperations === 0) {
          partial = true;
          continue;
        }
        let retainedOperation = operation;
        let patchBytes = 0;
        if (operation.type === "edit" && operation.patch) {
          patchBytes = Buffer.byteLength(JSON.stringify(operation.patch)) - 2;
          if (patchBytes > budget.remainingPatchBytes) {
            retainedOperation = { ...operation, patch: undefined, additions: 0, deletions: 0 };
            patchBytes = 0;
            partial = true;
          }
        } else if (operation.type === "edit") {
          partial = true;
        }
        const metadataOperation =
          retainedOperation.type === "edit" && retainedOperation.patch
            ? { ...retainedOperation, patch: undefined, additions: 0, deletions: 0 }
            : retainedOperation;
        const contribution = Buffer.byteLength(JSON.stringify({ path, operations: [metadataOperation] }));
        if (contribution > budget.remainingResponseBytes) {
          partial = true;
          continue;
        }
        budget.remainingOperations -= 1;
        budget.remainingPatchBytes -= patchBytes;
        budget.remainingResponseBytes -= contribution;
        const existing = files.get(path) ?? [];
        existing.push(retainedOperation);
        files.set(path, existing);
      }
    }
  } catch {
    return {
      source: { sessionId: descriptor.sessionId, root: descriptor.root, files: [] },
      partial: true,
      unavailable: true,
    };
  }
  return {
    source: {
      sessionId: descriptor.sessionId,
      root: descriptor.root,
      files: [...files.entries()].map(([path, operations]) => ({
        path,
        operations: operations.sort(
          (left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp),
        ),
      })),
    },
    partial,
    unavailable: false,
  };
}

function captureCalls(content: unknown, root: string, calls: Map<string, TrackedCall>): boolean {
  if (!Array.isArray(content)) return false;
  let evicted = false;
  for (const part of content) {
    const object = parseObject(part);
    if (!object || object.type !== "toolCall") continue;
    const id = boundedString(object.toolCallId) ?? boundedString(object.id);
    const name = boundedString(object.toolName) ?? boundedString(object.name);
    const args = parseObject(object.arguments);
    if (!id || !name || !args) continue;
    let call: TrackedCall | null = null;
    if (name === "edit") {
      const paths = extractEditPaths(args.input, root);
      if (paths.length > 0) call = { type: "edit", toolName: "edit", paths };
    } else if (name === "write" && typeof args.content === "string") {
      const path = resolveFilePath(args.path, root);
      call = path
        ? { type: "write", toolName: "write", path, byteCount: Buffer.byteLength(args.content) }
        : typeof args.path === "string" && /^[a-z][a-z\d+.-]*:\/\//i.test(args.path)
          ? { type: "device", toolName: "write" }
          : null;
    }
    if (!call) continue;
    if (!calls.has(id) && calls.size >= MAX_TRACKED_CALLS) {
      calls.delete(calls.keys().next().value as string);
      evicted = true;
    }
    calls.set(id, call);
  }
  return evicted;
}

function operationsFromResult(
  call: TrackedCall,
  message: Record<string, unknown>,
  descriptor: SessionFileChangeSourceDescriptor,
  timestamp: string,
): ResultOperations {
  if (message.toolName !== call.toolName) return { operations: [], omitted: true };
  const details = parseObject(message.details);
  if (details?.success === false || details?.status === "error" || details?.status === "failed") {
    return { operations: [], omitted: false };
  }
  if (call.type === "device") {
    if (!details || !Array.isArray(details.perFileResults)) return { operations: [], omitted: true };
    return perFileEditOperations(details.perFileResults, descriptor, timestamp);
  }
  if (call.type === "write") {
    const resultPath = explicitResultPath(details, descriptor.root) ?? call.path;
    if (resultPath !== call.path) return { operations: [], omitted: true };
    return {
      operations: [
        {
          path: resultPath,
          operation: {
            type: "write",
            timestamp,
            sessionId: descriptor.sessionId,
            resolvedPath: resultPath,
            byteCount: call.byteCount,
          },
        },
      ],
      omitted: false,
    };
  }
  if (!details) return { operations: [], omitted: true };
  if (Array.isArray(details.perFileResults)) {
    return perFileEditOperations(details.perFileResults, descriptor, timestamp);
  }
  if (call.paths.length !== 1) return { operations: [], omitted: true };
  const detailPath = explicitResultPath(details, descriptor.root);
  if (detailPath && detailPath !== call.paths[0]) return { operations: [], omitted: true };
  if (typeof details.diff !== "string" && typeof details.patch !== "string") {
    return { operations: [], omitted: true };
  }
  return {
    operations: [
      {
        path: call.paths[0]!,
        operation: editOperation(details.patch ?? details.diff, details.op, descriptor.sessionId, timestamp),
      },
    ],
    omitted: false,
  };
}

function perFileEditOperations(
  values: unknown[],
  descriptor: SessionFileChangeSourceDescriptor,
  timestamp: string,
): ResultOperations {
  const operations: ResultOperations["operations"] = [];
  let omitted = values.length === 0;
  for (const value of values) {
    const result = parseObject(value);
    if (!result) {
      omitted = true;
      continue;
    }
    if (result.isError === true || result.success === false) continue;
    const path = resolveFilePath(result.resolvedPath ?? result.path, descriptor.root);
    if (!path) {
      omitted = true;
      continue;
    }
    operations.push({
      path,
      operation: editOperation(result.patch ?? result.diff, result.op, descriptor.sessionId, timestamp),
    });
  }
  return { operations, omitted };
}

function editOperation(
  rawPatch: unknown,
  rawOperation: unknown,
  sessionId: string,
  timestamp: string,
): SessionFileOperation {
  const op =
    rawOperation === "create" ||
    rawOperation === "update" ||
    rawOperation === "delete" ||
    rawOperation === "rename"
      ? rawOperation
      : undefined;
  if (
    typeof rawPatch !== "string" ||
    rawPatch.length === 0 ||
    Buffer.byteLength(rawPatch) > MAX_RETAINED_PATCH_BYTES
  ) {
    return { type: "edit", timestamp, sessionId, ...(op ? { op } : {}), additions: 0, deletions: 0 };
  }
  const { additions, deletions } = countPatchLines(rawPatch);
  return { type: "edit", timestamp, sessionId, ...(op ? { op } : {}), patch: rawPatch, additions, deletions };
}

function countPatchLines(patch: string): { additions: number; deletions: number } {
  const lines = patch.split("\n");
  const hasHunks = lines.some((line) => /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(line));
  if (!hasHunks) {
    return lines.reduce(
      (totals, line) => {
        if (line.startsWith("+") && !line.startsWith("+++")) totals.additions += 1;
        else if (line.startsWith("-") && !line.startsWith("---")) totals.deletions += 1;
        return totals;
      },
      { additions: 0, deletions: 0 },
    );
  }

  let additions = 0;
  let deletions = 0;
  let oldRemaining = 0;
  let newRemaining = 0;
  for (const line of lines) {
    const header = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (header) {
      oldRemaining = header[1] === undefined ? 1 : Number(header[1]);
      newRemaining = header[2] === undefined ? 1 : Number(header[2]);
      continue;
    }
    if (oldRemaining === 0 && newRemaining === 0) continue;
    if (line.startsWith("+")) {
      additions += 1;
      newRemaining = Math.max(0, newRemaining - 1);
    } else if (line.startsWith("-")) {
      deletions += 1;
      oldRemaining = Math.max(0, oldRemaining - 1);
    } else if (!line.startsWith("\\")) {
      oldRemaining = Math.max(0, oldRemaining - 1);
      newRemaining = Math.max(0, newRemaining - 1);
    }
  }
  return { additions, deletions };
}

function extractEditPaths(input: unknown, root: string): string[] {
  if (typeof input !== "string") return [];
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const line of input.split("\n")) {
    const match = /^\[([^#\r\n]+)#[0-9A-Fa-f]{4}\]$/.exec(line);
    const path = match ? resolveFilePath(match[1], root) : null;
    if (path && !seen.has(path)) {
      seen.add(path);
      paths.push(path);
    }
  }
  return paths;
}

function explicitResultPath(details: Record<string, unknown> | null, root: string): string | null {
  if (!details) return null;
  const meta = parseObject(details.meta);
  const source = meta ? parseObject(meta.source) : null;
  return resolveFilePath(details.resolvedPath ?? details.path ?? source?.value, root);
}

function resolveFilePath(value: unknown, root: string): string | null {
  const path = boundedString(value, MAX_PATH_LENGTH);
  if (!path || /^[a-z][a-z\d+.-]*:\/\//i.test(path)) return null;
  return resolve(root, path);
}

async function* boundedLines(path: string, budget: CollectionBudget): AsyncGenerator<BoundedLine> {
  const stream = createReadStream(path, { highWaterMark: 64 * 1024 });
  let pending = Buffer.alloc(0);
  let dropping = false;
  for await (const rawChunk of stream) {
    const availableBytes = Math.min(rawChunk.length, budget.remainingHistoryBytes);
    budget.remainingHistoryBytes -= availableBytes;
    let chunk = (rawChunk as Buffer).subarray(0, availableBytes);
    while (chunk.length > 0) {
      const newline = chunk.indexOf(10);
      const fragment = newline < 0 ? chunk : chunk.subarray(0, newline);
      chunk = newline < 0 ? Buffer.alloc(0) : chunk.subarray(newline + 1);
      if (!dropping) {
        if (pending.length + fragment.length > MAX_JSONL_LINE_BYTES) {
          pending = Buffer.alloc(0);
          dropping = true;
        } else {
          pending = Buffer.concat([pending, fragment]);
        }
      }
      if (newline >= 0) {
        yield {
          value: dropping ? null : pending.toString("utf8").replace(/\r$/, ""),
          budgetExhausted: false,
        };
        pending = Buffer.alloc(0);
        dropping = false;
      }
    }
    if (availableBytes < rawChunk.length) {
      yield { value: null, budgetExhausted: true };
      return;
    }
  }
  if (dropping) yield { value: null, budgetExhausted: false };
  else if (pending.length > 0) {
    yield { value: pending.toString("utf8").replace(/\r$/, ""), budgetExhausted: false };
  }
}

function makeResponse(
  sessionId: string,
  state: "available" | "partial",
  sources: CollectedSource[],
  partial: boolean,
): SessionFileChangesResponse {
  const files = sources.flatMap((source) => source.files);
  const operations = files.flatMap((file) => file.operations);
  const edits = operations.filter((operation) => operation.type === "edit");
  const additions = edits.reduce((total, operation) => total + operation.additions, 0);
  const deletions = edits.reduce((total, operation) => total + operation.deletions, 0);
  return {
    sessionId,
    state,
    sources,
    fileCount: files.length,
    operationCount: operations.length,
    additions,
    deletions,
    changedLines: additions + deletions,
    message: partial ? "Some session changes could not be read" : null,
  };
}

function emptyResponse(
  sessionId: string,
  state: "partial" | "unavailable",
  message: string,
): SessionFileChangesResponse {
  return SessionFileChangesResponseSchema.parse({
    sessionId,
    state,
    sources: [],
    fileCount: 0,
    operationCount: 0,
    additions: 0,
    deletions: 0,
    changedLines: 0,
    message,
  });
}

function trimResponse(sources: CollectedSource[], bytesToFree: number): void {
  let freedBytes = 0;
  for (let sourceIndex = sources.length - 1; sourceIndex >= 0; sourceIndex -= 1) {
    const files = sources[sourceIndex]!.files;
    for (let fileIndex = files.length - 1; fileIndex >= 0; fileIndex -= 1) {
      const operations = files[fileIndex]!.operations;
      for (let operationIndex = operations.length - 1; operationIndex >= 0; operationIndex -= 1) {
        let operation = operations[operationIndex]!;
        if (operation.type === "edit" && operation.patch) {
          const retainedOperation = { ...operation, patch: undefined, additions: 0, deletions: 0 };
          freedBytes +=
            Buffer.byteLength(JSON.stringify(operation)) -
            Buffer.byteLength(JSON.stringify(retainedOperation));
          operations[operationIndex] = retainedOperation;
          operation = retainedOperation;
          if (freedBytes >= bytesToFree) return;
        }
        operations.splice(operationIndex, 1);
        freedBytes += Buffer.byteLength(JSON.stringify(operation)) + 1;
        if (operations.length === 0) files.splice(fileIndex, 1);
        if (freedBytes >= bytesToFree) return;
      }
    }
  }
}

function responseSize(response: SessionFileChangesResponse): number {
  return Buffer.byteLength(JSON.stringify(response));
}

function timestampOf(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp.toISOString();
}

function boundedString(value: unknown, maximum = 256): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) return null;
  return value;
}

function parseObject(value: unknown): Record<string, unknown> | null {
  const parsed = UnknownObjectSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
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
      const index = nextIndex++;
      results[index] = await callback(values[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}
