---
'create-basalt': patch
'@basaltkit/cli': patch
---

New apps ignore `@basaltkit/deploy`'s state and pre-migration dumps: `.gitignore` gains `/.basalt/` and `/backups/`, and the shipped `.dockerignore` (also written by `basalt publish dockerfile`) gains `.basalt` and `backups` — anchored at the root, so an app's own `backups` module is still copied into the image.
