import { describe, expect, it } from "vitest";
import { ExtensionToolCallTracker, getSkillCommands, normalizeExtensionMessage } from "./extension.js";

const SNAPSHOT_CONTENT = [{ type: "text", text: "*** Begin Patch\n*** End Patch" }];
const CANONICAL_DIFF = "-1|before\n+1|after";

describe("normalizeExtensionMessage", () => {
  it("preserves a successful edit result as a streaming canonical diff", () => {
    expect(
      normalizeExtensionMessage(
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
      normalizeExtensionMessage(
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
      normalizeExtensionMessage(
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

  it("correlates disclosure metadata for live extension tool results", () => {
    const tracker = new ExtensionToolCallTracker();
    expect(
      normalizeExtensionMessage(
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              toolCallId: "read-call",
              name: "read",
              arguments: { path: "/work/omp-remote/src/a.ts:1-20" },
            },
            {
              type: "toolCall",
              toolCallId: "bash-call",
              name: "bash",
              arguments: { command: "pnpm test" },
            },
            {
              type: "toolCall",
              toolCallId: "edit-call",
              name: "edit",
              arguments: { input: "[src/a.ts#ABCD]\nPUT >1:\n+const ready = true;" },
            },
            {
              type: "toolCall",
              toolCallId: "grep-call",
              name: "grep",
              arguments: { pattern: "toolCallId", path: "apps;packages" },
            },
            {
              type: "toolCall",
              toolCallId: "hub-call",
              name: "hub",
              arguments: { op: "send", to: "SessionDiffCoder", message: "Please finish now." },
            },
          ],
        },
        false,
        "assistant",
        tracker,
      ),
    ).toBeNull();

    expect(
      normalizeExtensionMessage(
        {
          role: "toolResult",
          toolCallId: "read-call",
          toolName: "read",
          content: "alpha",
          details: { path: "/work/omp-remote/src/a.ts" },
        },
        false,
        "read",
        tracker,
      ),
    ).toMatchObject({ readTarget: "/work/omp-remote/src/a.ts:1-20" });
    expect(
      normalizeExtensionMessage(
        {
          role: "toolResult",
          toolCallId: "bash-call",
          toolName: "bash",
          content: "passed",
          details: {},
        },
        false,
        "bash",
        tracker,
      ),
    ).toMatchObject({ toolTitle: "Bash: pnpm test" });
    expect(
      normalizeExtensionMessage(
        {
          role: "toolResult",
          toolCallId: "edit-call",
          toolName: "edit",
          content: SNAPSHOT_CONTENT,
          details: { path: "/work/omp-remote/src/a.ts", diff: "+1|const ready = true;" },
          isError: false,
        },
        false,
        "edit",
        tracker,
      ),
    ).toMatchObject({ toolTitle: "Edit: 🟦 src/a.ts ⟦+1⟧" });
    expect(
      normalizeExtensionMessage(
        {
          role: "toolResult",
          toolCallId: "grep-call",
          toolName: "grep",
          content: "matches",
          details: { matchCount: 24, fileCount: 3 },
        },
        false,
        "grep",
        tracker,
      ),
    ).toMatchObject({ toolTitle: "Grep: toolCallId 24 matches · 3 files · in apps, packages" });
    expect(
      normalizeExtensionMessage(
        {
          role: "toolResult",
          toolCallId: "hub-call",
          toolName: "hub",
          content: "Delivered to SessionDiffCoder",
          details: {
            op: "send",
            to: "SessionDiffCoder",
            receipts: [{ to: "SessionDiffCoder", outcome: "injected" }],
          },
        },
        false,
        "hub",
        tracker,
      ),
    ).toMatchObject({ toolTitle: "IRC ➤ SessionDiffCoder injected" });
  });

  it("preserves the resolved SKILL.md path from Read source metadata", () => {
    const tracker = new ExtensionToolCallTracker();
    tracker.capture([
      {
        type: "toolCall",
        toolCallId: "skill-read-call",
        name: "read",
        arguments: { path: "skill://using-woostack" },
      },
    ]);

    expect(
      normalizeExtensionMessage(
        {
          role: "toolResult",
          toolCallId: "skill-read-call",
          toolName: "read",
          content: "# Using woostack",
          details: {
            meta: { source: { value: "/Users/example/.agents/skills/using-woostack/SKILL.md" } },
          },
        },
        false,
        "skill-read-result",
        tracker,
      ),
    ).toMatchObject({
      readTarget: "skill://using-woostack",
      readResolvedPath: "/Users/example/.agents/skills/using-woostack/SKILL.md",
    });
  });

  it("keeps applied Edit counts when a later file fails", () => {
    const tracker = new ExtensionToolCallTracker();
    tracker.capture([
      {
        type: "toolCall",
        toolCallId: "partial-edit-call",
        name: "edit",
        arguments: { input: "[src/a.ts#ABCD]\nPUT >1:\n+const ready = true;" },
      },
    ]);

    expect(
      normalizeExtensionMessage(
        {
          role: "toolResult",
          toolCallId: "partial-edit-call",
          toolName: "edit",
          content: "src/b.ts had a stale snapshot tag",
          details: { diff: "+1|const ready = true;" },
          isError: true,
        },
        false,
        "partial-edit-result",
        tracker,
      ),
    ).toMatchObject({
      text: "src/b.ts had a stale snapshot tag",
      presentation: "text",
      toolTitle: "Edit: 🟦 src/a.ts ⟦+1⟧",
    });
  });

  it("formats a received IRC message in the Hub disclosure header", () => {
    expect(
      normalizeExtensionMessage(
        {
          role: "toolResult",
          toolName: "hub",
          content: "[message-id] SessionDiffCoder: Review complete.",
          details: {
            op: "wait",
            from: "Main",
            waited: {
              from: "SessionDiffCoder",
              to: "Main",
              body: "Review complete.",
            },
          },
          isError: false,
        },
        false,
        "hub-wait-result",
      ),
    ).toMatchObject({ toolTitle: "✉ IRC ⟵ SessionDiffCoder" });
  });

  it("rejects a present non-string message id", () => {
    expect(
      normalizeExtensionMessage({ id: 42, role: "assistant", content: "invalid id" }, false, "fallback-id"),
    ).toBeNull();
  });
  it("normalizes Read image parts through the resolver and omits assistant images", () => {
    expect(
      normalizeExtensionMessage(
        {
          id: "extension-read-image",
          role: "toolResult",
          toolName: "read",
          content: [{ type: "image", data: "blob:sha256:test", mimeType: "image/png" }],
        },
        false,
        "fallback-id",
        undefined,
        () => ({ status: "unavailable", reason: "missing" }),
      ),
    ).toMatchObject({ images: [{ status: "unavailable", reason: "missing" }] });
    expect(
      normalizeExtensionMessage(
        {
          role: "assistant",
          content: [{ type: "image", data: "blob:sha256:test", mimeType: "image/png" }],
        },
        false,
        "fallback-id",
      ),
    ).toBeNull();
    expect(
      normalizeExtensionMessage(
        {
          id: "errored-read-image",
          role: "toolResult",
          toolName: "read",
          isError: true,
          content: [{ type: "image", data: "blob:sha256:test", mimeType: "image/png" }],
        },
        false,
        "fallback-id",
        undefined,
        () => ({ status: "available", mimeType: "image/png", data: "iVBORw0KGgo=" }),
      ),
    ).toMatchObject({ images: [{ status: "unavailable", reason: "invalid_reference" }] });
  });
});

describe("getSkillCommands", () => {
  it("keeps only skill commands exposed by the active OMP session", () => {
    expect(
      getSkillCommands([
        { name: "skill:seo", description: "Audit search visibility", source: "skill" },
        { name: "review", description: "Review changes", source: "prompt" },
      ]),
    ).toEqual([{ name: "skill:seo", description: "Audit search visibility" }]);
  });
});
