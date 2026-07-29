---
type: fix
status: executing
branch: fix/unify-daemon-endpoint
---

# Fix: Keep live sessions and the web app on one daemon

## 1. Root Cause

`pnpm dev` creates a second in-memory daemon authority on port `4388`, while ordinary terminal OMP sessions register with the extension default `ws://127.0.0.1:4387/extension`. Vite proxies the development web app to `4388`, so its browser socket cannot see, stream, or control sessions registered with the daemon on `4387`.

Observed evidence:

- The root `package.json` sets `OMP_REMOTE_PORT=4388` when the variable is absent. Turbo passes that value to both the watched daemon and Vite.
- `apps/web/vite.config.ts` derives `/ws`, `/extension`, `/api`, and `/healthz` proxy targets from `OMP_REMOTE_PORT`, so the development browser reaches `4388`.
- `packages/infrastructure/omp-extension/src/extension.ts` defaults terminal-session registration to `ws://127.0.0.1:4387/extension` and reconnects to that same endpoint.
- Each daemon keeps its own `SessionRegistry`, browser sockets, extension sockets, and RPC sessions in memory. There is no cross-daemon stream or command route.
- A two-daemon reproduction registered an extension session with daemon A before the browser connected to daemon B. Daemon B returned an empty snapshot and rejected `steer` with `This OMP session is no longer connected.` The same late browser connection against daemon A received the connected snapshot, subsequent transcript events, routed `steer`, and the extension's `command_result`.
- `PRODUCT.md` defines one host authority and one dashboard for every OMP session on that host. The default development topology violates that invariant.

The `4388` default was introduced to avoid `EADDRINUSE` when the installed service already owns `4387`. Simply deleting the override while still starting a second watched daemon would restore that earlier failure. Development must reuse a healthy authoritative daemon when one already owns the configured endpoint, and start the watched daemon on that same endpoint only when no authority is running.

The endpoint fix removed the split authority but did not resolve the reported live session. A second, independently reproduced boundary failure prevents already-running sessions from registering at all:

- With the corrected development stack healthy on `127.0.0.1:4387`, `/healthz` reported `sessions: 0` while the catalog exposed active Task worker `TimeoutProvenanceQualityReview` only as disconnected history with `capabilities: ["resume"]`.
- A traced normal OMP session loaded the installed extension, opened `/extension`, and sent a registration snapshot without `sessionPath`. The daemon immediately closed the socket with code `1003` and reason `Invalid extension frame`; the extension retried every two seconds with the same rejected frame.
- `SessionSchema` requires `sessionPath`, and `ExtensionRegisterSchema` embeds `SessionSchema` directly. Omission therefore rejects the complete registration before the daemon can retain the socket or populate `SessionRegistry`.
- Current repository source already sends `sessionPath: ctx.sessionManager.getSessionFile() ?? null`, but the installed 2026-07-28 compiled extension predates that field. Its missing `resume` capability is valid and unrelated.
- OMP Task workers inherit user extensions and emit child `session_start`, so the active parent and child can recover on their next retry once the daemon accepts the immediately previous registration shape. No OMP restart or session resume should be required.
- The catalog separately classifies nested Task logs as resumable history. That representation defect explains the misleading fallback card, but it is not the cause of zero live registrations and is not a substitute for restoring the extension socket.

## 2. Proposed Fix

- Replace the unconditional `4388` root development command with a small Node launcher that probes the configured daemon `/healthz` endpoint.
- When a valid OMP Remote daemon is already reachable, start only the Vite development task and proxy it to that daemon. Existing terminal sessions remain registered, live, and interactive through the development web app.
- When no valid daemon is reachable, start the existing full Turbo development graph without overriding `OMP_REMOTE_PORT`; the watched daemon, Vite proxy, and extension default then converge on `4387`.
- Preserve explicit `OMP_REMOTE_HOST` and `OMP_REMOTE_PORT` overrides. Validate the same loopback host and port bounds used by the daemon, require the OMP Remote health response shape rather than accepting any HTTP 200 response, bound the probe with a short timeout, and leave real startup or proxy failures visible.
- Update development documentation to describe one authoritative endpoint and remove the instruction that ordinary terminal sessions must opt into port `4388`.
- Add no dependency and do not add cross-daemon federation, UI fallbacks, catalog merging, or per-command routing patches.
- Make only the extension registration input backward-compatible: accept an omitted `sessionPath` and normalize it to explicit `null` before the frame reaches canonical session state.
- Keep `SessionSchema` strict everywhere else, preserve valid nonempty paths unchanged, reject empty strings and wrong types, and do not synthesize the missing `resume` capability.
- Preserve current extension output. Compatibility is limited to the immediately previous installed frame shape so already-running extensions recover through their existing retry loop.

## 3. Implementation Plan

- [x] **Step 1: Reproduce with a failing test**
  - Add focused Node tests for the root development launcher: a valid existing daemon selects the web-only Turbo task; an absent, malformed, or timed-out health endpoint selects the full development graph; and explicit loopback host/port overrides are probed and preserved.
  - Add the launcher tests to the root test command and run them before implementation, capturing the missing-launcher failure.
- [x] **Step 2: Apply the minimal fix**
  - Add `scripts/dev.mjs` using Node's built-in `fetch`, `AbortSignal.timeout`, and child-process APIs. Validate configuration, probe `/healthz`, select the web-only or full Turbo command, inherit stdio, preserve arguments and exit/signal behavior, and log which authoritative endpoint is in use.
  - Change the root `dev` script to call the launcher without forcing port `4388`.
  - Update `README.md` development and environment guidance for the single-authority behavior and explicit overrides.
- [x] **Step 3: Verification**
  - Run the focused launcher tests, root test command, and root typecheck.
  - With a temporary valid daemon health server on a non-default loopback port, run `pnpm dev --dry=json` and verify Turbo selects only web development against that endpoint; with the server absent, verify the same finite command selects the full graph on the same endpoint.
  - Exercise the session path against one daemon: register an extension session before the browser connects, verify the browser snapshot marks it `source: "extension"`, `status: "running"`, and `connected: true`, verify a later transcript event streams to the browser, route `steer` to the extension, and return `command_result` to the browser.
- [x] **Step 4: Reproduce the rejected installed-extension frame**
  - Add protocol tests proving the immediately previous registration frame without `sessionPath` is normalized to `sessionPath: null`, while canonical `SessionSchema` still rejects omission.
  - Cover current nonempty paths unchanged plus empty-string and wrong-type rejection; run the focused test before implementation and capture the failure.
- [x] **Step 5: Apply boundary-local compatibility**
  - Give `ExtensionRegisterSchema` a registration-only session schema whose omitted `sessionPath` defaults to `null`.
  - Keep canonical session parsing and current extension snapshots unchanged; add no fallback command route and no synthetic resume capability.
- [x] **Step 6: Verify the reported active session**
  - Run focused protocol tests, root tests, and root typecheck under supported Node.
  - Start the corrected daemon against the currently installed previous extension and verify its retry stays open, increments live health, and upserts the same session ID without duplication.
  - Without restarting or resuming `TimeoutProvenanceQualityReview`, verify the dashboard replaces the saved-session fallback with connected live state, streams a subsequent event, routes `steer` to that child socket, and returns `command_result`.
  - `TimeoutProvenanceQualityReview` completed normally before the interaction probe could reach it and was not restarted or resumed. The same hot-registration, stream, and command path was verified against another already-loaded previous-extension Task session, including stable identity across daemon reconnect.
