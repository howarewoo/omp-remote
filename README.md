# OMP Remote

A phone-first PWA for supervising multiple [Oh My Pi](https://omp.sh) coding sessions from a private Tailnet. A loopback-only host daemon serves the dashboard, launches OMP RPC sessions, and accepts automatic registrations from ordinary terminal OMP sessions.

## Stack

| Layer | Choice | Version | Why |
| --- | --- | --- | --- |
| Runtime | Node.js LTS | `>=24.18.0` | Broad macOS/Linux service support and predictable process supervision |
| Package manager | pnpm | `11.17.0` | Deterministic workspace installs |
| Web | React + Vite | `19.2.8` + `8.1.5` | Small static PWA with no server-rendering requirement |
| PWA | `vite-plugin-pwa` | `1.3.0` | Installable shell and generated offline service worker |
| Host | Fastify + WebSocket | `5.10.0` + `11.3.0` | Long-lived local daemon with browser and extension sockets |
| Contracts | Zod | `4.4.3` | Runtime validation at every WebSocket and RPC boundary |
| OMP integration | OMP SDK + RPC | `17.1.8` | Native lifecycle events for existing sessions and RPC for dashboard-launched sessions |
| Workspace | Turborepo + TypeScript | `2.10.7` + `7.0.2` | Ordered builds across app, feature, and infrastructure slices |
| Private delivery | Tailscale Serve | Tailscale `1.98.9` verified | Tailnet HTTPS without exposing the daemon on a LAN or public interface |

No database or application login is used. This bootstrap targets one trusted user in one Tailnet; Tailscale membership is the access boundary.

## Architecture

```text
apps/web                         React PWA
apps/daemon                      Loopback Fastify host
packages/features/sessions       Session registry and dashboard
packages/infrastructure/protocol Shared Zod wire contracts
packages/infrastructure/omp-rpc  OMP JSONL RPC process client
packages/infrastructure/omp-extension
                                 Auto-registration extension and installer
packages/infrastructure/session-client
                                 Browser WebSocket client
packages/infrastructure/ui       Shared status presentation
packages/infrastructure/observability
                                 Structured host logging
```

The daemon exposes three local surfaces:

- `/` — the built PWA.
- `/ws` — origin-checked browser control and session updates.
- `/extension` — loopback-only OMP extension registration.

Dashboard-launched sessions run as isolated `omp --mode rpc --no-extensions` child processes. Existing terminal sessions are registered by the user extension and remain controlled by their original OMP process.

## Host setup

Prerequisites: OMP installed and authenticated, Node.js 24.18 or newer, pnpm 11.17.0, and a signed-in Tailscale client.

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm setup:extension
pnpm install:service
pnpm tailscale:serve
```

`setup:extension` copies the compiled extension to `${PI_CODING_AGENT_DIR:-~/.omp/agent}/extensions/omp-remote.js`. New OMP sessions then register automatically with `ws://127.0.0.1:4387/extension`.

`install:service` installs a user LaunchAgent on macOS or a user systemd service on Linux. Run it under the Node.js binary the service should retain.

`tailscale:serve` maps private Tailnet HTTPS to `http://127.0.0.1:4387`. On first use, Tailscale may print an admin URL that must be opened once to enable Serve for the Tailnet; rerun the command after approval.

The dashboard is then available at the HTTPS URL reported by `tailscale serve status`. Add that URL to the iOS or Android home screen to install the PWA.

## Development

```bash
pnpm dev
```

Unless `OMP_REMOTE_PORT` is already set, `pnpm dev` runs the development daemon on `127.0.0.1:4388`. The Vite app runs on `127.0.0.1:5173` and proxies `/api`, `/healthz`, `/ws`, and `/extension` to the daemon using `OMP_REMOTE_HOST` and `OMP_REMOTE_PORT`. The installed service and other production commands continue to default to port `4387`.

The default development endpoint is `OMP_REMOTE_EXTENSION_URL=ws://127.0.0.1:4388/extension`. Set it when starting terminal OMP sessions that should register with the development daemon instead of the installed service. If you override `OMP_REMOTE_HOST` or `OMP_REMOTE_PORT`, substitute the active host and port in this URL; enclose an IPv6 host in brackets, for example `ws://[::1]:4399/extension`.

Optional environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `OMP_REMOTE_HOST` | `127.0.0.1` | Daemon bind address; keep loopback for Tailscale Serve |
| `OMP_REMOTE_PORT` | `4387` | Daemon port; `pnpm dev` uses `4388` when unset |
| `OMP_REMOTE_ORIGIN` | local and `*.ts.net` origins | Exact browser origin override |
| `OMP_REMOTE_OMP_PATH` | `omp` | OMP executable used for RPC sessions |
| `OMP_REMOTE_EXTENSION_URL` | `ws://127.0.0.1:4387/extension` | Extension registration socket |

## Validation

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

CI runs the same checks on pushes and pull requests.
