import { describe, expect, it } from "vitest";
import {
  boundTranscriptImageBudget,
  TRANSCRIPT_IMAGE_MAX_BYTES,
  TRANSCRIPT_TEXT_LIMIT,
  TranscriptImageSchema,
  TranscriptMessageSchema,
  truncateTranscriptText,
  validateTranscriptImageBytes,
} from "./index.js";

describe("truncateTranscriptText", () => {
  it("adds an ellipsis without splitting a UTF-16 surrogate pair", () => {
    const exactLimit = "x".repeat(TRANSCRIPT_TEXT_LIMIT);
    const surrogateAtBoundary = `${"x".repeat(TRANSCRIPT_TEXT_LIMIT - 1)}😀tail`;

    expect(truncateTranscriptText(exactLimit)).toBe(exactLimit);
    expect(truncateTranscriptText(`${exactLimit}tail`)).toBe(`${exactLimit}…`);
    expect(truncateTranscriptText(surrogateAtBoundary)).toBe(`${"x".repeat(TRANSCRIPT_TEXT_LIMIT - 1)}…`);
  });
});

describe("TranscriptImageSchema", () => {
  it("validates each supported raster signature against its MIME type", () => {
    const fixtures = [
      ["image/png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
      ["image/jpeg", [0xff, 0xd8, 0xff, 0xe0]],
      ["image/gif", [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]],
      ["image/webp", [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]],
      ["image/avif", [0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66, 0, 0, 0, 0]],
    ] as const;
    for (const [mimeType, bytes] of fixtures) {
      expect(validateTranscriptImageBytes(new Uint8Array(bytes), mimeType)).toBeNull();
    }
  });

  it.each([
    ["image/png", "image/jpeg"],
    ["image/svg+xml", "image/png"],
  ] as const)("rejects an invalid or mismatched image (%s as %s)", (mimeType, signatureMimeType) => {
    const bytes =
      signatureMimeType === "image/png"
        ? new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
        : new Uint8Array([0xff, 0xd8, 0xff]);
    expect(validateTranscriptImageBytes(bytes, mimeType)).not.toBeNull();
  });
  it("rejects an unpadded base64 payload that decodes above the per-image limit", () => {
    const data = "A".repeat(Math.ceil(TRANSCRIPT_IMAGE_MAX_BYTES / 3) * 4);
    expect(
      TranscriptImageSchema.safeParse({ status: "available", mimeType: "image/png", data }).success,
    ).toBe(false);
  });

  it("rejects generic mif1 data without an AVIF compatible brand", () => {
    expect(
      validateTranscriptImageBytes(
        new Uint8Array([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x69, 0x66, 0x31, 0, 0, 0, 0]),
        "image/avif",
      ),
    ).toBe("mime_mismatch");
  });
  it("accepts mif1 data with an AVIF compatible brand inside ftyp", () => {
    expect(
      validateTranscriptImageBytes(
        new Uint8Array([
          0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x69, 0x66, 0x31, 0, 0, 0, 0, 0x61, 0x76, 0x69, 0x66,
        ]),
        "image/avif",
      ),
    ).toBeNull();
  });

  it("represents unavailable payloads without retaining bytes or paths", () => {
    expect(TranscriptImageSchema.parse({ status: "unavailable", reason: "budget_exceeded" })).toEqual({
      status: "unavailable",
      reason: "budget_exceeded",
    });
  });

  it("bounds retained available image bytes to the session budget", () => {
    const data = `${"A".repeat(Math.ceil(TRANSCRIPT_IMAGE_MAX_BYTES / 3) * 4 - 2)}==`;
    const messages = boundTranscriptImageBudget(
      Array.from({ length: 6 }, (_, index) => ({
        id: `image-${index}`,
        role: "tool" as const,
        text: "",
        timestamp: "2026-08-05T00:00:00.000Z",
        streaming: false,
        presentation: "text" as const,
        images: [{ status: "available" as const, mimeType: "image/png" as const, data }],
      })),
    );
    expect(messages.slice(0, 5).every((message) => message.images?.[0]?.status === "available")).toBe(true);
    expect(messages[5]?.images?.[0]).toMatchObject({ status: "unavailable", reason: "budget_exceeded" });
  });
});

describe("TranscriptMessageSchema", () => {
  it("preserves structured edit diff presentation and tool identity", () => {
    expect(
      TranscriptMessageSchema.parse({
        id: "edit-result-1",
        role: "tool",
        text: "-1|before\n+1|after",
        timestamp: "2026-07-29T12:00:00.000Z",
        streaming: false,
        presentation: "diff",
        toolName: "edit",
        toolTitle: "Edit: 🟦 src/dashboard.tsx ⟦+1⟧ ⟦−1⟧",
      }),
    ).toEqual({
      id: "edit-result-1",
      role: "tool",
      text: "-1|before\n+1|after",
      timestamp: "2026-07-29T12:00:00.000Z",
      streaming: false,
      presentation: "diff",
      toolName: "edit",
      toolTitle: "Edit: 🟦 src/dashboard.tsx ⟦+1⟧ ⟦−1⟧",
    });
  });

  it("preserves optional resolved-path metadata for read results", () => {
    expect(
      TranscriptMessageSchema.parse({
        id: "skill-read-result-1",
        role: "tool",
        text: "# Session learning",
        timestamp: "2026-07-29T12:00:00.000Z",
        streaming: false,
        toolName: "read",
        readTarget: "skill://using-woostack/references/session-learning.md",
        readResolvedPath: "/Users/example/.agents/skills/using-woostack/references/session-learning.md",
      }),
    ).toMatchObject({
      readTarget: "skill://using-woostack/references/session-learning.md",
      readResolvedPath: "/Users/example/.agents/skills/using-woostack/references/session-learning.md",
    });
  });

  it("defaults legacy transcript frames to text presentation", () => {
    expect(
      TranscriptMessageSchema.parse({
        id: "legacy-message-1",
        role: "system",
        text: "Legacy extension output",
        timestamp: "2026-07-29T12:00:00.000Z",
        streaming: false,
      }),
    ).toEqual({
      id: "legacy-message-1",
      role: "system",
      text: "Legacy extension output",
      timestamp: "2026-07-29T12:00:00.000Z",
      streaming: false,
      presentation: "text",
    });
  });
});
