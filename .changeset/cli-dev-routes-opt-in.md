---
'@basaltkit/cli': minor
'create-basalt': patch
---

`basalt dev` no longer prints the route table by default: it booted the app a second time (database connections included, up to 10s) before every dev session for output `basalt routes` gives on demand. Pass `--routes` to get it; `--no-routes` keeps working as a no-op. create-basalt's bin template comments follow, and `basalt update` refreshes them in an untouched bin.
