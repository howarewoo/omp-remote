---
name: omp-edit-diff-details
type: gotcha
scope: apps/daemon/src/**, packages/infrastructure/omp-extension/src/**, packages/infrastructure/protocol/src/**
tags: protocol, omp, transcript, tools
hook: OMP edit results keep canonical diff in details.diff
updated: 2026-07-29
source: [[fixes/2026-07-29-edit-tool-diff-colors]]
---
OMP toolResult content is a snapshot: preserve edit details.diff before transcript normalization.
