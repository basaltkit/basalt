---
'@basaltkit/tenancy': minor
---

`canonicalDomain`: stop tenants being created with no address.

Every durable `TenantSource` reads domains from one key — `tenant.domains` — and
an application that does not pass it gets a tenant with none. Silently: the
symptom never appears, because `subdomainResolver` slices the suffix off the
`Host` and answers without consulting the table.

So the firm serves traffic, and what is missing is the *record* that the address
belongs to it. `domainResolver` cannot find it, a custom domain cannot be
attached, and nothing stops a second firm claiming the same address, because the
uniqueness lives in the table that stayed empty.

The worst kind of gap: it does not break, it omits. An installation can run for
a year with an empty `tenant_domains` and discover it when the first client asks
for their own domain — with every historical row to backfill.

```ts
tenancyPlugin({
  source,
  resolvers,
  canonicalDomain: (tenant) => `${tenant.id}.${process.env.APP_DOMAIN}`,
})
```

Applied by `tenancy.create()` before the record is persisted, so every creation
path gets it — public signup, an admin route, a seed script — instead of each
one remembering. It is **added** to whatever the tenant already declares, never
substituted: the sources replace the whole domain set on save, so substituting
would erase a firm's own address the next time anything called `create`.
Returning `undefined` declines, for a tenant that should have no address.
