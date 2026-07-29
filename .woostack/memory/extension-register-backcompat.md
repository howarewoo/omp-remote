---
name: extension-register-backcompat
type: gotcha
scope: packages/infrastructure/protocol/src/**, packages/infrastructure/omp-extension/src/**, apps/daemon/src/**
tags: protocol, extension, websocket, compatibility
hook: Shipped extensions may outlive the daemon schema that produced them
updated: 2026-07-29
source: [[fixes/2026-07-29-unify-daemon-endpoint]]
---
Normalize lagging extension frames at ingress; keep canonical session state strict.
