---
name: omp-upgrade
description: Check OMP changelogs from the last supported version, track audit checkpoints across multiple releases, identify breaking changes and new capabilities across RPC, Extension, Protocol, and UI layers, update omp-remote, and automatically create pull requests to address breaking changes.
metadata:
  priority: 6
  docs:
    - "https://github.com/can1357/oh-my-pi/releases"
    - "https://omp.sh"
  pathPatterns:
    - 'pnpm-workspace.yaml'
    - 'package.json'
    - 'README.md'
    - '.omp/changelog-state.json'
    - 'packages/infrastructure/omp-extension/**/*'
    - 'packages/infrastructure/omp-rpc/**/*'
    - 'packages/infrastructure/protocol/**/*'
    - 'apps/daemon/**/*'
    - 'packages/features/sessions/**/*'
  bashPatterns:
    - '\bomp\s+--version\b'
    - '\bnode\s+scripts/check-omp-changelog\.mjs\b'
    - '\bpnpm\s+run\s+check:omp\b'
    - '\bpnpm\s+run\s+upgrade:omp\b'
  promptSignals:
    phrases:
      - "check omp changelog"
      - "upgrade omp"
      - "update omp-remote"
      - "check omp breaking changes"
      - "omp version upgrade"
      - "sync with omp"
      - "check omp releases"
      - "support new omp version"
      - "track omp changelog"
      - "create upgrade pr"
      - "create pr for omp upgrade"
    allOf:
      - [omp, changelog]
      - [omp, upgrade]
      - [omp, remote, breaking]
    anyOf:
      - "breaking changes"
      - "changelog"
      - "omp version"
      - "release notes"
      - "update omp-remote"
      - "create pr"
      - "upgrade pr"
    noneOf: []
    minScore: 6
retrieval:
  aliases:
    - omp upgrade
    - omp remote update
    - check omp changelog
    - omp breaking changes
    - update omp support
    - create omp upgrade pr
  intents:
    - check OMP changelogs from the last supported version
    - detect breaking changes in new OMP releases
    - track changelog audit checkpoints across multiple releases
    - upgrade omp-remote dependencies to match OMP version
    - automatically create pull requests to address breaking changes
    - verify OMP extension and RPC protocol compatibility
  entities:
    - omp
    - oh-my-pi
    - changelog
    - breaking changes
    - changelog-state
    - pull request
    - omp-extension
    - omp-rpc
    - protocol
    - upgrade
---

# OMP Upgrade & Compatibility Guide

Check OMP changelogs from the current supported version, track checkpoints across multiple releases, identify breaking changes across all layers of `omp-remote`, apply necessary updates, and automatically create pull requests to address breaking changes.

## Architecture Context

`omp-remote` supervises OMP sessions across two primary integration vectors:

1. **OMP Extension (`@omp-remote/omp-extension`)**:
   Runs inside the terminal `omp` process. Hooks into lifecycle events (`session_start`, `turn_end`, `message_update`, `tool_call_start`, `ask_request`, `tool_approval_requested`), resolves model options and skill commands via `ctx.models`, and publishes live state to the daemon via WebSocket.
2. **OMP RPC Process Client (`@omp-remote/omp-rpc`)**:
   Spawns and manages headless `omp --mode rpc` / `omp --mode rpc-ui` sessions. Sends commands (`prompt`, `steer`, `follow_up`, `get_state`, `set_model`, `set_thinking`, `set_fast_mode`, `ask_response`) and decodes streaming JSONL responses.

---

## State Tracking & Multi-Version History

The repository tracks when the changelog was last checked and the version checkpoint in **`.omp/changelog-state.json`**:

```json
{
  "lastCheckedVersion": "17.3.4",
  "lastCheckedAt": "2026-08-15T12:00:00.000Z",
  "baseSupportedVersion": "17.1.8",
  "history": [
    {
      "checkedAt": "2026-08-15T12:00:00.000Z",
      "fromVersion": "17.1.8",
      "toVersion": "17.3.4",
      "releaseCount": 21,
      "breakingChangeCount": 16
    }
  ]
}
```

### Multi-Version Workflow
1. **Incremental audits**: Running `pnpm run check:omp` automatically starts from `lastCheckedVersion` (or the catalog version on initial run) and evaluates newly published releases up to the latest installed CLI or GitHub tag.
2. **Checkpoint saving**: Each run updates `lastCheckedVersion`, `lastCheckedAt`, and records a history entry into `.omp/changelog-state.json` (use `--no-save` for read-only / dry-run checks).
3. **Full re-audits**: Use `--from-catalog` or `--from <version>` to audit all versions since the repository's base supported version rather than the incremental checkpoint.

---

## Automated Upgrade & PR Creation

The skill can automatically apply version updates and create a pull request on GitHub / Graphite:

```bash
# 1. Preview upgrade changes and PR metadata without mutating repository (dry-run)
node scripts/check-omp-changelog.mjs --create-pr --dry-run

# 2. Execute automated upgrade and create PR
pnpm run upgrade:omp

# Or create PR targeting a specific version
node scripts/check-omp-changelog.mjs --to 17.3.4 --create-pr
```

### What Automated Upgrade Performs:
1. **Audits Releases & Breaking Changes**: Fetches releases from GitHub and evaluates subsystem disruptions.
2. **Updates Workspace Files**:
   - Updates `@oh-my-pi/pi-coding-agent` under `catalog:` in `pnpm-workspace.yaml`.
   - Updates `@oh-my-pi/*` entries in `minimumReleaseAgeExclude` in `pnpm-workspace.yaml`.
   - Updates `README.md` Stack table OMP integration version.
3. **Records Checkpoint State**: Updates `.omp/changelog-state.json` with target version, timestamp, and audit summary.
4. **Creates Task Branch**: Creates `upgrade-omp-to-v<version>` branch via Graphite (`gt create`) or Git (`git checkout -b`).
5. **Submits Pull Request**: Submits PR via Graphite (`gt submit`) or GitHub CLI (`gh pr create`) with a structured Goal, Summary, Breaking Changes Addressed, Affected Subsystems, and Test Plan.

---

## Manual / Guided Upgrade Workflow

Follow these steps when manually reviewing changelogs or resolving complex code breaking changes:

### Step 1: Detect Base and Target Versions

1. **Base (checkpoint) version**: Resolved from `.omp/changelog-state.json` (or `pnpm-workspace.yaml` `catalog:` if unrecorded or `--from-catalog` is passed).
2. **Target version**:
   - If user specified a version or version range, use that (`--to <version>`).
   - Otherwise, detect the installed OMP CLI version (`omp --version`).
   - Or query the latest release tag from GitHub (`https://api.github.com/repos/can1357/oh-my-pi/releases`).

### Step 2: Run the OMP Changelog Audit Tool

Run the automated changelog checker:

```bash
# Check from last checked version to installed/latest version and update state checkpoint
pnpm run check:omp

# Re-audit entire range from workspace catalog version (17.1.8)
node scripts/check-omp-changelog.mjs --from-catalog

# Or check a specific custom range
node scripts/check-omp-changelog.mjs --from 17.1.8 --to 17.3.4

# Read-only check without updating state file
node scripts/check-omp-changelog.mjs --no-save

# Output structured JSON report
node scripts/check-omp-changelog.mjs --json
```

The tool parses GitHub releases between the two versions, isolates all `### Breaking Changes`, and categorizes impacts across `omp-remote` subsystems.

### Step 3: Subsystem Compatibility Review

Review the audit report against each `omp-remote` subsystem:

#### 1. OMP Extension (`packages/infrastructure/omp-extension/`)
- **Schema & Zod compatibility**: In OMP 17.2.10, `@oh-my-pi/pi-coding-agent` replaced direct `zod` re-exports with an `omptype`-backed compatibility facade (`@oh-my-pi/omptype/zod`). Ensure `extension.ts` uses `pi.zod` or workspace `zod` without relying on deprecated internal symbols.
- **Extension API & Context**:
  - Check `ctx.models.resolve()` / `ctx.models.list()` / `ctx.models.current()`.
  - Check dialog handlers (`ctx.ui`, `ExtensionAskDialogQuestion`, `ExtensionAskDialogResult`).
  - Check lifecycle event signatures (`session_start`, `session_stop`, `tool_approval_requested`, `mcp_notification`).
- **Build bundle**: Ensure `pnpm --filter @omp-remote/omp-extension build` produces a self-contained `dist/extension.js` that installs into `~/.omp/agent/extensions/omp-remote.js`.

#### 2. OMP RPC Client & Daemon (`packages/infrastructure/omp-rpc/`, `apps/daemon/`)
- **CLI flags & RPC mode**: Verify `omp --mode rpc` and `omp --mode rpc-ui` command-line flags.
- **RPC frame format**: Check JSONL request/response frames and chunked message handling (`chunkId`, `count`, `parts`).
- **Commands & State**:
  - `get_state`: Check response fields (e.g. `fastModeEnabled`, `fastModeActive`, token throughput).
  - `set_fast_mode`: Live fast-mode control commands.
  - `set_thinking` / `set_model`: Check supported thinking levels (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `auto`) and model role syntax (`@smol`, `@slow`, `@plan`, `@fast`, `@vibe`).
  - `ask_response`: Handle both single-select and multi-select question responses.

#### 3. Protocol & Normalizers (`packages/infrastructure/protocol/`, `apps/daemon/src/message-normalizer.ts`)
- **Hashline Patch Syntax**:
  - Hashline operations: `PUT`, `CUT`, `MV`, `REM`, and named register pastes (`PUT N.=M @name`).
  - Line anchor format: `N.=M` inclusive ranges.
- **Built-in Tool Arguments & Output**:
  - `read`: Support `:raw:N+K` and PDF document capture.
  - `edit`: Handle single-edit vs multi-edit schemas.
  - `task`: Subagent schema fields (`name`, `task`, `agent` vs legacy `id`, `assignment`, `role`).
  - `ask`: Rich interactive question schemas with tabs, option previews, notes, multi-select.
  - `think`: External thinking tool output (`think` blocks).
  - `browser`: Screenshot paths and relay mode.
- **Snapcompact & Compaction**: Compacted transcript scopes (`¶user:`, `¶think:`, `¶ai:`, `¶call:`).

#### 4. Workspace Catalogs & Exclusions (`pnpm-workspace.yaml`, `README.md`)
- Update all `@oh-my-pi/*` entries in `pnpm-workspace.yaml`:
  - `catalog:`: `@oh-my-pi/pi-coding-agent: <new-version>`
  - `minimumReleaseAgeExclude:`: Update `@oh-my-pi/*@<version>` entries.
- Update `README.md` Stack table row for `OMP integration`.

### Step 4: Verification Pipeline

Always run the full verification pipeline after making updates:

```bash
# 1. Typecheck all workspace packages
pnpm run typecheck

# 2. Check formatting and linters
pnpm run format:check
pnpm run lint
pnpm run lint:lines

# 3. Run complete unit and integration test suite
pnpm test

# 4. Verify extension bundling and user installation test
pnpm --filter @omp-remote/omp-extension test
```

---

## Known OMP Version Milestones

| Version | Key Changes & Potential Impacts |
|---|---|
| **v17.2.0** | Hashline removed `DEL`/`COPY` in favor of `CUT`/`PASTE`. Added `set_fast_mode` and token throughput in RPC `get_state`. Added `mcp_notification` extension event. Added `ExtensionContext.getAsyncJobSnapshot()`. |
| **v17.2.2** | Hashline unified `SWAP`/`INS` under `PUT`/`CUT` grammar and `.=` range syntax. Added `ctx.invokeTool()`. Dynamic `ctx.cwd` tracking. |
| **v17.2.5** | Computer tool converted to scriptable sessions. Edit tool replace mode changed to single-edit schema. `normalizeTools` options object. Added browser relay mode. |
| **v17.2.7** | Replaced `arktype` with `@oh-my-pi/omptype` for schema validation. |
| **v17.2.10** | Replaced re-exported `zod` API with `omptype`-backed compatibility facade (`@oh-my-pi/omptype/zod`). Added `--trusted-extension` CLI flag. |
| **v17.2.12** | Hashline `PUT N.=M @name` span paste throws on uncaptured register. Tree-sitter boundary repair. |
| **v17.2.14** | Added `externalThinking` setting and `think` tool. |
| **v17.3.0** | Renamed `withGeminiThinkingLoopGuard` to `withThinkingLoopGuard`. Removed global `advisor.subagents` setting in favor of `task.agentAdvisor`. Added OpenAI Daybreak and GPT-5.6 Cyber models. |
| **v17.3.2** | Hashline headers retain workspace-relative paths (`[src/foo.ts#1234]`). Gemini 3.7 Flash discovery. |
| **v17.3.4** | Restored PDF document page rendering via Chromium browser tool. |

---

## References

- [Breaking Changes Checklist](references/breaking-changes-checklist.md)
- [RPC & Extension Contracts](references/rpc-and-extension-contracts.md)
