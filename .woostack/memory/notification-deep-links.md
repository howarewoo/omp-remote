---
name: notification-deep-links
type: gotcha
scope: apps/*/public/*sw*.js, apps/*/src/*notification*.ts, packages/infrastructure/session-client/src/**
tags: pwa, service-worker, notifications, routing
hook: Notification deep links require payload identity, client navigation, and ready route data
updated: 2026-07-30
source: [[fixes/2026-07-30-push-notification-session-navigation]]
---
Notification deep links: preserve identity, navigate focused clients, then hydrate from ready sources.
