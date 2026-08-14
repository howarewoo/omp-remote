import { describe, expect, it } from "vitest";
import { normalizeRawMessage, normalizeSkillCommands, ToolCallTracker } from "./message-normalizer.js";

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
      lifecycle: { state: "running" },
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

  it("preserves only validated resolved-path metadata for a skill read result", () => {
    expect(
      normalizeRawMessage(
        {
          id: "skill-read-result",
          role: "toolResult",
          toolName: "read",
          content: "# Session learning",
          details: {
            meta: { source: { value: "skill://using-woostack/references/session-learning.md" } },
            resolvedPath: "  /Users/example/.agents/skills/using-woostack/references/session-learning.md  ",
            unrelated: { secret: true },
          },
        },
        false,
        "fallback-id",
      ),
    ).toEqual({
      id: "skill-read-result",
      role: "tool",
      text: "# Session learning",
      timestamp: expect.any(String),
      streaming: false,
      presentation: "text",
      toolName: "read",
      readTarget: "skill://using-woostack/references/session-learning.md",
      readResolvedPath: "/Users/example/.agents/skills/using-woostack/references/session-learning.md",
      lifecycle: { state: "success" },
    });
  });

  it("keeps read results valid when resolved-path metadata is absent", () => {
    const result = normalizeRawMessage(
      {
        id: "skill-read-without-resolved-path",
        role: "toolResult",
        toolName: "read",
        content: "# Session learning",
        details: {
          meta: { source: { value: "skill://using-woostack/references/session-learning.md" } },
        },
      },
      false,
      "fallback-id",
    );

    expect(result).toMatchObject({
      readTarget: "skill://using-woostack/references/session-learning.md",
    });
    expect(result).not.toHaveProperty("readResolvedPath");
  });

  it.each([
    ["blank", "   "],
    ["multiline", "/Users/example/skill.md\n/private"],
    ["non-string", 42],
    ["overlong", "x".repeat(10_001)],
  ])("omits %s resolved-path metadata", (_case, resolvedPath) => {
    expect(
      normalizeRawMessage(
        {
          id: "skill-read-malformed-path",
          role: "toolResult",
          toolName: "read",
          content: "# Session learning",
          details: {
            meta: { source: { value: "skill://using-woostack/references/session-learning.md" } },
            resolvedPath,
          },
        },
        false,
        "fallback-id",
      ),
    ).not.toHaveProperty("readResolvedPath");
  });

  it("does not preserve resolved-path details for other tools", () => {
    expect(
      normalizeRawMessage(
        {
          id: "bash-result-details",
          role: "toolResult",
          toolName: "bash",
          content: "command output",
          details: { resolvedPath: "/Users/example/.agents/skills/private.md" },
        },
        false,
        "fallback-id",
      ),
    ).not.toHaveProperty("readResolvedPath");
  });

  it.each([":1-180", ":raw", ":5-16,960-973"])(
    "correlates a read call so its requested %s selector survives result normalization",
    (selector) => {
      const toolCallTracker = new ToolCallTracker();
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
          { toolCallTracker },
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
          { toolCallTracker },
        ),
      ).toMatchObject({ readTarget: `/work/omp-remote/src/index.ts${selector}` });
    },
  );

  it("preserves the resolved SKILL.md path from Read source metadata", () => {
    const toolCallTracker = new ToolCallTracker();
    toolCallTracker.capture([
      {
        type: "toolCall",
        toolCallId: "skill-read-call",
        name: "read",
        arguments: { path: "skill://using-woostack" },
      },
    ]);

    expect(
      normalizeRawMessage(
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
        { toolCallTracker },
      ),
    ).toMatchObject({
      readTarget: "skill://using-woostack",
      readResolvedPath: "/Users/example/.agents/skills/using-woostack/SKILL.md",
    });
  });

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
    const toolCallTracker = new ToolCallTracker();
    toolCallTracker.observe(call);

    expect(normalizeRawMessage(result, true, "streaming-result", { toolCallTracker })).toMatchObject({
      readTarget: "/work/omp-remote/src/index.ts:1-180",
    });
    expect(normalizeRawMessage(result, false, "final-result", { toolCallTracker })).toMatchObject({
      readTarget: "/work/omp-remote/src/index.ts:1-180",
    });
    expect(normalizeRawMessage(result, false, "reused-result", { toolCallTracker })).toMatchObject({
      readTarget: "/work/omp-remote/src/index.ts",
    });

    const preWindowTracker = new ToolCallTracker();
    preWindowTracker.observe(call);
    preWindowTracker.observe(result);
    expect(
      normalizeRawMessage(result, false, "pre-window-reused-result", {
        toolCallTracker: preWindowTracker,
      }),
    ).toMatchObject({ readTarget: "/work/omp-remote/src/index.ts" });
  });

  it.each([
    {
      toolName: "bash",
      arguments: { command: "pnpm --filter sessions test\n&& pnpm lint" },
      details: {},
      content: "command output",
      expected: "Bash: pnpm --filter sessions test && pnpm lint",
    },
    {
      toolName: "write",
      arguments: { path: "packages/features/sessions/src/components/dashboard.tsx" },
      details: { resolvedPath: "/work/omp-remote/packages/features/sessions/src/components/dashboard.tsx" },
      content: "Wrote 42 bytes",
      expected: "Write: packages/features/sessions/src/components/dashboard.tsx",
    },
    {
      toolName: "edit",
      arguments: {
        input:
          "[.woostack/worktrees/revalidate-tri-245-defc/packages/infrastructure/ai/scripts/spikeChatgptMobileCapture.ts#ABCD]\nPUT >1:\n+const ready = true;",
      },
      details: {
        path: "/work/packages/infrastructure/ai/scripts/spikeChatgptMobileCapture.ts",
        diff: "+1|const ready = true;",
      },
      content: "*** Begin Patch\n*** End Patch",
      expected:
        "Edit: 🟦 .woostack/worktrees/revalidate-tri-245-defc/packages/infrastructure/ai/scripts/spikeChatgptMobileCapture.ts ⟦+1⟧",
    },
    {
      toolName: "grep",
      arguments: {
        pattern: 'type: "toolCall"|toolCallId|arguments: \\{ path|name: "bash"|name: "edit"',
        path: "apps;packages",
      },
      details: { matchCount: 24, fileCount: 3, scopePath: "ignored" },
      content: "matches",
      expected:
        'Grep: type: "toolCall"|toolCallId|arguments: \\{ path|name: "bash"|name: "edit" 24 matches · 3 files · in apps, packages',
    },
    {
      toolName: "hub",
      arguments: { op: "send", to: "SessionDiffCoder", message: "Please finish now." },
      details: {
        op: "send",
        to: "SessionDiffCoder",
        receipts: [{ to: "SessionDiffCoder", outcome: "injected" }],
      },
      content: "Delivered to SessionDiffCoder",
      expected: "IRC ➤ SessionDiffCoder injected",
    },
  ])("formats $toolName disclosure metadata from its call and result", (fixture) => {
    const toolCallTracker = new ToolCallTracker();
    const toolCallId = `${fixture.toolName}-call`;
    normalizeRawMessage(
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            toolCallId,
            name: fixture.toolName,
            arguments: fixture.arguments,
          },
        ],
      },
      false,
      `${fixture.toolName}-assistant`,
      { toolCallTracker },
    );

    expect(
      normalizeRawMessage(
        {
          role: "toolResult",
          toolCallId,
          toolName: fixture.toolName,
          content: fixture.content,
          details: fixture.details,
          isError: false,
        },
        false,
        `${fixture.toolName}-result`,
        { toolCallTracker },
      ),
    ).toMatchObject({ toolTitle: fixture.expected });
  });

  it("formats a received IRC message in the Hub disclosure header", () => {
    expect(
      normalizeRawMessage(
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
  it("keeps applied Edit counts when a later file fails", () => {
    const toolCallTracker = new ToolCallTracker();
    toolCallTracker.capture([
      {
        type: "toolCall",
        toolCallId: "partial-edit-call",
        name: "edit",
        arguments: { input: "[src/a.ts#ABCD]\nPUT >1:\n+const ready = true;" },
      },
    ]);

    expect(
      normalizeRawMessage(
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
        { toolCallTracker },
      ),
    ).toMatchObject({
      text: "src/b.ts had a stale snapshot tag",
      presentation: "text",
      toolTitle: "Edit: 🟦 src/a.ts ⟦+1⟧",
    });
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
  it("normalizes only Read image parts through the supplied blob resolver", () => {
    const normalized = normalizeRawMessage(
      {
        id: "read-image",
        role: "toolResult",
        toolName: "read",
        content: [
          { type: "text", text: "A screenshot" },
          { type: "image", data: "blob:sha256:abc", mimeType: "image/png" },
        ],
      },
      false,
      "fallback-id",
      {
        resolveReadImage: (data, mimeType) => ({
          status: "available",
          data: `${data}:${mimeType}`,
          mimeType: "image/png",
        }),
      },
    );
    expect(normalized).toMatchObject({
      text: "A screenshot",
      images: [{ status: "available", mimeType: "image/png" }],
    });
    expect(
      normalizeRawMessage(
        {
          id: "assistant-image",
          role: "assistant",
          content: [{ type: "image", data: "blob:sha256:abc", mimeType: "image/png" }],
        },
        false,
        "fallback-id",
      ),
    ).toBeNull();
    const errored = normalizeRawMessage(
      {
        id: "errored-read-image",
        role: "toolResult",
        toolName: "read",
        isError: true,
        content: [{ type: "image", data: "blob:sha256:abc", mimeType: "image/png" }],
      },
      false,
      "fallback-id",
      { resolveReadImage: () => ({ status: "available", mimeType: "image/png", data: "iVBORw0KGgo=" }) },
    );
    expect(errored?.images).toEqual([{ status: "unavailable", reason: "invalid_reference" }]);
  });

  it("assigns explicit lifecycle evidence for running, successful, and errored tool results", () => {
    const running = normalizeRawMessage(
      {
        id: "tool-running-raw",
        role: "toolResult",
        toolName: "bash",
        content: "executing...",
      },
      true,
      "fallback-id",
    );
    expect(running?.lifecycle).toEqual({ state: "running" });
    expect(running?.streaming).toBe(true);

    const success = normalizeRawMessage(
      {
        id: "tool-success-raw",
        role: "toolResult",
        toolName: "bash",
        content: "executed",
        isError: false,
      },
      false,
      "fallback-id",
    );
    expect(success?.lifecycle).toEqual({ state: "success" });
    expect(success?.streaming).toBe(false);

    const successDefault = normalizeRawMessage(
      {
        id: "tool-success-default",
        role: "toolResult",
        toolName: "bash",
        content: "executed",
      },
      false,
      "fallback-id",
    );
    expect(successDefault?.lifecycle).toEqual({ state: "success" });

    const errored = normalizeRawMessage(
      {
        id: "tool-error-raw",
        role: "toolResult",
        toolName: "bash",
        content: "execution failed",
        isError: true,
      },
      false,
      "fallback-id",
    );
    expect(errored?.lifecycle).toEqual({ state: "error" });
    expect(errored?.streaming).toBe(false);
  });

  it("omits lifecycle for non-tool messages and preserves legacy streaming semantics", () => {
    const user = normalizeRawMessage(
      {
        id: "user-raw-1",
        role: "user",
        content: "Analyze workspace",
      },
      false,
      "fallback-id",
    );
    expect(user?.lifecycle).toBeUndefined();

    const assistant = normalizeRawMessage(
      {
        id: "assistant-raw-1",
        role: "assistant",
        content: "Analyzing workspace...",
      },
      true,
      "fallback-id",
    );
    expect(assistant?.lifecycle).toBeUndefined();
    expect(assistant?.streaming).toBe(true);
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
