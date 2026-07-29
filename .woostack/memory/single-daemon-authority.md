---
name: single-daemon-authority
type: gotcha
scope: package.json, scripts/*.mjs, apps/*/src/**, packages/infrastructure/*/src/**
tags: daemon, sessions, websocket, development
hook: Live streams and commands never cross daemon processes
updated: 2026-07-29
source: [[fixes/2026-07-29-unify-daemon-endpoint]]
---
Session clients must share one daemon authority: streams and command routes do not cross processes.
