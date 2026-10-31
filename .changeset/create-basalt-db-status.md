---
'create-basalt': minor
'@basaltkit/prisma': patch
---

`bin/basalt.ts` gains `basalt db:status`: it runs `dbStatusCommand()` without booting the app (like `make:*`), so it reports where the migrations stand even while the app refuses to start on an unmigrated database. `basalt update` patches an untouched bin (now including the 1.16 template) and prints just this block for a customised one; `doctor` lists it among the pre-boot commands. `db:status` now prints "up to date" (it printed "up to-date").
