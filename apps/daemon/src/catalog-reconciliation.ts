import type { Session } from "@omp-remote/protocol";
import type { CatalogDiff } from "./session-catalog.js";

interface CatalogReconcilerOptions {
  refresh(): Promise<CatalogDiff>;
  syncActiveSubagents(session: Session): void;
  onError(error: unknown): void;
}

interface ReconciledSessionRegistrarOptions {
  registerSession(session: Session): void;
  requestCatalogReconciliation(): Promise<void>;
}

export function createCatalogReconciler({
  refresh,
  syncActiveSubagents,
  onError,
}: CatalogReconcilerOptions): () => Promise<void> {
  let activeReconciliation: Promise<void> | null = null;
  let refreshRequested = false;

  const reconcileOnce = async () => {
    try {
      const diff = await refresh();
      for (const session of diff.upserted) syncActiveSubagents(session);
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
