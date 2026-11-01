---
'@basaltkit/cli': minor
---

`runCli` warns when two commands share a name. The first registered still runs, but `basalt` now says on stderr which one ran and which were ignored (and `basalt list` shows the name once, with the same warning). Before, the duplicate vanished silently — e.g. `tenancyPlugin`'s own `tenant:migrate` hid a `tenantMigrateCommand` passed in `bin/basalt.ts`, which then looked broken.
