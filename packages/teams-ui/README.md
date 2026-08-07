# @machize/teams-ui

Página HTML self-contained para **gerir uma equipa** do [`@machize/teams`](https://www.npmjs.com/package/@machize/teams): convidar/revogar convites e listar/mudar-role/remover membros — **zero dependências, sem build**. Precisas deste módulo quando queres dar aos administradores um ecrã de gestão de equipa sem construíres a UI do zero.

## O que este módulo resolve

O `@machize/teams` já expõe as rotas de convites e membros. Este módulo é a **UI** por cima: uma página com um formulário de convite, a lista de convites pendentes (com revogar), e a lista de membros (com dropdown de role e remover) — tudo isolado por tenant.

## Instalação

```bash
pnpm add @machize/teams-ui
```

Depende do `@machize/core` e `@machize/fastify`. Requer o `teamsPlugin` + `teamRoutes` do `@machize/teams` montados.

## Começar em 5 minutos

```ts
import { createApp } from '@machize/core'
import { teamsPlugin, teamRoutes } from '@machize/teams'
import { teamsUiRoutes } from '@machize/teams-ui'
import { fastifyPlugin } from '@machize/fastify'

const app = await createApp({
  plugins: [
    // ... tenancyPlugin, authPlugin
    teamsPlugin(),
    fastifyPlugin({
      routes: [
        ...teamRoutes(),     // /team/invites*, /team/members*
        ...teamsUiRoutes(),  // GET /team/ui  ← a página
      ],
    }),
  ],
}).boot()
```

Abre **`/team/ui`** (autenticado como admin da equipa) para gerir convites e membros.

## Tenancy e autenticação

A página faz `fetch` same-origin, por isso assume que a sessão do browser está autenticada. Para **tenancy por subdomínio**, o tenant é resolvido automaticamente. Para **tenancy por header**, injeta o header:

```ts
teamsUiRoutes({ headers: { 'x-tenant-id': 'acme' } })
```

As ações de gestão (convidar, mudar role, remover) exigem `teamRole: 'admin'` nas rotas do `@machize/teams` — protege a própria página com um guard de admin se quiseres.

## Referência da API

### `teamsUiRoutes({ path?, apiBase?, title?, roles?, headers? })`

Devolve a rota que serve a página. `path` (default `/team/ui`), `apiBase` (default same-origin), `title`, `roles` (default `owner`/`admin`/`member`), `headers` (extra por pedido).

### `teamsPageHtml(options)`

Devolve o HTML da página como string, para servires à tua maneira.

## Como se liga aos outros módulos

- **`@machize/teams`** — fornece as rotas de convites/membros que esta página consome.
- **`@machize/tenancy` / `@machize/auth`** — resolvem o tenant e o utilizador do contexto.
- **`@machize/permissions`** — adiciona um *guard* à rota da página para restringir a admins.
