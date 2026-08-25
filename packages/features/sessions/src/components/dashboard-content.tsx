import {
  type ActiveSubagent,
  filterMainSessions,
  type SessionBranchTopology,
  type SessionFileChangesResponse,
} from "@omp-remote/protocol";
import { type FormEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
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
import {
  useBranchController,
  useFileChangesController,
  useSubagentDetails,
} from "./dashboard-resource-controllers.js";
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
import { SidebarInset, useSidebar } from "./ui/sidebar.js";
export function DashboardContent({
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
  const {
    viewedSubagent,
    setViewedSubagent,
    subagentDetails,
    requestSubagentDetails,
    cancelSubagentDetails,
  } = useSubagentDetails(onLoadSession);
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
  const {
    branchSelectorOpen,
    branchTopology,
    branchQuery,
    setBranchQuery,
    branchTopologyLoading,
    branchTopologyError,
    branchCheckoutPending,
    branchCheckoutError,
    canViewSelectedSessionBranches,
    handleBranchSelectorOpenChange,
    selectBranch,
  } = useBranchController({
    selectedSession,
    connection,
    onLoadSessionBranchTopology,
    onSwitchBranch,
  });
  const {
    fileChangesOpen,
    sessionFileChanges,
    sessionFileChangesLoading,
    sessionFileChangesError,
    sessionFileChangesSessionId,
    handleFileChangesOpenChange,
  } = useFileChangesController({ selectedSession, onLoadSessionFileChanges });
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
    return cancelSubagentDetails;
  }, [
    requestSubagentDetails,
    cancelSubagentDetails,
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
      await onCommand(sessionId, selectedSession.status === "running" ? "steer" : "prompt", trimmed);
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
