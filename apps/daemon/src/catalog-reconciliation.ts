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
}

export type CatalogSessionMetadataPatch = Partial<Pick<Session, "name" | "createdAt" | "activeSubagents">>;

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
}: ReconciledSessionRegistrarOptions): (session: Session) => Promise<void> {
  return (session) => {
    registerSession(session);
    return requestCatalogReconciliation();
  };
}
