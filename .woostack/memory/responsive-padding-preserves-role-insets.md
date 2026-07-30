---
name: responsive-padding-preserves-role-insets
type: gotcha
scope: apps/web/src/*.css
tags: css, responsive, spacing
hook: Responsive block overrides preserve role-specific inline spacing
updated: 2026-07-29
source: [[fixes/2026-07-29-mobile-tool-call-padding]]
---
Responsive block overrides use padding-block: shorthands can erase role-specific inline spacing.
