# @machize/api-keys-ui

Página HTML self-contained para **gerir API keys** do [`@machize/auth`](https://www.npmjs.com/package/@machize/auth): criar (mostra a chave **uma vez**), listar e revogar — **zero dependências, sem build**. Precisas deste módulo quando queres dar aos utilizadores um ecrã para gerirem as suas chaves de API sem construíres a UI do zero.

## O que este módulo resolve

O `@machize/auth` já expõe as rotas `POST/GET /apikeys` e `DELETE /apikeys/:id` (a chave em plaintext só aparece na criação). Este módulo é a **UI** por cima delas: uma página que lista as chaves, permite criar uma nova (revelando o segredo uma única vez, com botão de copiar) e revogar as existentes.

## Instalação

```bash
pnpm add @machize/api-keys-ui
```

Depende do `@machize/core` e `@machize/fastify`. Requer que o teu app monte as rotas de API keys do `@machize/auth` (`apiKeysPlugin` + `apiKeyRoutes`).

## Começar em 5 minutos

```ts
import { createApp } from '@machize/core'
import { authPlugin, authRoutes, apiKeysPlugin, apiKeyRoutes, MemoryUserSource } from '@machize/auth'
import { apiKeysUiRoutes } from '@machize/api-keys-ui'
import { fastifyPlugin } from '@machize/fastify'

const app = await createApp({
  plugins: [
    authPlugin({ users: new MemoryUserSource(), secret: process.env.JWT_SECRET! }),
    apiKeysPlugin(),
    fastifyPlugin({
      routes: [
        ...authRoutes(),
        ...apiKeyRoutes(),      // POST/GET /apikeys, DELETE /apikeys/:id
        ...apiKeysUiRoutes(),   // GET /apikeys/ui  ← a página
      ],
    }),
  ],
}).boot()
```

Abre **`/apikeys/ui`** (autenticado) e o utilizador pode criar, ver e revogar as suas chaves.

## Como funciona

A página é servida por `GET /apikeys/ui` (exige login). No browser, chama as rotas JSON com `credentials: 'same-origin'`, por isso assume que a sessão do utilizador já está autenticada para `${apiBase}/apikeys`. Ao criar uma chave, revela o segredo **uma única vez** (com aviso e botão de copiar) — depois disso só o prefixo é visível, como manda a segurança do `@machize/auth`.

## Referência da API

### `apiKeysUiRoutes({ path?, apiBase?, title? })`

Devolve a rota que serve a página. `path` (default `/apikeys/ui`), `apiBase` (onde estão as rotas JSON, default same-origin), `title`.

### `apiKeysPageHtml({ apiBase?, title? })`

Devolve o HTML da página como string — usa-o diretamente se quiseres servi-lo à tua maneira (ou noutro framework).

## Como se liga aos outros módulos

- **`@machize/auth`** — fornece as rotas de API keys que esta página consome (`apiKeysPlugin` + `apiKeyRoutes`).
- **`@machize/permissions`** — adiciona um *guard* à rota da página se quiseres restringir quem a vê.
