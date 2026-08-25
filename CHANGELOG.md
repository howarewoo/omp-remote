# Changelog

All notable changes to OMP Remote are recorded here. The project is pre-1.0 and supported on a best-effort basis; minor releases may change compatibility.

## Unreleased

### Changed

- No changes yet.

## 0.1.0 - 2026-08-22

### Added

- Phone-first installable dashboard for supervising multiple OMP sessions over a private Tailnet.
- Loopback-only host daemon with Tailscale Serve HTTPS delivery.
- Automatic registration of ordinary terminal OMP sessions through a user extension.
- Dashboard creation and control of parallel OMP RPC sessions, including transcript reconnect, prompts, steering, aborts, model and effort controls, and supported `ask` responses.
- Saved working directories, Git branch visibility and switching for eligible sessions, application-error reporting, and responsive desktop/mobile views.
- Per-device best-effort Web Push alerts for input-required and session-idle events, with locally stored subscriptions and VAPID keys.
- macOS launchd and Linux systemd user-service installation through the idempotent setup command.
- Operator guidance for installation, upgrade, recovery, troubleshooting, privacy, Tailscale teardown, and safe manual uninstall.

[Unreleased]: https://github.com/howarewoo/omp-remote/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/howarewoo/omp-remote/releases/tag/v0.1.0
