# Contributing

OMP Remote is an independent, unofficial project. It is not affiliated with, endorsed by, or sponsored by Oh My Pi or its maintainers.

## Before you start

For bugs and feature ideas, use the matching GitHub issue form. Never report a vulnerability publicly; follow [SECURITY.md](SECURITY.md).

Development requires Node.js `>=24.18.0` and pnpm `11.17.0`. Install the locked dependency graph:

```sh
pnpm install --frozen-lockfile
```

No Contributor License Agreement or Developer Certificate of Origin sign-off is required.

## Development boundaries

The workspace is split by responsibility:

- `apps/web`: React PWA shell.
- `apps/daemon`: loopback Fastify host and transport adapters.
- `packages/features`: user-facing feature slices.
- `packages/infrastructure`: shared protocol, RPC, extension, client, UI, and observability code.

Keep wire contracts in `packages/infrastructure/protocol` and validate untrusted input at its transport boundary. Preserve the loopback daemon/extension boundary and Tailnet access model. Do not add an account system or expose the daemon publicly.

For interface work, compose existing shadcn/ui components using this repository's Base UI-backed patterns and tokens. Prefer accessible primitives over custom interaction behavior.

Run the local development process with `pnpm dev`. Do not commit dependencies, build output, coverage, `.turbo`, local environment files, logs, TypeScript build metadata, or generated PWA service-worker files listed in `.gitignore`. Never commit credentials, local session data, or transcripts.

## Pull requests

Keep changes focused and explain the user-visible behavior, security implications, and test coverage. Update contracts, callers, and documentation together. Add tests for changed observable behavior rather than implementation details. Include screenshots for visible UI changes.

Before requesting review, run this exact sequence:

```sh
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm lint:lines
pnpm typecheck
pnpm test
pnpm build
```

Complete the pull request template, link related issues, and address review feedback without adding unrelated cleanup.