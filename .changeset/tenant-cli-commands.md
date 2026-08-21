---
"@basaltkit/tenancy": minor
---

Add the `tenant:list|create|migrate|seed|run` CLI commands.

`tenancyPlugin` now registers five commands into the CLI command bucket:

- **`tenant:list`** — table of all tenants (needs `source.list`).
- **`tenant:create <id> [--field=…]`** — persist a new tenant (needs the new optional `source.create`, implemented by `MemoryTenantSource`).
- **`tenant:migrate [--tenant=<id>]`** / **`tenant:seed [--tenant=<id>]`** — run the per-tenant `onMigrate` / `onSeed` hooks (new plugin options) inside each tenant's context, for one tenant or all via `forEach`.
- **`tenant:run <id> <command> [args…]`** — run any plugin-registered command inside a tenant's context.

New `TenantSource.create?` and `TenancyPluginOptions.onMigrate` / `onSeed`.
