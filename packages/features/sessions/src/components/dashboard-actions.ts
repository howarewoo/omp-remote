import type { AskRequest, Session } from "@omp-remote/protocol";

type SessionSection = {
  id: "terminal" | "daemon" | "disconnected";
  label: "Live terminal sessions" | "Live daemon-hosted sessions" | "Disconnected";
  sessions: Session[];
};

const SKILL_COMMAND_PREFIX = "skill:";
const SKILL_SUGGESTION_LIMIT = 8;
export interface DirectoryRailEntry {
  id: string;
  cwd: string | null;
  name: string;
  initials: string;
  count: number;
  label: string;
  tooltip: string;
}

export function getDirectoryBasename(cwd: string): string {
  const segments = cwd.split(/[/\\]+/).filter(Boolean);
  return segments.at(-1) || cwd || "root";
}

export function getDirectoryInitials(cwd: string): string {
  const name = getDirectoryBasename(cwd);
  const parts = name.split(/[-_.\s]+/).filter(Boolean);
  if (parts.length >= 2) {
    const first = parts[0]?.[0] ?? "";
    const second = parts[1]?.[0] ?? "";
    const initials = (first + second).toUpperCase();
    if (initials) return initials;
  }
  const alphanumeric = name.replace(/[^a-zA-Z0-9]/g, "");
  if (alphanumeric.length >= 2) {
    return alphanumeric.slice(0, 2).toUpperCase();
  }
  if (alphanumeric.length === 1) {
    return alphanumeric.toUpperCase();
  }
  return name.slice(0, 2).toUpperCase() || "•";
}

export function getDirectoryRailEntries(mainSessions: Session[]): DirectoryRailEntry[] {
  const liveSessions = mainSessions.filter((session) => session.connected);
  const allCount = liveSessions.length;

  const allEntry: DirectoryRailEntry = {
    id: "all",
    cwd: null,
    name: "All",
    initials: "All",
    count: allCount,
    label: `All sessions, ${allCount} live ${allCount === 1 ? "session" : "sessions"}`,
    tooltip: `All sessions (${allCount} live ${allCount === 1 ? "session" : "sessions"})`,
  };
  const cwdGroups = new Map<string, number>();
  for (const session of liveSessions) {
    cwdGroups.set(session.cwd, (cwdGroups.get(session.cwd) ?? 0) + 1);
  }

  const directoryEntries: DirectoryRailEntry[] = Array.from(cwdGroups.entries())
    .map(([cwd, count]) => {
      const basename = getDirectoryBasename(cwd);
      const initials = getDirectoryInitials(cwd);
      return {
        id: `directory:${cwd}`,
        cwd,
        name: basename,
        initials,
        count,
        label: `${cwd}, ${count} live ${count === 1 ? "session" : "sessions"}`,
        tooltip: `${cwd} (${count} live ${count === 1 ? "session" : "sessions"})`,
      };
    })
    .sort((a, b) => (a.cwd ?? "").localeCompare(b.cwd ?? ""));

  return [allEntry, ...directoryEntries];
}

export function filterSessionsByDirectory(mainSessions: Session[], selectedCwd: string | null): Session[] {
  if (selectedCwd === null) return mainSessions;
  return mainSessions.filter((session) => session.cwd === selectedCwd);
}

export function getComposerAction(
  session: Pick<Session, "capabilities" | "status">,
  message: string,
): "abort" | "steer" | null {
  if (message.trim()) return "steer";
  return session.status === "running" && session.capabilities.includes("abort") ? "abort" : null;
}

/**
 * Returns the active session's skill commands matching the composer's leading slash token.
 */
export function getSkillSuggestions(
  message: string,
  skillCommands: readonly Session["skillCommands"][number][],
): Session["skillCommands"] {
  const match = /^\/(?:skill:)?([^\s]*)$/i.exec(message);
  if (!match) return [];
  const query = match[1]?.toLocaleLowerCase() ?? "";
  return skillCommands
    .filter(
      (command) =>
        command.name.startsWith(SKILL_COMMAND_PREFIX) &&
        command.name.slice(SKILL_COMMAND_PREFIX.length).toLocaleLowerCase().includes(query),
    )
    .toSorted((left, right) => left.name.localeCompare(right.name))
    .slice(0, SKILL_SUGGESTION_LIMIT);
}

export function canKillSession(session: Pick<Session, "capabilities">): boolean {
  return session.capabilities.includes("kill");
}

export function groupSessionsForSidebar(sessions: Session[]): SessionSection[] {
  const terminal: Session[] = [];
  const daemon: Session[] = [];
  const disconnected: Session[] = [];

  for (const session of sessions) {
    if (!session.connected) {
      disconnected.push(session);
    } else {
      (session.source === "extension" ? terminal : daemon).push(session);
    }
  }

  const sections: SessionSection[] = [
    { id: "terminal", label: "Live terminal sessions", sessions: terminal },
    { id: "daemon", label: "Live daemon-hosted sessions", sessions: daemon },
    { id: "disconnected", label: "Disconnected", sessions: disconnected },
  ];
  return sections.filter((section) => section.sessions.length > 0);
}

export function formatSubagentActivityLabel(count: number): string {
  return `${count} ${count === 1 ? "subagent" : "subagents"} running`;
}

export function getActiveAskRequest(
  askRequests: readonly AskRequest[],
  selectedSessionId: string | null,
): AskRequest | null {
  return askRequests.find((request) => request.sessionId === selectedSessionId) ?? null;
}
