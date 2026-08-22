import {
  type ActiveSubagent,
  filterMainSessions,
  type SessionBranchTopology,
  type SessionFileChangesResponse,
} from "@omp-remote/protocol";
import { type FormEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ApplicationErrorViewer } from "./application-error-viewer.js";
import { ModelConfigurationDrawer, useConfigurationController } from "./dashboard/configuration-drawers.js";
import { EmptyDashboard } from "./dashboard/empty-dashboard.js";
import { LaunchSessionDialog } from "./dashboard/launch-session-dialog.js";
import { AbortSessionDialog, KillSessionDialog } from "./dashboard/session-action-dialogs.js";
import { SessionComposer } from "./dashboard/session-composer.js";
import { SessionHeader } from "./dashboard/session-header.js";
import { SessionMetadata } from "./dashboard/session-metadata.js";
import { SessionSidebar } from "./dashboard/session-sidebar.js";
import { SessionTranscript, WorkingIndicator } from "./dashboard/session-transcript.js";
import { TodoDrawer } from "./dashboard/todo-drawer.js";
import {
  filterSessionsByDirectory,
  getActiveAskRequest,
  getComposerAction,
  getDirectoryRailEntries,
  getSkillSuggestions,
  groupSessionsForSidebar,
} from "./dashboard-actions.js";
import type { DashboardProps, DashboardViewMode } from "./dashboard-props.js";
import { NotificationSettingsDrawer } from "./notification-settings-drawer.js";
import { SessionBranchSelector } from "./session-branch-selector.js";
import { SessionCostViewer } from "./session-cost-viewer.js";
import { formatSessionFileChangesMetadata, SessionFileChangesViewer } from "./session-file-changes-viewer.js";
import { SubagentSessionViewer } from "./subagent-session-viewer.js";
import {
  findLatestTodoResult,
  getTodoPresentation,
  getTodoTrackerLabel,
} from "./transcript/todo-tool-transcript.js";
import { renderTranscriptMessageItems } from "./transcript/transcript-entry.js";
import { Button } from "./ui/button.js";
import { MessageScrollerItem } from "./ui/message-scroller.js";
import { SidebarInset, SidebarProvider, useSidebar } from "./ui/sidebar.js";
import { toast } from "sonner";

export * from "./dashboard-exports.js";
export type { DashboardProps } from "./dashboard-props.js";

export function Dashboard(props: DashboardProps) {
  return (
    <SidebarProvider>
      <DashboardContent {...props} />
    </SidebarProvider>
  );
}

function DashboardContent({
  sessionsReady,
  sessions,
  queuedMessages,
  askRequests,
  savedWorkingDirectories,
  historyLoading,
  hasMoreHistory,
  connection,
  error,
  notificationState,
  notificationPreferences = { inputRequired: false, sessionIdle: false },
  notificationError = null,
  selectedSessionId,
  activeView: activeViewProp,
  onActiveViewChange,
  applicationErrors = [],
  applicationErrorsHealth = null,
  applicationErrorsLoading = false,
  applicationErrorsError = null,
  onClearApplicationErrors,
  onReloadApplicationErrors,
  onSelectedSessionChange,
  onToggleNotification = async () => undefined,
  onLaunch,
  onSaveWorkingDirectory,
  onRemoveWorkingDirectory,
  onCommand,
  onCancelQueuedMessage,
  onAbort,
  onKill,
  onSetModel,
  onSetEffort,
  onRespondToAsk,
  onAskActivity,
  onSearchHistory,
  onLoadMoreHistory,
  onLoadTranscript,
  transcriptHistory,
  onLoadOlderTranscript,
  onRetryTranscript,
  onReloadTranscript,
  onLoadSession,
  onLoadCost,
  onLoadSessionFileChanges,
  onLoadSessionBranchTopology,
  onSwitchBranch,
}: DashboardProps) {
  const [internalActiveView, setInternalActiveView] = useState<DashboardViewMode>("sessions");
  const activeView = activeViewProp ?? internalActiveView;
  const setActiveView = useCallback(
    (view: DashboardViewMode) => {
      if (onActiveViewChange) onActiveViewChange(view);
      else setInternalActiveView(view);
    },
    [onActiveViewChange],
  );
  const [viewedSubagent, setViewedSubagent] = useState<ActiveSubagent | null>(null);
  const [subagentDetails, setSubagentDetails] = useState<{
    id: string;
    state: "loading" | "loaded" | "error";
  } | null>(null);
  const subagentDetailsRequestRef = useRef(0);
  const requestSubagentDetails = useCallback(
    (id: string) => {
      const generation = ++subagentDetailsRequestRef.current;
      setSubagentDetails({ id, state: "loading" });
      void onLoadSession(id).then(
        () => {
          if (generation === subagentDetailsRequestRef.current) {
            setSubagentDetails({ id, state: "loaded" });
          }
        },
        () => {
          if (generation === subagentDetailsRequestRef.current) {
            setSubagentDetails({ id, state: "error" });
          }
        },
      );
    },
    [onLoadSession],
  );
  const [messagesBySession, setMessagesBySession] = useState<Record<string, string>>({});
  const [activeSkillIndex, setActiveSkillIndex] = useState(0);
  const [autocompleteDismissedFor, setAutocompleteDismissedFor] = useState<string | null>(null);
  const [notificationSettingsOpen, setNotificationSettingsOpen] = useState(false);
  const [messagePendingBySession, setMessagePendingBySession] = useState<
    Record<string, { requestId: string }>
  >({});
  const [commandErrorsBySession, setCommandErrorsBySession] = useState<
    Record<string, Partial<Record<"message" | "resume" | "abort" | "kill", string>>>
  >({});
  const [abortPendingBySession, setAbortPendingBySession] = useState<Record<string, boolean>>({});
  const [killPendingBySession, setKillPendingBySession] = useState<Record<string, boolean>>({});
  const [resumePendingBySession, setResumePendingBySession] = useState<Record<string, boolean>>({});
  const messageRequestBySessionRef = useRef<Record<string, { id: string; submittedDraft: string }>>({});
  const selectedSessionIdRef = useRef<string | null>(null);

  const [launchOpen, setLaunchOpen] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [launchCwd, setLaunchCwd] = useState("");
  const [launchState, setLaunchState] = useState<"idle" | "sending">("idle");
  const [savedDirectoryPending, setSavedDirectoryPending] = useState<{
    action: "save" | "remove";
    cwd: string;
  } | null>(null);
  const [savedDirectoryError, setSavedDirectoryError] = useState<string | null>(null);
  const [abortOpen, setAbortOpen] = useState(false);
  const [killOpen, setKillOpen] = useState(false);
  const [todoOpenSessionId, setTodoOpenSessionId] = useState<string | null>(null);
  const [costDrawerOpen, setCostDrawerOpen] = useState(false);
  const [selectedDirectory, setSelectedDirectory] = useState<string | null>(null);

  const [historyQuery, setHistoryQuery] = useState("");
  const [activeHistoryQuery, setActiveHistoryQuery] = useState("");

  const transcriptScrollToEndRef = useRef<(() => void) | null>(null);
  const registerTranscriptScrollToEnd = useCallback((handler: (() => void) | null) => {
    transcriptScrollToEndRef.current = handler;
  }, []);
  const [fileChangesOpen, setFileChangesOpen] = useState(false);
  const [sessionFileChanges, setSessionFileChanges] = useState<SessionFileChangesResponse | null>(null);
  const [sessionFileChangesLoading, setSessionFileChangesLoading] = useState(false);
  const [sessionFileChangesError, setSessionFileChangesError] = useState<string | null>(null);
  const [sessionFileChangesSessionId, setSessionFileChangesSessionId] = useState<string | null>(null);
  const fileChangesRequestRef = useRef(0);
  const fileChangesAbortRef = useRef<AbortController | null>(null);
  const fileChangesOpenRef = useRef(false);
  const [branchSelectorOpen, setBranchSelectorOpen] = useState(false);
  const [branchTopology, setBranchTopology] = useState<SessionBranchTopology | null>(null);
  const [branchQuery, setBranchQuery] = useState("");
  const [branchTopologyLoading, setBranchTopologyLoading] = useState(false);
  const [branchTopologyError, setBranchTopologyError] = useState<string | null>(null);
  const [branchCheckoutPending, setBranchCheckoutPending] = useState<string | null>(null);
  const [branchCheckoutError, setBranchCheckoutError] = useState<string | null>(null);
  const branchRequestGenerationRef = useRef(0);
  const branchSelectorSessionIdRef = useRef<string | null>(null);
  const branchLoadAbortRef = useRef<AbortController | null>(null);
  const fileChangesRefreshTimerRef = useRef<number | null>(null);
  const { isMobile, setOpenMobile } = useSidebar();

  const mainSessions = useMemo(() => filterMainSessions(sessions), [sessions]);
  const directoryEntries = useMemo(() => getDirectoryRailEntries(mainSessions), [mainSessions]);

  const selectedDirectoryHasLiveSessions =
    selectedDirectory !== null &&
    mainSessions.some((session) => session.connected && session.cwd === selectedDirectory);

  useEffect(() => {
    if (selectedDirectory !== null && !selectedDirectoryHasLiveSessions) {
      setSelectedDirectory(null);
    }
  }, [selectedDirectory, selectedDirectoryHasLiveSessions]);

  const activeDirectory = selectedDirectoryHasLiveSessions ? selectedDirectory : null;
  const visibleSessions = useMemo(
    () => filterSessionsByDirectory(mainSessions, activeDirectory),
    [mainSessions, activeDirectory],
  );
  const selectedMainSession = useMemo(
    () => mainSessions.find((session) => session.id === selectedSessionId) ?? null,
    [mainSessions, selectedSessionId],
  );

  useEffect(() => {
    if (
      activeDirectory !== null &&
      selectedMainSession !== null &&
      selectedMainSession.cwd !== activeDirectory
    ) {
      setSelectedDirectory(null);
    }
  }, [activeDirectory, selectedMainSession]);
  const sessionSections = useMemo(() => groupSessionsForSidebar(visibleSessions), [visibleSessions]);
  const selectedSession = useMemo(
    () => selectedMainSession ?? sessionSections[0]?.sessions[0] ?? null,
    [selectedMainSession, sessionSections],
  );
  const selectedSessionKey = selectedSession?.id ?? null;
  const setSessionCommandError = useCallback(
    (sessionId: string, operation: "message" | "resume" | "abort" | "kill", error: string) => {
      setCommandErrorsBySession((current) => ({
        ...current,
        [sessionId]: {
          ...current[sessionId],
          [operation]: error,
        },
      }));
    },
    [],
  );

  const clearSessionCommandError = useCallback(
    (sessionId: string, operation: "message" | "resume" | "abort" | "kill") => {
      setCommandErrorsBySession((current) => {
        const sessionErrors = current[sessionId];
        if (!sessionErrors || sessionErrors[operation] === undefined) return current;
        const updated = { ...sessionErrors };
        delete updated[operation];
        return {
          ...current,
          [sessionId]: updated,
        };
      });
    },
    [],
  );

  const message = selectedSessionKey ? (messagesBySession[selectedSessionKey] ?? "") : "";
  const setMessage = useCallback(
    (nextOrUpdater: string | ((current: string) => string)) => {
      if (!selectedSessionKey) return;
      clearSessionCommandError(selectedSessionKey, "message");
      setMessagesBySession((current) => {
        const currentVal = current[selectedSessionKey] ?? "";
        const nextVal = typeof nextOrUpdater === "function" ? nextOrUpdater(currentVal) : nextOrUpdater;
        return { ...current, [selectedSessionKey]: nextVal };
      });
    },
    [clearSessionCommandError, selectedSessionKey],
  );

  const visibleMessageError = selectedSessionKey
    ? (commandErrorsBySession[selectedSessionKey]?.message ?? null)
    : null;
  const visibleResumeError = selectedSessionKey
    ? (commandErrorsBySession[selectedSessionKey]?.resume ?? null)
    : null;
  const visibleKillError = selectedSessionKey
    ? (commandErrorsBySession[selectedSessionKey]?.kill ?? null)
    : null;
  const visibleComposerError = visibleMessageError ?? visibleResumeError;
  const canViewSelectedSessionBranches =
    selectedSession !== null &&
    selectedSession.branch !== null &&
    selectedSession.source !== "history" &&
    selectedSession.connected &&
    connection === "connected";
  const canSwitchSelectedSessionBranch =
    canViewSelectedSessionBranches &&
    (selectedSession.status === "idle" || selectedSession.status === "waiting");
  const resetBranchSelector = useCallback(() => {
    branchRequestGenerationRef.current += 1;
    branchLoadAbortRef.current?.abort();
    branchLoadAbortRef.current = null;
    branchSelectorSessionIdRef.current = null;
    setBranchSelectorOpen(false);
    setBranchTopology(null);
    setBranchQuery("");
    setBranchTopologyLoading(false);
    setBranchTopologyError(null);
    setBranchCheckoutPending(null);
    setBranchCheckoutError(null);
  }, []);
  const handleBranchSelectorOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        if (branchCheckoutPending !== null) return;
        resetBranchSelector();
        return;
      }
      if (!selectedSession || !canViewSelectedSessionBranches) return;
      if (branchSelectorSessionIdRef.current === selectedSession.id) return;

      branchLoadAbortRef.current?.abort();
      const abortController = new AbortController();
      const generation = ++branchRequestGenerationRef.current;
      const sessionId = selectedSession.id;
      branchLoadAbortRef.current = abortController;
      branchSelectorSessionIdRef.current = sessionId;
      setBranchSelectorOpen(true);
      setBranchTopology(null);
      setBranchQuery("");
      setBranchTopologyLoading(true);
      setBranchTopologyError(null);
      setBranchCheckoutPending(null);
      setBranchCheckoutError(null);

      void onLoadSessionBranchTopology(sessionId, abortController.signal)
        .then((topology) => {
          if (
            generation !== branchRequestGenerationRef.current ||
            abortController.signal.aborted ||
            branchSelectorSessionIdRef.current !== sessionId ||
            topology.sessionId !== sessionId
          )
            return;
          setBranchTopology(topology);
        })
        .catch((failure: unknown) => {
          if (
            generation !== branchRequestGenerationRef.current ||
            abortController.signal.aborted ||
            branchSelectorSessionIdRef.current !== sessionId
          )
            return;
          setBranchTopologyError(
            failure instanceof Error ? failure.message : "Local branch topology could not be loaded.",
          );
        })
        .finally(() => {
          if (
            generation === branchRequestGenerationRef.current &&
            branchSelectorSessionIdRef.current === sessionId
          ) {
            setBranchTopologyLoading(false);
            if (branchLoadAbortRef.current === abortController) branchLoadAbortRef.current = null;
          }
        });
    },
    [
      branchCheckoutPending,
      canViewSelectedSessionBranches,
      onLoadSessionBranchTopology,
      resetBranchSelector,
      selectedSession,
    ],
  );
  const clearSessionFileChangesRefreshTimer = useCallback(() => {
    if (fileChangesRefreshTimerRef.current === null) return;
    globalThis.clearTimeout(fileChangesRefreshTimerRef.current);
    fileChangesRefreshTimerRef.current = null;
  }, []);
  const refreshSessionFileChanges = useCallback(
    async (sessionId: string) => {
      const requestNumber = ++fileChangesRequestRef.current;
      fileChangesAbortRef.current?.abort();
      const abortController = new AbortController();
      fileChangesAbortRef.current = abortController;
      setSessionFileChangesSessionId(sessionId);
      setSessionFileChangesLoading(true);
      setSessionFileChangesError(null);
      try {
        const result = await onLoadSessionFileChanges(sessionId, abortController.signal);
        if (requestNumber !== fileChangesRequestRef.current || abortController.signal.aborted) return;
        setSessionFileChanges(result);
      } catch (failure) {
        if (requestNumber !== fileChangesRequestRef.current || abortController.signal.aborted) return;
        setSessionFileChanges(null);
        setSessionFileChangesError(
          failure instanceof Error ? failure.message : "Session file changes could not be loaded.",
        );
      } finally {
        if (requestNumber === fileChangesRequestRef.current) {
          setSessionFileChangesLoading(false);
          if (fileChangesAbortRef.current === abortController) fileChangesAbortRef.current = null;
        }
      }
    },
    [onLoadSessionFileChanges],
  );
  const handleFileChangesOpenChange = useCallback(
    (open: boolean) => {
      clearSessionFileChangesRefreshTimer();
      fileChangesOpenRef.current = open;
      setFileChangesOpen(open);
      if (!open) {
        fileChangesRequestRef.current += 1;
        fileChangesAbortRef.current?.abort();
        fileChangesAbortRef.current = null;
        setSessionFileChangesLoading(false);
        return;
      }
      if (selectedSession?.id) void refreshSessionFileChanges(selectedSession.id);
    },
    [clearSessionFileChangesRefreshTimer, refreshSessionFileChanges, selectedSession?.id],
  );
  const askingSessionIds = useMemo(
    () => new Set(askRequests.map((request) => request.sessionId)),
    [askRequests],
  );
  const activeAskRequest = getActiveAskRequest(askRequests, selectedSession?.id ?? null);
  const selectedSessionStatus =
    selectedSession && askingSessionIds.has(selectedSession.id) ? "waiting" : selectedSession?.status;
  const currentTodo = useMemo(
    () => (selectedSession ? findLatestTodoResult(selectedSession.messages) : null),
    [selectedSession?.messages],
  );
  const currentTodoPresentation = currentTodo ? getTodoPresentation(currentTodo) : null;
  const composerAction = selectedSession ? getComposerAction(selectedSession, message) : null;
  const skillSuggestions = useMemo(
    () => getSkillSuggestions(message, selectedSession?.skillCommands ?? []),
    [message, selectedSession?.skillCommands],
  );
  const visibleSkillSuggestions = autocompleteDismissedFor === message ? [] : skillSuggestions;
  const viewedSubagentIsAdvertised =
    viewedSubagent !== null &&
    selectedSession?.activeSubagents.some((subagent) => subagent.id === viewedSubagent.id) === true;
  const viewedSubagentSession = useMemo(
    () =>
      viewedSubagentIsAdvertised
        ? (sessions.find((session) => session.id === viewedSubagent?.id) ?? null)
        : null,
    [sessions, viewedSubagent?.id, viewedSubagentIsAdvertised],
  );
  const viewedSubagentIsLoaded = viewedSubagentSession !== null;
  useEffect(() => {
    const id = viewedSubagent?.id;
    if (!id || !sessionsReady || !viewedSubagentIsAdvertised || viewedSubagentIsLoaded) return;
    requestSubagentDetails(id);
    return () => {
      subagentDetailsRequestRef.current += 1;
    };
  }, [
    requestSubagentDetails,
    sessionsReady,
    viewedSubagent?.id,
    viewedSubagentIsAdvertised,
    viewedSubagentIsLoaded,
  ]);
  const retrySubagentDetails = useCallback(() => {
    const id = viewedSubagent?.id;
    if (!id || !viewedSubagentIsAdvertised || viewedSubagentIsLoaded) return;
    requestSubagentDetails(id);
  }, [requestSubagentDetails, viewedSubagent?.id, viewedSubagentIsAdvertised, viewedSubagentIsLoaded]);
  const viewedSubagentDetailsState =
    viewedSubagentSession?.source === "history"
      ? viewedSubagentSession.messages.length > 0
        ? "saved"
        : "empty"
      : viewedSubagentSession
        ? "live"
        : subagentDetails !== null && subagentDetails.id === viewedSubagent?.id
          ? subagentDetails.state === "loaded"
            ? "empty"
            : subagentDetails.state
          : "loading";
  const {
    availableModels,
    currentModelOption,
    filteredModels,
    configurationOpen,
    expandedModel,
    modelQuery,
    configurationPending,
    configurationError,
    openConfiguration,
    handleConfigurationOpenChange,
    onExpandedModelChange,
    onModelQueryChange,
    selectConfiguration,
  } = useConfigurationController({
    session: selectedSession,
    onSetModel,
    onSetEffort,
  });
  const sessionFileChangesMatchesSelection =
    selectedSession !== null && sessionFileChangesSessionId === selectedSession.id;
  const visibleSessionFileChanges = sessionFileChangesMatchesSelection ? sessionFileChanges : null;
  const visibleSessionFileChangesError = sessionFileChangesMatchesSelection ? sessionFileChangesError : null;
  const visibleSessionFileChangesLoading =
    sessionFileChangesLoading ||
    (fileChangesOpen && selectedSession !== null && !sessionFileChangesMatchesSelection);
  const sessionFileChangesMetadata = useMemo(
    () =>
      formatSessionFileChangesMetadata(
        visibleSessionFileChanges,
        visibleSessionFileChangesError,
        visibleSessionFileChangesLoading,
      ),
    [visibleSessionFileChanges, visibleSessionFileChangesError, visibleSessionFileChangesLoading],
  );

  useEffect(() => {
    setActiveSkillIndex(0);
    setAutocompleteDismissedFor(null);
  }, [message, selectedSession?.id]);

  useEffect(() => {
    if (sessionsReady && selectedSession && selectedSession.id !== selectedSessionId) {
      onSelectedSessionChange(selectedSession.id);
    }
  }, [onSelectedSessionChange, selectedSession, selectedSessionId, sessionsReady]);

  useEffect(() => {
    setViewedSubagent(null);
  }, [selectedSession?.id]);
  useLayoutEffect(() => {
    setCostDrawerOpen(false);
  }, [selectedSession?.id]);

  useLayoutEffect(() => {
    if (todoOpenSessionId !== null && (todoOpenSessionId !== selectedSession?.id || currentTodo === null)) {
      setTodoOpenSessionId(null);
    }
  }, [currentTodo, selectedSession?.id, todoOpenSessionId]);
  useLayoutEffect(() => {
    selectedSessionIdRef.current = selectedSession?.id ?? null;
  }, [selectedSession?.id]);

  useLayoutEffect(() => {
    if (branchSelectorSessionIdRef.current === null) return;
    const invalidSession =
      !selectedSession ||
      branchSelectorSessionIdRef.current !== selectedSession.id ||
      selectedSession.branch === null ||
      selectedSession.source === "history" ||
      !selectedSession.connected ||
      connection !== "connected" ||
      selectedSession.status === "disconnected" ||
      selectedSession.status === "history" ||
      (branchTopology !== null && selectedSession.branch !== branchTopology.currentBranch);
    if (invalidSession) resetBranchSelector();
  }, [
    connection,
    branchTopology?.currentBranch,
    resetBranchSelector,
    selectedSession?.branch,
    selectedSession?.connected,
    selectedSession?.id,
    selectedSession?.source,
    selectedSession?.status,
  ]);

  useEffect(
    () => () => {
      branchRequestGenerationRef.current += 1;
      branchLoadAbortRef.current?.abort();
    },
    [],
  );

  useEffect(() => {
    clearSessionFileChangesRefreshTimer();
    const sessionId = selectedSession?.id;
    if (!sessionId) {
      fileChangesRequestRef.current += 1;
      fileChangesAbortRef.current?.abort();
      fileChangesAbortRef.current = null;
      fileChangesOpenRef.current = false;
      setSessionFileChangesSessionId(null);
      setSessionFileChanges(null);
      setSessionFileChangesError(null);
      setSessionFileChangesLoading(false);
      setFileChangesOpen(false);
      return;
    }
    const refreshGeneration = ++fileChangesRequestRef.current;
    fileChangesAbortRef.current?.abort();
    fileChangesAbortRef.current = null;
    setSessionFileChangesSessionId(sessionId);
    setSessionFileChanges((current) => (current?.sessionId === sessionId ? current : null));
    setSessionFileChangesError(null);
    if (!fileChangesOpenRef.current) {
      setSessionFileChangesLoading(false);
      return;
    }
    setSessionFileChangesLoading(true);
    fileChangesRefreshTimerRef.current = globalThis.setTimeout(() => {
      fileChangesRefreshTimerRef.current = null;
      if (!fileChangesOpenRef.current || fileChangesRequestRef.current !== refreshGeneration) return;
      void refreshSessionFileChanges(sessionId);
    }, 750);
    return clearSessionFileChangesRefreshTimer;
  }, [
    clearSessionFileChangesRefreshTimer,
    refreshSessionFileChanges,
    selectedSession?.id,
    selectedSession?.lastActivity,
  ]);

  useEffect(
    () => () => {
      clearSessionFileChangesRefreshTimer();
      fileChangesRequestRef.current += 1;
      fileChangesAbortRef.current?.abort();
    },
    [clearSessionFileChangesRefreshTimer],
  );

  const selectedCostSessionId =
    selectedSession && (selectedSession.source === "history" || selectedSession.messages.length > 0)
      ? selectedSession.id
      : null;
  useEffect(() => {
    if (!selectedCostSessionId) return;
    void onLoadCost(selectedCostSessionId).catch(() => undefined);
  }, [onLoadCost, selectedCostSessionId]);

  const selectedTranscriptHistory = useMemo(() => {
    if (selectedSession && transcriptHistory.sessionId === selectedSession.id) {
      return transcriptHistory;
    }
    return {
      sessionId: selectedSession?.id ?? null,
      initialLoading: false,
      olderLoading: false,
      status: null,
      error: null,
    };
  }, [selectedSession, transcriptHistory]);

  useEffect(() => {
    const sessionId = selectedSession?.id;
    if (!sessionId) return;
    void onLoadTranscript(sessionId).catch(() => undefined);
  }, [onLoadTranscript, selectedSession?.id]);

  const selectSkillSuggestion = (commandName: string) => {
    setMessage(`/${commandName} `);
  };

  const submitMessage = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedSession || !composerAction || messagePendingBySession[selectedSession.id]) return;
    if (composerAction === "abort") {
      setAbortOpen(true);
      return;
    }
    const sessionId = selectedSession.id;
    const currentDraft = messagesBySession[sessionId] ?? "";
    const submittedDraft = currentDraft;
    const trimmed = currentDraft.trim();
    const requestId = crypto.randomUUID();
    const request = { id: requestId, submittedDraft };
    messageRequestBySessionRef.current[sessionId] = request;
    setMessagePendingBySession((current) => ({ ...current, [sessionId]: { requestId } }));
    clearSessionCommandError(sessionId, "message");

    try {
      await onCommand(sessionId, selectedSession.status === "running" ? "follow_up" : "prompt", trimmed);
      if (messageRequestBySessionRef.current[sessionId] === request) {
        if (selectedSessionIdRef.current === sessionId) {
          transcriptScrollToEndRef.current?.();
        }
        setMessagesBySession((current) =>
          current[sessionId] === submittedDraft ? { ...current, [sessionId]: "" } : current,
        );
      }
    } catch (commandFailure) {
      if (messageRequestBySessionRef.current[sessionId] === request) {
        const messageText =
          commandFailure instanceof Error ? commandFailure.message : "The instruction could not be sent";
        setSessionCommandError(sessionId, "message", messageText);
      }
    } finally {
      if (messageRequestBySessionRef.current[sessionId] === request) {
        delete messageRequestBySessionRef.current[sessionId];
        setMessagePendingBySession((current) => {
          if (!current[sessionId] || current[sessionId]?.requestId !== requestId) return current;
          const next = { ...current };
          delete next[sessionId];
          return next;
        });
      }
    }
  };

  const submitLaunch = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (launchState === "sending") return;
    const formElement = event.currentTarget;
    const cwd = launchCwd.trim();
    const resume = String(new FormData(formElement).get("resume") ?? "").trim();
    if (!cwd) return;
    setLaunchState("sending");
    setLaunchError(null);
    try {
      const sessionId = await onLaunch(cwd, resume || null);
      setSelectedDirectory(null);
      onSelectedSessionChange(sessionId);
      setLaunchOpen(false);
      setLaunchCwd("");
      formElement.reset();
    } catch (launchFailure) {
      const message =
        launchFailure instanceof Error ? launchFailure.message : "OMP could not start the session";
      setLaunchError(message);
      toast.error(message);
    } finally {
      setLaunchState("idle");
    }
  };

  const saveWorkingDirectory = async () => {
    const cwd = launchCwd.trim();
    if (!cwd || savedDirectoryPending) return;
    setSavedDirectoryPending({ action: "save", cwd });
    setSavedDirectoryError(null);
    try {
      await onSaveWorkingDirectory(cwd);
    } catch (saveFailure) {
      setSavedDirectoryError(
        saveFailure instanceof Error ? saveFailure.message : "The working directory could not be saved",
      );
    } finally {
      setSavedDirectoryPending(null);
    }
  };

  const removeWorkingDirectory = async (cwd: string) => {
    if (savedDirectoryPending) return;
    setSavedDirectoryPending({ action: "remove", cwd });
    setSavedDirectoryError(null);
    try {
      await onRemoveWorkingDirectory(cwd);
    } catch (removeFailure) {
      setSavedDirectoryError(
        removeFailure instanceof Error
          ? removeFailure.message
          : "The saved working directory could not be removed",
      );
    } finally {
      setSavedDirectoryPending(null);
    }
  };

  const submitHistorySearch = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const query = historyQuery.trim();
    try {
      await onSearchHistory(query);
      setActiveHistoryQuery(query);
    } catch {
      // The shared client exposes the actionable request error above the session list.
    }
  };

  const resumeSelectedSession = async () => {
    if (!selectedSession?.sessionPath || resumePendingBySession[selectedSession.id]) return;
    const sessionId = selectedSession.id;
    setResumePendingBySession((current) => ({ ...current, [sessionId]: true }));
    clearSessionCommandError(sessionId, "resume");
    try {
      const launchedSessionId = await onLaunch(selectedSession.cwd, selectedSession.sessionPath);
      onSelectedSessionChange(launchedSessionId);
    } catch (resumeFailure) {
      const messageText =
        resumeFailure instanceof Error ? resumeFailure.message : "The session could not be resumed";
      setSessionCommandError(sessionId, "resume", messageText);
      toast.error(messageText);
    } finally {
      setResumePendingBySession((current) => {
        if (!current[sessionId]) return current;
        const next = { ...current };
        delete next[sessionId];
        return next;
      });
    }
  };

  const abortSelectedSession = async () => {
    if (!selectedSession || abortPendingBySession[selectedSession.id]) return;
    const sessionId = selectedSession.id;
    setAbortPendingBySession((current) => ({ ...current, [sessionId]: true }));
    clearSessionCommandError(sessionId, "abort");
    try {
      await onAbort(sessionId);
      setAbortOpen(false);
    } catch (abortFailure) {
      const messageText =
        abortFailure instanceof Error ? abortFailure.message : "The active run could not be interrupted";
      setSessionCommandError(sessionId, "abort", messageText);
      toast.error(messageText);
    } finally {
      setAbortPendingBySession((current) => {
        if (!current[sessionId]) return current;
        const next = { ...current };
        delete next[sessionId];
        return next;
      });
    }
  };

  const killSelectedSession = async () => {
    if (!selectedSession || killPendingBySession[selectedSession.id]) return;
    const sessionId = selectedSession.id;
    setKillPendingBySession((current) => ({ ...current, [sessionId]: true }));
    clearSessionCommandError(sessionId, "kill");
    try {
      await onKill(sessionId);
      setKillOpen(false);
    } catch (killFailure) {
      const messageText =
        killFailure instanceof Error ? killFailure.message : "The session process could not be terminated";
      setSessionCommandError(sessionId, "kill", messageText);
    } finally {
      setKillPendingBySession((current) => {
        if (!current[sessionId]) return current;
        const next = { ...current };
        delete next[sessionId];
        return next;
      });
    }
  };

  const handleSelectDirectory = useCallback(
    (cwd: string | null) => {
      setSelectedDirectory(cwd);
      const filtered = filterSessionsByDirectory(mainSessions, cwd);
      const grouped = groupSessionsForSidebar(filtered);
      const firstSession = grouped[0]?.sessions[0] ?? null;
      if (firstSession && firstSession.id !== selectedSessionId) {
        onSelectedSessionChange(firstSession.id);
        setViewedSubagent(null);
      }
    },
    [mainSessions, onSelectedSessionChange, selectedSessionId],
  );

  const selectBranch = async (branch: string) => {
    if (
      !selectedSession ||
      !canSwitchSelectedSessionBranch ||
      branchCheckoutPending !== null ||
      !branchTopology?.branches.some((candidate) => candidate.name === branch) ||
      branch === branchTopology.currentBranch
    )
      return;
    const generation = branchRequestGenerationRef.current;
    const sessionId = selectedSession.id;
    setBranchCheckoutPending(branch);
    setBranchCheckoutError(null);
    try {
      await onSwitchBranch(sessionId, branch);
      if (
        generation !== branchRequestGenerationRef.current ||
        branchSelectorSessionIdRef.current !== sessionId
      )
        return;
      resetBranchSelector();
    } catch (failure) {
      if (
        generation !== branchRequestGenerationRef.current ||
        branchSelectorSessionIdRef.current !== sessionId
      )
        return;
      setBranchCheckoutPending(null);
      setBranchCheckoutError(failure instanceof Error ? failure.message : "Branch checkout failed.");
    }
  };

  return (
    <div className="app-shell">
      {SessionSidebar({
        mainSessions,
        visibleSessions,
        sessionSections,
        directoryEntries,
        selectedDirectory: activeDirectory,
        selectedSessionId: selectedSession?.id ?? null,
        askingSessionIds,
        historyLoading,
        hasMoreHistory,
        historyQuery,
        activeHistoryQuery,
        connection,
        activeView,
        applicationErrorsCount: applicationErrors.length,
        onSelectView: (view) => {
          setActiveView(view);
          if (isMobile) setOpenMobile(false);
        },
        onSelectDirectory: (cwd) => {
          handleSelectDirectory(cwd);
          setActiveView("sessions");
        },
        onHistoryQueryChange: setHistoryQuery,
        onSubmitHistorySearch: submitHistorySearch,
        onClearHistorySearch: () => {
          setHistoryQuery("");
          setActiveHistoryQuery("");
          void onSearchHistory("").catch(() => undefined);
        },
        onLaunchSession: () => setLaunchOpen(true),
        onSelectSession: (sessionId) => {
          onSelectedSessionChange(sessionId);
          setViewedSubagent(null);
          setOpenMobile(false);
          setActiveView("sessions");
        },
        onLoadMoreHistory: () => void onLoadMoreHistory().catch(() => undefined),
      })}

      {activeView === "application-errors" ? (
        <SidebarInset>
          <ApplicationErrorViewer
            errors={applicationErrors}
            loading={applicationErrorsLoading}
            {...(applicationErrorsHealth !== null && applicationErrorsHealth !== undefined
              ? { health: applicationErrorsHealth }
              : {})}
            {...(applicationErrorsError !== null && applicationErrorsError !== undefined
              ? { error: applicationErrorsError }
              : {})}
            {...(onClearApplicationErrors ? { onClearErrors: onClearApplicationErrors } : {})}
            {...(onReloadApplicationErrors ? { onReloadErrors: onReloadApplicationErrors } : {})}
            onBackToSessions={() => setActiveView("sessions")}
          />
        </SidebarInset>
      ) : (
        <SidebarInset>
          {SessionHeader({
            selectedSession,
            selectedSessionStatus,
            notificationState,
            onOpenNotificationSettings: () => setNotificationSettingsOpen(true),
            onKillSession: () => {
              if (selectedSessionKey) {
                clearSessionCommandError(selectedSessionKey, "kill");
              }
              setKillOpen(true);
            },
            onLaunchSession: () => setLaunchOpen(true),
          })}

          {error ? (
            <div className="system-alert" role="alert">
              <strong>Live connection needs attention.</strong>
              <span>{error}</span>
            </div>
          ) : null}

          {selectedSession ? (
            <section
              className="session-workspace"
              aria-label={`Controls for ${selectedSession.name ?? selectedSession.cwd}`}
            >
              {SessionTranscript({
                session: selectedSession,
                queuedMessages: queuedMessages.filter((message) => message.sessionId === selectedSession.id),
                transcriptHistory: selectedTranscriptHistory,
                activeAskRequest,
                connection,
                onRespondToAsk: (request, response) =>
                  onRespondToAsk(request.sessionId, request.requestId, response),
                onAskActivity: (request) => onAskActivity(request.sessionId, request.requestId),
                onCancelQueuedMessage,
                onViewSubagent: setViewedSubagent,
                onRegisterScrollToEnd: registerTranscriptScrollToEnd,
                onLoadOlderTranscript,
                onRetryTranscript,
                onReloadTranscript,
              })}
              {SessionMetadata({
                session: selectedSession,
                canViewBranches: canViewSelectedSessionBranches,
                modelLabel: currentModelOption?.name ?? selectedSession.model?.split("/").at(-1) ?? "Default",
                configurationPending,
                fileChangesMetadata: sessionFileChangesMetadata,
                todo:
                  currentTodo && currentTodoPresentation
                    ? {
                        overall: currentTodo.overall,
                        activeLabel: currentTodoPresentation.activeLabel,
                        activeState: currentTodoPresentation.activeState,
                        progressVerb: currentTodoPresentation.progressVerb,
                        label: getTodoTrackerLabel(currentTodo),
                      }
                    : null,
                onOpenBranchSelector: () => handleBranchSelectorOpenChange(true),
                onOpenConfiguration: openConfiguration,
                onOpenFileChanges: () => handleFileChangesOpenChange(true),
                onOpenCost: () => setCostDrawerOpen(true),
                onOpenTodo: () => setTodoOpenSessionId(selectedSession.id),
              })}

              {selectedSession.source === "history" ? (
                <div className="history-controls">
                  <div>
                    <strong>Saved session</strong>
                    <span>Resume this transcript to send new instructions.</span>
                  </div>
                  <Button
                    type="button"
                    disabled={
                      connection !== "connected" ||
                      Boolean(selectedSessionKey && resumePendingBySession[selectedSessionKey])
                    }
                    onClick={() => void resumeSelectedSession()}
                  >
                    Resume session
                  </Button>
                </div>
              ) : (
                SessionComposer({
                  message,
                  skillSuggestions: visibleSkillSuggestions,
                  activeSkillIndex,
                  composerAction,
                  sending: Boolean(selectedSessionKey && messagePendingBySession[selectedSessionKey]),
                  onSubmit: submitMessage,
                  onMessageChange: setMessage,
                  onMoveActiveSkill: (direction) =>
                    setActiveSkillIndex(
                      (current) =>
                        (current + direction + visibleSkillSuggestions.length) %
                        visibleSkillSuggestions.length,
                    ),
                  onSelectSkill: selectSkillSuggestion,
                  onDismissAutocomplete: setAutocompleteDismissedFor,
                })
              )}

              {visibleComposerError ? (
                <p className="inline-error" role="alert">
                  {visibleComposerError}
                </p>
              ) : null}
            </section>
          ) : (
            EmptyDashboard({ onLaunchSession: () => setLaunchOpen(true) })
          )}
        </SidebarInset>
      )}

      <SubagentSessionViewer
        open={viewedSubagent !== null}
        mobile={isMobile}
        subagent={viewedSubagent}
        session={viewedSubagentSession}
        detailsState={viewedSubagentDetailsState}
        onRetry={retrySubagentDetails}
        onOpenChange={(open) => {
          if (!open) setViewedSubagent(null);
        }}
      >
        {viewedSubagentSession?.messages.length ? (
          renderTranscriptMessageItems({
            messages: viewedSubagentSession.messages,
          })
        ) : (
          <MessageScrollerItem
            messageId={`subagent-empty:${viewedSubagentSession?.id ?? viewedSubagent?.id ?? "pending"}`}
          >
            <div className="empty-transcript">
              <span className="terminal-prompt" aria-hidden="true">
                π
              </span>
              <strong>
                {viewedSubagentDetailsState === "live"
                  ? "Waiting for subagent output"
                  : viewedSubagentDetailsState === "loading"
                    ? "Loading saved session"
                    : viewedSubagentDetailsState === "error"
                      ? "Session unavailable"
                      : "Saved session"}
              </strong>
              <p>
                {viewedSubagentDetailsState === "live"
                  ? "Live output will appear here as the subagent works."
                  : viewedSubagentDetailsState === "error"
                    ? "The session could not be loaded. Retry from the session drawer."
                    : viewedSubagentDetailsState === "loading"
                      ? "Loading saved output…"
                      : "No saved output is available for this session."}
              </p>
            </div>
          </MessageScrollerItem>
        )}
        {viewedSubagentSession?.status === "running" ? (
          <MessageScrollerItem messageId={`working:${viewedSubagentSession.id}`}>
            <WorkingIndicator
              status={viewedSubagentSession.status}
              message={viewedSubagentSession.messages.at(-1)}
            />
          </MessageScrollerItem>
        ) : null}
      </SubagentSessionViewer>

      <SessionFileChangesViewer
        open={fileChangesOpen}
        mobile={isMobile}
        result={visibleSessionFileChanges}
        loading={visibleSessionFileChangesLoading}
        error={visibleSessionFileChangesError}
        onOpenChange={handleFileChangesOpenChange}
      />
      <SessionCostViewer
        session={selectedSession}
        mobile={isMobile}
        open={costDrawerOpen}
        onOpenChange={setCostDrawerOpen}
      />
      <SessionBranchSelector
        open={branchSelectorOpen && Boolean(selectedSession?.branch)}
        mobile={isMobile}
        currentBranch={branchTopology?.currentBranch ?? selectedSession?.branch ?? ""}
        topology={branchTopology?.sessionId === selectedSession?.id ? branchTopology : null}
        query={branchQuery}
        loading={branchTopologyLoading}
        loadError={branchTopologyError}
        checkoutPending={branchCheckoutPending}
        checkoutError={branchCheckoutError}
        running={selectedSession?.status === "running"}
        onQueryChange={setBranchQuery}
        onSelectBranch={(branch) => void selectBranch(branch)}
        onOpenChange={handleBranchSelectorOpenChange}
      />
      {TodoDrawer({
        open: todoOpenSessionId === selectedSession?.id && currentTodo !== null,
        mobile: isMobile,
        todo: currentTodo,
        onOpenChange: (open) =>
          setTodoOpenSessionId(open && currentTodo ? (selectedSession?.id ?? null) : null),
      })}
      {ModelConfigurationDrawer({
        open: configurationOpen,
        mobile: isMobile,
        session: selectedSession,
        availableModels,
        filteredModels,
        expandedModel,
        modelQuery,
        pending: configurationPending,
        error: configurationError,
        onOpenChange: handleConfigurationOpenChange,
        onExpandedModelChange,
        onModelQueryChange,
        onSelectRole: (model, role) => void selectConfiguration({ model, role }),
        onSelectModel: (model, effort) =>
          void selectConfiguration(effort === undefined ? { model } : { model, effort }),
      })}
      {LaunchSessionDialog({
        open: launchOpen,
        cwd: launchCwd,
        savedWorkingDirectories,
        savedDirectoryPending,
        savedDirectoryError,
        launchError,
        sending: launchState === "sending",
        onOpenChange: (open) => {
          setLaunchOpen(open);
          if (!open) {
            setSavedDirectoryError(null);
            setLaunchError(null);
          }
        },
        onCwdChange: setLaunchCwd,
        onSaveWorkingDirectory: () => void saveWorkingDirectory(),
        onRemoveWorkingDirectory: (cwd) => void removeWorkingDirectory(cwd),
        onSubmit: submitLaunch,
        onCancel: () => setLaunchOpen(false),
      })}
      {AbortSessionDialog({
        open: abortOpen,
        sending: Boolean(selectedSessionKey && abortPendingBySession[selectedSessionKey]),
        onOpenChange: setAbortOpen,
        onAbort: () => void abortSelectedSession(),
        onKeepRunning: () => setAbortOpen(false),
      })}
      {KillSessionDialog({
        open: killOpen,
        sending: Boolean(selectedSessionKey && killPendingBySession[selectedSessionKey]),
        commandError: visibleKillError,
        onOpenChange: setKillOpen,
        onKill: () => void killSelectedSession(),
        onKeepSession: () => setKillOpen(false),
      })}
      <NotificationSettingsDrawer
        open={notificationSettingsOpen}
        mobile={isMobile}
        state={notificationState}
        preferences={notificationPreferences}
        error={notificationError}
        onOpenChange={setNotificationSettingsOpen}
        onToggleEvent={onToggleNotification}
      />
    </div>
  );
}
