import type { SessionStatus } from "@omp-remote/protocol";

export const SESSION_STATUS_LABEL: Record<SessionStatus, string> = {
  idle: "Route clear",
  running: "Train running",
  waiting: "Held for input",
  disconnected: "Signal lost",
};

export const SESSION_STATUS_TONE: Record<SessionStatus, string> = {
  idle: "clear",
  running: "running",
  waiting: "waiting",
  disconnected: "disconnected",
};
