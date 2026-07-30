---
type: fix
status: in-review
branch: fix/mobile-tool-call-padding
---

# Fix: Preserve transcript tool-call padding on mobile

## 1. Root Cause

At viewport widths of 760px or less, the later mobile rule `.transcript-entry { padding: 0.9rem 0; }` in `apps/web/src/index.css` has the same specificity as the earlier `.transcript-tool, .transcript-system { padding: 0.75rem; }` rule and wins by source order. The shorthand preserves the intended mobile block spacing but resets both inline sides to zero.

`TranscriptEntry` renders tool and collapsible system disclosures inside the affected `<article class="transcript-entry transcript-tool|transcript-system">`. The nested `<details>` and `<summary>` intentionally have no padding, so the article's lost inset is directly visible around the disclosure.

A Chromium computed-style reproduction using the repository's complete stylesheet and the production article/details/summary structure measured tool and system articles at `14.4px 0px 14.4px 0px` at 760px. With only the mobile rule disabled, both measured `12px` on every side. Ordinary transcript entries are intended to remain flush inline on mobile.

## 2. Proposed Fix

Replace the mobile `.transcript-entry` padding shorthand with `padding-block: 0.9rem`. This preserves the mobile vertical rhythm without resetting role-specific inline padding. Tool and system articles retain their established `0.75rem` inset; ordinary transcript entries retain their existing zero inline padding.

Do not add padding to `<details>` or `<summary>`. That would patch the symptom at the wrong DOM layer and duplicate spacing when the outer role container already supplies it. Do not add browser-test dependencies for this one-property regression; the repository has no browser-test harness, so use a concrete Chromium computed-style reproduction as the TDD verification command.

## 3. Implementation Plan

- [x] **Step 1: Reproduce with a failing browser check**
  - Load the complete `apps/web/src/index.css` in Chromium against the production tool, collapsible-system, and ordinary transcript-entry DOM shapes.
  - At 760px, assert tool and system article `padding-inline-start` and `padding-inline-end` equal `12px`, while an ordinary transcript entry remains `0px`; record the pre-fix tool/system failure (`0px`).
  - At 761px, assert tool and system articles remain `12px` inline to pin the breakpoint boundary.
- [x] **Step 2: Apply the minimal fix**
  - In the existing `@media (max-width: 760px)` rule in `apps/web/src/index.css`, replace `.transcript-entry { padding: 0.9rem 0; }` with `padding-block: 0.9rem`.
  - Leave disclosure markup, role-container spacing, and all other responsive rules unchanged.
- [x] **Step 3: Verification**
  - Re-run the Chromium computed-style check at 760px and 761px; confirm tool and system inline padding is `12px`, ordinary entries remain `0px`, and mobile block padding remains `14.4px`.
  - Run the focused web checks: `pnpm --filter @omp-remote/web test` and `pnpm --filter @omp-remote/web typecheck`.
  - Run the Impeccable detector once against `apps/web/src/index.css` after the UI change.
