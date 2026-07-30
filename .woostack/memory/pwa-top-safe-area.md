---
name: pwa-top-safe-area
type: gotcha
scope: apps/*/src/**
tags: pwa, css, ios
hook: Edge-to-edge PWA headers must preserve the top safe area
updated: 2026-07-29
source: [[fixes/2026-07-29-iphone-pwa-safe-area]]
---
Edge-to-edge PWA headers need the top inset in both padding and height: preserve the content band.
