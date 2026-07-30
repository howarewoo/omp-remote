---
type: fix
status: executing
branch: fix/push-notification-session-navigation
---

# Fix: Navigate notification taps to the originating session

## 1. Root Cause

The session identity is discarded between the session status transition and the notification click. `findSessionNotifications` has access to `session.id`, but `SessionNotificationEvent` contains only display fields and `showSessionNotification` hard-codes `NotificationOptions.data.url` to `/`. The service worker opens that generic URL only when no app window exists; when a same-origin app window already exists, it focuses the window without navigating. The dashboard then stores its selected session only in component state and never consumes a session identifier from the URL. No click path can select the notification's originating session.

The deficiency is reproduced against the current code in both service-worker branches. A Node VM probe supplied `data.url = "/?session=session-2"` to the unchanged `notification-sw.js`: an existing same-origin client recorded only `close` and `focus`, with no `navigate` call. With no existing client and the production payload, the worker recorded `openWindow("/")`. The focused notification suite passes because it asserts notification copy and tags only; it has no navigation contract.

The broken data flow is:

1. `apps/daemon/src/index.ts` broadcasts session status updates containing the session ID.
2. `packages/infrastructure/session-client/src/index.tsx` applies those updates to live sessions.
3. `apps/web/src/session-notifications.ts` detects the transition but omits the session ID from the notification event and emits `/` as the notification URL.
4. `apps/web/public/notification-sw.js` focuses an existing client without navigating, or opens the generic dashboard.
5. `apps/web/src/App.tsx` and `packages/features/sessions/src/components/dashboard.tsx` have no URL-to-selection bridge.

## 2. Proposed Fix

Preserve the session identity as one encoded, same-origin deep link: `/?session=<encoded-session-id>`. Add that URL to each `SessionNotificationEvent` and to `NotificationOptions.data.url`. Give the direct `Notification` fallback equivalent click behavior so every notification path navigates and focuses the app.

Validate notification target URLs inside `notification-sw.js`. For an existing same-origin window, navigate that client to the validated target and then focus it; when no client exists, open the same target. Missing, malformed, or cross-origin data falls back to the app root.

Move session selection ownership to `App`, which reads the `session` query parameter and passes the selected ID plus a change callback to `Dashboard`. Preserve a requested ID while sessions are initially empty; once sessions arrive, select the requested session when present or fall back to the normal first session when absent. Replace the query parameter whenever selection changes so manual sidebar selection and fallback do not leave a stale notification target. No router or new dependency is required.

Security and edge behavior:

- Encode session IDs exactly once and decode them with `URLSearchParams`, including reserved characters and Unicode.
- Permit only same-origin notification targets; never navigate or open a cross-origin URL from notification data.
- Keep `/` as the deterministic fallback for missing, malformed, or stale notification data.
- Preserve the requested session through the initial empty WebSocket snapshot and resolve it only when sessions are available.
- Use the first same-origin window returned by `clients.matchAll` consistently; both focused/background and fully closed PWA paths reach the same URL.
- Keep notification copy, status-transition eligibility, and service-worker registration behavior unchanged.

## 3. Implementation Plan

- [x] **Step 1: Reproduce with failing tests**
  - Extend `apps/web/src/session-notifications.test.ts` to require idle and waiting events to contain the originating session deep link and to prove reserved session-ID characters are encoded exactly once.
  - Add `apps/web/src/notification-sw.test.ts` that executes the service-worker click handler with mocked clients and proves an existing same-origin client is navigated before focus, a closed app opens the target, and missing, malformed, or cross-origin targets fall back to `/`.
  - Exercise the direct `Notification` fallback with a mocked browser notification and require its click handler to close, navigate to the encoded session URL, and focus the app window.
  - Extend `packages/features/sessions/src/components/dashboard.test.ts` with selection cases proving a requested session wins over the default, survives an initially empty session list, and falls back deterministically when absent.
  - Add focused URL-state tests beside `App` for reading and replacing the `session` query parameter without dropping unrelated query parameters.
  - Run the focused web and sessions tests and record that the new navigation cases fail against the current implementation.
- [x] **Step 2: Apply the minimal fix**
  - Add a session-specific URL to `SessionNotificationEvent`, construct it from `session.id` in one helper, and use it for both service-worker and direct browser notifications.
  - Give direct browser notifications an `onclick` handler that closes the notification, navigates the current app window to the session URL, and focuses it.
  - Update `notification-sw.js` to validate the target against `self.location.origin`, navigate an existing same-origin client before focusing it, and open the same target when no client exists.
  - Make `App` own the selected session ID derived from the URL, replace the query parameter on selection changes, and pass the controlled selection contract into `Dashboard`.
  - Update `Dashboard` to use the controlled selected ID, retain the normal first-session fallback, and report sidebar/fallback selections through the callback without introducing a second routing mechanism.
- [x] **Step 3: Verification**
  - Run the focused notification, service-worker, URL-state, and dashboard test files.
  - Run the web and sessions package typechecks and existing package test suites.
  - Build the web application to verify the public service-worker import and browser types.
  - Serve the built PWA and exercise the generated service worker with an actual persistent notification and `NotificationEvent` while the app is open; verify it navigates to the addressed session. Verify the closed-client `openWindow` branch with the behavioral worker test because the host cannot automate a physical macOS notification tap, and separately verify the built app consumes that deep link plus manual selection replaces the stale query target.
