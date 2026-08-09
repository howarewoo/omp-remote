import { describe, expect, it } from "vitest";
import { parseTodoResult } from "./todo-parser.js";

const TODO_RESULT_TEXT = [
  "Remaining items (1):",
  "  - Build custom todo tool interface [in_progress] (Implementation)",
  "Overall: 2/4 done, 1 open, 1 blocked.",
  'Active phase 2/3 "Implementation" (0/1) — earliest phase with open work',
  "  Research:",
  "    - [X] Locate todo rendering and UI conventions",
  "    - [X] Define todo interaction contract",
  "  Implementation:",
  "    - [ ] Build custom todo tool interface (in progress)",
  "  Verification:",
  "    - [ ] Exercise todo flow in browser (blocked: format probe)",
].join("\n");

describe("parseTodoResult", () => {
  it("parses canonical multi-phase progress and derives phase states", () => {
    expect(parseTodoResult(TODO_RESULT_TEXT)).toEqual({
      overall: { done: 2, total: 4, open: 1, blocked: 1 },
      activePhase: { index: 2, total: 3, name: "Implementation", done: 0, taskTotal: 1 },
      phases: [
        {
          name: "Research",
          state: "completed",
          tasks: [
            { label: "Locate todo rendering and UI conventions", state: "completed" },
            { label: "Define todo interaction contract", state: "completed" },
          ],
        },
        {
          name: "Implementation",
          state: "in-progress",
          tasks: [{ label: "Build custom todo tool interface", state: "in-progress" }],
        },
        {
          name: "Verification",
          state: "blocked",
          tasks: [{ label: "Exercise todo flow in browser", state: "blocked", reason: "format probe" }],
        },
      ],
    });
  });

  it("preserves completed, blocked, and dropped task states", () => {
    const parsed = parseTodoResult(
      [
        "Overall: 2/3 done, 0 open, 1 blocked.",
        'Active phase 1/1 "Delivery" (2/3).',
        "  Delivery:",
        "    - [x] Ship renderer (completed)",
        "    - [ ] Await approval (blocked: review pending)",
        "    - [ ] Remove obsolete branch (dropped)",
      ].join("\n"),
    );

    expect(parsed?.overall).toEqual({ done: 2, total: 3, open: 0, blocked: 1 });
    expect(parsed?.phases[0]).toEqual({
      name: "Delivery",
      state: "blocked",
      tasks: [
        { label: "Ship renderer", state: "completed" },
        { label: "Await approval", state: "blocked", reason: "review pending" },
        { label: "Remove obsolete branch", state: "dropped" },
      ],
    });
  });

  it("accepts completed output without an active phase or open count", () => {
    expect(
      parseTodoResult(["Overall: 1/1 done.", "  Finish:", "    - [x] Hand off"].join("\n")),
    ).toMatchObject({
      overall: { done: 1, total: 1 },
      phases: [{ state: "completed" }],
    });
  });

  it("rejects overall and active counts that contradict task states", () => {
    expect(parseTodoResult(TODO_RESULT_TEXT.replace("2/4 done, 1 open", "1/4 done, 2 open"))).toBeNull();
    expect(parseTodoResult(TODO_RESULT_TEXT.replace("(0/1) —", "(1/1) —"))).toBeNull();
  });

  it("treats omitted open and blocked counts as zero", () => {
    expect(
      parseTodoResult(
        [
          "Overall: 0/1 done.",
          'Active phase 1/1 "Work" (0/1).',
          "  Work:",
          "    - [ ] Continue work (in progress)",
        ].join("\n"),
      ),
    ).toBeNull();
    expect(
      parseTodoResult(
        [
          "Overall: 0/1 done.",
          'Active phase 1/1 "Work" (0/1).',
          "  Work:",
          "    - [ ] Await access (blocked)",
        ].join("\n"),
      ),
    ).toBeNull();
  });
});
