---
'@basaltkit/deploy': patch
---

The preflight no longer reports `runtime.attach: <container> does not exist` for the dedicated infra's own containers: on a new server the infra step creates them before the release.
