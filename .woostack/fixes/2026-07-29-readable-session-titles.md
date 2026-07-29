---
type: fix
status: in-review
branch: fix/readable-session-titles
---

# Fix: Replace generated session filenames with readable titles

## 1. Root Cause

`SessionCatalog.readSessionMetadata` turns empty OMP title records and absent header titles into the JSONL filename stem. Root session filenames are generated as `${filesystemSafe(timestamp)}_${sessionId}`, so the daemon publishes that storage identifier as a non-null session name and the dashboard's readable fallbacks never run.

Inspection of 7,100 real session files found that 6,827 had empty title records and no usable header title. Every top-level filename used the generated timestamp-and-ID form, while nested agent filenames such as `SessionTitleDebug.jsonl` remained meaningful. The fallback must therefore distinguish the exact generated root filename from custom or nested names rather than replacing every filename-derived title.

## 2. Proposed Fix

Keep session-title precedence centralized in `apps/daemon/src/session-catalog.ts`:

1. Use the trimmed mutable title record when present.
2. Otherwise use the trimmed session-header title.
3. Otherwise preserve a meaningful filename stem.
4. When the stem exactly equals the generated value derived from a valid header timestamp and ID, use the final segment of `cwd`.
5. Return `null` when the generated stem has no readable cwd segment so the dashboard can show its existing `Untitled session` fallback.

Compare against the exact generated stem rather than a broad timestamp regular expression. This preserves intentionally timestamp-like custom filenames and existing nested-agent labels. Do not derive titles from transcript text: most affected sessions have no user message, and metadata-only title resolution should remain bounded and deterministic.

Derive the expected generated stem only when the header timestamp is a valid string or number; a missing or invalid timestamp keeps the filename stem unchanged. The change does not alter the `Session` schema, transport contract, catalog search fields, or persistence. Catalog entries are rebuilt on daemon startup, so no migration or cache invalidation is required.

## 3. Implementation Plan

- [x] **Step 1: Reproduce with a failing test**
  - Add a catalog fixture with an empty title, no header title, a generated timestamp-and-ID filename, and `cwd: /workspace/alpha`.
  - Assert that its session name is `alpha`, not the generated filename stem.
  - Retain the existing nested `ResearchAgent.jsonl` assertion to prove meaningful filenames still win.
- [x] **Step 2: Apply the minimal fix**
  - Change the shared catalog fallback to receive the validated header ID and cwd plus the raw header timestamp.
  - Derive the exact generated stem only from a valid timestamp, compare it with the actual filename stem, and replace a match with the cwd leaf or `null`.
  - Preserve mutable-title, header-title, meaningful custom filename, and invalid-timestamp behavior.
- [x] **Step 3: Verification**
  - Run the focused daemon catalog test and confirm the new case fails before the fix and passes afterward.
  - Run daemon typechecking, the workspace test suite, and lint.
  - Exercise the catalog against representative generated and nested session fixtures and confirm readable names without nested-agent regressions.
