---
'@basaltkit/deploy-ui': patch
---

Visual redesign: the deploy UI now reads as an operations console. A fixed sidebar with the Basalt mark, the target selector and icon navigation (a top bar below 900px); a context strip on every screen with the target, a prominent PROTECTED badge, the ssh destination, the server host and the app; graphite design tokens with a full dark theme and one molten accent; cards, key/value grids, status pills, tables with sticky headers, findings with severity badges and the fix in a mono callout, empty states, and elevated dialogs that mark destructive actions. The run screen has a step timeline (running, ok, failed, skipped, no end seen) with durations, and a terminal-style log with time and source columns and warn/error tinting. Same CSP (no inline script or style, nothing loaded from elsewhere), same text-only rendering.
