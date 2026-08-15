# OMP Remote Breaking Changes Checklist

When auditing OMP changelogs and upgrading `omp-remote`, systematically check each item on this checklist.

## 1. Extension API & Lifecycle Events

- [ ] **Import Paths & Re-exports**:
  - `@oh-my-pi/pi-coding-agent`: Check that exported types (`ExtensionAPI`, `ExtensionContext`, `ExtensionAskDialogQuestion`, `ExtensionAskDialogResult`) match the imported signatures.
  - Zod / Type validation: Ensure schema definitions use `pi.zod` or `@omp-remote/protocol` without relying on internal OMP package paths.
- [ ] **Extension Lifecycle Events**:
  - `session_start` / `session_stop`
  - `message_update` / `message_append`
  - `tool_call_start` / `tool_call_end` / `tool_approval_requested`
  - `turn_start` / `turn_end`
  - `mcp_notification`
- [ ] **UI & Dialog Integration**:
  - `ctx.ui.ask()` / `ctx.ui.askQuestion()` signature changes.
  - Multi-select question schema support (`multi: true` with string array responses).
  - Previews, descriptions, headers, and tabs on ask dialogs.
- [ ] **Model & Role Resolution**:
  - `ctx.models.resolve()` returns model object with provider, id, context tokens, output tokens.
  - Role identifiers (`@smol`, `@slow`, `@plan`, `@fast`, `@vibe`).
  - Thinking level support (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `auto`).
- [ ] **Extension Bundling & Installation**:
  - Verify `tsup` bundles `@omp-remote/omp-extension` into a single standalone CommonJS/ESM module without unbundled workspace dependencies.
  - Verify user installer (`install.ts`) copies the bundle to `~/.omp/agent/extensions/omp-remote.js`.

---

## 2. RPC Protocol & Process Client

- [ ] **CLI Mode Flags**:
  - Verify `omp --mode rpc` / `omp --mode rpc-ui` / `--trusted-extension` argument syntax.
- [ ] **RPC Wire Protocol**:
  - JSONL message framing (single frame per line, max length limits).
  - Chunked message reassembly (`chunkId`, `count`, `parts`).
  - Sequence numbers and response matching (`id`, `requestId`).
- [ ] **Command Schemas**:
  - `prompt`: `{ text, attachments, model, thinking }`
  - `steer`: Interrupt or steer current turn with user input.
  - `follow_up`: Queue subsequent turn instruction.
  - `get_state`: State response schema (`status`, `model`, `thinking`, `fastMode`, token metrics).
  - `set_model` / `set_thinking` / `set_fast_mode`.
  - `ask_response`: `{ id, response }` answering interactive ask prompts.
- [ ] **Process Lifecycle & Signals**:
  - Child process exit codes, stderr captures, and graceful shutdown handling.

---

## 3. Protocol & Normalizers

- [ ] **Hashline Patch Syntax**:
  - Validate parser handles `PUT N.=M:`, `PUT <N:`, `PUT >N:`, `PUT N*:`, `CUT N.=M`, `MV DEST`, `REM`.
  - Line anchor format: `[file#TAG]` headers with workspace-relative paths.
  - Named register syntax: `PUT N.=M @register` / `CUT N.=M @register`.
- [ ] **Tool Call Normalizers**:
  - `read`: Path resolution, inline selectors (`:50-200`, `:raw:50+20`), PDF extractions.
  - `write`: File overwrite and binary/base64 handling.
  - `edit`: Patch language validation and diff rendering.
  - `bash` / `eval`: Multi-command output capture and exit code extraction.
  - `task`: Subagent delegations (`tasks[]` array with `name`, `task`, `agent`, `outputSchema`).
  - `ask`: Questions with option labels, descriptions, and previews.
  - `browser`: Actions (`open`, `run`, `close`), screenshots, and relay mode.
  - `think`: Thinking blocks and external thinking tool output.
- [ ] **Transcript Scopes**:
  - Compacted scopes: `¶user:`, `¶think:`, `¶ai:`, `¶call:`, `¶ask:`.

---

## 4. Daemon & Session Catalog

- [ ] **Session Discovery & Metadata**:
  - Read session records from `~/.omp/agent/sessions/` and `~/.omp/agent/stats.db`.
  - Parse session timestamps, parent session relationships, model usage, and token costs.
- [ ] **Git Branch & Worktree Runtime**:
  - Active git branch detection and branch switching inside session working directories.
- [ ] **File Changes Ledger**:
  - Compute cumulative mutations from session history without inspecting local worktree diffs.

---

## 5. Workspace Configuration

- [ ] **`pnpm-workspace.yaml`**:
  - Update `catalog:` entry for `@oh-my-pi/pi-coding-agent`.
  - Update `minimumReleaseAgeExclude:` list for all `@oh-my-pi/*` packages.
- [ ] **`README.md`**:
  - Update the Stack table row for `OMP integration` to match the new version.
