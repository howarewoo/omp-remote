---
type: fix
status: hardened
branch: fix/edit-tool-diff-colors
---

# Fix: Preserve OMP edit diffs in the remote transcript

## 1. Root Cause

OMP emits completed edits as structured `toolResult` messages. The human-readable `content` is only a snapshot of the edit call; the canonical numbered diff is stored in `details.diff` and the renderer identity is stored in `toolName`.

All three remote ingress paths flatten that structure before it reaches the web renderer:

- `packages/infrastructure/omp-extension/src/extension.ts` keeps only text content and maps unknown roles, including `toolResult`, to `system`.
- `apps/daemon/src/index.ts` repeats the same flattening for RPC messages.
- `apps/daemon/src/session-catalog.ts` repeats it for persisted transcripts.
- `packages/infrastructure/protocol/src/index.ts` has no presentation discriminator or tool identity fields with which to preserve the structured result.

A read-only probe of a persisted edit result confirmed `role: "toolResult"`, `toolName: "edit"`, snapshot text in `content`, and the real `-<line>|...` / `+<line>|...` diff in `details.diff`. The current normalizers deterministically discard the latter fields and emit a generic system message. `SystemTranscriptText` then renders the surviving snapshot as collapsed gray prose.

The CSS palette is already correct: `--omp-red: #fc3a4b` and `--omp-green: #89d281` match OMP's dark theme, and `.diff-removed` / `.diff-added` use those tokens. The defect is loss of structured diff data, not incorrect color values. The focused sessions renderer suite passes because it covers only diff text already supplied to `parseTranscriptBlocks`; it does not cover OMP edit-result ingestion.

Compatibility constraint: installed extensions can lag the daemon. New structured fields must be backward-compatible and legacy transcript frames must still normalize to ordinary text.
An already installed extension cannot recover the discarded fields. Live terminal-session verification therefore requires rebuilding, reinstalling with `pnpm setup:extension`, and starting a new OMP session; a lagging extension remains supported but continues to emit legacy text-only frames.

## 2. Proposed Fix

Preserve the semantic presentation at ingress instead of trying to infer edit diffs from generic system prose:

1. Extend `TranscriptMessageSchema` with backward-compatible structured presentation metadata and optional `toolName`. Legacy frames default to text presentation; canonical state remains strict after parsing.
2. Normalize `toolResult` to protocol role `tool` in extension, RPC, and history ingestion. For successful `toolName: "edit"` results with a string `details.diff`, use that canonical diff as the payload and mark it as diff presentation. Keep error text and non-edit tool results as text.
3. Extract the duplicated daemon RPC/history normalization into one pure, testable module. Keep the installed extension's normalizer local because it is deployed independently and may outlive the daemon protocol version.
4. Route diff presentation directly through the existing `classifyDiffLine` rendering path so OMP's numbered `-<line>|...` and `+<line>|...` rows receive the existing `.diff-removed` and `.diff-added` colors. Do not change the palette or infer diffs from arbitrary prose.
5. Preserve presentation metadata through registry and client streaming replacement. Display the preserved tool name in the transcript author label when present.

No new dependency, migration, logging, or CSS token is required.

## 3. Implementation Plan

- [ ] **Step 1: Reproduce with failing contract and ingress tests**
  - In `packages/infrastructure/protocol/src/index.test.ts`, prove a structured edit-diff transcript message parses while a legacy text-only frame defaults to text presentation.
  - Add a pure extension-normalizer test using `{ role: "toolResult", toolName: "edit", content: [snapshot text], details: { diff: "-1|before\n+1|after" } }`; require role `tool`, canonical diff payload, diff presentation, tool identity, and the supplied streaming state.
  - Add daemon normalizer coverage with the same fixture for RPC input, plus `apps/daemon/src/session-catalog.test.ts` coverage proving persisted history uses `details.diff` rather than snapshot content.
  - Extend registry and session-client replacement tests to prove tool presentation metadata survives streaming updates.
  - In `packages/features/sessions/src/components/dashboard.test.ts`, require the canonical numbered diff to render `diff-removed` before `diff-added` and the tool author label to use `edit`.

- [ ] **Step 2: Apply the minimal shared-root fix**
  - Add the backward-compatible presentation discriminator and optional tool identity to the protocol schema.
  - Extract and use one daemon raw-message normalizer for RPC and history; preserve existing ID, timestamp, empty-message, and history-truncation behavior.
  - Extract the extension's pure normalizer without adding a runtime dependency on the independently deployed protocol package; emit the new fields while retaining old-frame compatibility at daemon ingress.
  - Render structured diff presentation through the existing diff component/classifier and use `toolName` for the author label. Leave existing prose parsing and CSS colors unchanged.
  - Keep unsuccessful edits and edit results without a string `details.diff` as text so error output is never hidden or misclassified.

- [ ] **Step 3: Verification**
  - Run focused tests for protocol, extension, daemon, session client, session registry, and sessions renderer packages.
  - Run the affected package typechecks and the web production build.
  - Smoke-test a transcript fixture containing a structured OMP edit result and verify the rendered tool block is labeled `edit`, remains visible as a tool block, and shows removed rows red and added rows green.
  - Confirm a legacy text-only frame and an errored edit result still render as text.
  - For the live-extension path, rebuild and reinstall the extension, start a new OMP session, and confirm its edit result carries the same structured presentation; do not require old installed extensions to synthesize data they discarded.
