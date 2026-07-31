---
name: async-session-command-invalidation
type: gotcha
scope: packages/features/sessions/src/components/**
tags: sessions, async, react
hook: Async session commands must ignore completions after selection changes
updated: 2026-07-30
source: [[fixes/2026-07-30-model-effort-selectors]]
---
Async session commands: ignore stale completions after selection changes to protect newer state.
