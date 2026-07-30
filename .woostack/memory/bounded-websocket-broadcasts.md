---
name: bounded-websocket-broadcasts
type: pattern
scope: apps/daemon/**
tags: websocket, backpressure, memory
hook: Bound WebSocket queues before shared serialization
updated: 2026-07-30
source: [[fixes/2026-07-30-remote-session-durability]]
---
WebSocket broadcasts: reject lagging peers before shared serialization to bound host memory.
