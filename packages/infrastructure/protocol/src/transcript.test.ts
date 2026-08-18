import { describe, expect, it } from "vitest";
import {
  boundTranscriptImageBudget,
  SessionTranscriptResponseSchema,
  TRANSCRIPT_IMAGE_MAX_BYTES,
  TRANSCRIPT_PAGE_SIZE,
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

  it("preserves running tool lifecycle on a streaming tool message", () => {
    expect(
      TranscriptMessageSchema.parse({
        id: "tool-running-1",
        role: "tool",
        text: "partial stdout",
        timestamp: "2026-07-29T12:00:00.000Z",
        streaming: true,
        toolName: "bash",
        lifecycle: { state: "running" },
      }),
    ).toEqual({
      id: "tool-running-1",
      role: "tool",
      text: "partial stdout",
      timestamp: "2026-07-29T12:00:00.000Z",
      streaming: true,
      presentation: "text",
      toolName: "bash",
      lifecycle: { state: "running" },
    });
  });

  it("preserves success tool lifecycle on a completed tool message", () => {
    expect(
      TranscriptMessageSchema.parse({
        id: "tool-success-1",
        role: "tool",
        text: "command succeeded",
        timestamp: "2026-07-29T12:00:00.000Z",
        streaming: false,
        toolName: "bash",
        lifecycle: { state: "success" },
      }),
    ).toEqual({
      id: "tool-success-1",
      role: "tool",
      text: "command succeeded",
      timestamp: "2026-07-29T12:00:00.000Z",
      streaming: false,
      presentation: "text",
      toolName: "bash",
      lifecycle: { state: "success" },
    });
  });

  it("preserves error tool lifecycle on an errored tool message", () => {
    expect(
      TranscriptMessageSchema.parse({
        id: "tool-error-1",
        role: "tool",
        text: "command failed with exit code 1",
        timestamp: "2026-07-29T12:00:00.000Z",
        streaming: false,
        toolName: "bash",
        lifecycle: { state: "error" },
      }),
    ).toEqual({
      id: "tool-error-1",
      role: "tool",
      text: "command failed with exit code 1",
      timestamp: "2026-07-29T12:00:00.000Z",
      streaming: false,
      presentation: "text",
      toolName: "bash",
      lifecycle: { state: "error" },
    });
  });

  it("preserves legacy records without the lifecycle field across all roles", () => {
    const roles = ["user", "assistant", "tool", "system"] as const;
    for (const role of roles) {
      const parsed = TranscriptMessageSchema.parse({
        id: `legacy-${role}-1`,
        role,
        text: `Legacy content for ${role}`,
        timestamp: "2026-07-29T12:00:00.000Z",
        streaming: false,
      });
      expect(parsed.lifecycle).toBeUndefined();
      expect(parsed.role).toBe(role);
    }
  });

  it.each([
    ["running state on a non-streaming tool message", { streaming: false, lifecycle: { state: "running" } }],
    ["success state on a streaming tool message", { streaming: true, lifecycle: { state: "success" } }],
    ["error state on a streaming tool message", { streaming: true, lifecycle: { state: "error" } }],
    ["lifecycle on a non-tool role", { role: "assistant", streaming: true, lifecycle: { state: "running" } }],
    [
      "error lifecycle with canonical diff presentation",
      { presentation: "diff", lifecycle: { state: "error" } },
    ],
    ["unevidenced waiting state", { lifecycle: { state: "waiting" } }],
    ["unevidenced canceled state", { lifecycle: { state: "canceled" } }],
    ["unknown lifecycle state", { lifecycle: { state: "unknown" } }],
  ])("rejects contradictory or unevidenced %s", (_case, patch) => {
    const candidate = {
      id: "contradictory-message-1",
      role: "tool" as const,
      text: "output",
      timestamp: "2026-07-29T12:00:00.000Z",
      streaming: false,
      presentation: "text" as const,
      toolName: "bash",
      ...patch,
    };
    expect(TranscriptMessageSchema.safeParse(candidate).success).toBe(false);
  });
});

describe("SessionTranscriptResponseSchema", () => {
  const msg = { id: "m1", role: "user" as const, text: "hi", timestamp: "2026-08-01T00:00:00.000Z", streaming: false, presentation: "text" as const };

  it.each([
    ["complete", { status: "complete", olderCursor: null, messages: [msg] }],
    ["available", { status: "available", olderCursor: "cursor-123", messages: [msg] }],
    ["unavailable", { status: "unavailable", olderCursor: null, messages: [msg] }],
    ["invalidated", { status: "invalidated", olderCursor: null, messages: [] }],
  ] as const)("validates %s variant", (_name, variant) => {
    expect(SessionTranscriptResponseSchema.parse({ sessionId: "s1", ...variant })).toMatchObject({ sessionId: "s1", ...variant });
  });

  it.each([
    ["available with null cursor", { status: "available", messages: [], olderCursor: null }],
    ["complete with string cursor", { status: "complete", messages: [], olderCursor: "c" }],
    ["unavailable with string cursor", { status: "unavailable", messages: [], olderCursor: "c" }],
    ["invalidated with string cursor", { status: "invalidated", messages: [], olderCursor: "c" }],
    ["empty sessionId", { sessionId: "", status: "complete", messages: [], olderCursor: null }],
    ["unknown property (strict)", { sessionId: "s1", status: "complete", messages: [], olderCursor: null, extra: 1 }],
    ["messages exceeding page size", { sessionId: "s1", status: "complete", messages: Array.from({ length: TRANSCRIPT_PAGE_SIZE + 1 }, (_, i) => ({ ...msg, id: `m-${i}` })), olderCursor: null }],
  ])("rejects invalid response: %s", (_case, payload) => {
    expect(SessionTranscriptResponseSchema.safeParse({ sessionId: "s1", ...payload }).success).toBe(false);
  });
});
