import type { ActiveSubagent, SessionBranchTopology, SessionFileChangesResponse } from "@omp-remote/protocol";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DashboardProps } from "./dashboard-props.js";

type DashboardSession = DashboardProps["sessions"][number];

export function useSubagentDetails(onLoadSession: DashboardProps["onLoadSession"]) {
  const [viewedSubagent, setViewedSubagent] = useState<ActiveSubagent | null>(null);
  const [subagentDetails, setSubagentDetails] = useState<{
    id: string;
    state: "loading" | "loaded" | "error";
  } | null>(null);
  const requestRef = useRef(0);
  const requestSubagentDetails = useCallback(
    (id: string) => {
      const generation = ++requestRef.current;
      setSubagentDetails({ id, state: "loading" });
      void onLoadSession(id).then(
        () => {
          if (generation === requestRef.current) setSubagentDetails({ id, state: "loaded" });
        },
        () => {
          if (generation === requestRef.current) setSubagentDetails({ id, state: "error" });
        },
      );
    },
    [onLoadSession],
  );
  const cancelSubagentDetails = useCallback(() => {
    requestRef.current += 1;
  }, []);

  return {
    viewedSubagent,
    setViewedSubagent,
    subagentDetails,
    requestSubagentDetails,
    cancelSubagentDetails,
  };
}

interface BranchControllerOptions {
  selectedSession: DashboardSession | null;
  connection: DashboardProps["connection"];
  onLoadSessionBranchTopology: DashboardProps["onLoadSessionBranchTopology"];
  onSwitchBranch: DashboardProps["onSwitchBranch"];
}

export function useBranchController({
  selectedSession,
  connection,
  onLoadSessionBranchTopology,
  onSwitchBranch,
}: BranchControllerOptions) {
  const [branchSelectorOpen, setBranchSelectorOpen] = useState(false);
  const [branchTopology, setBranchTopology] = useState<SessionBranchTopology | null>(null);
  const [branchQuery, setBranchQuery] = useState("");
  const [branchTopologyLoading, setBranchTopologyLoading] = useState(false);
  const [branchTopologyError, setBranchTopologyError] = useState<string | null>(null);
  const [branchCheckoutPending, setBranchCheckoutPending] = useState<string | null>(null);
  const [branchCheckoutError, setBranchCheckoutError] = useState<string | null>(null);
  const requestGenerationRef = useRef(0);
  const selectorSessionIdRef = useRef<string | null>(null);
  const loadAbortRef = useRef<AbortController | null>(null);

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
    requestGenerationRef.current += 1;
    loadAbortRef.current?.abort();
    loadAbortRef.current = null;
    selectorSessionIdRef.current = null;
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
      if (selectorSessionIdRef.current === selectedSession.id) return;

      loadAbortRef.current?.abort();
      const abortController = new AbortController();
      const generation = ++requestGenerationRef.current;
      const sessionId = selectedSession.id;
      loadAbortRef.current = abortController;
      selectorSessionIdRef.current = sessionId;
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
            generation !== requestGenerationRef.current ||
            abortController.signal.aborted ||
            selectorSessionIdRef.current !== sessionId ||
            topology.sessionId !== sessionId
          )
            return;
          setBranchTopology(topology);
        })
        .catch((failure: unknown) => {
          if (
            generation !== requestGenerationRef.current ||
            abortController.signal.aborted ||
            selectorSessionIdRef.current !== sessionId
          )
            return;
          setBranchTopologyError(
            failure instanceof Error ? failure.message : "Local branch topology could not be loaded.",
          );
        })
        .finally(() => {
          if (generation === requestGenerationRef.current && selectorSessionIdRef.current === sessionId) {
            setBranchTopologyLoading(false);
            if (loadAbortRef.current === abortController) loadAbortRef.current = null;
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

  const selectBranch = useCallback(
    async (branch: string) => {
      if (
        !selectedSession ||
        !canSwitchSelectedSessionBranch ||
        branchCheckoutPending !== null ||
        !branchTopology?.branches.some((candidate) => candidate.name === branch) ||
        branch === branchTopology.currentBranch
      )
        return;
      const generation = requestGenerationRef.current;
      const sessionId = selectedSession.id;
      setBranchCheckoutPending(branch);
      setBranchCheckoutError(null);
      try {
        await onSwitchBranch(sessionId, branch);
        if (generation !== requestGenerationRef.current || selectorSessionIdRef.current !== sessionId) return;
        resetBranchSelector();
      } catch (failure) {
        if (generation !== requestGenerationRef.current || selectorSessionIdRef.current !== sessionId) return;
        setBranchCheckoutPending(null);
        setBranchCheckoutError(failure instanceof Error ? failure.message : "Branch checkout failed.");
      }
    },
    [
      branchCheckoutPending,
      branchTopology,
      canSwitchSelectedSessionBranch,
      onSwitchBranch,
      resetBranchSelector,
      selectedSession,
    ],
  );

  useLayoutEffect(() => {
    if (selectorSessionIdRef.current === null) return;
    const invalidSession =
      !selectedSession ||
      selectorSessionIdRef.current !== selectedSession.id ||
      selectedSession.branch === null ||
      selectedSession.source === "history" ||
      !selectedSession.connected ||
      connection !== "connected" ||
      selectedSession.status === "disconnected" ||
      selectedSession.status === "history" ||
      (branchTopology !== null && selectedSession.branch !== branchTopology.currentBranch);
    if (invalidSession) resetBranchSelector();
  }, [connection, branchTopology?.currentBranch, resetBranchSelector, selectedSession]);

  useEffect(
    () => () => {
      requestGenerationRef.current += 1;
      loadAbortRef.current?.abort();
    },
    [],
  );

  return {
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
  };
}

interface FileChangesControllerOptions {
  selectedSession: DashboardSession | null;
  onLoadSessionFileChanges: DashboardProps["onLoadSessionFileChanges"];
}

export function useFileChangesController({
  selectedSession,
  onLoadSessionFileChanges,
}: FileChangesControllerOptions) {
  const [fileChangesOpen, setFileChangesOpen] = useState(false);
  const [sessionFileChanges, setSessionFileChanges] = useState<SessionFileChangesResponse | null>(null);
  const [sessionFileChangesLoading, setSessionFileChangesLoading] = useState(false);
  const [sessionFileChangesError, setSessionFileChangesError] = useState<string | null>(null);
  const [sessionFileChangesSessionId, setSessionFileChangesSessionId] = useState<string | null>(null);
  const requestRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const openRef = useRef(false);
  const refreshTimerRef = useRef<number | null>(null);

  const clearRefreshTimer = useCallback(() => {
    if (refreshTimerRef.current === null) return;
    globalThis.clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = null;
  }, []);

  const refreshSessionFileChanges = useCallback(
    async (sessionId: string) => {
      const requestNumber = ++requestRef.current;
      abortRef.current?.abort();
      const abortController = new AbortController();
      abortRef.current = abortController;
      setSessionFileChangesSessionId(sessionId);
      setSessionFileChangesLoading(true);
      setSessionFileChangesError(null);
      try {
        const result = await onLoadSessionFileChanges(sessionId, abortController.signal);
        if (requestNumber !== requestRef.current || abortController.signal.aborted) return;
        setSessionFileChanges(result);
      } catch (failure) {
        if (requestNumber !== requestRef.current || abortController.signal.aborted) return;
        setSessionFileChanges(null);
        setSessionFileChangesError(
          failure instanceof Error ? failure.message : "Session file changes could not be loaded.",
        );
      } finally {
        if (requestNumber === requestRef.current) {
          setSessionFileChangesLoading(false);
          if (abortRef.current === abortController) abortRef.current = null;
        }
      }
    },
    [onLoadSessionFileChanges],
  );

  const handleFileChangesOpenChange = useCallback(
    (open: boolean) => {
      clearRefreshTimer();
      openRef.current = open;
      setFileChangesOpen(open);
      if (!open) {
        requestRef.current += 1;
        abortRef.current?.abort();
        abortRef.current = null;
        setSessionFileChangesLoading(false);
        return;
      }
      if (selectedSession?.id) void refreshSessionFileChanges(selectedSession.id);
    },
    [clearRefreshTimer, refreshSessionFileChanges, selectedSession?.id],
  );

  useEffect(() => {
    clearRefreshTimer();
    const sessionId = selectedSession?.id;
    if (!sessionId) {
      requestRef.current += 1;
      abortRef.current?.abort();
      abortRef.current = null;
      openRef.current = false;
      setSessionFileChangesSessionId(null);
      setSessionFileChanges(null);
      setSessionFileChangesError(null);
      setSessionFileChangesLoading(false);
      setFileChangesOpen(false);
      return;
    }
    const refreshGeneration = ++requestRef.current;
    abortRef.current?.abort();
    abortRef.current = null;
    setSessionFileChangesSessionId(sessionId);
    setSessionFileChanges((current) => (current?.sessionId === sessionId ? current : null));
    setSessionFileChangesError(null);
    if (!openRef.current) {
      setSessionFileChangesLoading(false);
      return;
    }
    setSessionFileChangesLoading(true);
    refreshTimerRef.current = globalThis.setTimeout(() => {
      refreshTimerRef.current = null;
      if (!openRef.current || requestRef.current !== refreshGeneration) return;
      void refreshSessionFileChanges(sessionId);
    }, 750);
    return clearRefreshTimer;
  }, [clearRefreshTimer, refreshSessionFileChanges, selectedSession?.id, selectedSession?.lastActivity]);

  useEffect(
    () => () => {
      clearRefreshTimer();
      requestRef.current += 1;
      abortRef.current?.abort();
    },
    [clearRefreshTimer],
  );

  return {
    fileChangesOpen,
    sessionFileChanges,
    sessionFileChangesLoading,
    sessionFileChangesError,
    sessionFileChangesSessionId,
    handleFileChangesOpenChange,
  };
}
