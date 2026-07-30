---
type: fix
status: executing
branch: fix/subagent-session-classification
---

# Fix: Keep subagents nested and silence their notifications

## 1. Root Cause

OMP persists ancestry in the session-file layout: a root session at `<root>.jsonl` owns subagent sessions beneath `<root>/<agent>.jsonl`. `SessionCatalog` already uses that durable relationship to list only root histories and to expose non-exited children through the parent session's `activeSubagents` field.

The live browser path loses that distinction in two places:

- `filterMainSessions` in `packages/infrastructure/protocol/src/index.ts` identifies subagents only by their temporary membership in a parent's current `activeSubagents` array. A newly registered subagent is therefore top-level until the periodic catalog refresh populates the parent, and an exited subagent becomes top-level again after the refresh removes it from the active array while `markSessionHistorical` retains its registry entry.
- `findSessionNotifications` in `apps/web/src/session-notifications.ts` examines the unfiltered session array, so a connected subagent's `running → idle` or `waiting` transition is notification-eligible even when the dashboard happens to hide that session.

The parent activity UI also waits for the daemon's ten-second catalog timer. A worker that registers between refreshes can appear late, and a sufficiently short-lived worker can finish before the parent ever receives active membership.

This is reproduced in the running dashboard: completed workers such as `RedQualityReview`, `RedSpecReview`, and `NotificationRedTests` appear as top-level History rows, while the current `SubagentVisibilityDebug` worker appears in the selected parent only because it has reached the catalog's active list. A focused source-level probe likewise produced `sidebarBeforeCatalog=["main","worker"]`, a `session-worker-idle` notification, and `sidebarAfterExit=["main","worker"]`. Existing tests cover steady-state active membership but not pre-sync, post-exit, or notification behavior.

## 2. Proposed Fix

Make the protocol helper the single client-side identity boundary:

- Strengthen `filterMainSessions` to exclude sessions whose `sessionPath` is structurally nested beneath another session's `<path-without-.jsonl>/` directory, recursively. Retain current active-subagent ID filtering as a fallback for legacy or null paths.
- Use the same helper in `findSessionNotifications`, classifying against the union of previous and current snapshots before comparing transitions. Parent sessions remain eligible; nested subagents never generate browser notifications even if their parent is absent from one transient snapshot.
- Request catalog reconciliation when an extension session registers, applying returned root-session upserts through the existing `syncActiveSubagents` path instead of waiting for the periodic timer. Serialize refresh requests so registration and timer refreshes cannot race or overwrite newer catalog state. Keep the timer as recovery and log refresh failures without blocking registration.

This preserves the existing product contract: active workers are available from the parent session's subagent control; completed workers are omitted rather than promoted into navigation. It adds no dependency or persisted schema field, keeps `activeSubagents` scoped to current activity, and uses the JSONL hierarchy already treated as authoritative by `SessionCatalog`.

Edge and safety behavior:

- Require a complete `<parent>.jsonl` to `<parent>/…/*.jsonl` boundary; shared filename prefixes and unrelated directories must not be classified as ancestry.
- Support recursively nested workers under the same root session.
- Preserve active-ID filtering when either side lacks `sessionPath`.
- Do not suppress root-session notifications.
- Do not delay or reject extension registration when immediate catalog refresh fails; the existing timer must reconcile later.
- Preserve refresh request order when multiple subagents register concurrently or a registration overlaps the periodic timer.

## 3. Implementation Plan

- [x] **Step 1: Reproduce with failing tests**
  - Extend `packages/infrastructure/protocol/src/index.test.ts` with structurally nested active, exited/history, and recursively nested workers whose parent `activeSubagents` array is empty; assert only root and unrelated sessions remain.
  - Include shared-prefix and unrelated-path cases so only the exact `<parent-without-.jsonl>/` boundary nests a session, and retain a null-path active-ID fallback case.
  - Extend `apps/web/src/session-notifications.test.ts` to prove nested workers never notify before catalog synchronization, after active membership clears, or when their parent is absent from one transition snapshot, while an eligible parent transition still notifies.
  - Add focused daemon coverage for registration-triggered reconciliation without advancing the ten-second timer, asserting the parent receives active membership while the child remains available for its transcript; cover overlapping refresh requests without time-based sleeps.
  - Run only the focused protocol, web-notification, and daemon tests and record that the new cases fail against current behavior.
- [x] **Step 2: Apply the minimal fix**
  - Add exact, recursive session-path ancestry detection inside the protocol module and use it from `filterMainSessions`, retaining active-ID fallback behavior.
  - Classify notification eligibility against the combined previous/current session identity set, then compare transitions only for root sessions.
  - Extract one serialized daemon catalog-reconciliation function used by both extension registration and the periodic timer; apply root upserts through `syncActiveSubagents`, report refresh failures without breaking later queued refreshes, and never block registration.
- [x] **Step 3: Verification**
  - Run the focused protocol, notification, daemon, dashboard, and session-client suites.
  - Run affected package typechecks and the web production build.
  - Start the daemon and dashboard, spawn and complete a real subagent, and verify it is never a sidebar row, appears under its parent while active, disappears from parent activity when finished, and emits no notification; verify a parent waiting/idle transition still notifies.
