---
type: fix
status: in-review
branch: fix/dashboard-test-fixtures
---

# Fix: Restore dashboard test fixture type safety

## 1. Root Cause

Main commit `aee5bce9bd0a816a80f450de9b33b467a45ca108` added the required `DashboardProps.onSetModel` and `DashboardProps.onSetEffort` callbacks in `packages/features/sessions/src/components/dashboard.tsx`, but did not add them to the shared `DASHBOARD_DEFAULTS` fixture in `packages/features/sessions/src/components/dashboard.test.ts`.

`ControlledDashboardProps` extends the complete `DashboardProps` contract. All six failing `renderControlledDashboard` constructions inherit the same incomplete defaults object, so `pnpm --filter @omp-remote/sessions typecheck` deterministically reports TS2345 at lines 536, 566, 569, 589, 592, and 604. The production caller in `apps/web/src/App.tsx` already supplies both callbacks, and the dashboard's 36 runtime tests pass; this is a shared test-fixture/typecheck regression, not a demonstrated production behavior defect.

PR #47 merged while its CI check was still pending. That check later failed with the same diagnostics. Its manual test plan did not typecheck `@omp-remote/sessions`.

## 2. Proposed Fix

Add resolved `vi.fn()` mocks for `onSetModel` and `onSetEffort` to `DASHBOARD_DEFAULTS`, adjacent to the existing session action callbacks. This fixes every affected construction at the shared source without weakening `DashboardProps`, making production callbacks optional, adding casts, or duplicating mocks across call sites.

## 3. Implementation Plan

- [x] **Step 1: Reproduce the compile-time regression**
  - Run `pnpm --filter @omp-remote/sessions typecheck` and confirm it fails only because the six controlled-dashboard fixtures omit `onSetModel` and `onSetEffort`.
- [x] **Step 2: Complete the shared dashboard fixture**
  - Add `onSetModel` and `onSetEffort` resolved mocks to `DASHBOARD_DEFAULTS` in `packages/features/sessions/src/components/dashboard.test.ts`.
  - Do not change the required `DashboardProps` contract or production component behavior.
- [x] **Step 3: Verify compile-time and runtime coverage**
  - Run `pnpm --filter @omp-remote/sessions typecheck` and require exit code 0.
  - Run `pnpm --filter @omp-remote/sessions exec vitest run src/components/dashboard.test.ts` and require all existing dashboard tests to pass.
