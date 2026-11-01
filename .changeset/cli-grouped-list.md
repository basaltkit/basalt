---
'@basaltkit/cli': minor
---

`basalt list` groups commands by the prefix before the first `:` (ungrouped ones like `dev` and `routes` on top, then `ai`, `db`, `queue`, `tenant`, … alphabetically, registration order inside). `basalt list <group>` — or just `basalt <group>`, e.g. `basalt tenant` — shows one group, and an unknown group names the ones there are. A mistyped command gets a suggestion: `Unknown command "tenant:migrat". Did you mean tenant:migrate?` (also for the bare action: `migrate` → `tenant:migrate`). No command was renamed. New exports: `renderCommandList`, `commandGroup`, `commandGroups`, `suggestCommands`.
