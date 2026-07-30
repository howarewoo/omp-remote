import { describe, expect, it } from "vitest";
import { getSkillCommands, normalizeExtensionMessage } from "./extension.js";

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

  it("rejects a present non-string message id", () => {
    expect(
      normalizeExtensionMessage({ id: 42, role: "assistant", content: "invalid id" }, false, "fallback-id"),
    ).toBeNull();
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
