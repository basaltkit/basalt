<script setup>
import { data as packages } from '../../packages.data.ts'
</script>

# Ecossistema

Todo o ecossistema `@basaltkit/*` — **{{ packages.length }} pacotes** e as suas
versões atuais. Cada pacote é pequeno e focado, funciona por si só, e é publicado
de forma independente no npm.

::: tip Sempre atualizado
Esta tabela é gerada no build a partir do `package.json` de cada pacote, por isso
reflete sempre as versões publicadas mais recentes.
:::

<table>
  <thead>
    <tr><th>Pacote</th><th>Versão</th><th>Descrição</th></tr>
  </thead>
  <tbody>
    <tr v-for="p in packages" :key="p.name">
      <td><code>{{ p.name }}</code></td>
      <td><Badge type="tip" :text="p.version" /></td>
      <td>{{ p.description }}</td>
    </tr>
  </tbody>
</table>

## Instalar

Instala só os pacotes que a tua app precisa — vê [Para além do SaaS](./para-alem-do-saas)
para escolher um conjunto mínimo.

```bash
pnpm add @basaltkit/core @basaltkit/fastify
```
