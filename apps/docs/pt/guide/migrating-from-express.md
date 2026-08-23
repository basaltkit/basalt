# Migrar do Express

Não precisas de reescrever a tua aplicação para adotar o Basalt, e não precisas
de abandonar o Express. O Basalt corre **sobre** o Express (`@basaltkit/express`),
por isso podes migrar uma rota de cada vez — ou nunca trocar de adaptador.

Este guia cobre os dois caminhos:

1. **Incremental (recomendado)** — mantém a tua app Express a correr e deixa o
   Basalt montar rotas novas por cima. Migras os handlers quando lhes mexes.
2. **Completo** — portas as rotas para `route()` e, opcionalmente, trocas o
   adaptador para Fastify ou Hono pelo débito dos [benchmarks](./benchmarks).

## A mudança central

O Express acopla o handler a `(req, res)` e ao próprio Express. O Basalt descreve
uma rota como **dados** — método, url, schemas tipados, um handler quase puro — e
um adaptador liga-a a um servidor. O mesmo `route()` corre no Express, Fastify ou
Hono sem alterações.

```ts
// Express
app.post('/users', async (req, res) => {
  const { email } = req.body
  if (!email) return res.status(400).json({ error: 'email required' })
  const user = await db.users.create({ data: { email } })
  res.status(201).json(user)
})

// Basalt — a validação é declarativa, a resposta é o valor de retorno
import { route } from '@basaltkit/http'
import { z } from 'zod'

export const createUser = route({
  method: 'POST',
  url: '/users',
  body: z.object({ email: z.string().email() }),   // 400 automático em caso de erro
  async handler({ body, reply }) {
    const user = await db.users.create({ data: { email: body.email } })
    return reply.code(201).send(user)   // ou simplesmente `return user` para 200
  },
})
```

## Caminho 1 — Incremental (strangler)

`expressPlugin({ app })` recebe a **tua** app Express. Tudo o que já está montado
continua a funcionar; o Basalt acrescenta as suas rotas, container de DI, plugins
e middleware de borda ao lado.

```ts
import express from 'express'
import { createApp } from '@basaltkit/core'
import { expressPlugin, EXPRESS } from '@basaltkit/express'
import { securityPlugin } from '@basaltkit/http'
import { createUser } from './routes/users.js'

// 1. A tua app existente — intacta
const legacy = express()
legacy.use(existingAuthMiddleware)
legacy.get('/legacy/thing', legacyHandler)

// 2. Entrega-a ao Basalt
const app = await createApp({
  plugins: [
    securityPlugin({ cors: { origin: true } }),
    expressPlugin({ app: legacy, routes: [createUser] }),
  ],
}).boot()

// 3. Um servidor, os dois mundos
app.container.get(EXPRESS).listen(3000)
```

Agora `/legacy/thing` corre o handler antigo e `/users` corre a rota Basalt. Vais
movendo endpoints ao teu ritmo; apagas o handler Express quando o `route()` que o
substitui estiver no ar. Nada obriga a uma reescrita de uma só vez.

## Caminho 2 — Mapa da migração completa

### Roteamento

| Express | Basalt |
| --- | --- |
| `app.get('/x', h)` | `route({ method: 'GET', url: '/x', handler })` |
| `req.params.id` | `params: z.object({ id: z.string() })` → `handler({ params })` |
| `req.query.q` | `query: z.object({ q: z.string() })` → `handler({ query })` |
| `req.body` | `body: z.object({...})` → `handler({ body })` |
| `res.json(x)` | `return x` (o valor de retorno é o corpo) |
| `res.status(201).json(x)` | `return reply.code(201).send(x)` |
| `res.status(204).end()` | `return reply.code(204).send()` |
| `res.set('X', v)` | `return reply.header('X', v).send(x)` |

### Validação

Elimina as verificações manuais `if (!req.body.email) return res.status(400)` —
declara um schema Zod e o Basalt devolve um `400` estruturado antes do handler
correr. O handler recebe a entrada já tipada e parseada.

### Middleware → plugins, enrichers, guards

| Padrão Express | Equivalente Basalt |
| --- | --- |
| `app.use(helmet()); app.use(cors())` | `securityPlugin({ cors, ... })` |
| `app.use(morgan())` / métricas | `metricsPlugin()` + `loggerPlugin()` |
| `app.use(authMiddleware)` | `authPlugin({...})` + `meta: { auth: true }` na rota |
| `req.user = ...` no middleware | um **enricher de pedido** (`http:enrichers`) → `context.user` |
| `app.use(rateLimiter)` | um **guard** (`http:guards`) que rejeita antes do handler |
| `app.use(errorHandler)` | lança `HttpError(status, code, message)`; o adaptador formata |

Guards e enrichers vivem em buckets de metadados neutros, por isso aplicam-se em
**qualquer** adaptador — a mesma lógica de auth/rate-limit protege as tuas rotas
quer fiques no Express quer passes para Fastify.

### Autenticação

```ts
// Express: middleware JWT feito à mão em cada router protegido
router.use(requireAuth)

// Basalt: um plugin + uma flag por rota; context.user é tipado e preenchido
authPlugin({ users, secret, hasher })
route({ method: 'GET', url: '/me', meta: { auth: true },
  async handler({ context }) { return context.user } })
```

### Erros

```ts
// Express
if (!user) return res.status(404).json({ error: 'not found' })

// Basalt — lança; o adaptador renderiza um envelope de erro consistente
import { HttpError } from '@basaltkit/http'
if (!user) throw new HttpError(404, 'USER_NOT_FOUND', 'User not found')
```

## Devias trocar de adaptador?

Não és obrigado. Se ficares no `expressPlugin`, ganhas o container, os plugins, a
validação e todo o ecossistema `@basaltkit/*` mantendo a compatibilidade com o
middleware do Express. Se mais tarde quiseres mais débito, troca para
`fastifyPlugin` — **as tuas definições `route()` não mudam** (vê os
[benchmarks](./benchmarks): o Basalt sobre Fastify mantém ~90–95% do Fastify cru).

## Checklist

- [ ] `pnpm add @basaltkit/core @basaltkit/express @basaltkit/http zod`
- [ ] Envolve a tua app existente: `expressPlugin({ app: legacyApp })`
- [ ] Substitui `app.use(cors/helmet)` por `securityPlugin`
- [ ] Move um router para `route()` com schemas Zod; apaga o handler Express
- [ ] Substitui o middleware de auth por `authPlugin` + `meta: { auth: true }`
- [ ] Converte os early-returns `res.status(4xx)` em `throw new HttpError(...)`
- [ ] Repete por router; quando o último handler legacy desaparecer, remove a opção `app`
- [ ] (Opcional) troca `expressPlugin` → `fastifyPlugin`; as rotas ficam idênticas
