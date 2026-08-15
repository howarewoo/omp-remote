import type { AskRequest, Session } from "@omp-remote/protocol";
import { describe, expect, it } from "vitest";
import {
  canKillSession,
  filterSessionsByDirectory,
  formatSubagentActivityLabel,
  getActiveAskRequest,
  getComposerAction,
  getDirectoryBasename,
  getDirectoryInitials,
  getDirectoryRailEntries,
  getSkillSuggestions,
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

  skillCommands: [],
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

describe("getSkillSuggestions", () => {
  const skills: Session["skillCommands"] = [
    { name: "skill:seo", description: "Audit search visibility" },
    { name: "skill:woostack-change", description: "Ship a bounded enhancement" },
    { name: "skill:woostack-fix", description: "Diagnose and fix a bug" },
  ];

  it("shows sorted skill commands for an empty slash query", () => {
    expect(getSkillSuggestions("/", skills)).toEqual(skills);
  });

  it.each(["/woo", "/skill:woo"])("filters skills from %s", (message) => {
    expect(getSkillSuggestions(message, skills).map(({ name }) => name)).toEqual([
      "skill:woostack-change",
      "skill:woostack-fix",
    ]);
  });

  it("closes suggestions once command arguments begin", () => {
    expect(getSkillSuggestions("/skill:seo audit this page", skills)).toEqual([]);
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

describe("getDirectoryBasename", () => {
  it.each([
    ["/work/omp-remote", "omp-remote"],
    ["/work/project/nested-module", "nested-module"],
    ["C:\\Users\\dev\\project", "project"],
    ["/", "/"],
    ["", "root"],
  ])("extracts basename from %s as %s", (cwd, expected) => {
    expect(getDirectoryBasename(cwd)).toBe(expected);
  });
});

describe("getDirectoryInitials", () => {
  it.each([
    ["/work/omp-remote", "OR"],
    ["/work/api_service", "AS"],
    ["/work/web.dashboard", "WD"],
    ["/work/frontend", "FR"],
    ["/work/a", "A"],
    ["/work/123-tool", "1T"],
  ])("derives compact initials from %s as %s", (cwd, expected) => {
    expect(getDirectoryInitials(cwd)).toBe(expected);
  });

  it("allows duplicate basenames with different paths to share initials", () => {
    expect(getDirectoryInitials("/team-a/backend")).toBe("BA");
    expect(getDirectoryInitials("/team-b/backend")).toBe("BA");
  });
});

describe("getDirectoryRailEntries", () => {
  it("places All first with the total live-session count", () => {
    const sessions: Session[] = [
      { ...BASE_SESSION, id: "s1", cwd: "/work/repo-a", lastActivity: "2026-07-28T10:00:00.000Z" },
      { ...BASE_SESSION, id: "s2", cwd: "/work/repo-b", lastActivity: "2026-07-28T12:00:00.000Z" },
      { ...BASE_SESSION, id: "s3", cwd: "/work/repo-a", lastActivity: "2026-07-28T14:00:00.000Z" },
    ];

    const entries = getDirectoryRailEntries(sessions);
    expect(entries[0]).toEqual({
      id: "all",
      cwd: null,
      name: "All",
      initials: "All",
      count: 3,
      label: "All sessions, 3 live sessions",
      tooltip: "All sessions (3 live sessions)",
    });
  });

  it("groups by exact cwd and keeps path ordering stable when activity changes", () => {
    const sessions: Session[] = [
      { ...BASE_SESSION, id: "s1", cwd: "/work/alpha", lastActivity: "2026-07-28T10:00:00.000Z" },
      { ...BASE_SESSION, id: "s2", cwd: "/work/beta", lastActivity: "2026-07-28T15:00:00.000Z" },
      { ...BASE_SESSION, id: "s3", cwd: "/work/gamma", lastActivity: "2026-07-28T12:00:00.000Z" },
      { ...BASE_SESSION, id: "s4", cwd: "/work/alpha", lastActivity: "2026-07-28T16:00:00.000Z" },
    ];

    const entries = getDirectoryRailEntries(sessions);
    expect(entries.map((entry) => entry.cwd)).toEqual([null, "/work/alpha", "/work/beta", "/work/gamma"]);
    expect(entries[1]?.count).toBe(2);
    expect(entries[1]?.label).toBe("/work/alpha, 2 live sessions");
    expect(entries[1]?.tooltip).toBe("/work/alpha (2 live sessions)");

    const reorderedActivity = sessions.map((session, index) => ({
      ...session,
      lastActivity: `2026-07-29T0${index}:00:00.000Z`,
    }));
    expect(getDirectoryRailEntries(reorderedActivity).map((entry) => entry.cwd)).toEqual([
      null,
      "/work/alpha",
      "/work/beta",
      "/work/gamma",
    ]);
  });

  it("keeps the All entry key distinct from a relative cwd named all", () => {
    const entries = getDirectoryRailEntries([{ ...BASE_SESSION, cwd: "all" }]);

    expect(entries.map((entry) => entry.id)).toEqual(["all", "directory:all"]);
  });

  it("breaks ties deterministically by exact cwd path comparison", () => {
    const sessions: Session[] = [
      { ...BASE_SESSION, id: "s1", cwd: "/work/zoo", lastActivity: "2026-07-28T12:00:00.000Z" },
      { ...BASE_SESSION, id: "s2", cwd: "/work/apple", lastActivity: "2026-07-28T12:00:00.000Z" },
    ];

    const entries = getDirectoryRailEntries(sessions);
    expect(entries.map((entry) => entry.cwd)).toEqual([null, "/work/apple", "/work/zoo"]);
  });

  it("preserves exact cwd identity for duplicate basenames in different directories", () => {
    const sessions: Session[] = [
      { ...BASE_SESSION, id: "s1", cwd: "/frontend/app", lastActivity: "2026-07-28T10:00:00.000Z" },
      { ...BASE_SESSION, id: "s2", cwd: "/backend/app", lastActivity: "2026-07-28T12:00:00.000Z" },
    ];

    const entries = getDirectoryRailEntries(sessions);
    expect(entries.map((entry) => ({ cwd: entry.cwd, name: entry.name, initials: entry.initials }))).toEqual([
      { cwd: null, name: "All", initials: "All" },
      { cwd: "/backend/app", name: "app", initials: "AP" },
      { cwd: "/frontend/app", name: "app", initials: "AP" },
    ]);
  });

  it("counts only connected sessions and omits disconnected-only directories", () => {
    const sessions: Session[] = [
      { ...BASE_SESSION, id: "live-alpha", cwd: "/work/alpha", lastActivity: "2026-07-28T10:00:00.000Z" },
      {
        ...BASE_SESSION,
        id: "disconnected-alpha",
        cwd: "/work/alpha",
        connected: false,
        status: "history",
        lastActivity: "2026-07-28T15:00:00.000Z",
      },
      {
        ...BASE_SESSION,
        id: "disconnected-history",
        cwd: "/work/history-only",
        connected: false,
        status: "history",
        lastActivity: "2026-07-28T16:00:00.000Z",
      },
    ];

    const entries = getDirectoryRailEntries(sessions);

    expect(entries.map((entry) => entry.cwd)).toEqual([null, "/work/alpha"]);
    expect(entries.map((entry) => entry.count)).toEqual([1, 1]);
    expect(entries[1]?.tooltip).toBe("/work/alpha (1 live session)");
  });
});

describe("filterSessionsByDirectory", () => {
  const sessions: Session[] = [
    { ...BASE_SESSION, id: "s1", cwd: "/work/alpha" },
    { ...BASE_SESSION, id: "s2", cwd: "/work/beta" },
    { ...BASE_SESSION, id: "s3", cwd: "/work/alpha" },
  ];

  it("returns all main sessions when no directory is selected", () => {
    expect(filterSessionsByDirectory(sessions, null)).toEqual(sessions);
  });

  it("filters sessions by exact cwd matching", () => {
    expect(filterSessionsByDirectory(sessions, "/work/alpha")).toEqual([sessions[0], sessions[2]]);
    expect(filterSessionsByDirectory(sessions, "/work/beta")).toEqual([sessions[1]]);
    expect(filterSessionsByDirectory(sessions, "/work/missing")).toEqual([]);
  });
});
