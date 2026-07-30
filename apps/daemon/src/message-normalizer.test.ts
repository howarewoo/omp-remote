import { describe, expect, it } from "vitest";
import { normalizeRawMessage, normalizeSkillCommands } from "./message-normalizer.js";

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
