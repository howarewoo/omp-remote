---
type: fix
status: in-review
branch: fix/dev-port-collision
---

# Fix: Let development coexist with the installed daemon

## 1. Root Cause

`pnpm dev` reliably fails after `pnpm install:service` because both commands start a daemon on the same default socket. The installed macOS LaunchAgent `com.omp-remote.daemon` currently owns `127.0.0.1:4387` as PID 84295, while the root `dev` script runs `turbo run dev`, whose `@omp-remote/daemon` task starts `tsx watch src/index.ts` with the same `OMP_REMOTE_PORT` default. The second `app.listen()` therefore raises `EADDRINUSE`.

Observed evidence:

- `lsof -nP -iTCP:4387 -sTCP:LISTEN` reports PID 84295 listening on `127.0.0.1:4387`.
- `ps -p 84295 -o pid=,ppid=,command=` identifies the installed `apps/daemon/dist/index.js` process with parent PID 1.
- `~/Library/LaunchAgents/com.omp-remote.daemon.plist` configures that daemon with `RunAtLoad` and `KeepAlive`.
- `apps/daemon/src/index.ts` defaults `OMP_REMOTE_PORT` to `4387` and listens on that port.
- `apps/web/vite.config.ts` hard-codes its HTTP and WebSocket proxy targets to port `4387`, so it cannot follow a distinct development port. The Vite WebSocket `EPIPE` messages occur after the primary daemon startup failure; their exact socket-close trigger has not been independently reproduced, so verification must prove whether sharing the corrected development target removes them rather than adding an error-swallowing fallback.

The installed service is behaving correctly and should remain available. Development needs its own default port, while retaining the existing environment override for callers that deliberately select another port.

## 2. Proposed Fix

- Change the root `dev` command to supply `OMP_REMOTE_PORT=4388` only when the caller has not already set `OMP_REMOTE_PORT`. This isolates the watched development daemon from the installed service without stopping or mutating that service.
- Make the Vite proxy derive its daemon host and port from `OMP_REMOTE_HOST` and `OMP_REMOTE_PORT`, with the existing production defaults when either variable is absent. Format IPv6 loopback correctly. Do not swallow proxy errors: after both development processes share the same target, a real proxy failure should remain visible.
- Document the development default, the explicit override, and that terminal OMP sessions must use `OMP_REMOTE_EXTENSION_URL=ws://127.0.0.1:4388/extension` when they should register with the development daemon rather than the installed service.
- Add no dependency and change no production service configuration, daemon API, or network exposure.

## 3. Implementation Plan

- [x] **Step 1: Reproduce with a failing test**
  - Add a focused web configuration test proving that custom daemon host/port values produce matching HTTP and WebSocket proxy targets, including IPv6 loopback formatting.
  - Run the focused test before implementation and capture its failure against the current hard-coded proxy configuration.
- [x] **Step 2: Apply the minimal fix**
  - Export a small daemon-target resolver from `apps/web/vite.config.ts` and use it for both proxy entries.
  - Update the root `dev` script to default `OMP_REMOTE_PORT` to `4388` while preserving an explicit caller value.
  - Update the README development and environment sections with the development-port and extension-registration behavior.
- [x] **Step 3: Verification**
  - Run the focused web configuration test and the web package typecheck.
  - With the installed service still listening on `4387`, start `pnpm dev`, wait for both Vite on `5173` and the watched daemon on `4388`, then request `/healthz` through Vite and establish the dashboard WebSocket path without `EADDRINUSE` or proxy `EPIPE`.
  - Stop only the development process tree and confirm the installed service still owns `4387`.
