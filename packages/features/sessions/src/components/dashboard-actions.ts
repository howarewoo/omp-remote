import { type AskRequest, type Session } from "@omp-remote/protocol";

type SessionSection = {
  id: "terminal" | "daemon" | "disconnected";
  label: "Live terminal sessions" | "Live daemon-hosted sessions" | "Disconnected";
  sessions: Session[];
};

const SKILL_COMMAND_PREFIX = "skill:";
const SKILL_SUGGESTION_LIMIT = 8;

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
