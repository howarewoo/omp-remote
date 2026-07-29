import type { SessionStatus } from "@omp-remote/protocol";

export const SESSION_STATUS_LABEL: Record<SessionStatus, string> = {
  idle: "Idle",
  running: "Running",
  waiting: "Waiting",
  disconnected: "Disconnected",
  history: "History",
};

export const SESSION_STATUS_TONE: Record<SessionStatus, string> = {
  idle: "clear",
  running: "running",
  waiting: "waiting",
  disconnected: "disconnected",
  history: "history",
};
