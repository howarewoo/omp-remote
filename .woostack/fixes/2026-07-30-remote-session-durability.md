---
type: fix
status: in-review
branch: fix/remote-session-durability
---

# Fix: Keep dashboard-launched sessions alive when a browser falls behind

## 1. Root Cause

The `change/session-notifications` dashboard-launched RPC session was disposed while its task was still running, leaving its uncommitted worktree and branch behind:

- `~/.omp/agent/sessions/-Documents-GitHub-omp-remote/2026-07-30T13-28-26-166Z_019fb336-4535-7000-873b-b7a7c4a6ca6c.jsonl` records `session_exit` with `reason: "dispose"` at `2026-07-30T13:42:53.605Z` while a browser tool call was pending.
- `~/Library/Logs/OMP Remote/daemon.log` records the daemon listening again at `2026-07-30T13:42:55.748Z`, two seconds after that disposal.
- The immediately preceding crash in `daemon.error.log` reached the approximately 4 GB V8 heap limit. Its stack is in `JsonStringify`, and the same log contains repeated heap-limit crashes.

The bad allocation has two causes at the browser broadcast boundary. First, `SessionRegistry.update()` emits a full `session_upsert`, including every retained transcript message, for metadata-only changes. The extension event path applies such an update before every transcript delta, so each message produces a growing full-session frame plus the intended `transcript_upsert`. A real-socket smoke test demonstrated the effect after the first guard implementation: with one healthy reader, one paused reader, and one 256 KiB update every 50 ms, the healthy browser was still terminated after 67 updates because the full-session frames themselves grew beyond the 8 MiB queue limit. Second, `apps/daemon/src/index.ts` previously serialized every frame separately for every `WebSocket.OPEN` browser socket and called `send()` without checking `bufferedAmount`. A suspended phone PWA can remain logically open while it stops draining TCP data, so those repeated snapshots accumulate without a bound in `ws`'s outbound queue. The queue eventually exhausts the daemon heap. Because dashboard-launched OMP RPC processes are direct stdio children of the daemon, the daemon crash disposes the in-flight OMP session even though Git worktrees and branches remain on disk.

This fix addresses the observed crash contract selected at hardening: slow or suspended dashboard clients must not be able to exhaust the daemon and terminate active RPC tasks. Making RPC workers survive arbitrary daemon restarts is a separate process-supervision architecture and is not part of this fix.

## 2. Proposed Fix

Fix both sources at their shared boundaries:

- Add a typed `session_update` server frame containing only a session ID and a metadata patch that cannot include `id` or `messages`.
- Make `SessionRegistry.update()` emit that compact patch instead of a full `session_upsert`; keep `upsert()` as the full initial/replacement snapshot and `transcript_upsert` as the only transcript delta.
- Apply `session_update` patches in the browser client without replacing retained messages.
- Before serializing or sending any browser frame, exclude sockets that are not open.
- If an open socket already has at least 8 MiB buffered, terminate that socket immediately so `ws` releases its queued frames; do not use a graceful close that can remain blocked behind the same queue.
- Serialize each broadcast frame once and reuse that payload for all healthy recipients instead of allocating one JSON string per browser.
- Keep the one-recipient snapshot path under the same backpressure guard.
- Return delivery counts and the largest rejected queue size so the daemon can log a warning when it terminates lagging dashboard clients. Log only queue size/count metadata, never frame or transcript contents.
- Preserve all existing command and transcript frame shapes. The new metadata frame is an internal client/daemon protocol addition with no UI copy or user workflow change.

No new dependency, database, or process supervisor is required. Existing `change/session-notifications` files and worktree are user work and remain untouched.

## 3. Implementation Plan

- [x] **Step 1: Reproduce with a failing test**
  - Add `apps/daemon/src/browser-broadcast.test.ts` with fake WebSocket peers.
  - Prove an open peer above the buffer limit is currently sent another frame instead of being terminated.
  - Specify that a lagging peer is terminated before serialization, healthy peers still receive the frame, non-open peers are ignored, a broadcast with no healthy recipients does not serialize, and one broadcast serializes its frame only once for multiple healthy peers.
- [x] **Step 2: Apply the minimal fix**
  - Add `apps/daemon/src/browser-broadcast.ts` containing the shared 8 MiB backpressure policy and single-serialization broadcast path.
  - Replace the local `sendFrame` and `broadcast` implementations in `apps/daemon/src/index.ts` with the tested helper.
  - Emit a warning containing terminated peer count and buffered-byte metadata when backpressure protection activates; do not log payload content.
- [x] **Step 3: Reproduce growing session snapshots with failing tests**
  - Extend protocol coverage for a metadata-only `session_update` frame whose patch rejects `id` and `messages`.
  - Update `SessionRegistry` tests to require `update()` to emit a compact detached patch instead of a full session with transcript messages.
  - Add session-client coverage requiring metadata patches to preserve retained transcript messages and unrelated session identity.
- [x] **Step 4: Emit and apply compact session updates**
  - Add the `session_update` frame and patch types to the shared protocol.
  - Change `SessionRegistry.update()` to emit compact detached patches while preserving its full internal session state.
  - Handle `session_update` in the browser client by merging metadata into the matching live session without replacing messages.
  - Keep daemon registry broadcasting on the shared typed event path; do not add per-caller message stripping.
- [x] **Step 5: Verification**
  - Run focused protocol, registry, session-client, and daemon broadcast regression tests.
  - Run the affected package test suites and typechecks.
  - Smoke-test a daemon with one healthy WebSocket peer and one intentionally non-reading peer: sustained transcript-sized updates must terminate only the lagging peer, keep the daemon healthy, preserve the healthy peer, and deliver compact `session_update` frames rather than growing session snapshots.
  - Confirm the existing browser reconnect path reconnects after termination and receives a fresh snapshot.
