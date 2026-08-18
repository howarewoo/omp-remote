import type { FileHandle } from "node:fs/promises";
import { open } from "node:fs/promises";

export const DEFAULT_MAX_RECORD_BYTES = 16 * 1024 * 1024;
export const DEFAULT_CHUNK_BYTES = 64 * 1024;

export interface ReverseJsonlOptions {
  path?: string;
  handle?: FileHandle;
  startOffset?: number;
  endOffset?: number;
  maxRecordBytes?: number;
  chunkSize?: number;
}

export interface ReverseJsonlRecord<T = unknown> {
  value: T;
  raw: string;
  startOffset: number;
  endOffset: number;
}

function parseRecordPayload<T>(
  rawBytes: Buffer,
  startOffset: number,
  endOffset: number,
  maxRecordBytes: number,
): ReverseJsonlRecord<T> | null {
  let end = rawBytes.length;
  if (end > 0 && rawBytes[end - 1] === 0x0a) {
    end -= 1;
    if (end > 0 && rawBytes[end - 1] === 0x0d) end -= 1;
  } else if (end > 0 && rawBytes[end - 1] === 0x0d) {
    end -= 1;
  }

  if (end > maxRecordBytes) {
    throw new RangeError(`JSONL record exceeds maximum supported size of ${maxRecordBytes} bytes`);
  }

  const payload = rawBytes.subarray(0, end);
  if (payload.length === 0) return null;
  const raw = payload.toString("utf8");
  return {
    value: JSON.parse(raw) as T,
    raw,
    startOffset,
    endOffset,
  };
}

export async function* readReverseJsonl<T = unknown>(
  target: string | ReverseJsonlOptions,
  options?: Omit<ReverseJsonlOptions, "path">,
): AsyncGenerator<ReverseJsonlRecord<T>, void, unknown> {
  const opts: ReverseJsonlOptions = typeof target === "string" ? { path: target, ...options } : target;
  const maxRecordBytes = opts.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES;
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_BYTES;

  if (chunkSize <= 0) throw new RangeError("chunkSize must be positive");
  if (maxRecordBytes <= 0) throw new RangeError("maxRecordBytes must be positive");
  if (!opts.handle && !opts.path) throw new TypeError("Either path or handle must be provided");

  const ownsHandle = !opts.handle;
  const handle = opts.handle ?? (await open(opts.path!, "r"));

  try {
    const stat = await handle.stat();
    const rangeStart = Math.max(0, opts.startOffset ?? 0);
    const rangeEnd = Math.min(stat.size, opts.endOffset ?? stat.size);

    if (rangeStart >= rangeEnd) return;

    let filePos = rangeEnd;
    let pendingCrossChunk = false;
    let pendingBytes = 0;
    let currentRecordEndOffset = -1;
    let foundFirstNewline = false;

    const chunk = Buffer.allocUnsafe(chunkSize);

    while (filePos > rangeStart || pendingCrossChunk) {
      if (filePos <= rangeStart && pendingCrossChunk) {
        const recordLength = currentRecordEndOffset - rangeStart;
        if (recordLength > maxRecordBytes + 2) {
          throw new RangeError(`JSONL record exceeds maximum supported size of ${maxRecordBytes} bytes`);
        }
        pendingCrossChunk = false;
        pendingBytes = 0;

        const recordBuf = Buffer.allocUnsafe(recordLength);
        const { bytesRead } = await handle.read(recordBuf, 0, recordLength, rangeStart);
        if (bytesRead !== recordLength) {
          throw new Error(`Failed to read record at offset ${rangeStart}`);
        }

        const record = parseRecordPayload<T>(recordBuf, rangeStart, currentRecordEndOffset, maxRecordBytes);
        if (record) yield record;
        return;
      }

      const readLength = Math.min(chunkSize, filePos - rangeStart);
      const chunkOffset = filePos - readLength;
      const { bytesRead } = await handle.read(chunk, 0, readLength, chunkOffset);
      if (bytesRead !== readLength) {
        throw new Error(`Failed to read ${readLength} bytes from offset ${chunkOffset}`);
      }
      filePos = chunkOffset;

      const activeChunk = chunk.subarray(0, bytesRead);

      if (!foundFirstNewline) {
        const lastNl = activeChunk.lastIndexOf(0x0a);
        if (lastNl === -1) continue;

        foundFirstNewline = true;
        currentRecordEndOffset = chunkOffset + lastNl + 1;
        let cursor = lastNl;

        while (cursor >= 0) {
          const prevNl = cursor > 0 ? activeChunk.lastIndexOf(0x0a, cursor - 1) : -1;
          if (prevNl === -1) {
            pendingCrossChunk = true;
            pendingBytes = cursor;
            if (pendingBytes > maxRecordBytes + 2) {
              throw new RangeError(`JSONL record exceeds maximum supported size of ${maxRecordBytes} bytes`);
            }
            break;
          }

          const record = parseRecordPayload<T>(
            activeChunk.subarray(prevNl + 1, cursor),
            chunkOffset + prevNl + 1,
            chunkOffset + cursor + 1,
            maxRecordBytes,
          );
          if (record) yield record;

          currentRecordEndOffset = chunkOffset + prevNl + 1;
          cursor = prevNl;
        }
        continue;
      }

      const lastNl = activeChunk.lastIndexOf(0x0a);
      if (lastNl === -1) {
        pendingBytes += bytesRead;
        if (pendingBytes > maxRecordBytes + 2) {
          throw new RangeError(`JSONL record exceeds maximum supported size of ${maxRecordBytes} bytes`);
        }
        continue;
      }

      const startOffset = chunkOffset + lastNl + 1;
      const recordLength = currentRecordEndOffset - startOffset;
      if (recordLength > maxRecordBytes + 2) {
        throw new RangeError(`JSONL record exceeds maximum supported size of ${maxRecordBytes} bytes`);
      }
      pendingCrossChunk = false;
      pendingBytes = 0;

      const recordBuf = Buffer.allocUnsafe(recordLength);
      const { bytesRead: recBytesRead } = await handle.read(recordBuf, 0, recordLength, startOffset);
      if (recBytesRead !== recordLength) {
        throw new Error(`Failed to read record at offset ${startOffset}`);
      }

      const record = parseRecordPayload<T>(recordBuf, startOffset, currentRecordEndOffset, maxRecordBytes);
      if (record) yield record;

      currentRecordEndOffset = chunkOffset + lastNl + 1;
      let cursor = lastNl;

      while (cursor >= 0) {
        const prevNl = cursor > 0 ? activeChunk.lastIndexOf(0x0a, cursor - 1) : -1;
        if (prevNl === -1) {
          pendingCrossChunk = true;
          pendingBytes = cursor;
          if (pendingBytes > maxRecordBytes + 2) {
            throw new RangeError(`JSONL record exceeds maximum supported size of ${maxRecordBytes} bytes`);
          }
          break;
        }

        const record = parseRecordPayload<T>(
          activeChunk.subarray(prevNl + 1, cursor),
          chunkOffset + prevNl + 1,
          chunkOffset + cursor + 1,
          maxRecordBytes,
        );
        if (record) yield record;

        currentRecordEndOffset = chunkOffset + prevNl + 1;
        cursor = prevNl;
      }
    }
  } finally {
    if (ownsHandle) {
      await handle.close();
    }
  }
}

export const reverseJsonl = readReverseJsonl;
