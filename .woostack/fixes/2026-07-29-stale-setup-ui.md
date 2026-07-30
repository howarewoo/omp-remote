---
type: fix
status: in-review
branch: fix/stale-setup-ui
---

# Fix: Setup serves a previously cached UI

## 1. Root Cause

`pnpm run setup` builds and serves the current production files, but an already installed Workbox service worker can continue answering navigations with its precached `index.html` before the browser performs its throttled update check. The stale HTML then loads the previous hashed JavaScript and CSS bundles.

The production-only divergence is in `apps/web/vite.config.ts`: `VitePWA` precaches HTML, JavaScript, and CSS and installs a navigation fallback for `/index.html`. Its generated `registerSW.js` only calls `navigator.serviceWorker.register("/sw.js")`; it does not explicitly call `ServiceWorkerRegistration.update()`. Development does not enable the PWA service worker.

The bug was reproduced against the running setup service. The raw server response and `apps/web/dist/index.html` were byte-identical and both referenced `/assets/index-CIEgMGgl.js`, while a browser controlled by the existing service worker repeatedly loaded cached `/assets/index-BlMXgif9.js`. Calling `navigator.serviceWorker.getRegistration().then((registration) => registration.update())` and reloading immediately switched the browser to `index-CIEgMGgl.js`. The daemon launch time followed the build, so neither stale build output nor a stale daemon process caused this macOS reproduction.

## 2. Proposed Fix

Use the `virtual:pwa-register` client from `vite-plugin-pwa` instead of the passive generated registration script. Declare its existing `workbox-window` runtime package directly so pnpm exposes the import to the web bundle:

- Disable VitePWA's injected `registerSW.js` so there is one registration authority.
- Register the worker immediately from the web entrypoint.
- When registration succeeds, explicitly call `ServiceWorkerRegistration.update()` to bypass the browser's normal update throttle.
- Keep `registerType: "autoUpdate"`; the plugin's Workbox client already reloads once when an updated worker activates and takes control.
- Report registration and update failures to the console instead of silently swallowing them.

This fixes the proven browser-cache boundary without changing setup order, rebuilding twice, clearing `dist`, or restarting the daemon again.

## 3. Implementation Plan

- [x] **Step 1: Reproduce with a failing test**
  - Add a focused web test for a small PWA registration module.
  - Assert that registration starts immediately and that a returned existing registration receives exactly one `update()` call.
  - Assert that registration/update failures remain observable rather than becoming unhandled or silent failures.
- [x] **Step 2: Apply the minimal fix**
  - Add the PWA registration module using `virtual:pwa-register` and the existing auto-update mode.
  - Load the plugin's client types and declare its existing `workbox-window` runtime package directly so TypeScript and the production bundler resolve the virtual module.
  - Disable the duplicate generated registration injection in `apps/web/vite.config.ts`.
  - Invoke the registration module from `apps/web/src/main.tsx` before rendering the application.
- [x] **Step 3: Verification**
  - Run the focused web tests and the existing setup-script tests.
  - Run the production build and confirm its HTML contains only the application bundle, with service-worker registration owned by the application module.
  - In one browser origin, establish an older worker/cache, serve the newer build, navigate within the update-throttle window, and verify the browser requests the worker update, reloads once, and displays the newer hashed application bundle without cache clearing or a manual `registration.update()` call.
