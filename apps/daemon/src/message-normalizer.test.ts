import { describe, expect, it } from "vitest";
import { normalizeRawMessage, normalizeSkillCommands, ReadTargetTracker } from "./message-normalizer.js";

const SNAPSHOT_CONTENT = [{ type: "text", text: "*** Begin Patch\n*** End Patch" }];
const CANONICAL_DIFF = "-1|before\n+1|after";

describe("normalizeRawMessage", () => {
  it("preserves a successful RPC edit result as a streaming canonical diff", () => {
    expect(
      normalizeRawMessage(
        {
          id: "edit-result-1",
          role: "toolResult",
          toolName: "edit",
          content: SNAPSHOT_CONTENT,
          details: { diff: CANONICAL_DIFF },
          isError: false,
          timestamp: "2026-07-29T12:00:00.000Z",
        },
        true,
        "fallback-id",
      ),
    ).toEqual({
      id: "edit-result-1",
      role: "tool",
      text: CANONICAL_DIFF,
      timestamp: "2026-07-29T12:00:00.000Z",
      streaming: true,
      presentation: "diff",
      toolName: "edit",
    });
  });

  it("keeps a successful non-edit result as tool text even when details contains a diff", () => {
    expect(
      normalizeRawMessage(
        {
          id: "bash-result-1",
          role: "toolResult",
          toolName: "bash",
          content: [{ type: "text", text: "command output" }],
          details: { diff: CANONICAL_DIFF },
          isError: false,
          timestamp: "2026-07-29T12:00:00.000Z",
        },
        false,
        "fallback-id",
      ),
    ).toMatchObject({
      role: "tool",
      text: "command output",
      streaming: false,
      presentation: "text",
      toolName: "bash",
    });
  });

  it.each([
    ["errored edits", { details: { diff: CANONICAL_DIFF }, isError: true }],
    ["edits without a string diff", { details: { diff: null }, isError: false }],
  ])("keeps %s as snapshot text", (_case, editState) => {
    expect(
      normalizeRawMessage(
        {
          id: "edit-result-text",
          role: "toolResult",
          toolName: "edit",
          content: SNAPSHOT_CONTENT,
          timestamp: "2026-07-29T12:00:00.000Z",
          ...editState,
        },
        false,
        "fallback-id",
      ),
    ).toMatchObject({
      role: "tool",
      text: "*** Begin Patch\n*** End Patch",
      streaming: false,
      presentation: "text",
      toolName: "edit",
    });
  });

  it.each([
    ["a null tool name", { toolName: null, isError: false }],
    ["a non-boolean error flag", { toolName: "edit", isError: "false" }],
  ])("keeps snapshot text when tool metadata has %s", (_case, metadata) => {
    expect(
      normalizeRawMessage(
        {
          id: "malformed-tool-metadata",
          role: "toolResult",
          content: SNAPSHOT_CONTENT,
          details: { diff: CANONICAL_DIFF },
          ...metadata,
        },
        false,
        "fallback-id",
      ),
    ).toMatchObject({
      id: "malformed-tool-metadata",
      role: "tool",
      text: "*** Begin Patch\n*** End Patch",
      presentation: "text",
    });
  });

  it("preserves validated result metadata and prefers its source over the directory fallback", () => {
    expect(
      normalizeRawMessage(
        {
          id: "read-result-1",
          role: "toolResult",
          toolName: "read",
          content: "file contents",
          details: {
            meta: { source: { value: "/work/omp-remote/src/index.ts" } },
            path: "/work/omp-remote/src",
          },
        },
        false,
        "fallback-id",
      ),
    ).toMatchObject({ readTarget: "/work/omp-remote/src/index.ts" });

    expect(
      normalizeRawMessage(
        {
          id: "read-directory-1",
          role: "toolResult",
          toolName: "read",
          content: "src/\n  index.ts",
          details: { path: "/work/omp-remote/src" },
        },
        false,
        "fallback-id",
      ),
    ).toMatchObject({ readTarget: "/work/omp-remote/src" });
  });
  it.each([":1-180", ":raw", ":5-16,960-973"])(
    "correlates a read call so its requested %s selector survives result normalization",
    (selector) => {
      const readTargetTracker = new ReadTargetTracker();
      expect(
        normalizeRawMessage(
          {
            id: `assistant-read-${selector}`,
            role: "assistant",
            content: [
              {
                type: "toolCall",
                toolCallId: `read-call-${selector}`,
                name: "read",
                arguments: { path: `/work/omp-remote/src/index.ts${selector}` },
              },
            ],
          },
          false,
          "assistant-fallback",
          { readTargetTracker },
        ),
      ).toBeNull();

      expect(
        normalizeRawMessage(
          {
            id: `read-result-${selector}`,
            role: "toolResult",
            toolCallId: `read-call-${selector}`,
            toolName: "read",
            content: "file contents",
            details: { meta: { source: { value: "/work/omp-remote/src/index.ts" } } },
          },
          false,
          "result-fallback",
          { readTargetTracker },
        ),
      ).toMatchObject({ readTarget: `/work/omp-remote/src/index.ts${selector}` });
    },
  );

  it("retains selectors through streaming results and consumes them on the final result", () => {
    const call = {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          toolCallId: "read-call-streaming",
          name: "read",
          arguments: { path: "/work/omp-remote/src/index.ts:1-180" },
        },
      ],
    };
    const result = {
      role: "toolResult",
      toolCallId: "read-call-streaming",
      toolName: "read",
      content: "file contents",
      details: { meta: { source: { value: "/work/omp-remote/src/index.ts" } } },
    };
    const readTargetTracker = new ReadTargetTracker();
    readTargetTracker.observe(call);

    expect(normalizeRawMessage(result, true, "streaming-result", { readTargetTracker })).toMatchObject({
      readTarget: "/work/omp-remote/src/index.ts:1-180",
    });
    expect(normalizeRawMessage(result, false, "final-result", { readTargetTracker })).toMatchObject({
      readTarget: "/work/omp-remote/src/index.ts:1-180",
    });
    expect(normalizeRawMessage(result, false, "reused-result", { readTargetTracker })).toMatchObject({
      readTarget: "/work/omp-remote/src/index.ts",
    });

    const preWindowTracker = new ReadTargetTracker();
    preWindowTracker.observe(call);
    preWindowTracker.observe(result);
    expect(
      normalizeRawMessage(result, false, "pre-window-reused-result", {
        readTargetTracker: preWindowTracker,
      }),
    ).toMatchObject({ readTarget: "/work/omp-remote/src/index.ts" });
  });

  it.each([
    ["blank source metadata", { meta: { source: { value: " \n " } } }],
    ["non-string source metadata", { meta: { source: { value: 42 } } }],
    ["an arbitrary nested value", { request: { path: "/work/secret.txt" } }],
    ["a malformed directory fallback", { path: { value: "/work/secret.txt" } }],
  ])("ignores %s for read target provenance", (_case, details) => {
    expect(
      normalizeRawMessage(
        {
          id: "read-result-malformed",
          role: "toolResult",
          toolName: "read",
          content: "result",
          details,
        },
        false,
        "fallback-id",
      ),
    ).not.toHaveProperty("readTarget");
  });

  it("drops non-text assistant content", () => {
    expect(
      normalizeRawMessage(
        { id: "assistant-thinking", role: "assistant", content: [{ type: "thinking" }] },
        true,
        "fallback-id",
      ),
    ).toBeNull();
  });

  it("keeps empty live tool results unless all empty text is explicitly omitted", () => {
    const raw = { id: "empty-tool-result", role: "toolResult", content: [{ type: "status" }] };

    expect(normalizeRawMessage(raw, true, "fallback-id")).toMatchObject({
      id: "empty-tool-result",
      role: "tool",
      text: "",
      streaming: true,
    });
    expect(normalizeRawMessage(raw, false, "fallback-id", { omitEmptyText: true })).toBeNull();
  });

  it("rejects a present non-string message id", () => {
    expect(
      normalizeRawMessage({ id: 42, role: "assistant", content: "invalid id" }, false, "fallback-id"),
    ).toBeNull();
  });
});

describe("normalizeSkillCommands", () => {
  it("keeps only valid skill command metadata from OMP", () => {
    expect(
      normalizeSkillCommands([
        { name: "skill:seo", description: "Audit search visibility", source: "skill" },
        { name: "help", description: "Show help", source: "builtin" },
        { name: "skill:broken", description: 42, source: "skill" },
      ]),
    ).toEqual([{ name: "skill:seo", description: "Audit search visibility" }]);
  });
});
