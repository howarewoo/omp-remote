---
name: mobile-hidden-footer-collapse
type: gotcha
scope: apps/web/src/*.css
tags: css, responsive, mobile
hook: Hidden mobile children must not leave fixed-height container gaps
updated: 2026-07-29
source: [[fixes/2026-07-29-iphone-pwa-bottom-gap]]
---
Hidden mobile children need their container min-height collapsed at the same breakpoint.
