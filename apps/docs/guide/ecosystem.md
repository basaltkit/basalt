<script setup>
import { data as packages } from '../packages.data.ts'
</script>

# Ecosystem

The full `@basaltkit/*` ecosystem — **{{ packages.length }} packages** and their
current versions. Each package is small and focused, works on its own, and is
published independently to npm.

::: tip Always up to date
This table is generated at build time from every package's `package.json`, so it
always reflects the latest published versions.
:::

<table>
  <thead>
    <tr><th>Package</th><th>Version</th><th>Description</th></tr>
  </thead>
  <tbody>
    <tr v-for="p in packages" :key="p.name">
      <td><code>{{ p.name }}</code></td>
      <td><Badge type="tip" :text="p.version" /></td>
      <td>{{ p.description }}</td>
    </tr>
  </tbody>
</table>

## Installing

Install only the packages your app needs — see [Beyond SaaS](./beyond-saas) for
choosing a minimal set.

```bash
pnpm add @basaltkit/core @basaltkit/fastify
```
