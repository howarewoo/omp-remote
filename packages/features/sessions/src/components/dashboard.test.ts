import type { Session } from "@omp-remote/protocol";
import { describe, expect, it } from "vitest";
import { formatSubagentActivityLabel, groupSessionsByConnection, parseTranscriptText } from "./dashboard.js";

const BASE_SESSION: Session = {
  id: "session-1",
  source: "rpc",
  name: "Bootstrap",
  cwd: "/work/omp-remote",
  status: "idle",
  connected: true,
  model: "openai/gpt-5.6",
  contextPercent: 12,
  createdAt: "2026-07-28T16:00:00.000Z",
  lastActivity: "2026-07-28T17:00:00.000Z",
  capabilities: ["prompt", "steer", "follow_up", "abort", "resume"],
  messages: [],
  sessionPath: "/work/.omp/session.jsonl",
  activeSubagents: [],
};

describe("groupSessionsByConnection", () => {
  it("lists connected sessions before disconnected sessions while preserving their order", () => {
    const sessions = [
      { ...BASE_SESSION, id: "disconnected-new", connected: false, status: "disconnected" as const },
      { ...BASE_SESSION, id: "connected-new" },
      { ...BASE_SESSION, id: "connected-old" },
      { ...BASE_SESSION, id: "disconnected-old", connected: false, status: "history" as const },
    ];

    expect(groupSessionsByConnection(sessions)).toEqual([
      {
        id: "connected",
        label: "Connected",
        sessions: [sessions[1], sessions[2]],
      },
      {
        id: "disconnected",
        label: "Disconnected",
        sessions: [sessions[0], sessions[3]],
      },
    ]);
  });

  it("omits empty connection sections", () => {
    expect(groupSessionsByConnection([BASE_SESSION])).toEqual([
      {
        id: "connected",
        label: "Connected",
        sessions: [BASE_SESSION],
      },
    ]);
  });
});

describe("formatSubagentActivityLabel", () => {
  it.each([
    [1, "1 subagent running"],
    [3, "3 subagents running"],
  ])("formats %i active subagents", (count, expected) => {
    expect(formatSubagentActivityLabel(count)).toBe(expected);
  });
});

describe("parseTranscriptText", () => {
  it("marks additions and deletions inside fenced diffs", () => {
    expect(
      parseTranscriptText(
        [
          "Updated the component:",
          "```diff",
          " const stable = true;",
          "-const tone = 'blue';",
          "+const tone = 'green';",
          "```",
        ].join("\n"),
      ),
    ).toEqual([
      { kind: "text", text: "Updated the component:" },
      { kind: "context", text: " const stable = true;" },
      { kind: "removed", text: "-const tone = 'blue';" },
      { kind: "added", text: "+const tone = 'green';" },
    ]);
  });

  it("keeps unified diff metadata distinct from changed lines", () => {
    expect(
      parseTranscriptText(
        [
          "diff --git a/source.ts b/source.ts",
          "--- a/source.ts",
          "+++ b/source.ts",
          "@@ -1 +1 @@",
          "-const before = true;",
          "+const after = true;",
          "Finished.",
        ].join("\n"),
      ),
    ).toEqual([
      { kind: "meta", text: "diff --git a/source.ts b/source.ts" },
      { kind: "meta", text: "--- a/source.ts" },
      { kind: "meta", text: "+++ b/source.ts" },
      { kind: "meta", text: "@@ -1 +1 @@" },
      { kind: "removed", text: "-const before = true;" },
      { kind: "added", text: "+const after = true;" },
      { kind: "text", text: "Finished." },
    ]);
  });

  it("does not color ordinary prose that starts with plus or minus", () => {
    expect(parseTranscriptText("- Removed clutter\n+ Added clarity")).toEqual([
      { kind: "text", text: "- Removed clutter" },
      { kind: "text", text: "+ Added clarity" },
    ]);
  });
});
