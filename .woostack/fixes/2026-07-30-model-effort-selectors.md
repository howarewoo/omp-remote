---
type: fix
status: in-review
branch: fix/model-effort-selectors
---

# Fix: Make model and effort independently selectable

## 1. Root Cause

The session-info model control is a native disabled button whenever either the session omits the `model` capability or `availableModels` is absent/empty. A disabled button suppresses its click handler, while `.session-model-trigger:disabled` deliberately keeps full opacity, so the control looks actionable but tapping it does nothing.

The failure is reproduced in the running dashboard: the selected extension session renders `.session-model-trigger[disabled]`; its live WebSocket snapshot reports model `openai-codex/gpt-5.6-sol` but only `prompt`, `steer`, `follow_up`, `abort`, and `resume` capabilities and no `availableModels`. The installed extension now publishes `model`, `effort`, and `availableModels`, which proves this specific session loaded an older extension implementation and cannot safely accept model commands until restarted. The UI still needs a responsive, truthful failure state instead of a silent no-op.

The combined control also couples two independent choices. The user explicitly requested separate model and effort selectors, with the model selector opening a drawer containing the available model list.

## 2. Proposed Fix

- Replace the combined model-and-effort metadata button with independent `Model` and `Effort` selector cells while preserving `Context` and `Updated` metadata.
- Give each selector its own controlled Base UI drawer: the model drawer lists models and the effort drawer lists the current model's supported effort levels.
- Keep selector triggers tappable even when the live session lacks the newly published catalog. Open the appropriate drawer and render an explicit restart/resume-required empty state instead of silently suppressing the click. Never send `set_model` or `set_effort` when the corresponding capability or option is unavailable.
- Allow at most one selector drawer to be open. Share the existing configuration request state so an in-flight model or effort update disables both option lists and prevents dismissal until the request settles; surface the existing actionable error in the drawer that initiated the request.
- Do not invent a cross-session model catalog or send commands to an older extension: model availability and authentication are session-specific, and stale extensions do not implement the command contract.
- Treat a model change and its resulting effort catalog as server-authoritative. Do not infer a default effort or issue a second command; wait for the session patch, then derive the effort selector from the updated current model.

## 3. Implementation Plan

- [x] **Step 1: Reproduce with failing component tests**
  - Add a dashboard test proving a model trigger opens its drawer for a session with the model capability and populated model options.
  - Add coverage proving a stale live session without model metadata opens a truthful unavailable state rather than rendering a disabled no-op.
  - Add coverage proving model and effort are exposed as separate selectors, only one drawer opens at a time, and selecting an effort invokes only `onSetEffort`.
- [x] **Step 2: Apply the minimal UI fix**
  - Split the combined metadata trigger and combined drawer state in `dashboard.tsx` into independent model and effort selectors using the existing shadcn/Base UI primitives.
  - Render session-scoped option lists when supported and restart/resume guidance when capability data is unavailable.
  - Adjust existing metadata and drawer CSS for four narrow mobile-first cells and separate drawer bodies without changing the rest of the dashboard visual language.
  - Reuse the existing `Session`, `Effort`, `Button`, and `Drawer` types/components; add no dependency or parallel selector abstraction.
- [x] **Step 3: Verification**
  - Run the sessions component test file and package typecheck.
  - Start the current web app, exercise both selectors in a mobile viewport, confirm the model list drawer and effort drawer independently open, and confirm the stale-session fallback is visible and non-destructive.
  - Run the Impeccable mechanical detector once over the changed TSX and CSS targets.
