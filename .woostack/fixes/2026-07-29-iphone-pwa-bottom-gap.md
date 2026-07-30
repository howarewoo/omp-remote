---
type: fix
status: executing
branch: fix/iphone-pwa-bottom-gap
---

# Fix: Remove the oversized bottom gap in the iPhone PWA

## 1. Root Cause

The installed iOS PWA renders edge to edge (`apps/web/index.html` uses `viewport-fit=cover` and the standalone manifest), so the composer must reserve exactly the home-indicator safe area without stacking unrelated desktop spacing.

At a 393 × 852 iPhone viewport, `apps/web/src/index.css` currently accumulates three independent empty regions around the mobile composer:

- `.transcript` keeps its desktop `2rem` bottom padding because the mobile rule changes only `padding-top`, leaving 32px between the final transcript content and the composer.
- `.composer-footer` keeps `min-height: 1.75rem`. At widths up to 430px, CSS hides the shortcut label; when the session is not running, no footer child is visible, but the empty flex row still consumes 28px below the textarea.
- `.composer` adds `max(0.5rem, calc(env(safe-area-inset-bottom) - 0.5rem))`, which is 26px on an iPhone with a 34px bottom inset. Combined with the empty footer, the working input ends 54px above the screen bottom while reserving only 26px of the actual 34px safe area.

The visible dead region is therefore 86px in the idle narrow-screen case: 32px above the composer plus 28px of ghost footer height and 26px below it. The user report establishes the installed-iPhone premise; source geometry and the current computed-style baseline establish its cause. The regression entered when the mobile composer moved to block flow without mobile-specific footer collapse or transcript-bottom spacing.

## 2. Proposed Fix

Update only `apps/web/src/index.css`:

- Define `--safe-area-bottom: env(safe-area-inset-bottom, 0px)` on `:root`, matching the existing top-inset variable and allowing deterministic browser geometry checks without device detection.
- Set the mobile transcript bottom padding explicitly to `0.75rem`, reducing the desktop-only breathing room while preserving separation from the composer border.
- Make the mobile composer consume `max(0.75rem, var(--safe-area-bottom))`, so the input clears the complete home-indicator inset and retains 12px spacing on devices with no inset.
- At widths up to 430px, override `.composer-footer` to `min-height: 0`. The footer then collapses when its shortcut is hidden and the session is idle, while a visible `.live-copy` continues to establish its natural height during an active run.

Keep the edge-to-edge metadata, shell height, component markup, desktop/tablet footer behavior, running-state indicator, and top safe-area behavior unchanged. No dependency, API, data, copy, accessibility, or persistence changes are required.

## 3. Implementation Plan

- [x] **Step 1: Reproduce the mobile gap with a failing geometry check**
  - Launch the web app stylesheet at a 393 × 852 viewport and inject representative transcript/composer markup.
  - Override `--safe-area-bottom` to `34px` for a deterministic notched-iPhone inset.
  - In the idle state, assert `.composer-footer` has `0px` height, `.composer` has `34px` bottom padding, and `.transcript` has `12px` bottom padding. The current stylesheet fails all three assertions with `28px`, `8px` in non-WebKit browser emulation, and `32px` respectively.
  - Record the current combined narrow idle spacing so the test proves the reported premise before implementation.
- [x] **Step 2: Apply the shared CSS fix**
  - Add the root bottom-safe-area variable.
  - Add the mobile transcript bottom-padding override and replace the mobile composer bottom-padding formula.
  - Add the narrow-screen footer minimum-height override; do not hide the running-state footer.
- [x] **Step 3: Verify mobile and desktop behavior**
  - Repeat the 393 × 852 idle geometry check with a simulated 34px inset; require footer height `0px`, composer bottom padding `34px`, and transcript bottom padding `12px`.
  - Repeat with a running-state `.live-copy`; require the footer to remain visible and the composer to preserve the 34px safe-area padding.
  - Repeat at 768px with a zero inset; require the shortcut footer and existing desktop transcript/composer spacing to remain unchanged.
  - Build the focused web package and run the Impeccable detector once for `apps/web/src/index.css`.
  - Smoke-test the installed PWA on a notched iPhone in portrait: open an idle session, confirm the textarea sits directly above the home-indicator safe zone without the oversized blank band, then start a run and confirm the live-output status remains visible.
