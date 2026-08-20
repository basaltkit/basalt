<script setup>
import { data as groups } from '../../packages.data.ts'
const labels = {
  foundation: 'Fundação',
  http: 'HTTP & API',
  data: 'Persistência & dados',
  queues: 'Filas & agendamento',
  auth: 'Autenticação & acesso',
  tenancy: 'Multi-tenancy & equipas',
  billing: 'Faturação & pagamentos',
  search: 'Pesquisa',
  capabilities: 'Capacidades',
  admin: 'Admin & UI',
  devx: 'Experiência de desenvolvimento',
}
const total = groups.reduce((sum, g) => sum + g.packages.length, 0)
</script>

# Ecossistema

Todo o ecossistema `@basaltkit/*` — **{{ total }} pacotes** agrupados por área, com
as suas versões atuais. Cada pacote é pequeno e focado, funciona por si só, e é
publicado de forma independente no npm.

::: tip Sempre atualizado
Esta página é gerada no build a partir do `package.json` de cada pacote, por isso
as versões refletem sempre os lançamentos publicados mais recentes.
:::

<template v-for="g in groups" :key="g.key">
  <h2>{{ labels[g.key] ?? g.key }}</h2>
  <table>
    <thead>
      <tr><th>Pacote</th><th>Versão</th><th>Descrição</th></tr>
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

## Instalar

Instala só os pacotes que a tua app precisa — vê [Para além do SaaS](./para-alem-do-saas)
para escolher um conjunto mínimo.

```bash
pnpm add @basaltkit/core @basaltkit/fastify
```
