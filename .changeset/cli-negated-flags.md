---
'@basaltkit/cli': patch
---

`parseArgv` understands negated flags, making `basalt dev --no-routes` actually work.

A bare `--no-<name>` now yields `flags['<name>'] === false` instead of `flags['no-<name>'] === true`. `basalt dev` has always tested `flags['routes'] !== false`, so the documented `--no-routes` opt-out was a silent no-op — the route table printed regardless. Only the bare form negates; `--no-cache=x` still parses as the literal key `no-cache`.
