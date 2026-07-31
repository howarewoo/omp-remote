---
name: typed-fixtures-follow-required-props
type: gotcha
scope: packages/features/*/src/**/*.test.ts
tags: typescript, tests, fixtures
hook: Typed shared fixtures must track required prop additions
updated: 2026-07-30
source: [[fixes/2026-07-30-dashboard-test-fixtures]]
---
Typed fixtures must follow required prop additions: transpile-only tests can pass while package typecheck fails.
