---
'@basaltkit/cli': patch
---

`basalt upgrade` with nothing to change now says "No codemods to apply. To update the dependencies: basalt update" instead of "everything is up to date", which read as if the dependencies had been checked. The command's description says the same.
