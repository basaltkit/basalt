---
'@basaltkit/cli': minor
'@basaltkit/tenancy': patch
'@basaltkit/prisma': patch
'@basaltkit/queue': patch
'@basaltkit/ai': patch
'@basaltkit/audit': patch
'@basaltkit/http': patch
'@basaltkit/scheduler': patch
'@basaltkit/mailer': patch
---

`basalt help <command>` (or `basalt <command> --help`) prints a command's usage line, description and flags without running it. `CommandDefinition` gains optional `usage` (what follows the name: `'<id> [--force] [--yes]'`) and `flags` (`{ '--yes': 'Skip the confirmation' }`). The framework's commands — `routes`, `dev`, `upgrade`, `publish`, `tenant:*`, `queue:*`, `db:status`, `prisma:sync`, `ai:fix|plan|make`, `audit:verify`, `generate:docs`, `schedule:run`, `mail:preview` — move their usage out of the description into these fields, so `basalt list` shows one short line per command. New export: `renderCommandHelp`.
