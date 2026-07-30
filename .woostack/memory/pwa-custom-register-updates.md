---
name: pwa-custom-register-updates
type: gotcha
scope: apps/*/vite.config.ts, apps/*/src/**
tags: pwa, service-worker, vite
hook: Custom PWA registration must force update and activation
updated: 2026-07-29
source: [[fixes/2026-07-29-stale-setup-ui]]
---
Custom PWA registration: force update and activation or stale shells persist across builds.
