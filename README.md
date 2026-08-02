# OMP Remote

A phone-first PWA for supervising multiple [Oh My Pi](https://omp.sh) coding sessions from a private Tailnet. A loopback-only host daemon serves the dashboard, launches OMP RPC sessions, and accepts automatic registrations from ordinary terminal OMP sessions.

## Comparison with OMP mobile options

OMP support is called out explicitly; tools limited to the upstream Pi Coding Agent are intentionally excluded.

| Solution | OMP integration | Phone interface | Existing terminal sessions | New and parallel sessions | Remote access |
| --- | --- | --- | --- | --- | --- |
| **OMP Remote** | Direct OMP SDK and RPC integration, including `ask` responses | Installable PWA | Automatically registers ordinary terminal OMP sessions through an extension | Launch and supervise multiple OMP RPC sessions | Loopback-only daemon served privately through Tailscale; no public application endpoint |
| [Harness Remote](https://github.com/giuliastro/harness-remote) | Included HTTP/SSE bridge launches `omp acp` | Installable PWA and Android APK | Reads transcript history from sessions created by other OMP processes without modifying OMP state | Create, browse, prompt, stop, and switch models across sessions and saved servers | Loopback by default; non-loopback LAN or VPN access requires Basic Auth |
| [Agent of Empires](https://github.com/agent-of-empires/agent-of-empires) | OMP through a structured ACP view or raw tmux terminal | Installable PWA with mobile plan panels, tool cards, and swipe approval | Persists and reattaches AoE-managed OMP sessions in tmux | Create and manage parallel sessions with optional worktrees and sandboxes | Built-in Tailscale Funnel or Cloudflare Tunnel with QR and passphrase access |
| [Happy](https://github.com/slopus/happy) | No native OMP integration; the CLI wraps Claude Code and Codex | Native iOS and Android apps plus a web app | Does not attach arbitrary terminal sessions; sessions must be started through the Happy CLI | Start, monitor, and steer multiple Happy-wrapped Claude Code or Codex sessions | End-to-end encrypted hosted relay, with a self-hosting option |
| [SSH + tmux](https://github.com/tmux/tmux/wiki) | Raw OMP terminal | Mobile SSH client | Reattaches the exact terminal session | Manually create and manage tmux sessions or windows | User-managed SSH, firewall, and optional private VPN |

Capabilities reflect the linked projects' public documentation and may change.

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

Dashboard-launched sessions run as isolated `omp --mode rpc-ui` child processes. When OMP needs input through the `ask` tool, the dashboard presents the question and returns the selected answer to that session. Existing terminal sessions are registered by the user extension and remain controlled by their original OMP process.

## Getting started

Follow these steps on the macOS or Linux computer where you run OMP.

### 1. Install the prerequisites

- [OMP](https://omp.sh), installed and authenticated.
- [Node.js](https://nodejs.org/en/download) 24.18 or newer.
- [pnpm](https://pnpm.io/installation) 11.17.0.
- [Git](https://git-scm.com/downloads).
- [Tailscale](https://tailscale.com/download) on both the computer and your phone. Sign in to the same Tailscale network (Tailnet) on both devices.

### 2. Install OMP Remote

Paste this single command into a terminal:

```bash
git clone https://github.com/howarewoo/omp-remote.git && pnpm --dir omp-remote run setup
```

The setup command installs dependencies, builds OMP Remote, connects future OMP terminal sessions, starts the background service, and configures private Tailscale access. It is safe to rerun. If Tailscale prints an admin URL the first time, open it to enable Serve and then rerun the same command.

When setup finishes, it prints the private `https://...ts.net` dashboard URL. OMP Remote is not exposed to the public internet; only devices allowed onto your Tailnet can reach it.

### 3. Open it on your phone

1. Open Tailscale on your phone and make sure it is connected.
2. Open the dashboard URL from setup in Safari or Chrome.
3. Optional: install it like an app. On iPhone, use **Share → Add to Home Screen**. On Android, open the browser menu and choose **Install app** or **Add to Home screen**.

Start a new OMP terminal session after setup and it will appear in the dashboard automatically. The dashboard works over Wi-Fi or mobile data from anywhere, as long as the host computer is awake, online, running OMP Remote, and connected to Tailscale.

## Development

```bash
pnpm dev
```

`pnpm dev` uses one authoritative daemon endpoint. It probes the configured `OMP_REMOTE_HOST` and `OMP_REMOTE_PORT` (default `127.0.0.1:4387`): when a healthy OMP Remote daemon is already running there, development reuses it and starts only the Vite app; otherwise, development starts the daemon and Vite on that same endpoint. Vite runs on `127.0.0.1:5173` and proxies `/api`, `/healthz`, `/ws`, and `/extension` to the configured daemon.

The terminal extension defaults to `ws://127.0.0.1:4387/extension`, so ordinary terminal sessions and `pnpm dev` share the same daemon authority. Explicit `OMP_REMOTE_HOST` and `OMP_REMOTE_PORT` overrides are preserved. To run an isolated alternate daemon, set those endpoint overrides for `pnpm dev` and set `OMP_REMOTE_EXTENSION_URL` for terminal sessions that should connect to it; enclose an IPv6 host in brackets, for example `OMP_REMOTE_EXTENSION_URL=ws://[::1]:4399/extension`.

Optional environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `OMP_REMOTE_HOST` | `127.0.0.1` | Authoritative daemon bind and development proxy host; loopback only |
| `OMP_REMOTE_PORT` | `4387` | Authoritative daemon and development proxy port |
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
