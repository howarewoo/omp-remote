# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

A single Tailnet owner supervising OMP coding sessions from an iOS or Android phone while away from the private macOS or Linux host.

## Product Purpose

OMP Remote provides one phone-first dashboard for every OMP session on a private host. Success means the user can see what each session is doing, open its live transcript, steer it, interrupt a run, and start or resume work without returning to the host terminal.

## Positioning

Unlike terminal mirroring or one-room collaboration links, OMP Remote automatically registers terminal-launched OMP sessions and combines them with dashboard-launched RPC sessions in a persistent multi-session control surface.

## Operating Context

The dashboard runs as a loopback-only host service on macOS and Linux. Tailscale Serve provides private HTTPS access within the owner’s Tailnet. OMP terminal sessions register through an auto-discovered extension; dashboard-owned sessions run through OMP RPC v2. The primary client is an installed mobile PWA used for intermittent, one-handed supervision.

## Capabilities and Constraints

- Show all active registered sessions and their run, connection, working-directory, and context state.
- Stream session transcript and lifecycle updates with reconnect support.
- Keep steer and abort controls immediately available on mobile.
- Launch and resume dashboard-owned OMP sessions.
- Preserve the distinction between controls supported by RPC-owned and extension-registered sessions.
- Support macOS and Linux hosts.
- Bind the application server only to loopback and rely on Tailscale ACLs as the single-user access boundary.
- Store no application data in a cloud service.
- Remain installable as an iOS and Android PWA.

## Evidence on Hand

OMP 17.1.x exposes a documented JSONL RPC v2 protocol and auto-discovers project and user extensions. OMP also ships a single-session encrypted collaboration client, but no existing multi-session directory is part of that relay design. No customer claims, performance benchmarks, or external brand assets exist and none should be fabricated.

## Product Principles

- Show live state before offering control.
- Keep remote actions explicit and reversible where OMP supports reversal.
- Preserve the host as the authority; reconnect clients to truth rather than reconstructing it locally.
- Make the two urgent mobile actions, steer and abort, reachable without navigating away from the transcript.
- Treat Tailnet privacy as a deployment boundary, not permission to expose a non-loopback backend.

## Accessibility & Inclusion

The PWA must support keyboard navigation, visible focus, reduced motion, sufficient contrast, screen-reader labels, touch targets appropriate for phones, and responsive layouts down to narrow mobile viewports.
