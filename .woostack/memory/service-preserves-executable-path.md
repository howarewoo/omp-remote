---
name: service-preserves-executable-path
type: gotcha
scope: scripts/**, apps/daemon/**
tags: service, environment, process
hook: Background services must preserve installer PATH for command-by-name child spawns
updated: 2026-07-30
source: [[fixes/2026-07-30-service-omp-path]]
---
Background services must preserve installer PATH: command-by-name child spawns otherwise fail.
