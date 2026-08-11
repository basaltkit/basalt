# Introdução

O Basalt é um toolkit "baterias incluídas" para construir aplicações SaaS em
Node.js. Não é mais uma framework HTTP — o Fastify já faz isso bem. Preenche a
camada entre o servidor e um produto SaaS acabado: **tenancy, faturação,
autenticação, permissões, auditoria, filas, notificações** — integrados com uma
coerência ponta-a-ponta rara em Node.js, e com inferência de TypeScript da rota
até ao cliente.

## Porquê o Basalt

- **Self-hosted, sem lock-in.** Os teus dados vivem no teu PostgreSQL, os teus
  utilizadores autenticam-se contra a tua base de dados. Gateways como o Stripe
  são drivers, não donos do teu estado.
- **Multi-tenancy como cidadão de primeira classe.** Ao contrário da maioria das
  stacks Node onde a tenancy é aparafusada por cima, o contexto do tenant
  permeia cache, storage, queue, logger e Prisma nativamente através do
  `AsyncLocalStorage`.
- **Convenção acima de configuração.** Uma app Basalt corre com zero
  configuração; tudo é substituível.
- **Adoção incremental.** Cada pacote funciona sozinho numa app Fastify
  existente. A framework completa é o destino, não a portagem para entrar.

## A visita de 30 segundos

```ts
import { createApp } from '@basaltkit/core'
import { fastifyPlugin, FASTIFY, route } from '@basaltkit/fastify'
import { z } from 'zod'

const hello = route({
  method: 'GET',
  url: '/hello/:name',
  params: z.object({ name: z.string() }),
  async handler({ params }) {
    return { message: `Hello, ${params.name}` }
  },
})

const app = await createApp({ plugins: [fastifyPlugin({ routes: [hello] })] }).boot()
await app.container.get(FASTIFY).listen({ port: 3000 })
```

O tipo de `params` da rota é inferido a partir do schema Zod — o handler fica
totalmente tipado, e o mesmo schema pode alimentar o OpenAPI e o
[cliente SDK](/pt/reference/packages).

::: tip Dica: Não estás em Fastify?
A mesma `route` corre sem alterações em **Express** e **Hono** — troca
`fastifyPlugin` por `expressPlugin` ou `honoPlugin`. Vê
[Adaptadores HTTP](/pt/guide/adapters) para exemplos completos.
:::

## Do zero a correr

O caminho mais rápido do nada até uma API tipada e autenticada é o scaffolder de
projeto. Escreve uma app com forma de produção e inclui apenas o que escolheres —
nada de código morto é enviado.

### 1. Scaffold

```bash
pnpm create basalt my-saas       # ou: npm create basalt my-saas
```

Corre-o sem nome para responderes às perguntas interativamente, ou passa flags
para as saltar:

```bash
pnpm create basalt my-saas --billing --cli   # adiciona subscrições + a CLI `basalt`
pnpm create basalt my-saas -y                 # aceita todos os defaults, sem perguntas
```

Multi-tenancy e autenticação estão **ativos por defeito** — desativa com
`--no-tenancy` / `--no-auth`. O scaffolder não instala dependências nem mexe no
git a menos que peças; adiciona `--install --git`, ou fá-lo tu no passo
seguinte. A lista completa de flags vive em [Instalação](/pt/guide/installation).

### 2. Instalar e configurar

```bash
cd my-saas
pnpm install
cp .env.example .env
```

O `.env` gerado contém `PORT`, `HOST`, `LOG_LEVEL`, `NODE_ENV` e — com auth — um
`APP_SECRET` (validado por `src/env.ts` com `@basaltkit/env`). Vem com um default
de desenvolvimento; define o teu próprio antes de produção, e nota que a auth
requer um segredo de **pelo menos 16 caracteres**.

### 3. Correr

```bash
pnpm dev        # API em http://localhost:3000
```

O `src/server.ts` arranca a app, resolve a instância Fastify e escuta — e
encerra de forma limpa em `SIGINT`/`SIGTERM`.

### 4. Primeiros pedidos

Cada app gerada expõe um índice amigável e um health check:

```bash
curl http://localhost:3000/
# { "name": "my-saas", "status": "ok", "endpoints": ["GET /", "GET /health", ...] }

curl http://localhost:3000/health
# { "ok": true, "requestId": "…", "tenant": null }
```

Com auth ativa (o default), as rotas `/auth/*` já estão ligadas. Regista-te,
inicia sessão e depois chama uma rota autenticada com o token devolvido:

```bash
curl -X POST http://localhost:3000/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"ada@example.com","password":"secretpassword1"}'

curl -X POST http://localhost:3000/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"ada@example.com","password":"secretpassword1"}'
# → { "user": {…}, "accessToken": "…", "refreshToken": "…" }

curl http://localhost:3000/auth/me \
  -H 'authorization: Bearer <accessToken>'
# → o utilizador autenticado
```

Corre o smoke test incluído para confirmar que tudo está ligado:

```bash
pnpm test
```

## Adicionar um store durável

O scaffold arranca com **stores em memória** — perfeitos para dev e CI, mas
esquecem tudo ao reiniciar. Cada store no Basalt é uma interface com um default
em memória, por isso tornar-se durável é uma troca, não uma reescrita.

Abre `src/app.ts`: o `authPlugin` está configurado com um `MemoryUserSource`.
Troca-o por um conjunto durável de stores suportado pelo SQLite embutido do Node
— sem ORM, sem ferramenta de migração, sem serviço externo:

```bash
pnpm add @basaltkit/auth-sqlite
```

```ts
// src/app.ts
import { authPlugin, authRoutes, mfaRoutes } from '@basaltkit/auth'
import { sqliteAuthStores } from '@basaltkit/auth-sqlite'
import { env } from './env.js'

const stores = sqliteAuthStores('./data/auth.db') // ':memory:' por defeito

authPlugin({
  secret: env.APP_SECRET,
  users: stores.users,
  sessions: stores.sessions,
  refreshTokens: stores.refreshTokens,
  tokens: stores.tokens, // verificação de email + reposição de password
  mfa: stores.mfa,
})
```

Agora os utilizadores sobrevivem a um reinício. O mesmo padrão troca qualquer
store em memória por um durável — vê [Persistência e stores duráveis](/pt/guide/persistence)
para o mapa completo (backends SQLite e Prisma para auth, teams, auditoria,
tenancy e mais).

## Para onde a seguir

- [Instalação](/pt/guide/installation) — gestores de pacotes, requisitos e como
  adicionar o Basalt a uma app existente.
- [Conceitos Fundamentais](/pt/guide/concepts) — plugins, o container de DI,
  contexto de pedido e hooks.
- [Adaptadores HTTP](/pt/guide/adapters) — as mesmas rotas em Fastify, Express
  ou Hono.
- [Web UI e componentes](/pt/guide/web-ui) — um SDK type-safe e tabelas/formulários
  de admin.
- [Construir um SaaS de notas](/pt/cookbook/notes-saas) — um passo-a-passo completo
  ponta-a-ponta.
