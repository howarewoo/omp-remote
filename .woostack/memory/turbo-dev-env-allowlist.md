---
name: turbo-dev-env-allowlist
type: gotcha
scope: turbo.json, package.json, apps/*/vite.config.ts
tags: turborepo, environment, development
hook: Turbo strict mode filters undeclared development environment values
updated: 2026-07-28
source: [[fixes/2026-07-28-dev-port-collision]]
---
Environment defaults set by a root script do not reach Turbo child tasks in strict mode unless the task declares them in `env` or `passThroughEnv`. Keep backend bind variables and frontend proxy variables on the same allowlist so both processes select one endpoint.
