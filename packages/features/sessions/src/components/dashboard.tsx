import {
  type ActiveSubagent,
  type AskRequest,
  type AskResponse,
  type Effort,
  filterMainSessions,
  type Session,
  type SessionBranchTopology,
  type SessionFileChangesResponse,
} from "@omp-remote/protocol";
import { type FormEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { SessionBranchSelector } from "./session-branch-selector.js";
import { formatSessionFileChangesMetadata, SessionFileChangesViewer } from "./session-file-changes-viewer.js";
import { SubagentSessionViewer } from "./subagent-session-viewer.js";
import { SessionCostViewer } from "./session-cost-viewer.js";
import { EmptyDashboard } from "./dashboard/empty-dashboard.js";
import { DashboardIcon, SessionHeader, type NotificationState } from "./dashboard/session-header.js";
import { formatEffortLabel, SessionMetadata } from "./dashboard/session-metadata.js";
import { SessionSidebar } from "./dashboard/session-sidebar.js";
import { SessionTranscript, WorkingIndicator } from "./dashboard/session-transcript.js";
import { Button } from "./ui/button.js";
import { Dialog } from "./ui/dialog.js";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  getResponsiveDrawerProps,
} from "./ui/drawer.js";
import { Input } from "./ui/input.js";
import { MessageScrollerItem } from "./ui/message-scroller.js";
import { SidebarInset, SidebarProvider, useSidebar } from "./ui/sidebar.js";
import { Textarea } from "./ui/textarea.js";
import { cn } from "./ui/utils.js";
import {
  getActiveAskRequest,
  getComposerAction,
  getSkillSuggestions,
  groupSessionsForSidebar,
} from "./dashboard-actions.js";
import {
  findLatestTodoResult,
  getTodoPresentation,
  getTodoTrackerLabel,
  TodoPhaseList,
  TodoProgressSummary,
} from "./transcript/todo-tool-transcript.js";
import { renderTranscriptMessageItems } from "./transcript/transcript-entry.js";
export { AskToolCall, type AskToolCallProps } from "./ask/ask-tool-call.js";
export {
  canKillSession,
  formatSubagentActivityLabel,
  getActiveAskRequest,
  getComposerAction,
  getSkillSuggestions,
  groupSessionsForSidebar,
} from "./dashboard-actions.js";
export { parseTodoResult } from "./todo-parser.js";
export type {
  TodoActivePhase,
  TodoOverallProgress,
  TodoPhase,
  TodoResult,
  TodoTask,
  TodoTaskState,
} from "./todo-parser.js";
export { parseInlineTranscript } from "./transcript/inline-markup.js";
export type { InlineTranscriptToken } from "./transcript/inline-markup.js";
export { tokenizeBashTitle } from "./transcript/bash-title.js";
export type { BashTitleToken, BashTitleTokenKind } from "./transcript/bash-title.js";
export { tokenizeCode } from "./transcript/code-tokenizer.js";
export type { SyntaxToken, SyntaxTokenKind } from "./transcript/code-tokenizer.js";
export { parseTranscriptBlocks } from "./transcript/blocks.js";
export { TranscriptCodeBlock, TranscriptText, formatSystemTextPreview } from "./transcript/code-block.js";
export { formatToolTextPreview, ToolTranscriptText } from "./transcript/tool-transcript.js";
export { parseDisclosureImages } from "./transcript/disclosure-content.js";
export type { DisclosureTranscriptSegment } from "./transcript/disclosure-content.js";
export {
  findLatestTodoResult,
  TodoToolTranscript,
} from "./transcript/todo-tool-transcript.js";
export {
  MessageScrollerScrollController,
  renderTranscriptMessageItems,
  SystemTranscriptText,
  TranscriptEntry,
} from "./transcript/transcript-entry.js";
export { WorkingIndicator } from "./dashboard/session-transcript.js";

type ComposerMode = "prompt" | "steer" | "follow_up";

const EMPTY_MODEL_OPTIONS: NonNullable<Session["availableModels"]> = [];
const SKILL_SUGGESTION_LIST_ID = "composer-skill-suggestions";

export interface DashboardProps {
  sessions: Session[];
  askRequests: AskRequest[];
  savedWorkingDirectories: string[];
  sessionsReady: boolean;
  historyLoading: boolean;
  hasMoreHistory: boolean;
  connection: "connecting" | "connected" | "disconnected";
  error: string | null;
  notificationState: NotificationState;
  selectedSessionId: string | null;
  onSelectedSessionChange(sessionId: string): void;
  onEnableNotifications(): Promise<void>;
  onLaunch(cwd: string, resume: string | null): Promise<string>;
  onSaveWorkingDirectory(cwd: string): Promise<void>;
  onRemoveWorkingDirectory(cwd: string): Promise<void>;
  onCommand(sessionId: string, command: ComposerMode, text: string): Promise<void>;
  onAbort(sessionId: string): Promise<void>;
  onKill(sessionId: string): Promise<void>;
  onSetModel(sessionId: string, model: string): Promise<void>;
  onSetEffort(sessionId: string, effort: Effort): Promise<void>;
  onRespondToAsk(sessionId: string, askRequestId: string, response: AskResponse): Promise<void>;
  onAskActivity(sessionId: string, askRequestId: string): Promise<void>;
  onSearchHistory(query: string): Promise<void>;
  onLoadMoreHistory(): Promise<void>;
  onLoadTranscript(sessionId: string): Promise<void>;
  onLoadCost(sessionId: string): Promise<void>;
  onLoadSessionFileChanges(sessionId: string, signal?: AbortSignal): Promise<SessionFileChangesResponse>;
  onLoadSessionBranchTopology(sessionId: string, signal?: AbortSignal): Promise<SessionBranchTopology>;
  onSwitchBranch(sessionId: string, branch: string): Promise<void>;
}

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
  askRequests,
  savedWorkingDirectories,
  historyLoading,
  hasMoreHistory,
  connection,
  error,
  notificationState,
  selectedSessionId,
  onSelectedSessionChange,
  onEnableNotifications,
  onLaunch,
  onSaveWorkingDirectory,
  onRemoveWorkingDirectory,
  onCommand,
  onAbort,
  onKill,
  onSetModel,
  onSetEffort,
  onRespondToAsk,
  onAskActivity,
  onSearchHistory,
  onLoadMoreHistory,
  onLoadTranscript,
  onLoadCost,
  onLoadSessionFileChanges,
  onLoadSessionBranchTopology,
  onSwitchBranch,
}: DashboardProps) {
  const [viewedSubagent, setViewedSubagent] = useState<ActiveSubagent | null>(null);
  const [message, setMessage] = useState("");
  const [activeSkillIndex, setActiveSkillIndex] = useState(0);
  const [autocompleteDismissedFor, setAutocompleteDismissedFor] = useState<string | null>(null);
  const [commandState, setCommandState] = useState<"idle" | "sending">("idle");
  const [commandError, setCommandError] = useState<string | null>(null);
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
  const [configurationDrawer, setConfigurationDrawer] = useState<"model" | "effort" | null>(null);
  const [modelQuery, setModelQuery] = useState("");
  const [configurationPending, setConfigurationPending] = useState<string | null>(null);
  const [configurationError, setConfigurationError] = useState<{
    drawer: "model" | "effort";
    message: string;
  } | null>(null);
  const [historyQuery, setHistoryQuery] = useState("");
  const [activeHistoryQuery, setActiveHistoryQuery] = useState("");
  const [transcriptLoadingId, setTranscriptLoadingId] = useState<string | null>(null);
  const loadedTranscriptIdRef = useRef<string | null>(null);
  const transcriptScrollToEndRef = useRef<(() => void) | null>(null);
  const registerTranscriptScrollToEnd = useCallback((handler: (() => void) | null) => {
    transcriptScrollToEndRef.current = handler;
  }, []);
  const configurationRequestRef = useRef<{ sessionId: string } | null>(null);
  const configurationSessionIdRef = useRef<string | null>(null);
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
  const sessionSections = useMemo(() => groupSessionsForSidebar(mainSessions), [mainSessions]);
  const selectedSession = useMemo(
    () =>
      mainSessions.find((session) => session.id === selectedSessionId) ??
      sessionSections[0]?.sessions[0] ??
      null,
    [mainSessions, selectedSessionId, sessionSections],
  );
  const canSwitchSelectedSessionBranch =
    selectedSession !== null &&
    selectedSession.branch !== null &&
    selectedSession.source !== "history" &&
    selectedSession.connected &&
    connection === "connected" &&
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
      if (!selectedSession || !canSwitchSelectedSessionBranch) return;
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
      canSwitchSelectedSessionBranch,
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
  const activeSkillSuggestion = visibleSkillSuggestions[activeSkillIndex] ?? visibleSkillSuggestions[0];
  const viewedSubagentSession = useMemo(
    () => sessions.find((session) => session.id === viewedSubagent?.id) ?? null,
    [sessions, viewedSubagent?.id],
  );
  const availableModels = selectedSession?.availableModels ?? EMPTY_MODEL_OPTIONS;
  const currentModelOption = availableModels.find(
    (model) => `${model.provider}/${model.id}` === selectedSession?.model,
  );
  const filteredModels = useMemo(() => {
    const query = modelQuery.trim().toLocaleLowerCase();
    const matchingModels = query
      ? availableModels.filter((model) =>
          [model.name, model.provider, model.id, ...(model.roles ?? [])].some((value) =>
            value.toLocaleLowerCase().includes(query),
          ),
        )
      : availableModels;
    return matchingModels
      .map((model, index) => ({ model, index }))
      .sort(
        (a, b) =>
          Number((b.model.roles?.length ?? 0) > 0) - Number((a.model.roles?.length ?? 0) > 0) ||
          a.index - b.index,
      )
      .map(({ model }) => model);
  }, [availableModels, modelQuery]);
  const availableEfforts = currentModelOption?.efforts ?? [];
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
    configurationSessionIdRef.current = selectedSession?.id ?? null;
    configurationRequestRef.current = null;
    setConfigurationDrawer(null);
    setModelQuery("");
    setConfigurationPending(null);
    setConfigurationError(null);
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

  const selectedCostSessionId = selectedSession?.id ?? null;
  useEffect(() => {
    if (!selectedCostSessionId) return;
    void onLoadCost(selectedCostSessionId).catch(() => undefined);
  }, [onLoadCost, selectedCostSessionId]);

  useEffect(() => {
    if (selectedSession?.source !== "history" || loadedTranscriptIdRef.current === selectedSession.id) return;
    const sessionId = selectedSession.id;
    loadedTranscriptIdRef.current = sessionId;
    setTranscriptLoadingId(sessionId);
    void onLoadTranscript(sessionId)
      .catch(() => {
        if (loadedTranscriptIdRef.current === sessionId) loadedTranscriptIdRef.current = null;
      })
      .finally(() => setTranscriptLoadingId((current) => (current === sessionId ? null : current)));
  }, [onLoadTranscript, selectedSession]);

  const selectSkillSuggestion = (commandName: string) => {
    setMessage(`/${commandName} `);
  };

  const submitMessage = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedSession || !composerAction || commandState === "sending") return;
    if (composerAction === "abort") {
      setAbortOpen(true);
      return;
    }
    setCommandState("sending");
    setCommandError(null);
    try {
      await onCommand(selectedSession.id, "steer", message.trim());
      transcriptScrollToEndRef.current?.();
      setMessage("");
    } catch (commandFailure) {
      setCommandError(
        commandFailure instanceof Error ? commandFailure.message : "The instruction could not be sent",
      );
    } finally {
      setCommandState("idle");
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
      onSelectedSessionChange(sessionId);
      setLaunchOpen(false);
      setLaunchCwd("");
      formElement.reset();
    } catch (launchFailure) {
      setLaunchError(
        launchFailure instanceof Error ? launchFailure.message : "OMP could not start the session",
      );
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
    if (!selectedSession?.sessionPath || commandState === "sending") return;
    setCommandState("sending");
    setCommandError(null);
    try {
      const sessionId = await onLaunch(selectedSession.cwd, selectedSession.sessionPath);
      onSelectedSessionChange(sessionId);
    } catch (resumeFailure) {
      setCommandError(
        resumeFailure instanceof Error ? resumeFailure.message : "The session could not be resumed",
      );
    } finally {
      setCommandState("idle");
    }
  };

  const abortSelectedSession = async () => {
    if (!selectedSession) return;
    setCommandState("sending");
    setCommandError(null);
    try {
      await onAbort(selectedSession.id);
      setAbortOpen(false);
    } catch (abortFailure) {
      setCommandError(
        abortFailure instanceof Error ? abortFailure.message : "The active run could not be interrupted",
      );
    } finally {
      setCommandState("idle");
    }
  };

  const killSelectedSession = async () => {
    if (!selectedSession) return;
    setCommandState("sending");
    setCommandError(null);
    try {
      await onKill(selectedSession.id);
      setKillOpen(false);
    } catch (killFailure) {
      setCommandError(
        killFailure instanceof Error ? killFailure.message : "The session process could not be terminated",
      );
    } finally {
      setCommandState("idle");
    }
  };

  const selectModel = async (model: string) => {
    if (
      !selectedSession ||
      configurationPending ||
      !selectedSession.capabilities.includes("model") ||
      !availableModels.some((option) => `${option.provider}/${option.id}` === model)
    )
      return;
    const request = { sessionId: selectedSession.id };
    configurationRequestRef.current = request;
    setConfigurationPending(model);
    setConfigurationError(null);
    try {
      await onSetModel(selectedSession.id, model);
    } catch (configurationFailure) {
      if (
        configurationRequestRef.current !== request ||
        configurationSessionIdRef.current !== request.sessionId
      )
        return;
      setConfigurationError({
        drawer: "model",
        message:
          configurationFailure instanceof Error
            ? configurationFailure.message
            : "The model could not be changed",
      });
    } finally {
      if (
        configurationRequestRef.current === request &&
        configurationSessionIdRef.current === request.sessionId
      ) {
        configurationRequestRef.current = null;
        setConfigurationPending(null);
      }
    }
  };

  const selectEffort = async (effort: Effort) => {
    if (
      !selectedSession ||
      configurationPending ||
      !selectedSession.capabilities.includes("effort") ||
      !currentModelOption?.efforts.includes(effort)
    )
      return;
    const request = { sessionId: selectedSession.id };
    configurationRequestRef.current = request;
    setConfigurationPending(effort);
    setConfigurationError(null);
    try {
      await onSetEffort(selectedSession.id, effort);
    } catch (configurationFailure) {
      if (
        configurationRequestRef.current !== request ||
        configurationSessionIdRef.current !== request.sessionId
      )
        return;
      setConfigurationError({
        drawer: "effort",
        message:
          configurationFailure instanceof Error
            ? configurationFailure.message
            : "The effort could not be changed",
      });
    } finally {
      if (
        configurationRequestRef.current === request &&
        configurationSessionIdRef.current === request.sessionId
      ) {
        configurationRequestRef.current = null;
        setConfigurationPending(null);
      }
    }
  };

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
        sessionSections,
        selectedSessionId: selectedSession?.id ?? null,
        askingSessionIds,
        historyLoading,
        hasMoreHistory,
        historyQuery,
        activeHistoryQuery,
        connection,
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
        },
        onLoadMoreHistory: () => void onLoadMoreHistory().catch(() => undefined),
      })}

      <SidebarInset>
        {SessionHeader({
          selectedSession,
          selectedSessionStatus,
          notificationState,
          onEnableNotifications: () => void onEnableNotifications(),
          onKillSession: () => {
            setCommandError(null);
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
              transcriptLoading: transcriptLoadingId === selectedSession.id,
              activeAskRequest,
              connection,
              onRespondToAsk: (request, response) =>
                onRespondToAsk(request.sessionId, request.requestId, response),
              onAskActivity: (request) => onAskActivity(request.sessionId, request.requestId),
              onViewSubagent: setViewedSubagent,
              onRegisterScrollToEnd: registerTranscriptScrollToEnd,
            })}
            {SessionMetadata({
              session: selectedSession,
              canSwitchBranch: canSwitchSelectedSessionBranch,
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
              onOpenModelSelector: () => setConfigurationDrawer("model"),
              onOpenEffortSelector: () => setConfigurationDrawer("effort"),
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
                  disabled={connection !== "connected" || commandState === "sending"}
                  onClick={() => void resumeSelectedSession()}
                >
                  Resume session
                </Button>
              </div>
            ) : (
              <form className="composer" onSubmit={submitMessage}>
                <div className="composer-field">
                  <label className="sr-only" htmlFor="composer-message">
                    Steer current run
                  </label>
                  {visibleSkillSuggestions.length > 0 ? (
                    <div
                      className="skill-suggestions"
                      id={SKILL_SUGGESTION_LIST_ID}
                      role="listbox"
                      aria-label="Available skills"
                    >
                      {visibleSkillSuggestions.map((skill, index) => (
                        <button
                          type="button"
                          className={cn("skill-suggestion", index === activeSkillIndex && "active")}
                          id={`${SKILL_SUGGESTION_LIST_ID}-${index}`}
                          role="option"
                          aria-selected={index === activeSkillIndex}
                          key={skill.name}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={(event) => {
                            selectSkillSuggestion(skill.name);
                            event.currentTarget.form?.querySelector("textarea")?.focus();
                          }}
                        >
                          <code>/{skill.name}</code>
                          {skill.description ? <span>{skill.description}</span> : null}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  <Textarea
                    id="composer-message"
                    value={message}
                    aria-autocomplete="list"
                    aria-controls={visibleSkillSuggestions.length > 0 ? SKILL_SUGGESTION_LIST_ID : undefined}
                    aria-expanded={visibleSkillSuggestions.length > 0}
                    aria-activedescendant={
                      activeSkillSuggestion
                        ? `${SKILL_SUGGESTION_LIST_ID}-${visibleSkillSuggestions.indexOf(activeSkillSuggestion)}`
                        : undefined
                    }
                    onChange={(event) => setMessage(event.target.value)}
                    placeholder="Redirect the current run…"
                    rows={1}
                    onKeyDown={(event) => {
                      if (event.nativeEvent.isComposing) return;
                      if (event.key === "Enter" && event.shiftKey) return;
                      if (visibleSkillSuggestions.length > 0) {
                        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                          event.preventDefault();
                          const direction = event.key === "ArrowDown" ? 1 : -1;
                          setActiveSkillIndex(
                            (current) =>
                              (current + direction + visibleSkillSuggestions.length) %
                              visibleSkillSuggestions.length,
                          );
                        } else if (
                          (event.key === "Enter" && !event.metaKey && !event.ctrlKey && !event.altKey) ||
                          event.key === "Tab"
                        ) {
                          event.preventDefault();
                          if (activeSkillSuggestion) selectSkillSuggestion(activeSkillSuggestion.name);
                        } else if (event.key === "Escape") {
                          event.preventDefault();
                          setAutocompleteDismissedFor(message);
                        }
                        return;
                      }
                      if (event.key === "Enter" && !event.metaKey && !event.ctrlKey && !event.altKey) {
                        event.preventDefault();
                        event.currentTarget.form?.requestSubmit();
                      }
                    }}
                  />
                  <Button
                    className="send-button"
                    type="submit"
                    size="icon"
                    variant={composerAction === "abort" ? "destructive" : "default"}
                    disabled={!composerAction || commandState === "sending"}
                    aria-label={
                      commandState === "sending"
                        ? "Sending instruction"
                        : composerAction === "abort"
                          ? "Abort active run"
                          : composerAction === "steer"
                            ? "Steer active run"
                            : "Enter an instruction to steer"
                    }
                  >
                    <DashboardIcon name={composerAction === "abort" ? "stop" : "send"} />
                  </Button>
                </div>
              </form>
            )}

            {commandError ? (
              <p className="inline-error" role="alert">
                {commandError}
              </p>
            ) : null}
          </section>
        ) : (
          EmptyDashboard({ onLaunchSession: () => setLaunchOpen(true) })
        )}
      </SidebarInset>

      <SubagentSessionViewer
        open={viewedSubagent !== null}
        mobile={isMobile}
        subagent={viewedSubagent}
        session={viewedSubagentSession}
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
                {viewedSubagentSession ? "Waiting for subagent output" : "Connecting to subagent"}
              </strong>
              <p>
                {viewedSubagentSession
                  ? "Live output will appear here as the subagent works."
                  : "The session will appear as soon as the host publishes it."}
              </p>
            </div>
          </MessageScrollerItem>
        )}
        {viewedSubagentSession?.status === "running" ? (
          <MessageScrollerItem messageId={`working:${viewedSubagentSession.id}`}>
            <WorkingIndicator status={viewedSubagentSession.status} />
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
      <Drawer
        open={todoOpenSessionId === selectedSession?.id && currentTodo !== null}
        onOpenChange={(open) =>
          setTodoOpenSessionId(open && currentTodo ? (selectedSession?.id ?? null) : null)
        }
        {...getResponsiveDrawerProps(isMobile)}
      >
        <DrawerContent className="model-settings-sheet todo-tracker-sheet">
          <DrawerHeader className="model-settings-header todo-tracker-sheet-header">
            <div>
              <DrawerTitle>Current Todo</DrawerTitle>
              <DrawerDescription>
                Review the latest Todo progress and complete task list for this session.
              </DrawerDescription>
            </div>
            <DrawerClose
              render={
                <Button type="button" variant="ghost" size="icon" autoFocus aria-label="Close current Todo" />
              }
            >
              <DashboardIcon name="close" />
            </DrawerClose>
          </DrawerHeader>
          <div className="model-settings-body todo-tracker-sheet-body">
            {currentTodo ? (
              <>
                <TodoProgressSummary todo={currentTodo} />
                <TodoPhaseList todo={currentTodo} />
              </>
            ) : null}
          </div>
        </DrawerContent>
      </Drawer>

      <Drawer
        open={configurationDrawer === "model"}
        onOpenChange={(open) => {
          if (configurationPending) return;
          setConfigurationDrawer(open ? "model" : null);
          if (!open) {
            setModelQuery("");
            setConfigurationError(null);
          }
        }}
        {...getResponsiveDrawerProps(isMobile)}
      >
        <DrawerContent className="model-settings-sheet">
          <DrawerHeader className="model-settings-header">
            <div>
              <DrawerTitle>Model</DrawerTitle>
              <DrawerDescription>Choose the model for this session.</DrawerDescription>
            </div>
            <DrawerClose
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Close model settings"
                  disabled={configurationPending !== null}
                />
              }
            >
              <DashboardIcon name="close" />
            </DrawerClose>
          </DrawerHeader>
          <div className="model-settings-body" aria-busy={configurationPending !== null}>
            {selectedSession?.capabilities.includes("model") && availableModels.length > 0 ? (
              <>
                {availableModels.length > 8 ? (
                  <label className="model-search-field" htmlFor="model-settings-search">
                    <span className="sr-only">Search models</span>
                    <DashboardIcon name="search" />
                    <Input
                      id="model-settings-search"
                      value={modelQuery}
                      onChange={(event) => setModelQuery(event.target.value)}
                      placeholder="Search models"
                      autoComplete="off"
                    />
                  </label>
                ) : null}
                <section className="model-settings-section" aria-labelledby="model-settings-model-heading">
                  <div className="model-settings-section-heading">
                    <h3 id="model-settings-model-heading">Model</h3>
                    <span>{availableModels.length} available</span>
                  </div>
                  <div className="model-option-list">
                    {filteredModels.map((model) => {
                      const value = `${model.provider}/${model.id}`;
                      const roles = model.roles ?? [];
                      const selected = value === selectedSession.model;
                      return (
                        <Button
                          className={cn("model-option", selected && "selected")}
                          type="button"
                          variant="ghost"
                          aria-pressed={selected}
                          disabled={configurationPending !== null}
                          onClick={() => void selectModel(value)}
                          key={value}
                        >
                          <span>
                            <strong>{model.name}</strong>
                            {roles.length > 0 ? (
                              <small className="model-option-roles">
                                Configured roles: {roles.join(" · ")}
                              </small>
                            ) : null}
                            <small>{value}</small>
                          </span>
                          <span className="selection-indicator" aria-hidden="true" />
                        </Button>
                      );
                    })}
                    {filteredModels.length === 0 ? (
                      <p className="model-settings-empty">No models match “{modelQuery.trim()}”.</p>
                    ) : null}
                  </div>
                </section>
              </>
            ) : (
              <p className="model-settings-empty model-settings-unavailable">
                {selectedSession?.source !== "history"
                  ? "Restart this session with the latest extension to change its model."
                  : "Resume this session to load its available models."}
              </p>
            )}
            {configurationError?.drawer === "model" ? (
              <p className="inline-error model-settings-error" role="alert">
                {configurationError.message}
              </p>
            ) : null}
          </div>
          <DrawerFooter className="model-settings-footer">
            <DrawerClose
              render={
                <Button type="button" disabled={configurationPending !== null}>
                  Done
                </Button>
              }
            />
          </DrawerFooter>
        </DrawerContent>
      </Drawer>

      <Drawer
        open={configurationDrawer === "effort"}
        onOpenChange={(open) => {
          if (configurationPending) return;
          setConfigurationDrawer(open ? "effort" : null);
          if (!open) setConfigurationError(null);
        }}
        {...getResponsiveDrawerProps(isMobile)}
      >
        <DrawerContent className="model-settings-sheet">
          <DrawerHeader className="model-settings-header">
            <div>
              <DrawerTitle>Effort</DrawerTitle>
              <DrawerDescription>
                Choose the reasoning effort for {currentModelOption?.name ?? "this session"}.
              </DrawerDescription>
            </div>
            <DrawerClose
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Close effort settings"
                  disabled={configurationPending !== null}
                />
              }
            >
              <DashboardIcon name="close" />
            </DrawerClose>
          </DrawerHeader>
          <div className="model-settings-body" aria-busy={configurationPending !== null}>
            {selectedSession?.capabilities.includes("effort") &&
            currentModelOption &&
            availableEfforts.length > 0 ? (
              <section className="model-settings-section" aria-labelledby="model-settings-effort-heading">
                <div className="model-settings-section-heading">
                  <h3 id="model-settings-effort-heading">Effort</h3>
                  <span>{currentModelOption.name}</span>
                </div>
                <div className="effort-options">
                  {availableEfforts.map((effort) => (
                    <Button
                      className={cn("effort-option", effort === selectedSession.effort && "selected")}
                      type="button"
                      variant="outline"
                      aria-pressed={effort === selectedSession.effort}
                      disabled={configurationPending !== null}
                      onClick={() => void selectEffort(effort)}
                      key={effort}
                    >
                      {formatEffortLabel(effort)}
                    </Button>
                  ))}
                </div>
              </section>
            ) : (
              <p className="model-settings-empty model-settings-unavailable">
                {selectedSession?.capabilities.includes("effort") &&
                currentModelOption &&
                availableEfforts.length === 0
                  ? "This model does not expose adjustable effort."
                  : selectedSession?.source !== "history"
                    ? "Restart this session with the latest extension to change its effort."
                    : "Resume this session to load its available effort choices."}
              </p>
            )}
            {configurationError?.drawer === "effort" ? (
              <p className="inline-error model-settings-error" role="alert">
                {configurationError.message}
              </p>
            ) : null}
          </div>
          <DrawerFooter className="model-settings-footer">
            <DrawerClose
              render={
                <Button type="button" disabled={configurationPending !== null}>
                  Done
                </Button>
              }
            />
          </DrawerFooter>
        </DrawerContent>
      </Drawer>

      <Dialog
        open={launchOpen}
        onOpenChange={(open) => {
          setLaunchOpen(open);
          if (!open) {
            setSavedDirectoryError(null);
            setLaunchError(null);
          }
        }}
        title="Start an OMP session"
        description="Choose a working directory. Add a saved session ID or JSONL path to resume it."
      >
        <form className="launch-form" onSubmit={submitLaunch}>
          <div className="launch-field">
            <label htmlFor="launch-cwd">Working directory</label>
            <div className="launch-cwd-control">
              <Input
                id="launch-cwd"
                name="cwd"
                required
                placeholder="/Users/you/project"
                autoComplete="off"
                autoFocus
                value={launchCwd}
                onChange={(event) => setLaunchCwd(event.target.value)}
              />
              <Button
                type="button"
                variant="outline"
                disabled={!launchCwd.trim() || savedDirectoryPending !== null}
                onClick={() => void saveWorkingDirectory()}
              >
                {savedDirectoryPending?.action === "save" ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>
          {savedWorkingDirectories.length > 0 ? (
            <section className="saved-directory-list" aria-label="Saved working directories">
              {savedWorkingDirectories.map((cwd) => (
                <div className="saved-directory-item" key={cwd}>
                  <Button
                    type="button"
                    variant="ghost"
                    className="saved-directory-select"
                    disabled={savedDirectoryPending !== null}
                    onClick={() => setLaunchCwd(cwd)}
                  >
                    {cwd}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove saved working directory ${cwd}`}
                    disabled={savedDirectoryPending !== null}
                    onClick={() => void removeWorkingDirectory(cwd)}
                  >
                    <DashboardIcon name="trash" />
                  </Button>
                </div>
              ))}
            </section>
          ) : null}
          <label htmlFor="launch-resume">
            <span>
              Resume ID or path <small>Optional</small>
            </span>
            <Input
              id="launch-resume"
              name="resume"
              placeholder="Session ID or .jsonl path"
              autoComplete="off"
            />
          </label>
          {savedDirectoryError ? (
            <p className="inline-error saved-directory-error" role="alert">
              {savedDirectoryError}
            </p>
          ) : null}
          {launchError ? (
            <p className="inline-error" role="alert">
              {launchError}
            </p>
          ) : null}
          <footer className="dialog-actions">
            <Button
              type="button"
              variant="ghost"
              disabled={launchState === "sending"}
              onClick={() => setLaunchOpen(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={launchState === "sending"}>
              {launchState === "sending" ? "Starting…" : "Start session"}
            </Button>
          </footer>
        </form>
      </Dialog>

      <Dialog
        open={abortOpen}
        onOpenChange={setAbortOpen}
        title="Abort this run?"
        description="OMP will stop the active run. The session and transcript stay available."
      >
        <footer className="dialog-actions">
          <Button type="button" variant="ghost" onClick={() => setAbortOpen(false)}>
            Keep running
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={commandState === "sending"}
            onClick={() => void abortSelectedSession()}
          >
            Abort run
          </Button>
        </footer>
      </Dialog>

      <Dialog
        open={killOpen}
        onOpenChange={setKillOpen}
        dismissible={commandState !== "sending"}
        title="Kill this session?"
        description="This ends the OMP process and its active run. The transcript stays available as a saved session."
      >
        {commandError ? (
          <p className="inline-error" role="alert">
            {commandError}
          </p>
        ) : null}
        <footer className="dialog-actions kill-dialog-actions">
          <Button
            type="button"
            variant="ghost"
            disabled={commandState === "sending"}
            onClick={() => setKillOpen(false)}
          >
            Keep session
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={commandState === "sending"}
            aria-busy={commandState === "sending"}
            onClick={() => void killSelectedSession()}
          >
            {commandState === "sending" ? "Killing…" : "Kill session"}
          </Button>
        </footer>
      </Dialog>
    </div>
  );
}
