<script setup>
import { data as groups } from '../packages.data.ts'
const labels = {
  foundation: 'Foundation',
  http: 'HTTP & API',
  data: 'Persistence & data',
  queues: 'Queues & scheduling',
  auth: 'Auth & access',
  tenancy: 'Multi-tenancy & teams',
  billing: 'Billing & payments',
  search: 'Search',
  capabilities: 'Capabilities',
  admin: 'Admin & UI',
  devx: 'Developer experience',
}
const total = groups.reduce((sum, g) => sum + g.packages.length, 0)
</script>

# Ecosystem

The full `@basaltkit/*` ecosystem — **{{ total }} packages** grouped by area, with
their current versions. Each package is small and focused, works on its own, and
is published independently to npm.

::: tip Always up to date
This page is generated at build time from every package's `package.json`, so the
versions always reflect the latest published releases.
:::

<template v-for="g in groups" :key="g.key">
  <h2>{{ labels[g.key] ?? g.key }}</h2>
  <table>
    <thead>
      <tr><th>Package</th><th>Version</th><th>Description</th></tr>
    </thead>
    <tbody>
      <tr v-for="p in g.packages" :key="p.name">
        <td><code>{{ p.name }}</code></td>
        <td><Badge type="tip" :text="p.version" /></td>
        <td>{{ p.description }}</td>
      </tr>
    </tbody>
  </table>
</template>

## Installing

Install only the packages your app needs — see [Beyond SaaS](./beyond-saas) for
choosing a minimal set.

```bash
pnpm add @basaltkit/core @basaltkit/fastify
```
