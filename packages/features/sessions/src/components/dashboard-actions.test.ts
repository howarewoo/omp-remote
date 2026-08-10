import type { AskRequest, Session } from "@omp-remote/protocol";
import { describe, expect, it } from "vitest";
import {
  canKillSession,
  formatSubagentActivityLabel,
  getActiveAskRequest,
  getComposerAction,
  getComposerSuggestions,
  groupSessionsForSidebar,
} from "./dashboard-actions.js";

const BASE_SESSION: Session = {
  id: "session-1",
  source: "rpc",
  name: "Bootstrap",
  cwd: "/work/omp-remote",
  branch: "feature/session-header",
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

  composerCommands: [],
};

describe("getComposerAction", () => {
  it("uses the integrated submit control to abort a running session when the composer is blank", () => {
    expect(getComposerAction({ ...BASE_SESSION, status: "running" }, "   ")).toBe("abort");
  });

  it("changes the integrated submit control to steer when the composer contains text", () => {
    expect(getComposerAction({ ...BASE_SESSION, status: "running" }, "Change direction")).toBe("steer");
  });

  it("has no action for blank input when the session cannot be aborted", () => {
    expect(getComposerAction(BASE_SESSION, "")).toBeNull();
    expect(
      getComposerAction(
        {
          ...BASE_SESSION,
          status: "running",
          capabilities: BASE_SESSION.capabilities.filter((capability) => capability !== "abort"),
        },
        "",
      ),
    ).toBeNull();
  });
});

describe("getComposerSuggestions", () => {
  const composerCommands: Session["composerCommands"] = [
    { name: "skill:seo", description: "Audit search visibility" },
    { name: "skill:woostack-change", description: "Ship a bounded enhancement" },
    { name: "skill:woostack-fix", description: "Diagnose and fix a bug" },
    { name: "btw", description: "Show branch context" },
  ];

  it("shows sorted composer commands for an empty slash query", () => {
    expect(getComposerSuggestions("/", composerCommands)).toEqual([
      composerCommands[3],
      composerCommands[0],
      composerCommands[1],
      composerCommands[2],
    ]);
  });

  it.each(["/woo", "/skill:woo"])("filters skills from %s", (message) => {
    expect(getComposerSuggestions(message, composerCommands).map(({ name }) => name)).toEqual([
      "skill:woostack-change",
      "skill:woostack-fix",
    ]);
  });

  it.each(["/b", "/bt", "/btw"])("matches the advertised btw command from %s", (message) => {
    expect(getComposerSuggestions(message, composerCommands).map(({ name }) => name)).toEqual(["btw"]);
  });

  it("closes suggestions once command arguments begin", () => {
    expect(getComposerSuggestions("/skill:seo audit this page", composerCommands)).toEqual([]);
  });
});

describe("canKillSession", () => {
  it("allows killing only sessions that advertise the capability", () => {
    expect(canKillSession({ ...BASE_SESSION, capabilities: [...BASE_SESSION.capabilities, "kill"] })).toBe(
      true,
    );
    expect(canKillSession(BASE_SESSION)).toBe(false);
  });
});

describe("groupSessionsForSidebar", () => {
  it("separates live terminal and daemon-hosted sessions before disconnected sessions", () => {
    const sessions = [
      { ...BASE_SESSION, id: "disconnected-new", connected: false, status: "disconnected" as const },
      { ...BASE_SESSION, id: "terminal-new", source: "extension" as const },
      { ...BASE_SESSION, id: "daemon-new" },
      { ...BASE_SESSION, id: "terminal-old", source: "extension" as const },
      { ...BASE_SESSION, id: "daemon-old" },
      {
        ...BASE_SESSION,
        id: "disconnected-old",
        connected: false,
        source: "history" as const,
        status: "history" as const,
      },
    ];

    expect(groupSessionsForSidebar(sessions)).toEqual([
      {
        id: "terminal",
        label: "Live terminal sessions",
        sessions: [sessions[1], sessions[3]],
      },
      {
        id: "daemon",
        label: "Live daemon-hosted sessions",
        sessions: [sessions[2], sessions[4]],
      },
      {
        id: "disconnected",
        label: "Disconnected",
        sessions: [sessions[0], sessions[5]],
      },
    ]);
  });

  it("omits empty sidebar sections", () => {
    expect(groupSessionsForSidebar([BASE_SESSION])).toEqual([
      {
        id: "daemon",
        label: "Live daemon-hosted sessions",
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

describe("getActiveAskRequest", () => {
  const requests: AskRequest[] = [
    {
      sessionId: "session-2",
      requestId: "ask-2",
      kind: "select",
      title: "Second session question",
      options: ["Continue", "Stop"],
      initialValue: null,
      expiresAt: null,
    },
    {
      sessionId: "session-1",
      requestId: "ask-1",
      kind: "text",
      title: "Selected session question",
      options: [],
      initialValue: null,
      expiresAt: null,
    },
  ];

  it("prioritizes the selected session without reordering the request queue", () => {
    expect(getActiveAskRequest(requests, "session-1")).toBe(requests[1]);
    expect(requests.map(({ requestId }) => requestId)).toEqual(["ask-2", "ask-1"]);
  });

  it("returns only a request belonging to the selected session", () => {
    expect(getActiveAskRequest(requests, "missing-session")).toBeNull();
    expect(getActiveAskRequest(requests, null)).toBeNull();
    expect(getActiveAskRequest([], "session-1")).toBeNull();
  });
});
