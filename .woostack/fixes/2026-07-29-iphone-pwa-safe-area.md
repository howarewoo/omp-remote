---
type: fix
status: executing
branch: fix/iphone-pwa-safe-area
---

# Fix: Keep PWA headers clear of the iPhone camera island

## 1. Root Cause

The installed iOS PWA intentionally renders edge to edge: `apps/web/index.html` enables `viewport-fit=cover` and `black-translucent` status-bar styling, while `apps/web/vite.config.ts` uses `display: "standalone"`. The user-reported overlap is therefore reproducible on a notched iPhone when the PWA launches from the Home Screen.

The shared shell stylesheet only protects bottom controls with `env(safe-area-inset-bottom)`. It never consumes `env(safe-area-inset-top)`. As a result, `.session-header` starts its content with `0.6rem` top padding and `.sidebar-header` with no top padding even though iOS lays the document out from the physical top edge. Both the main session header and the mobile sidebar drawer render controls inside the status-bar and camera-island exclusion zone.

## 2. Proposed Fix

Update only `apps/web/src/index.css`:

- Define `--safe-area-top` on `:root`, backed by `env(safe-area-inset-top, 0px)`, so the production value comes from WebKit and browser verification can override it without device detection.
- Set `.session-header` to `min-height: calc(4rem + var(--safe-area-top))` and add the top inset to its existing `0.6rem` top padding. Preserve the mobile 3.75rem content band with `calc(3.75rem + var(--safe-area-top))`.
- Apply the same top-height invariant to `.sidebar-header`. Update its base, collapsed, and mobile-collapsed padding declarations so no shorthand can erase the inset.
- Leave the existing edge-to-edge metadata, component markup, and bottom safe-area behavior unchanged. No dependency, API, data, copy, or accessibility contract changes are required.

## 3. Implementation Plan

- [x] **Step 1: Reproduce the unsafe header geometry**
  - Launch the web app at a 393 × 852 mobile viewport.
  - Set `--safe-area-top: 59px` on the root element and assert `getBoundingClientRect().top >= 59` for the first control in `.session-header`. Before the fix, the property is not consumed and the assertion fails.
  - Open the mobile sidebar and assert the same boundary for the first control in `.sidebar-header`.
- [x] **Step 2: Apply the shared safe-area fix**
  - Add `--safe-area-top` to `:root` using `env(safe-area-inset-top, 0px)`.
  - Update `.session-header`, its mobile minimum-height override, `.sidebar-header`, and both collapsed sidebar-header overrides with the hardened top-height and top-padding formulas.
  - Keep existing header spacing and dimensions unchanged when the top inset is zero.
- [x] **Step 3: Verify behavior and regressions**
  - Repeat the portrait assertions with a simulated 59px top inset; both main and drawer header controls must clear the top boundary.
  - Clear the simulated inset and compare computed header height and padding at desktop and mobile viewports with the recorded pre-fix baseline.
  - Run the focused web build and the Impeccable detector for `apps/web/src/index.css`.
