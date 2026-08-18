import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, constants as fsConstants, fstatSync, openSync, readSync } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { open } from "node:fs/promises";
import { join } from "node:path";
import {
  boundTranscriptImageBudget, getTranscriptImageByteLength, normalizeSkillPromptRecord, TRANSCRIPT_IMAGE_MAX_BYTES,
  TRANSCRIPT_IMAGE_SESSION_MAX_BYTES, type TranscriptImage, type TranscriptImageMimeType,
  type TranscriptMessage, truncateTranscriptText, validateTranscriptImageBytes,
} from "@omp-remote/protocol";
import { materializeReadImages, normalizeRawMessage, ToolCallTracker } from "./message-normalizer.js";
import { DEFAULT_MAX_RECORD_BYTES, readReverseJsonl } from "./reverse-jsonl.js";

export const TRANSCRIPT_PAGE_SIZE = 50;
export const MAX_CURSOR_LENGTH = 512;
const CURSOR_SECRET = randomBytes(32);

export type TranscriptHistoryStatus = "complete" | "available" | "unavailable" | "invalidated";
export interface TranscriptPageResult { sessionId: string; messages: TranscriptMessage[]; olderCursor: string | null; status: TranscriptHistoryStatus; }
export interface ReadTranscriptPageOptions { sessionId: string; sessionPath?: string | null; cursor?: string | null; blobDirectory?: string; maxRecordBytes?: number; chunkSize?: number; openFile?: (path: string) => Promise<FileHandle>; }
export interface CursorPayload { s: string; dev: number; ino: number; btime: number; end: number; next: number; }

export function isValidCursorPayload(p: unknown): p is CursorPayload {
  return (
    typeof p === "object" && !!p && !Array.isArray(p) && "s" in p && typeof p.s === "string" && p.s.length === 64 &&
    "dev" in p && Number.isSafeInteger(p.dev) && (p.dev as number) >= 0 && "ino" in p && Number.isSafeInteger(p.ino) && (p.ino as number) >= 0 &&
    "btime" in p && Number.isSafeInteger(p.btime) && (p.btime as number) >= 0 && "end" in p && Number.isSafeInteger(p.end) && (p.end as number) >= 0 &&
    "next" in p && Number.isSafeInteger(p.next) && (p.next as number) >= 0 && (p.next as number) <= (p.end as number)
  );
}

export function encodeCursor(payload: CursorPayload, secret = CURSOR_SECRET): string {
  if (!isValidCursorPayload(payload)) throw new TypeError("Invalid cursor payload");
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${payloadB64}.${createHmac("sha256", secret).update(payloadB64).digest("base64url")}`;
}

export function decodeAndVerifyCursor(cursor: string, secret = CURSOR_SECRET): CursorPayload | null {
  if (cursor.length > MAX_CURSOR_LENGTH) return null;
  const dotIndex = cursor.indexOf(".");
  if (dotIndex === -1) return null;
  const [payloadB64, sig] = [cursor.slice(0, dotIndex), cursor.slice(dotIndex + 1)];
  if (!payloadB64 || !sig) return null;
  const expectedSig = createHmac("sha256", secret).update(payloadB64).digest("base64url");
  const [b1, b2] = [Buffer.from(sig, "utf8"), Buffer.from(expectedSig, "utf8")];
  if (b1.length !== b2.length || !timingSafeEqual(b1, b2)) return null;
  try {
    const p = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    return isValidCursorPayload(p) ? p : null;
  } catch {
    return null;
  }
}

export function resolveAgentBlobDirectory(sessionPath: string): string | undefined {
  const marker = "/sessions/";
  const markerIndex = sessionPath.lastIndexOf(marker);
  return markerIndex >= 0 ? join(sessionPath.slice(0, markerIndex), "blobs") : undefined;
}

export function resolveReadImage(blobDirectory: string, reference: string, mimeType: string, maxBytes = TRANSCRIPT_IMAGE_MAX_BYTES): TranscriptImage {
  const match = /^blob:sha256:([a-f0-9]{64})$/.exec(reference);
  const hash = match?.[1];
  if (!hash) return { status: "unavailable", reason: "invalid_reference" };
  let handle: number | undefined;
  try {
    handle = openSync(join(blobDirectory, hash), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const fileStats = fstatSync(handle);
    if (!fileStats.isFile()) return { status: "unavailable", reason: "invalid_reference" };
    if (fileStats.size > TRANSCRIPT_IMAGE_MAX_BYTES) return { status: "unavailable", reason: "oversized" };
    if (fileStats.size > maxBytes) return { status: "unavailable", reason: "budget_exceeded" };
    const buffer = Buffer.allocUnsafe(Math.min(TRANSCRIPT_IMAGE_MAX_BYTES, maxBytes) + 1);
    const bytesRead = readSync(handle, buffer, 0, buffer.length, 0);
    if (bytesRead > TRANSCRIPT_IMAGE_MAX_BYTES) return { status: "unavailable", reason: "oversized" };
    if (bytesRead > maxBytes) return { status: "unavailable", reason: "budget_exceeded" };
    const bytes = buffer.subarray(0, bytesRead);
    if (createHash("sha256").update(bytes).digest("hex") !== hash) return { status: "unavailable", reason: "invalid_reference" };
    const reason = validateTranscriptImageBytes(bytes, mimeType);
    if (reason) return { status: "unavailable", reason };
    return { status: "available", mimeType: mimeType as TranscriptImageMimeType, data: bytes.toString("base64") };
  } catch {
    return { status: "unavailable", reason: "missing" };
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
}

export function createReadImageResolver(blobDirectory: string, maxSessionBytes = TRANSCRIPT_IMAGE_SESSION_MAX_BYTES): (data: string, mimeType: string) => TranscriptImage {
  let retainedBytes = 0;
  return (data, mimeType) => {
    const remainingBytes = maxSessionBytes - retainedBytes;
    if (remainingBytes <= 0) return { status: "unavailable", reason: "budget_exceeded" };
    const image = resolveReadImage(blobDirectory, data, mimeType, remainingBytes);
    if (image.status !== "available") return image;
    const imageBytes = getTranscriptImageByteLength(image);
    if (retainedBytes + imageBytes > maxSessionBytes) return { status: "unavailable", reason: "budget_exceeded" };
    retainedBytes += imageBytes;
    return image;
  };
}

function normalizeTimestamp(value: unknown): string {
  if (typeof value === "number" || typeof value === "string") {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return "1970-01-01T00:00:00.000Z";
}

function extractCanonicalToolCalls(content: unknown): Array<{ toolCallId: string; toolName: string; arguments: Record<string, unknown> }> {
  if (!Array.isArray(content)) return [];
  const calls: Array<{ toolCallId: string; toolName: string; arguments: Record<string, unknown> }> = [];
  for (const part of content) {
    if (typeof part !== "object" || !part || !("type" in part) || part.type !== "toolCall") continue;
    if (!("arguments" in part) || typeof part.arguments !== "object" || !part.arguments || Array.isArray(part.arguments)) continue;
    const rawCallId = "toolCallId" in part && typeof part.toolCallId === "string" ? part.toolCallId : "id" in part ? part.id : undefined;
    const rawName = "toolName" in part && typeof part.toolName === "string" ? part.toolName : "name" in part ? part.name : undefined;
    const id = typeof rawCallId === "string" && rawCallId ? rawCallId : undefined;
    const name = typeof rawName === "string" && rawName ? rawName : undefined;
    if (id && name) calls.push({ toolCallId: id, toolName: name, arguments: part.arguments as Record<string, unknown> });
  }
  return calls;
}

function normalizeTranscriptMessage(record: Record<string, unknown>, offset: number, toolCallTracker: ToolCallTracker): TranscriptMessage | null {
  if (record.type !== "message" || typeof record.message !== "object" || !record.message || Array.isArray(record.message)) return null;
  const rawMsg = record.message as Record<string, unknown>;
  const rawTimestamp = record.timestamp ?? ("timestamp" in rawMsg ? rawMsg.timestamp : undefined);
  const timestamp = normalizeTimestamp(rawTimestamp);
  const message = normalizeRawMessage(
    rawMsg,
    false,
    typeof record.id === "string" ? record.id : (text) => `${timestamp}-${offset}-${createHash("sha256").update(text).digest("hex").slice(0, 16)}`,
    { timestamp, omitEmptyText: true, ignoreRawId: true, toolCallTracker },
  );
  return message ? { ...message, text: truncateTranscriptText(message.text) } : null;
}

function normalizeSkillPromptMessage(record: Record<string, unknown>): TranscriptMessage | null {
  const prompt = normalizeSkillPromptRecord(record, (text) => `skill-prompt-${createHash("sha256").update(text, "utf8").digest("hex")}`);
  if (!prompt) return null;
  return {
    id: prompt.id,
    role: "user",
    text: truncateTranscriptText(prompt.text),
    timestamp: normalizeTimestamp(record.timestamp),
    streaming: false,
    presentation: "text",
  };
}

export async function readTranscriptPage(options: ReadTranscriptPageOptions): Promise<TranscriptPageResult> {
  const { sessionId, sessionPath, cursor } = options;
  const sessionHash = createHash("sha256").update(sessionId).digest("hex");

  let cursorPayload: CursorPayload | null = null;
  if (cursor !== undefined && cursor !== null) {
    cursorPayload = decodeAndVerifyCursor(cursor);
    if (!cursorPayload || cursorPayload.s !== sessionHash) return { sessionId, messages: [], olderCursor: null, status: "invalidated" };
  }

  if (!sessionPath) return { sessionId, messages: [], olderCursor: null, status: cursorPayload ? "invalidated" : "unavailable" };

  const openFile = options.openFile ?? ((p: string) => open(p, "r"));
  let handle: FileHandle | undefined;
  try {
    handle = await openFile(sessionPath);
    const stat = await handle.stat();

    if (cursorPayload) {
      if (
        stat.dev !== cursorPayload.dev || stat.ino !== cursorPayload.ino ||
        Math.floor(stat.birthtimeMs) !== cursorPayload.btime ||
        stat.size < cursorPayload.end || cursorPayload.next > cursorPayload.end
      ) return { sessionId, messages: [], olderCursor: null, status: "invalidated" };
    }

    const initialEndOffset = cursorPayload ? cursorPayload.end : stat.size;
    const targetEnd = cursorPayload ? cursorPayload.next : initialEndOffset;
    if (targetEnd === 0) return { sessionId, messages: [], olderCursor: null, status: "complete" };

    const readerOpts = {
      handle,
      maxRecordBytes: options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES,
      ...(options.chunkSize !== undefined ? { chunkSize: options.chunkSize } : {}),
    };

    const candidateRecords: Array<{ record: Record<string, unknown>; startOffset: number; endOffset: number }> = [];
    const pendingToolCallIds = new Set<string>();
    const olderMatchedAssistantRecords: Record<string, unknown>[] = [];
    let skillPromptCandidate: { record: Record<string, unknown>; startOffset: number } | undefined;
    let oldestCandidateStartOffset = targetEnd;
    let hasOlderMeaningfulMessage = false;

    for await (const entry of readReverseJsonl<Record<string, unknown>>({ ...readerOpts, startOffset: 0, endOffset: targetEnd })) {
      if (typeof entry.value !== "object" || !entry.value || Array.isArray(entry.value)) continue;

      const skillPromptMessage = normalizeSkillPromptMessage(entry.value);
      if (skillPromptMessage) {
        skillPromptCandidate = { record: entry.value, startOffset: entry.startOffset };
      }

      if (entry.value.type === "message" && typeof entry.value.message === "object" && entry.value.message && !Array.isArray(entry.value.message)) {
        const rawMsg = entry.value.message as Record<string, unknown>;
        const testMsg = normalizeRawMessage(rawMsg, false, "test-id", { omitEmptyText: true, ignoreRawId: true });

        if (candidateRecords.length < TRANSCRIPT_PAGE_SIZE) {
          if (testMsg !== null) {
            candidateRecords.push({ record: entry.value, startOffset: entry.startOffset, endOffset: entry.endOffset });
            oldestCandidateStartOffset = entry.startOffset;
            if (rawMsg.role === "toolResult" && typeof rawMsg.toolCallId === "string" && rawMsg.toolCallId) {
              pendingToolCallIds.add(rawMsg.toolCallId);
            }
          }
          if (rawMsg.role === "assistant" && pendingToolCallIds.size > 0) {
            for (const call of extractCanonicalToolCalls(rawMsg.content)) {
              if (pendingToolCallIds.has(call.toolCallId)) {
                pendingToolCallIds.delete(call.toolCallId);
                olderMatchedAssistantRecords.push(entry.value);
              }
            }
          }
        } else {
          if (testMsg !== null) hasOlderMeaningfulMessage = true;
          if (rawMsg.role === "assistant" && pendingToolCallIds.size > 0) {
            for (const call of extractCanonicalToolCalls(rawMsg.content)) {
              if (pendingToolCallIds.has(call.toolCallId)) {
                pendingToolCallIds.delete(call.toolCallId);
                olderMatchedAssistantRecords.push(entry.value);
              }
            }
          }
        }
      }
    }

    const toolCallTracker = new ToolCallTracker();
    for (let i = olderMatchedAssistantRecords.length - 1; i >= 0; i--) {
      const rawMsg = olderMatchedAssistantRecords[i]!.message as Record<string, unknown>;
      if (Array.isArray(rawMsg.content)) toolCallTracker.capture(rawMsg.content);
    }

    const blobDir = options.blobDirectory ?? (options.sessionPath ? resolveAgentBlobDirectory(options.sessionPath) : undefined);
    const resolveImage = blobDir ? createReadImageResolver(blobDir) : undefined;

    const normalizedMessages: TranscriptMessage[] = [];
    const normalizedOffsets: number[] = [];
    for (let i = candidateRecords.length - 1; i >= 0; i--) {
      const item = candidateRecords[i]!;
      const msg = normalizeTranscriptMessage(item.record, item.startOffset, toolCallTracker);
      if (!msg) continue;
      const withImages = resolveImage && typeof item.record.message === "object" && item.record.message
        ? materializeReadImages(msg, item.record.message, resolveImage)
        : msg;
      normalizedMessages.push(withImages);
      normalizedOffsets.push(item.startOffset);
    }

    let nextCursorOffset = oldestCandidateStartOffset;
    if (skillPromptCandidate) {
      const prompt = normalizeSkillPromptMessage(skillPromptCandidate.record);
      if (prompt && !normalizedMessages.some((message) => message.id === prompt.id)) {
        if (normalizedMessages.length >= TRANSCRIPT_PAGE_SIZE) {
          normalizedMessages.shift();
          normalizedOffsets.shift();
          hasOlderMeaningfulMessage = true;
          if (candidateRecords.length > 0) {
            nextCursorOffset = candidateRecords[candidateRecords.length - 1]!.endOffset;
          }
        }
        const insertAt = normalizedOffsets.findIndex((offset) => offset > skillPromptCandidate!.startOffset);
        if (insertAt < 0) {
          normalizedMessages.push(prompt);
          normalizedOffsets.push(skillPromptCandidate.startOffset);
        } else {
          normalizedMessages.splice(insertAt, 0, prompt);
          normalizedOffsets.splice(insertAt, 0, skillPromptCandidate.startOffset);
        }
      }
    }

    const messages = boundTranscriptImageBudget(normalizedMessages);
    if (!hasOlderMeaningfulMessage || candidateRecords.length === 0) {
      return { sessionId, messages, olderCursor: null, status: "complete" };
    }

    const payload: CursorPayload = {
      s: sessionHash, dev: stat.dev, ino: stat.ino, btime: Math.floor(stat.birthtimeMs),
      end: initialEndOffset, next: nextCursorOffset,
    };
    if (!isValidCursorPayload(payload)) return { sessionId, messages: [], olderCursor: null, status: "invalidated" };

    return { sessionId, messages, olderCursor: encodeCursor(payload), status: "available" };
  } catch (error) {
    if (error instanceof RangeError || (typeof error === "object" && error !== null && "name" in error && error.name === "RangeError")) {
      return { sessionId, messages: [], olderCursor: null, status: "invalidated" };
    }
    if (typeof error === "object" && error !== null && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      return { sessionId, messages: [], olderCursor: null, status: cursorPayload ? "invalidated" : "unavailable" };
    }
    if (error instanceof SyntaxError) return { sessionId, messages: [], olderCursor: null, status: "invalidated" };
    throw error;
  } finally {
    await handle?.close();
  }
}
