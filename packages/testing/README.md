# @machize/testing

Kit de testes para aplicações Machize: arranca a aplicação em memória com `createTestApp`, faz pedidos HTTP fingindo utilizadores e tenants, substitui o correio e a fila por versões falsas com asserções, e viaja no tempo. Precisas dele sempre que quiseres escrever testes automáticos da tua aplicação sem servidores, bases de dados ou serviços externos reais.

## O que este módulo resolve

Testar uma aplicação web "a sério" é trabalhoso: teria de se arrancar o servidor num porto, autenticar um utilizador verdadeiro, esperar por e-mails reais e aguardar dias para ver uma subscrição expirar. Nada disto é prático num teste automático, que deve correr em milissegundos e sempre com o mesmo resultado.

Este pacote resolve o problema com quatro ferramentas. O `createTestApp` arranca a tua aplicação e injeta os pedidos HTTP diretamente no servidor Fastify, sem rede — e deixa-te "fingir" que o pedido vem de um utilizador ou tenant específico (`actingAs` / `asTenant`), sem passar pelo login. Um **fake** (objeto falso que substitui um serviço real durante os testes) de correio, `fakeMailer`, grava os e-mails em vez de os enviar; outro de filas, `fakeQueue`, captura os trabalhos (jobs) em vez de os executar — ambos com asserções ao estilo Laravel (`assertSent`, `assertDispatched`). Por fim, `time` desloca o relógio (`time.travel('15d')`) para testares expirações e prazos sem esperar.

Tudo funciona em qualquer executor de testes (Vitest, Jest, node:test…), porque nada aqui depende do executor.

## Instalação

```bash
pnpm add -D @machize/testing
```

> Nota: depende de `@machize/core`, `@machize/fastify`, `@machize/mailer`, `@machize/queue` e `fastify`. Os projetos criados com `create-machize` já trazem `@machize/testing` nas `devDependencies`.

## Começar em 5 minutos

1. Cria uma rota simples e um teste. Em `tests/health.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { fastifyPlugin, route } from '@machize/fastify'
import { createTestApp } from '@machize/testing'

const health = route({
  method: 'GET',
  url: '/health',
  async handler() {
    return { ok: true }
  },
})

describe('health', () => {
  it('responde 200 com ok: true', async () => {
    const app = await createTestApp({
      plugins: [fastifyPlugin({ routes: [health] })],
    })

    const response = await app.get('/health')
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ ok: true })

    await app.shutdown() // desliga sempre a app no fim
  })
})
```

2. Corre o teste:

```bash
pnpm vitest run
```

Não há porto, nem rede, nem servidor a arrancar à parte — o pedido é injetado diretamente no Fastify (mecanismo `inject` do próprio Fastify).

## Guia de utilização

### Pedidos HTTP fluentes

O `TestApp` tem um método por verbo HTTP. Nos verbos com corpo (`post`, `put`, `patch`), o segundo argumento é o payload:

```typescript
const created = await app.post('/projects', { name: 'Primeiro' })
expect(created.statusCode).toBe(201)
const id = created.json().id

await app.patch(`/projects/${id}`, { name: 'Renomeado' })
await app.delete(`/projects/${id}`)
```

A resposta é uma `LightMyRequestResponse` do Fastify: usa `.statusCode`, `.json()`, `.body`, `.headers`.

### Fingir utilizadores e tenants (impersonação)

O `createTestApp` acrescenta automaticamente um plugin de teste que lê os cabeçalhos especiais `x-test-user` / `x-test-tenant` e preenche `ctx().user` / `ctx().tenant` — o mesmo contexto que a tua aplicação usa em produção. **Nunca registes este mecanismo numa aplicação real.**

```typescript
import { ctx } from '@machize/core'
import { fastifyPlugin, route } from '@machize/fastify'
import { createTestApp } from '@machize/testing'

const whoami = route({
  method: 'GET',
  url: '/whoami',
  async handler() {
    const { user, tenant } = ctx()
    return { user: user ?? null, tenant: tenant ?? null }
  },
})

const app = await createTestApp({ plugins: [fastifyPlugin({ routes: [whoami] })] })

// defaults para todos os pedidos seguintes (encadeável)
app.actingAs({ id: 'u1', email: 'ada@example.com' }).asTenant('acme')
const eu = await app.get('/whoami')
// → { user: { id: 'u1', email: 'ada@example.com' }, tenant: { id: 'acme' } }

// override só para um pedido
const outro = await app.get('/whoami', { tenant: 'globex' })
// → tenant: { id: 'globex' }

await app.shutdown()
```

### Correio falso com asserções — `fakeMailer`

Grava os e-mails "enviados" em memória em vez de os enviar:

```typescript
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineMail, MAILER } from '@machize/mailer'
import { createTestApp, fakeMailer } from '@machize/testing'

const WelcomeEmail = defineMail({
  name: 'welcome',
  schema: z.object({ name: z.string() }),
  subject: ({ name }) => `Bem-vindo, ${name}!`,
  text: ({ name }) => `Olá ${name}`,
})

it('envia o e-mail de boas-vindas', async () => {
  const mail = fakeMailer()
  const app = await createTestApp({ plugins: [mail.plugin] })

  mail.assertNothingSent()
  const mailer = app.container.get(MAILER)
  await mailer.send(WelcomeEmail, { name: 'Ada' }, { to: 'ada@example.com' })

  const sent = mail.assertSent(WelcomeEmail, (m) => m.to.includes('ada@example.com'))
  expect(sent.subject).toBe('Bem-vindo, Ada!')

  await app.shutdown()
})
```

`assertSent` devolve a primeira mensagem correspondente (para verificares assunto, destinatários, etc.) e lança `MailAssertionError` se nada corresponder; `assertNothingSent` lança se algo tiver sido enviado. O array `mail.sent` tem tudo, por ordem.

### Fila falsa — `fakeQueue`

Captura os despachos de jobs **sem os executar**; `drain()` corre o acumulado pelos handlers reais:

```typescript
import { expect, it } from 'vitest'
import { z } from 'zod'
import { defineJob } from '@machize/queue'
import { createTestApp, fakeQueue } from '@machize/testing'

const SendWelcome = defineJob({
  name: 'email.welcome',
  schema: z.object({ userId: z.string() }),
  handle: ({ userId }) => console.log('a processar', userId),
})

it('despacha o job de boas-vindas', async () => {
  const queue = fakeQueue({ jobs: [SendWelcome] })
  const app = await createTestApp({ plugins: [queue.plugin] })

  await SendWelcome.dispatch({ userId: 'u-1' })

  const captured = queue.assertDispatched(SendWelcome)
  expect(captured.queue).toBe('default')
  expect(captured.payload).toEqual({ userId: 'u-1' })

  // até aqui nada foi executado; agora corre os handlers reais:
  expect(await queue.drain()).toBe(1)

  await app.shutdown()
})
```

### Viagem no tempo — `time`

Desloca o "agora" (`Date.now()` e `new Date()` sem argumentos) sem depender do executor de testes. Datas explícitas (`new Date('2026-01-01')`) não são afetadas.

```typescript
import { afterEach, expect, it } from 'vitest'
import { time } from '@machize/testing'

afterEach(() => time.restore()) // chama SEMPRE no afterEach

it('o trial expira após 15 dias', () => {
  time.travel('15d')                        // avança 15 dias (acumulável)
  time.travelTo(new Date('2030-06-01'))     // ou fixa uma data concreta
  expect(new Date().toISOString().slice(0, 10)).toBe('2030-06-01')
})
```

O formato da duração (`'15d'`, `'2h'`, …) é o `DurationInput` de `@machize/core` (`parseDuration`).

## Referência da API

Exportado a partir de `@machize/testing`:

### `createTestApp(options?): Promise<TestApp>`

Cria a aplicação com `createApp` (as mesmas `CreateAppOptions` de `@machize/core`), antepõe o plugin de impersonação, faz `boot()` e devolve um `TestApp`.

| Parâmetro | Tipo | Obrigatório? | Default | Descrição |
| --- | --- | --- | --- | --- |
| `options` | `CreateAppOptions` | Não | `{}` | Opções de `createApp`; os teus `plugins` são acrescentados depois do plugin de impersonação |

### Classe `TestApp`

| Membro | Assinatura | Descrição |
| --- | --- | --- |
| `app` | `MachizeApp` | A aplicação subjacente |
| `container` | `Container` (getter) | Contentor de dependências — `app.container.get(TOKEN)` |
| `server` | `FastifyInstance` (getter) | O servidor Fastify (token `FASTIFY`) |
| `actingAs(user)` | `(user: TestActor) => this` | Define o utilizador default dos próximos pedidos |
| `asTenant(tenant)` | `(tenant: string \| { id: string }) => this` | Define o tenant default dos próximos pedidos |
| `request(method, url, options?)` | `Promise<LightMyRequestResponse>` | Pedido genérico |
| `get(url, options?)` | idem | GET |
| `post(url, payload?, options?)` | idem | POST com corpo |
| `put(url, payload?, options?)` | idem | PUT com corpo |
| `patch(url, payload?, options?)` | idem | PATCH com corpo |
| `delete(url, options?)` | idem | DELETE |
| `shutdown()` | `Promise<void>` | Desliga a aplicação (chama no fim de cada teste) |

`TestActor`: `{ id: string; email?: string; [key: string]: unknown }`.

`TestRequestOptions`:

| Campo | Tipo | Obrigatório? | Default | Descrição |
| --- | --- | --- | --- | --- |
| `payload` | `unknown` | Não | — | Corpo do pedido |
| `headers` | `Record<string, string>` | Não | — | Cabeçalhos extra |
| `user` | `TestActor` | Não | default de `actingAs` | Utilizador só para este pedido |
| `tenant` | `string \| { id: string; … }` | Não | default de `asTenant` | Tenant só para este pedido |

### `fakeMailer(options?): FakeMailer`

| Parâmetro | Tipo | Obrigatório? | Default | Descrição |
| --- | --- | --- | --- | --- |
| `options` | `MailerOptions` | Não | `{ from: 'test@machize.dev' }` | Opções do `Mailer` real (remetente, etc.) |

`FakeMailer`:

| Membro | Tipo | Descrição |
| --- | --- | --- |
| `plugin` | plugin Machize | Regista o mailer falso — passa em `createTestApp({ plugins: [mail.plugin, …] })` |
| `sent` | `ResolvedMail[]` | Tudo o que foi "enviado", por ordem |
| `assertSent(mail, predicate?)` | `(MailDefinition \| string, (m: ResolvedMail) => boolean) => ResolvedMail` | Devolve a primeira correspondência; lança `MailAssertionError` se nenhuma |
| `assertNothingSent()` | `() => void` | Lança `MailAssertionError` se algo foi enviado |

`FAKE_MAILER` — token `createToken<FakeMailer>('testing:mailer')`. *(Avançado.)*

### `fakeQueue(options?): FakeQueue`

| Parâmetro | Tipo | Obrigatório? | Default | Descrição |
| --- | --- | --- | --- | --- |
| `options.jobs` | `JobDefinition[]` | Não | — | Jobs a registar no `queuePlugin` (necessário para `drain()` executar os handlers) |

`FakeQueue`:

| Membro | Tipo | Descrição |
| --- | --- | --- |
| `plugin` | `queuePlugin(...)` | Regista a fila falsa na aplicação de teste |
| `dispatched` | `CapturedJob[]` | Todos os despachos, por ordem |
| `assertDispatched(job, predicate?)` | `(JobDefinition \| string, (c: CapturedJob) => boolean) => CapturedJob` | Devolve a primeira correspondência; lança `QueueAssertionError` se nenhuma |
| `assertNothingDispatched()` | `() => void` | Lança `QueueAssertionError` se algo foi despachado |
| `drain()` | `() => Promise<number>` | Executa o acumulado pelos handlers reais; devolve quantos correram |

`CapturedJob`: `{ queue: string; job: string; payload: unknown; context: unknown; options: AddJobOptions }`.

### `time`

| Método | Assinatura | Descrição |
| --- | --- | --- |
| `time.travel(duration)` | `(duration: DurationInput) => void` | Avança o relógio (acumula com chamadas anteriores) |
| `time.travelTo(date)` | `(date: Date) => void` | Fixa o "agora" numa data concreta |
| `time.restore()` | `() => void` | Desfaz o patch e repõe o offset a zero — chama sempre em `afterEach` |

### Erros

- `MailAssertionError` — código `TEST_MAIL_ASSERTION` (estende `MachizeError`).
- `QueueAssertionError` — código `TEST_QUEUE_ASSERTION` (estende `MachizeError`).

## Erros comuns e soluções (FAQ)

**O teste fica pendurado e o Vitest não termina.**
Faltou `await app.shutdown()` no fim do teste. A aplicação mantém recursos abertos até ser desligada.

**`ctx().user` vem sempre `undefined` nos handlers.**
Confirma que criaste a app com `createTestApp` (é ele que instala a impersonação) e que chamaste `actingAs(...)` antes do pedido — ou passaste `{ user: ... }` nas opções desse pedido. A impersonação funciona por enriquecedores de pedido do `@machize/fastify`; precisa do `fastifyPlugin` registado.

**`Expected mail "welcome" to have been sent. Sent: (nothing)`**
O código não chegou a enviar o e-mail, ou o `Mailer` usado não é o falso. Garante que `mail.plugin` está na lista `plugins` de `createTestApp` **antes** de resolveres `MAILER` do contentor.

**O `drain()` devolve 0 ou os handlers não correm.**
Passa os jobs ao criar a fila falsa: `fakeQueue({ jobs: [MeuJob] })`. Sem o registo, o executor não sabe que handler chamar.

**Uma viagem no tempo "contaminou" os testes seguintes.**
O patch do `Date` é global. Chama `time.restore()` em `afterEach` — mesmo que só um teste viaje no tempo.

**Posso usar `actingAs` em produção?**
Não. O plugin de impersonação lê cabeçalhos (`x-test-user`) sem qualquer validação — é exclusivamente para testes e só existe dentro de `createTestApp`.

## Como se liga aos outros módulos

- **`@machize/core`** — `createTestApp` embrulha `createApp`; `time` usa `parseDuration`; os erros estendem `MachizeError`.
- **`@machize/fastify`** — os pedidos são injetados no `FastifyInstance` (token `FASTIFY`); a impersonação é um `RequestEnricher` registado no balde `http:enrichers`.
- **`@machize/mailer`** — `fakeMailer` regista um `Mailer` real com o `MemoryMailDriver`, sob o mesmo token `MAILER` que a aplicação usa.
- **`@machize/queue`** — `fakeQueue` usa o `queuePlugin` real com um driver que captura em vez de executar.
- **`@machize/generator`** — os testes gerados por `mach make:resource` usam `createTestApp` deste pacote.
- **`create-machize`** — os projetos novos incluem `@machize/testing` nas `devDependencies` e um teste de arranque pronto a correr.
