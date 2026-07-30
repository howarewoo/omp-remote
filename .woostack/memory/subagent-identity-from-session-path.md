---
name: subagent-identity-from-session-path
type: gotcha
scope: apps/*/src/**, packages/infrastructure/*/src/**, packages/features/sessions/src/**
tags: sessions, subagents
hook: Nested session paths identify subagents; activeSubagents only reports current activity
updated: 2026-07-30
source: [[fixes/2026-07-30-subagent-session-classification]]
---
Subagent identity: derive ancestry from nested session paths; activeSubagents is transient activity.
