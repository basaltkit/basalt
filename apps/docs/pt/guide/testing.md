# Testes

O [`@basaltkit/testing`](/reference/packages/testing) arranca a tua app **em memória**
e deixa-te conduzi-la como um cliente real — sem porta, sem rede, sem base de dados,
sem serviços externos. Os pedidos correm em milissegundos e são deterministas.
Funciona com qualquer test runner (Vitest, Jest, `node:test`).

## Arrancar a app e fazer pedidos

O `createTestApp` arranca a tua app e injeta pedidos HTTP diretamente no servidor
(o `inject` do Fastify), devolvendo os helpers `get`/`post`/… familiares.

```ts
import { describe, expect, it } from 'vitest'
import { fastifyPlugin, route } from '@basaltkit/fastify'
import { createTestApp } from '@basaltkit/testing'

const health = route({ method: 'GET', url: '/health', async handler() { return { ok: true } } })

describe('health', () => {
  it('responde 200', async () => {
    const app = await createTestApp({ plugins: [fastifyPlugin({ routes: [health] })] })
    const res = await app.get('/health')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    await app.shutdown() // faz sempre shutdown no fim
  })
})
```

## Agir como um utilizador ou tenant

Salta o login por completo — personifica o utilizador/tenant de onde o pedido devia
vir. O `createTestApp` acrescenta um enricher só-de-teste que popula `ctx().user` /
`ctx().tenant` exatamente como em produção:

```ts
const res = await app
  .actingAs({ id: 'u1', email: 'ana@acme.io' }) // finge que este utilizador está autenticado
  .asTenant('acme')                              // e este tenant está em contexto
  .post('/projects', { name: 'Launch' })
```

## Fakes com assertions

Troca mail e queue por **fakes** que gravam em vez de fazer. Cada um expõe um
`.plugin` que registas, mais assertions ao estilo Laravel:

```ts
import { createTestApp, fakeMailer, fakeQueue } from '@basaltkit/testing'

const mail = fakeMailer()
const queue = fakeQueue()
const app = await createTestApp({ plugins: [fastifyPlugin({ routes }), mail.plugin, queue.plugin] })

await app.actingAs(user).post('/invite', { email: 'bob@acme.io' })

mail.assertSent(InviteEmail, (m) => m.to.includes('bob@acme.io')) // devolve a mensagem
queue.assertDispatched(SendWelcome)
await queue.drain() // corre os jobs capturados pelos handlers reais
```

O `mail.sent` / os jobs capturados guardam tudo por ordem; `assertNothingSent` lança
se algo tiver sido enviado.

## Viajar no tempo

Testa expirações e prazos sem esperar:

```ts
import { time } from '@basaltkit/testing'

await app.actingAs(user).post('/subscribe', { plan: 'pro', trialDays: 14 })
time.travel('15d')                       // salta 15 dias para a frente
time.travelTo(new Date('2027-01-01'))    // …ou para uma data exata
// …verifica que o trial já expirou
time.restore()                           // desfaz o patch, restaura o relógio real
```

Tudo é determinista e independente do runner. Projetos criados com `create-basalt` já
incluem `@basaltkit/testing` nas `devDependencies`.
