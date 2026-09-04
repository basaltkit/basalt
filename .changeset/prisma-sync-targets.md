---
'@basaltkit/prisma': patch
---

`prisma:sync` can be told which schema each domain belongs to.

The command had one schema path and one flat list of domains. That list mixes
domains living in every tenant's schema (`auth`, `permissions`, `audit`,
`activity`, `teams`, `notifications`) with domains living only in the central
one (`tenancy`, `subscriptions`), and nothing told them apart.

So `prisma:sync --yes` — the obvious invocation — wrote `Tenant`,
`Subscription` and `Payment` into the schema of every tenant. Those tables must
never hold a row; having them there is a place for one tenant's data to land
unnoticed. It was caught by reading a diff, not by the tool.

```ts
prismaSyncCommand({
  targets: {
    central: { schemaPath: 'prisma/schema.prisma', domains: ['tenancy', 'subscriptions'] },
    tenant: {
      schemaPath: 'prisma/tenants/schema.prisma',
      domains: ['auth', 'permissions', 'audit', 'activity', 'teams', 'notifications'],
    },
  },
})
```

`--only` narrows inside each target and never moves a domain across one.
`--push`/`--migrate` run once per schema that actually changed, rather than
producing an empty migration for one that did not. `--schema` is refused when
targets are declared: it names a single file, and guessing which would write
central models into it.

Without `targets`, behaviour is unchanged.
