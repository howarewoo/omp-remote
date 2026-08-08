Use shadcn/ui with Base UI for all UI elements.

Treat session file changes as one cumulative ledger of successful mutations from the selected session and all descendants, keyed by resolved absolute path. Never derive session file changes from checked-out Git state or group the display by descendant.

In a fresh worktree, before running a focused package test that imports workspace packages through exported `dist` entries, build the selected package and its workspace dependency graph when those artifacts are absent (for pnpm: `pnpm --filter PACKAGE... build`).