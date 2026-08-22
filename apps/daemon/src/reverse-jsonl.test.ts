import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readReverseJsonl, reverseJsonl } from "./reverse-jsonl.js";

describe("readReverseJsonl", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "omp-rev-test-"));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("traverses 120 records newest-first with exact contiguous byte offsets", async () => {
    const filePath = join(testDir, "120.jsonl");
    const records = Array.from({ length: 120 }, (_, i) => ({
      id: i,
      text: `Record ${i} with multibyte 🚀 and CRLF`,
    }));
    const content = records.map((r) => JSON.stringify(r)).join("\r\n") + "\r\n";
    const contentBuffer = Buffer.from(content, "utf8");
    await writeFile(filePath, content);

    const results = [];
    for await (const record of readReverseJsonl<{ id: number; text: string }>(filePath, {
      chunkSize: 17,
    })) {
      results.push(record);
    }

    expect(results).toHaveLength(120);
    expect(results[0]?.value.id).toBe(119);
    expect(results[119]?.value.id).toBe(0);
    expect(results.every((r, idx) => r.value.id === 119 - idx)).toBe(true);

    for (let i = 0; i < results.length; i++) {
      const current = results[i]!;
      if (i === results.length - 1) {
        expect(current.startOffset).toBe(0);
      } else {
        const nextOlder = results[i + 1]!;
        expect(current.startOffset).toBe(nextOlder.endOffset);
      }
      expect(contentBuffer.subarray(current.startOffset, current.endOffset).toString("utf8")).toBe(
        JSON.stringify(current.value) + "\r\n",
      );
    }
  });

  it("handles multibyte UTF-8 characters across chunk boundaries", async () => {
    const filePath = join(testDir, "unicode.jsonl");
    const records = [
      { id: 1, text: "🎉 Special 🦹 Unicode 🚀 Test 🌟" },
      { id: 2, text: "こんにちは世界 🌍 Привет мир" },
      { id: 3, text: "Plain text" },
    ];
    await writeFile(filePath, records.map((r) => JSON.stringify(r)).join("\n") + "\n");

    for (const chunkSize of [1, 2, 3, 5, 7, 13, 17, 32, 64]) {
      const results = [];
      for await (const record of readReverseJsonl<{ id: number; text: string }>(filePath, {
        chunkSize,
      })) {
        results.push(record.value);
      }
      expect(results).toEqual([records[2], records[1], records[0]]);
    }
  });

  it("ignores unterminated append tails at the end of the file", async () => {
    const filePath = join(testDir, "unterminated.jsonl");
    const validRecords = [
      { id: 1, text: "first" },
      { id: 2, text: "second" },
    ];
    const validContent = validRecords.map((r) => JSON.stringify(r)).join("\n") + "\n";
    const corruptedContent = `${validContent}{"id": 3, "text": "incomplet${"x".repeat(300)}`;
    await writeFile(filePath, corruptedContent);

    for (const chunkSize of [1, 3, 7, 13, 17, 64]) {
      const results = [];
      for await (const record of readReverseJsonl<{ id: number; text: string }>(filePath, {
        chunkSize,
      })) {
        results.push(record.value);
      }
      expect(results).toEqual([
        { id: 2, text: "second" },
        { id: 1, text: "first" },
      ]);
    }

    const untermOnlyPath = join(testDir, "unterm-only.jsonl");
    await writeFile(untermOnlyPath, `{"partial": true${"y".repeat(300)}`);
    for (const chunkSize of [1, 5, 17, 64]) {
      const untermResults = [];
      for await (const r of readReverseJsonl(untermOnlyPath, { chunkSize })) {
        untermResults.push(r);
      }
      expect(untermResults).toHaveLength(0);
    }
  });

  it("respects startOffset and endOffset range boundaries", async () => {
    const filePath = join(testDir, "offsets.jsonl");
    const records = [
      { id: 10, text: "first" },
      { id: 20, text: "second" },
      { id: 30, text: "third" },
    ];
    await writeFile(filePath, records.map((r) => JSON.stringify(r)).join("\n") + "\n");

    const all = [];
    for await (const record of readReverseJsonl<{ id: number }>(filePath)) {
      all.push(record);
    }
    expect(all).toHaveLength(3);

    const third = all[0]!;
    const second = all[1]!;

    const sub = [];
    for await (const record of readReverseJsonl<{ id: number }>(filePath, {
      startOffset: second.startOffset,
      endOffset: third.startOffset,
    })) {
      sub.push(record);
    }
    expect(sub).toHaveLength(1);
    expect(sub[0]?.value.id).toBe(20);
    expect(sub[0]?.startOffset).toBe(second.startOffset);
    expect(sub[0]?.endOffset).toBe(second.endOffset);
  });

  it("enforces maxRecordBytes on payload for exact-limit LF/CRLF and rejects oversized records", async () => {
    const filePath = join(testDir, "limit.jsonl");
    const olderRecord = JSON.stringify({ id: 0, text: "older" });
    const maxBytes = 100;
    const base = JSON.stringify({ id: 1, text: "a".repeat(maxBytes - 20) });
    const pad = maxBytes - Buffer.byteLength(base, "utf8");
    const exactRecord = JSON.stringify({ id: 1, text: "a".repeat(maxBytes - 20 + pad) });
    expect(Buffer.byteLength(exactRecord, "utf8")).toBe(maxBytes);

    // Exact limit LF passes with older record
    await writeFile(filePath, `${olderRecord}\n${exactRecord}\n`);
    const lfResults = [];
    for await (const r of readReverseJsonl<{ id: number }>(filePath, {
      maxRecordBytes: maxBytes,
      chunkSize: 13,
    })) {
      lfResults.push(r.value.id);
    }
    expect(lfResults).toEqual([1, 0]);

    // Exact limit CRLF passes with older record
    await writeFile(filePath, `${olderRecord}\r\n${exactRecord}\r\n`);
    const crlfResults = [];
    for await (const r of readReverseJsonl<{ id: number }>(filePath, {
      maxRecordBytes: maxBytes,
      chunkSize: 13,
    })) {
      crlfResults.push(r.value.id);
    }
    expect(crlfResults).toEqual([1, 0]);

    // Max + 1 byte LF throws RangeError
    const overLF = `${exactRecord.slice(0, -2)}x"}`;
    expect(Buffer.byteLength(overLF, "utf8")).toBe(maxBytes + 1);
    await writeFile(filePath, `${olderRecord}\n${overLF}\n`);
    await expect(async () => {
      for await (const _ of readReverseJsonl(filePath, { maxRecordBytes: maxBytes, chunkSize: 13 })) {
        // drain
      }
    }).rejects.toThrow(RangeError);

    // Max + 1 byte CRLF throws RangeError
    await writeFile(filePath, `${olderRecord}\r\n${overLF}\r\n`);
    await expect(async () => {
      for await (const _ of readReverseJsonl(filePath, { maxRecordBytes: maxBytes, chunkSize: 13 })) {
        // drain
      }
    }).rejects.toThrow(RangeError);
  });

  it("proves oversized cross-chunk records never allocate or read buffers above maxRecordBytes + 2", async () => {
    const filePath = join(testDir, "oversized-cross-chunk.jsonl");
    const maxBytes = 50;
    const bigRecord = JSON.stringify({ id: 1, text: "x".repeat(120) });
    await writeFile(filePath, `{"id":0}\n${bigRecord}\n`);

    const handle = await open(filePath, "r");
    let maxPositionalReadRequested = 0;
    const origRead = handle.read.bind(handle);
    handle.read = ((
      buffer: NodeJS.ArrayBufferView,
      offset?: number | null,
      length?: number | null,
      position?: number | null,
    ) => {
      if (position !== undefined && typeof length === "number" && length > maxPositionalReadRequested) {
        maxPositionalReadRequested = length;
      }
      return origRead(buffer, offset, length, position);
    }) as typeof handle.read;

    try {
      await expect(async () => {
        for await (const _ of readReverseJsonl({ handle, maxRecordBytes: maxBytes, chunkSize: 17 })) {
          // drain
        }
      }).rejects.toThrow(RangeError);
      expect(maxPositionalReadRequested).toBeLessThanOrEqual(maxBytes + 2);
    } finally {
      await handle.close();
    }
  });

  it("assembles large records across thousands of chunk seams in a single linear pass", async () => {
    const filePath = join(testDir, "large-seams.jsonl");
    const olderRecord = JSON.stringify({ id: 0, text: "older" });
    const bigRecord = JSON.stringify({ id: 999, data: "x".repeat(100_000) });
    await writeFile(filePath, `${olderRecord}\n${bigRecord}\r\n${olderRecord}\n`);

    const results = [];
    for await (const record of readReverseJsonl<{ id: number }>(filePath, {
      chunkSize: 17,
      maxRecordBytes: 200_000,
    })) {
      results.push(record.value.id);
    }
    expect(results).toEqual([0, 999, 0]);
  });

  it("aliases reverseJsonl to readReverseJsonl", () => {
    expect(reverseJsonl).toBe(readReverseJsonl);
  });
});
