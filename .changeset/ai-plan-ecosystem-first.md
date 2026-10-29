---
'@basaltkit/ai': minor
---

`ai:plan` / `ai:make` plan with the ecosystem first: the Architect prompt carries a catalog of the official packages and the project's installed ones, so a capability a package covers (comments, files, notifications, teams, billing…) becomes a new `package` step instead of a generated model. `ai:make` lists package steps first in its follow-ups and stops cleanly when a plan only reuses packages. Also fixes the stale "arrives in the next phase" messages.
