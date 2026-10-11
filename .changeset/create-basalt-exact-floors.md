---
'create-basalt': patch
---

A new app's `@basaltkit/*` ranges are floored at the exact published version (`^3.0.2`), not at the start of its minor line (`^3.0.0`). A patch can carry the dependency ranges that make a package work with the rest of the scaffold — a dependent patch after a sibling's major — and a `.0` floor let a fresh install resolve the older patch of the same line.
