import { type RpcSession } from "@omp-remote/omp-rpc";
import { type BrowserCommand, type Session, type SessionBranchTopology } from "@omp-remote/protocol";
import { SessionRegistry } from "@omp-remote/sessions/services";
import { WebSocket } from "ws";
import {
  assertBranchSwitchSessionState,
  loadGitBranchTopology,
  resolveGitBranch,
  resolveGitWorktree,
  switchGitBranch,
} from "./git-branch.js";
import { RpcStateResponseSchema } from "./daemon-schemas.js";

const BRANCH_SWITCH_STATE_TIMEOUT_MS = 2_000;
const MAX_CONCURRENT_BRANCH_TOPOLOGY_LOADS = 4;
const MAX_CONCURRENT_WORKTREE_RESOLUTIONS = 8;

export class BranchTopologyCapacityError extends Error {}

type BranchRuntimeDependencies = {
  registry: SessionRegistry;
  rpcSessions: Map<string, RpcSession>;
  extensionSockets: Map<string, WebSocket>;
};

export function createBranchRuntime({ registry, rpcSessions, extensionSockets }: BranchRuntimeDependencies) {
  const switchingGitWorktrees = new Set<string>();
  const branchSwitchingSessionIds = new Set<string>();
  const branchTopologyLoads = new Map<string, Promise<SessionBranchTopology | null>>();
  let activeBranchTopologyLoads = 0;

  async function loadSessionBranchTopology(
    cwd: string,
    sessionId: string,
  ): Promise<SessionBranchTopology | null> {
    const worktree = await resolveGitWorktree(cwd);
    if (!worktree) return null;
    const pendingLoad = branchTopologyLoads.get(worktree);
    if (pendingLoad) {
      const topology = await pendingLoad;
      return topology ? { ...topology, sessionId } : null;
    }
    if (activeBranchTopologyLoads >= MAX_CONCURRENT_BRANCH_TOPOLOGY_LOADS) {
      throw new BranchTopologyCapacityError("Branch topology capacity is exhausted");
    }

    activeBranchTopologyLoads += 1;
    const load = loadGitBranchTopology(cwd, sessionId);
    branchTopologyLoads.set(worktree, load);
    try {
      const topology = await load;
      return topology ? { ...topology, sessionId } : null;
    } finally {
      if (branchTopologyLoads.get(worktree) === load) branchTopologyLoads.delete(worktree);
      activeBranchTopologyLoads -= 1;
    }
  }

  function refreshSessionBranch(sessionId: string, cwd: string): void {
    void resolveGitBranch(cwd).then((branch) => {
      const currentSession = registry.get(sessionId);
      if (currentSession?.cwd === cwd) registry.update(sessionId, { branch });
    });
  }

  function isLiveBranchSession(session: Session): boolean {
    return (
      session.connected &&
      session.source !== "history" &&
      session.status !== "disconnected" &&
      session.status !== "history"
    );
  }

  async function branchSwitchBlocksSessionCommand(
    command: Extract<BrowserCommand, { type: "session_command" }>,
  ): Promise<boolean> {
    if (command.command !== "prompt" && command.command !== "steer" && command.command !== "follow_up") {
      return false;
    }
    if (branchSwitchingSessionIds.has(command.sessionId)) return true;
    if (switchingGitWorktrees.size === 0) return false;
    const session = registry.get(command.sessionId);
    if (!session || !isLiveBranchSession(session)) return false;
    const worktree = await resolveGitWorktree(session.cwd);
    return worktree !== null && switchingGitWorktrees.has(worktree);
  }

  async function sessionsInGitWorktree(expectedSession: Session, worktree: string): Promise<Session[]> {
    const candidates = registry.list().filter(isLiveBranchSession);
    const resolvedWorktrees = new Array<string | null>(candidates.length);
    let nextIndex = 0;
    const workerCount = Math.min(MAX_CONCURRENT_WORKTREE_RESOLUTIONS, candidates.length);
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (nextIndex < candidates.length) {
          const index = nextIndex;
          nextIndex += 1;
          const candidate = candidates[index];
          if (!candidate) continue;
          resolvedWorktrees[index] =
            candidate.cwd === expectedSession.cwd ? worktree : await resolveGitWorktree(candidate.cwd);
        }
      }),
    );
    return candidates.filter((_, index) => resolvedWorktrees[index] === worktree);
  }

  async function assertSessionIdleForBranchSwitch(session: Session): Promise<void> {
    assertBranchSwitchSessionState(session);
    if (session.source === "rpc") {
      const rpcSession = rpcSessions.get(session.id);
      if (!rpcSession) throw new Error("This OMP session is no longer connected.");
      const state = RpcStateResponseSchema.parse(
        await rpcSession.request({ type: "get_state" }, { timeoutMs: BRANCH_SWITCH_STATE_TIMEOUT_MS }),
      );
      if (state.data.isStreaming || state.data.queuedMessageCount) {
        throw new Error("Cannot switch branches while a session in the Git worktree is running.");
      }
      return;
    }
    if (session.source === "extension") {
      const extensionSocket = extensionSockets.get(session.id);
      if (extensionSocket?.readyState !== WebSocket.OPEN) {
        throw new Error("This OMP session is no longer connected.");
      }
      return;
    }
    throw new Error("Historical sessions cannot switch branches.");
  }

  function sameSessionRegistration(left: Session, right: Session): boolean {
    return (
      left.id === right.id &&
      left.source === right.source &&
      left.cwd === right.cwd &&
      left.createdAt === right.createdAt &&
      left.sessionPath === right.sessionPath
    );
  }

  async function refreshGitWorktreeSessions(
    expectedSession: Session,
    worktree: string,
    branch: string | null,
  ): Promise<boolean> {
    let expectedSessionUpdated = false;
    for (const candidate of await sessionsInGitWorktree(expectedSession, worktree)) {
      const current = registry.get(candidate.id);
      if (!current || !sameSessionRegistration(candidate, current)) continue;
      if (candidate.id === expectedSession.id && !sameSessionRegistration(expectedSession, current)) {
        continue;
      }
      if (!registry.update(candidate.id, { branch })) continue;
      if (candidate.id === expectedSession.id) expectedSessionUpdated = true;
    }
    return expectedSessionUpdated;
  }

  async function switchSessionBranch(
    command: Extract<BrowserCommand, { type: "switch_branch" }>,
  ): Promise<void> {
    const session = registry.get(command.sessionId);
    if (!session) throw new Error("This OMP session is no longer connected.");
    assertBranchSwitchSessionState(session);

    const worktree = await resolveGitWorktree(session.cwd);
    if (!worktree) throw new Error("Session is not in a Git worktree.");
    if (switchingGitWorktrees.has(worktree)) {
      throw new Error("A branch switch is already in progress for this Git worktree.");
    }
    switchingGitWorktrees.add(worktree);
    const lockedSessionIds = new Set([session.id]);
    branchSwitchingSessionIds.add(session.id);

    try {
      const switchSessions: Session[] = [];
      let refreshedSession: Session | undefined;
      for (const candidate of await sessionsInGitWorktree(session, worktree)) {
        const current = registry.get(candidate.id);
        if (!current || !sameSessionRegistration(candidate, current)) {
          if (candidate.id === session.id) {
            throw new Error("This OMP session is no longer connected.");
          }
          continue;
        }
        if (candidate.id === session.id && !sameSessionRegistration(session, current)) {
          throw new Error("This OMP session is no longer connected.");
        }
        lockedSessionIds.add(current.id);
        branchSwitchingSessionIds.add(current.id);
        switchSessions.push(current);
        if (current.id === session.id) refreshedSession = current;
      }
      if (!refreshedSession) throw new Error("This OMP session is no longer connected.");
      await Promise.all(switchSessions.map(assertSessionIdleForBranchSwitch));

      const checkedSession = registry.get(command.sessionId);
      if (!checkedSession || !sameSessionRegistration(refreshedSession, checkedSession)) {
        throw new Error("This OMP session is no longer connected.");
      }
      assertBranchSwitchSessionState(checkedSession);

      let switchError: unknown;
      try {
        await switchGitBranch(checkedSession.cwd, command.branch);
      } catch (error) {
        switchError = error;
      }
      const branch = await resolveGitBranch(checkedSession.cwd);
      if (!(await refreshGitWorktreeSessions(checkedSession, worktree, branch))) {
        throw new Error("This OMP session is no longer connected.");
      }
      if (switchError) throw switchError;
      if (branch !== command.branch) throw new Error("Git did not switch to the requested branch.");
    } finally {
      for (const sessionId of lockedSessionIds) branchSwitchingSessionIds.delete(sessionId);
      switchingGitWorktrees.delete(worktree);
    }
  }

  return {
    loadSessionBranchTopology,
    refreshSessionBranch,
    branchSwitchBlocksSessionCommand,
    switchSessionBranch,
  };
}
