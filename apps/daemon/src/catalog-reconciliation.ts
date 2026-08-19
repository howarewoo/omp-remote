import type { Session } from "@omp-remote/protocol";
import type { CatalogDiff } from "./session-catalog.js";

interface CatalogReconcilerOptions {
  refresh(): Promise<CatalogDiff>;
  syncCatalogSession(session: Session): void;
  onError(error: unknown): void;
}

interface ReconciledSessionRegistrarOptions {
  registerSession(session: Session): void;
  requestCatalogReconciliation(): Promise<void>;
  resolveSession?(session: Session): Session | undefined;
}

export interface RegistrationGenerationQueue<Registration, Frame> {
  register(registration: Registration): Promise<boolean>;
  accept(frame: Frame): Promise<void>;
  close(): void;
}

export function createRegistrationGenerationQueue<Registration, Frame>(
  registerGeneration: (registration: Registration, isCurrent: () => boolean) => Promise<boolean>,
  applyFrame: (frame: Frame) => void | Promise<void>,
): RegistrationGenerationQueue<Registration, Frame> {
  let closed = false;
  let generation = 0;
  let registrationResult = Promise.resolve(false);
  let applicationQueue = Promise.resolve();

  return {
    register(registration) {
      const currentGeneration = ++generation;
      const isCurrent = () => !closed && generation === currentGeneration;
      if (closed) return Promise.resolve(false);
      registrationResult = registerGeneration(registration, isCurrent)
        .then((registered) => registered && isCurrent())
        .catch((error: unknown) => {
          if (isCurrent()) throw error;
          return false;
        });
      applicationQueue = Promise.resolve();
      return registrationResult;
    },
    accept(frame) {
      const currentGeneration = generation;
      const currentRegistration = registrationResult;
      applicationQueue = applicationQueue.then(async () => {
        if (closed || currentGeneration === 0 || generation !== currentGeneration) return;
        if (!(await currentRegistration) || closed || generation !== currentGeneration) return;
        await applyFrame(frame);
      });
      return applicationQueue;
    },
    close() {
      closed = true;
      generation += 1;
      applicationQueue = Promise.resolve();
    },
  };
}

export interface DeferredRegistrationReplay<Frame> {
  accept(frame: Frame): void;
  register(shouldReplay?: (frame: Frame) => boolean): void;
  dispose(): void;
}

export function createDeferredRegistrationReplay<Frame>(
  applyFrame: (frame: Frame) => void,
): DeferredRegistrationReplay<Frame> {
  let registered = false;
  let replaying = false;
  const deferredFrames: Frame[] = [];

  return {
    accept(frame) {
      if (!registered || replaying) {
        deferredFrames.push(frame);
        return;
      }
      applyFrame(frame);
    },
    register(shouldReplay = () => true) {
      if (registered) return;
      registered = true;
      replaying = true;
      for (const frame of deferredFrames) {
        if (shouldReplay(frame)) applyFrame(frame);
      }
      deferredFrames.length = 0;
      replaying = false;
    },
    dispose() {
      registered = true;
      deferredFrames.length = 0;
      replaying = false;
    },
  };
}

export function resolveReconciledSession(
  liveSession: Session,
  catalogSession: Session | undefined,
): Session | undefined {
  if (!catalogSession) return liveSession.parentSessionId === undefined ? undefined : liveSession;
  if (catalogSession.parentSessionId === undefined) return undefined;
  return {
    ...liveSession,
    createdAt: catalogSession.createdAt,
    activeSubagents: catalogSession.activeSubagents,
    parentSessionId: catalogSession.parentSessionId,
  };
}

export async function registerDeferredSession(
  session: Session,
  registerSession: (session: Session, isCurrent: () => boolean) => Promise<boolean>,
  isCurrent: () => boolean,
  waitForRetry: () => Promise<void>,
): Promise<boolean> {
  while (isCurrent()) {
    if (await registerSession(session, isCurrent)) return isCurrent();
    if (isCurrent()) await waitForRetry();
  }
  return false;
}

export async function waitForCatalogTopology(
  requestCatalogReconciliation: () => Promise<void>,
  resolveSession: () => Session | undefined,
  interrupted: Promise<void>,
  waitForRetry: () => Promise<void>,
  isInterrupted: () => boolean,
): Promise<Session | undefined> {
  while (true) {
    if (isInterrupted()) return undefined;
    const interruptedBeforeRefresh = await Promise.race([
      requestCatalogReconciliation().then(() => false),
      interrupted.then(() => true),
    ]);
    if (interruptedBeforeRefresh || isInterrupted()) return undefined;
    const session = resolveSession();
    if (session?.parentSessionId !== undefined) return session;
    const interruptedBeforeRetry = await Promise.race([
      waitForRetry().then(() => false),
      interrupted.then(() => true),
    ]);
    if (interruptedBeforeRetry || isInterrupted()) return undefined;
  }
}

export type CatalogSessionMetadataPatch = Partial<
  Pick<Session, "name" | "createdAt" | "activeSubagents" | "parentSessionId">
>;

export function getCatalogSessionMetadataPatch(
  liveSession: Session,
  catalogSession: Session,
): CatalogSessionMetadataPatch | null {
  const patch: CatalogSessionMetadataPatch = {};
  let changed = false;
  if (liveSession.source === "rpc" && liveSession.name !== catalogSession.name) {
    patch.name = catalogSession.name;
    changed = true;
  }
  if (liveSession.createdAt !== catalogSession.createdAt) {
    patch.createdAt = catalogSession.createdAt;
    changed = true;
  }
  if (
    catalogSession.parentSessionId !== undefined &&
    liveSession.parentSessionId !== catalogSession.parentSessionId
  ) {
    patch.parentSessionId = catalogSession.parentSessionId;
    changed = true;
  }
  if (!activeSubagentsEqual(liveSession.activeSubagents, catalogSession.activeSubagents)) {
    patch.activeSubagents = catalogSession.activeSubagents;
    changed = true;
  }
  return changed ? patch : null;
}

function activeSubagentsEqual(left: Session["activeSubagents"], right: Session["activeSubagents"]): boolean {
  return (
    left.length === right.length &&
    left.every((subagent, index) => {
      const other = right[index];
      return (
        subagent.id === other?.id &&
        subagent.name === other.name &&
        subagent.lastActivity === other.lastActivity
      );
    })
  );
}

export function createCatalogReconciler({
  refresh,
  syncCatalogSession,
  onError,
}: CatalogReconcilerOptions): () => Promise<void> {
  let activeReconciliation: Promise<void> | null = null;
  let refreshRequested = false;

  const reconcileOnce = async () => {
    try {
      const diff = await refresh();
      for (const session of diff.upserted) syncCatalogSession(session);
    } catch (error) {
      try {
        onError(error);
      } catch {
        // Error reporting must not poison later reconciliation requests.
      }
    }
  };

  const reconcileUntilCurrent = async () => {
    do {
      refreshRequested = false;
      await reconcileOnce();
    } while (refreshRequested);
  };

  return () => {
    refreshRequested = true;
    if (activeReconciliation) return activeReconciliation;

    activeReconciliation = reconcileUntilCurrent().finally(() => {
      activeReconciliation = null;
    });
    return activeReconciliation;
  };
}

export function createReconciledSessionRegistrar({
  registerSession,
  requestCatalogReconciliation,
  resolveSession,
}: ReconciledSessionRegistrarOptions): (
  session: Session | (() => Session),
  isCurrent?: () => boolean,
) => Promise<boolean> {
  return async (session, isCurrent = () => true) => {
    await requestCatalogReconciliation();
    if (!isCurrent()) return false;
    const currentSession = typeof session === "function" ? session() : session;
    const resolvedSession = resolveSession?.(currentSession);
    if (resolveSession && !resolvedSession) return false;
    if (!isCurrent()) return false;
    registerSession(resolvedSession ?? currentSession);
    return true;
  };
}
