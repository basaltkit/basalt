---
'@basaltkit/generator': patch
'@basaltkit/ai': patch
---

Read `--no-register` / `--no-migrate` through the CLI's new flag negation.

`@basaltkit/cli`'s `parseArgv` now parses a bare `--no-<name>` as `<name>: false`. These commands checked the literal `flags['no-register']` / `flags['no-migrate']` key, which that change would have made permanently absent — silently re-enabling the very behavior the flag suppresses. Both now check the negated form, and still accept the legacy literal key for programmatic callers.
