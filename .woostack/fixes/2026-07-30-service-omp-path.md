---
type: fix
status: executing
branch: fix/service-omp-path
---

# Fix: Restore web-launched session creation

## 1. Root Cause

The installed background daemon cannot resolve the OMP executable. The web launch flow reaches the daemon correctly, but `RpcSession.start()` receives the default `OMP_REMOTE_OMP_PATH` value `omp`, and the service process has neither `OMP_REMOTE_OMP_PATH` nor the installer shell's `PATH`.

This is reproduced end to end on the installed macOS service: submitting `/Users/adamwoo/Documents/GitHub/omp-remote` through **New session** leaves the launch dialog open with `spawn omp ENOENT`, while `/Users/adamwoo/Library/Logs/OMP Remote/daemon.error.log` records the same failure at lines 55–56. The interactive installation environment resolves OMP at `/opt/homebrew/bin/omp`, but the generated launchd plist at `/Users/adamwoo/Library/LaunchAgents/com.omp-remote.daemon.plist` defines only `NODE_ENV`. `scripts/install-service.mjs` has the same omission in its macOS launchd and Linux systemd templates.

The broken boundary is service installation, not the dashboard command, WebSocket protocol, or RPC response handling. The daemon already propagates the spawn error to the browser.

## 2. Proposed Fix

Preserve the installation environment's executable search path in both generated service definitions. Refactor the service template rendering into exported pure functions in `scripts/install-service.mjs` so both platform outputs can be tested without installing or restarting a real service. Escape the injected path for launchd XML and systemd environment syntax, while keeping `OMP_REMOTE_OMP_PATH` as the existing explicit override. Fail installation with an actionable error if PATH is absent rather than installing a service that cannot resolve OMP.

Add a focused installer test that proves a PATH containing the OMP directory is present in both service definitions, register that test in the root test command, and leave the daemon, WebSocket, and UI contracts unchanged.

## 3. Implementation Plan

- [x] **Step 1: Reproduce with a failing test**
  - Add `scripts/install-service.test.mjs` covering the launchd plist and systemd unit rendered with an installation PATH containing a non-system OMP directory.
  - Assert each service definition preserves that PATH using its platform-native environment syntax and safely escapes special characters.
  - Assert installation rejects a missing PATH instead of writing a known-broken service definition.
  - Add the installer test to the root `test` script and confirm it fails against the current templates.
- [x] **Step 2: Apply the minimal fix**
  - Extract pure launchd and systemd template renderers from `scripts/install-service.mjs` without changing installation behavior.
  - Include the installer process's PATH in both generated service environments, with correct launchd XML and systemd quoting.
  - Validate PATH before writing either service definition and report why installation cannot continue when it is absent.
  - Keep `OMP_REMOTE_OMP_PATH` behavior and all browser/daemon protocol code unchanged.
- [x] **Step 3: Verification**
  - Run the focused installer test and the existing setup script tests.
  - Build the workspace.
  - Start an isolated daemon from the worktree with a service-equivalent PATH, submit **New session** through the browser, and verify the launch resolves successfully instead of returning `spawn omp ENOENT`.
