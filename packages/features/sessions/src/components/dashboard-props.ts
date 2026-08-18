import type {
  ApplicationErrorRecord,
  ApplicationErrorStorageHealth,
  AskRequest,
  AskResponse,
  Effort,
  Session,
  SessionBranchTopology,
  SessionFileChangesResponse,
  TranscriptHistoryStatus,
} from "@omp-remote/protocol";
export type {
  ApplicationErrorRecord,
  ApplicationErrorStorageHealth,
  TranscriptHistoryStatus,
} from "@omp-remote/protocol";
import type { NotificationState } from "./dashboard/session-header.js";

type ComposerMode = "prompt" | "steer" | "follow_up";
type NotificationEventKey = "inputRequired" | "sessionIdle";
type NotificationEventPreferences = Record<NotificationEventKey, boolean>;
export interface QueuedMessage {
  id: string;
  sessionId: string;
  text: string;
  createdAt: string;
  status: "queued" | "failed";
  error?: string;
}

export type ApplicationErrorSource = "daemon" | "browser";
export type ApplicationErrorSeverity = "error" | "fatal";

export interface DashboardTranscriptHistoryState {
  sessionId: string | null;
  initialLoading: boolean;
  olderLoading: boolean;
  status: TranscriptHistoryStatus | null;
  error: string | null;
}

export type DashboardViewMode = "sessions" | "application-errors";

export interface DashboardProps {
  sessions: Session[];
  queuedMessages: readonly QueuedMessage[];
  askRequests: AskRequest[];
  savedWorkingDirectories: string[];
  sessionsReady: boolean;
  historyLoading: boolean;
  hasMoreHistory: boolean;
  connection: "connecting" | "connected" | "disconnected";
  error: string | null;
  notificationState: NotificationState;
  notificationPreferences?: NotificationEventPreferences;
  notificationError?: string | null;
  selectedSessionId: string | null;
  activeView?: DashboardViewMode;
  onActiveViewChange?(view: DashboardViewMode): void;
  applicationErrors?: readonly ApplicationErrorRecord[];
  applicationErrorsHealth?: ApplicationErrorStorageHealth | null;
  applicationErrorsLoading?: boolean;
  applicationErrorsError?: string | null;
  onClearApplicationErrors?(): Promise<void>;
  onReloadApplicationErrors?(): Promise<void>;
  onSelectedSessionChange(sessionId: string): void;
  onToggleNotification?(event: NotificationEventKey, enabled: boolean): Promise<void>;
  onLaunch(cwd: string, resume: string | null): Promise<string>;
  onSaveWorkingDirectory(cwd: string): Promise<void>;
  onRemoveWorkingDirectory(cwd: string): Promise<void>;
  onCommand(sessionId: string, command: ComposerMode, text: string): Promise<void>;
  onCancelQueuedMessage(messageId: string): void;
  onAbort(sessionId: string): Promise<void>;
  onKill(sessionId: string): Promise<void>;
  onSetModel(sessionId: string, model: string): Promise<void>;
  onSetEffort(sessionId: string, effort: Effort): Promise<void>;
  onRespondToAsk(sessionId: string, askRequestId: string, response: AskResponse): Promise<void>;
  onAskActivity(sessionId: string, askRequestId: string): Promise<void>;
  onSearchHistory(query: string): Promise<void>;
  onLoadMoreHistory(): Promise<void>;
  onLoadTranscript(sessionId: string): Promise<void>;
  transcriptHistory: DashboardTranscriptHistoryState;
  onLoadOlderTranscript(): Promise<void>;
  onRetryTranscript(): Promise<void>;
  onReloadTranscript(): Promise<void>;
  onLoadSession(sessionId: string): Promise<void>;
  onLoadCost(sessionId: string): Promise<void>;
  onLoadSessionFileChanges(sessionId: string, signal?: AbortSignal): Promise<SessionFileChangesResponse>;
  onLoadSessionBranchTopology(sessionId: string, signal?: AbortSignal): Promise<SessionBranchTopology>;
  onSwitchBranch(sessionId: string, branch: string): Promise<void>;
}
