# Testes

O [`@basaltkit/testing`](/reference/packages/testing) arranca a tua app inteira
**dentro do processo de teste** e deixa-te conduzi-la como um cliente real — sem
porta, sem rede, sem base de dados, sem serviços externos. É desacoplado do test
runner (Vitest, Jest e `node:test` funcionam todos, nada aqui importa um) e do
adaptador HTTP: a mesma suite corre sem alterações em Fastify, Express ou Hono.
Usa-o sempre que um teste precisaria de um servidor a sério, de um utilizador
autenticado, de uma caixa de correio ou de um relógio.

[[toc]]

## Modelo mental

O pacote são quatro ferramentas independentes que se compõem. Nada é global
exceto o relógio — e esse tens mesmo de o repor tu.

| Peça | Substitui | Âmbito / tempo de vida |
| --- | --- | --- |
| `createTestApp()` → `TestApp` | Arrancar um servidor e chamá-lo por HTTP | Até `await app.shutdown()` |
| `.actingAs()` / `.asTenant()` | Registar, iniciar sessão, enviar um header de tenant | Fixo no `TestApp`; substituível por pedido |
| `fakeMailer()` / `fakeQueue()` | O driver de mail real / o backend de fila real | A instância da app onde são registados |
| `time` | Esperar que um trial, token ou lock expire | **Global ao processo** até `time.restore()` |

A personificação não é um truque do Fastify. O `createTestApp` antepõe um plugin
escondido (`basalt:testing:impersonation`) que regista um **enricher** de pedido
no bucket de metadados neutro `http:enrichers`. O enricher lê os headers
`x-test-user` / `x-test-tenant` que os helpers de pedido colocam e escreve
`ctx().user` / `ctx().tenant` — exatamente o que a auth e a tenancy fazem em
produção, e por isso guards, scoping por tenant e trilhos de auditoria
comportam-se de forma idêntica em qualquer adaptador. Nunca registes esse plugin
numa app real; só o `createTestApp` o acrescenta.

## Início rápido

Um ficheiro, copiável, que arranca e passa:

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

    await app.shutdown() // sempre — corre o hook de shutdown de cada plugin
  })
})
```

O `createTestApp` aceita tudo o que o `createApp` aceita (`plugins`, `config`)
mais `adapter`, arranca a app por ti e devolve um `TestApp`. No caminho por
predefinição não há `listen()` nem `fetch`: os pedidos entram diretamente no
encaminhamento.

## Fazer pedidos

O `request(method, url, options)` é a primitiva; o resto é açúcar por cima dela.

```ts
await app.get('/projects')
await app.post('/projects', { name: 'Launch' })              // corpo no 2.º argumento
await app.put('/projects/1', { name: 'Renamed' })
await app.patch('/projects/1', { name: 'Renamed' })
await app.delete('/projects/1')
await app.request('HEAD', '/projects')                        // qualquer outro verbo

await app.get('/projects', { headers: { 'accept-language': 'pt-PT' } })
```

Os corpos são serializados como o `inject` do Fastify o faz: um objeto simples
torna-se JSON com `content-type: application/json`, uma string é enviada tal e
qual, e um corpo em `GET`/`HEAD` é descartado. Todos os adaptadores devolvem o
mesmo `TestResponse`:

```ts
const res = await app.post('/projects', { name: 'Launch' })
res.statusCode          // 201
res.headers['location'] // os nomes dos headers vêm em minúsculas
res.body                // o corpo em bruto, como string
res.json<Project>()     // parseado — síncrono, sem await
```

O `res.json()` é síncrono de propósito, para que uma assertion nunca precise de
mais um `await`. Em Express e Hono a resposta é reconstruída a partir de uma
`Response` de `fetch` real; vários headers `Set-Cookie` são reunidos em
`headers['set-cookie']` como array.

## Agir como um utilizador ou tenant

Salta a ida ao login e declara de quem vem o pedido. As predefinições são fixas
(os métodos devolvem `this`, por isso encadeiam-se), e qualquer pedido
individual pode substituí-las:

```ts
const app = await createTestApp({ plugins: [/* … */] })

app.actingAs({ id: 'u1', email: 'ana@acme.io' }) // passa a ser ctx().user
   .asTenant('acme')                              // passa a ser ctx().tenant — { id: 'acme' }

await app.post('/projects', { name: 'Launch' })   // como a Ana, em acme

// Substituição pontual, sem mexer nas predefinições:
await app.get('/projects', { user: { id: 'u2' }, tenant: { id: 'globex', plan: 'pro' } })
```

O `actingAs` aceita qualquer objeto com um `id` (os campos extra são
preservados, por isso `{ id, email, platformAdmin: true }` chega intacto a
`ctx().user`). O `asTenant` aceita uma string — expandida para `{ id }` — ou um
objeto completo com forma de tenant.

::: tip Dica: a personificação salta a autenticação, não a autorização
O enricher define o contexto; não emite um token. Os guards continuam a correr:
uma rota `meta: { can: 'projects:delete' }` continua a consultar o
`@basaltkit/permissions`, e `meta: { teamRole: 'admin' }` continua a consultar o
store de membros. Por isso o `actingAs` é a forma certa de testar que um
*member* recebe `403 TEAM_ROLE_REQUIRED` — semeia o membro, não finjas o
veredicto. Vê [Autorização](/pt/guide/authorization) e [Equipas](/pt/guide/teams).
:::

## Correr a mesma suite em Express ou Hono

O `adapter` decide apenas como os pedidos são despachados — o plugin do
adaptador correspondente continua a ser registado por ti:

```ts
import { expressPlugin } from '@basaltkit/express'
import { createTestApp } from '@basaltkit/testing'

const app = await createTestApp({
  adapter: 'express', // ou 'hono'; por predefinição 'fastify'
  plugins: [expressPlugin({ routes: [health] })],
})
const res = await app.get('/health') // mesmos helpers, mesmo TestResponse
await app.shutdown()                 // fecha também o socket em escuta
```

| `adapter` | Como viaja um pedido | Socket | Instalação extra |
| --- | --- | --- | --- |
| `'fastify'` (predefinição) | `server.inject()` — in-process, ligado de forma lazy no primeiro pedido | nenhum | nenhuma |
| `'express'` | `listen(0, '127.0.0.1')` no arranque, depois `fetch` | porta local efémera, fechada pelo `shutdown()` | `@basaltkit/express` + `express` |
| `'hono'` | `hono.fetch(new Request('http://basalt.test' + url))` — in-process | nenhum | `@basaltkit/hono` + `hono` |

O `@basaltkit/express` e o `@basaltkit/hono` são **peers opcionais** do
`@basaltkit/testing`: o caminho Fastify nunca os carrega, e uma instalação em
falta falha com uma mensagem acionável em vez de `ERR_MODULE_NOT_FOUND`. Como só
o despacho difere, um `describe.each(['fastify', 'express', 'hono'])`
parametrizado é o teste de conformidade mais barato para tudo o que é escrito
contra o contrato neutro do `@basaltkit/http` — vê
[Adaptadores HTTP](/pt/guide/adapters).

::: warning Aviso: `app.server()` é só para Fastify, e é assíncrono
O `await app.server()` resolve o token `FASTIFY`. Em `'express'` / `'hono'` lança
`DI_UNKNOWN_TOKEN` — resolve antes `EXPRESS` / `HONO` a partir de
`app.container`.

Passou a método na 2.0: o `@basaltkit/fastify` é agora um peer opcional,
carregado a pedido, para este pacote nunca conseguir pôr uma segunda cópia do
adaptador na tua árvore.
:::

## O fake de mail

O `fakeMailer()` troca o driver de mail por um que grava. Devolve um `.plugin`
que registas (reclama o mesmo nome `basalt:mailer` que o `mailerPlugin` real,
por isso regista **um ou o outro**) mais assertions ao estilo Laravel:

```ts
import { createTestApp, fakeMailer } from '@basaltkit/testing'
import { InviteEmail } from '../src/mail/invite.js'

const mail = fakeMailer({ from: 'no-reply@acme.io' })
const app = await createTestApp({ plugins: [fastifyPlugin({ routes }), mail.plugin] })

await app.actingAs({ id: 'u1' }).post('/team/invites', { email: 'bob@acme.io' })

const message = mail.assertSent(InviteEmail)                       // pela definição
mail.assertSent('invite', (m) => m.to.includes('bob@acme.io'))     // …ou por nome + predicado
expect(message.subject).toContain('acme')

mail.sent            // ResolvedMail[] — tudo, por ordem
mail.assertNothingSent() // lança se algo tiver sido enviado
```

Cada mensagem gravada é um `ResolvedMail` totalmente **renderizado**:
`{ mail, to, from, cc, bcc, replyTo?, subject, text?, html? }`. Ou seja, os
templates de assunto/corpo, o `layout` partilhado e o escape de HTML correram
mesmo — verifica as strings renderizadas, não os dados de entrada. O
`assertSent` devolve a primeira correspondência para poderes aprofundar; uma
falha lança `MailAssertionError` a listar o que *foi* enviado.

::: warning Aviso: o objeto de opções substitui o remetente por predefinição
O `fakeMailer()` sem argumentos assume `{ from: 'test@basalt.dev' }`. Passa
quaisquer opções e essa predefinição desaparece — `fakeMailer({ layout })` não
tem `from`, por isso qualquer mail cujo envelope omita `to`/`from` falha com
`MailIncompleteError` (`MAIL_INCOMPLETE`). Inclui sempre `from` quando passares
opções.
:::

## O fake de fila

O `fakeQueue()` captura os despachos em vez de os correr, por isso um pedido em
teste devolve de imediato e verificas a *intenção*:

```ts
import { createTestApp, fakeQueue } from '@basaltkit/testing'
import { SendWelcome } from '../src/jobs/send-welcome.js'

const queue = fakeQueue({ jobs: [SendWelcome] }) // regista os jobs que despachas
const app = await createTestApp({ plugins: [fastifyPlugin({ routes }), queue.plugin] })

await app.actingAs({ id: 'u1' }).asTenant('acme').post('/auth/register', { /* … */ })

const job = queue.assertDispatched(SendWelcome, (j) => j.payload.userId === 'u1')
expect(job.queue).toBe('default')
expect(job.options.attempts).toBe(3)          // as AddJobOptions resolvidas
expect(job.context.tenantId).toBe('acme')     // o snapshot serializado do contexto

expect(await queue.drain()).toBe(1)           // agora corre mesmo o backlog
```

O `queue.dispatched` guarda cada captura por ordem como um `CapturedJob`:
`{ queue, job, payload, context, options }`. O `payload` e o `context` vêm do
envelope que o `QueueManager` construiu de facto — o `context` é o snapshot de
`requestId`, `correlationId`, `traceId`, `userId` e `tenantId`, por isso podes
verificar que um job despachado dentro de um tenant leva esse tenant até ao
worker. As `options` são as `AddJobOptions` resolvidas (`attempts`, `backoff`,
`delayMs`, `priority`, `removeOnComplete`, `removeOnFail`), que é como testas
uma declaração `defineJob({ attempts, backoff })` sem um Redis.

O `drain()` executa o backlog pelos handlers **reais**, restaurando primeiro o
contexto de cada job, e devolve quantos correram. Esvazia o backlog pendente mas
deixa `dispatched` intacto, por isso as assertions continuam a funcionar depois.
Chama-o para testar o handler e a rota de uma vez; deixa-o de fora para provar
que a rota apenas *enfileirou*. Mais sobre jobs em [Filas e jobs](/pt/guide/queues).

## Viajar no tempo

O `time` desloca o relógio sem depender do test runner:

```ts
import { time } from '@basaltkit/testing'
import { afterEach } from 'vitest'

afterEach(() => time.restore()) // faz isto uma vez, no topo do ficheiro

await app.actingAs(user).post('/subscribe', { plan: 'pro' })

time.travel('15d')                    // relativo, cumulativo — aceita qualquer DurationInput
time.travel('2h')                     // …agora 15 dias e 2 horas à frente
time.travelTo(new Date('2027-01-01')) // absoluto — substitui o offset

const res = await app.get('/subscription')
expect(res.json().status).toBe('expired')
```

Faz patch a `globalThis.Date` para que `Date.now()` e `new Date()` devolvam o
"agora" deslocado; `new Date(2026, 0, 1)` e `new Date(ms)` ficam intactos,
porque só o tempo *atual* se move. Os temporizadores **não** levam patch — o
`setTimeout` continua a contar milissegundos reais; usa os fake timers do teu
runner se também precisares disso.

::: danger Perigo: o relógio é global ao processo
O offset e o patch vivem em estado de módulo, não por `TestApp`. Um teste que
viaja e nunca chama `time.restore()` corrompe todos os testes seguintes no mesmo
worker — tipicamente sob a forma de um token misteriosamente expirado. Usa
sempre `afterEach(() => time.restore())`, e nunca corras ficheiros que viajam no
tempo com concorrência dentro do ficheiro.
:::

## Referência de opções

`createTestApp(options)` — tudo o que vem de `CreateAppOptions`, mais `adapter`:

| Opção | Tipo | Predefinição | Objetivo |
| --- | --- | --- | --- |
| `plugins` | `BasaltPlugin[]` | `[]` | Os plugins da tua app. O plugin de personificação é anteposto automaticamente |
| `config` | `Record<string, unknown>` | `{}` | Config em bruto indexada pelo nome do plugin, validada pelo `configSchema` de cada um |
| `adapter` | `'fastify' \| 'express' \| 'hono'` | `'fastify'` | Como os pedidos são despachados. `'express'`/`'hono'` exigem o peer opcional instalado |

`TestApp`:

| Membro | Tipo | Objetivo |
| --- | --- | --- |
| `app` | `BasaltApp` | A app arrancada — chega a `app.hooks` a partir daqui para verificar eventos emitidos |
| `container` | `Container` | Resolve serviços (`container.get(TEAMS)`) para semear estado diretamente em vez de por HTTP |
| `server` | `FastifyInstance` | A instância Fastify em bruto. **Só no adaptador Fastify** |
| `actingAs(user)` | `(TestActor) => this` | Define o `ctx().user` por predefinição. `TestActor` é `{ id, email?, …qualquer }` |
| `asTenant(tenant)` | `(string \| { id }) => this` | Define o `ctx().tenant` por predefinição. Uma string é expandida para `{ id }` |
| `request(method, url, options?)` | `Promise<TestResponse>` | Despacha qualquer verbo |
| `get/delete(url, options?)` | `Promise<TestResponse>` | Açúcar, sem corpo |
| `post/put/patch(url, payload?, options?)` | `Promise<TestResponse>` | Açúcar, corpo no segundo argumento |
| `shutdown()` | `Promise<void>` | Fecha o socket do driver (Express) **e** corre o shutdown de cada plugin |

`TestRequestOptions` (o último argumento de cada helper):

| Opção | Tipo | Predefinição | Objetivo |
| --- | --- | --- | --- |
| `payload` | `unknown` | — | Corpo do pedido. Objetos são codificados em JSON; ignorado em `GET`/`HEAD` |
| `headers` | `Record<string, string>` | `{}` | Headers extra — negociação de conteúdo, chaves de idempotência, um `authorization` a sério |
| `user` | `TestActor` | de `actingAs` | Personifica outro utilizador só neste pedido |
| `tenant` | `string \| { id, … }` | de `asTenant` | Personifica outro tenant só neste pedido |

`fakeMailer(options?)` — `options` é um `MailerOptions` (`from`, `replyTo`,
`layout`), por predefinição `{ from: 'test@basalt.dev' }`:

| Membro | Tipo | Objetivo |
| --- | --- | --- |
| `plugin` | plugin | Regista-o em `plugins` — reclama o nome `basalt:mailer` |
| `sent` | `ResolvedMail[]` | Todas as mensagens renderizadas, por ordem de envio |
| `assertSent(mail, predicate?)` | `(MailDefinition \| string, fn?) => ResolvedMail` | Devolve a primeira correspondência; lança `MailAssertionError` se não houver |
| `assertNothingSent()` | `() => void` | Lança (nomeando o que foi enviado) se algo tiver saído |

`fakeQueue(options?)`:

| Opção / membro | Tipo | Objetivo |
| --- | --- | --- |
| `jobs` | `JobDefinition[]` | Jobs a registar para que `job.dispatch()` fique ligado — igual a `queuePlugin({ jobs })` |
| `plugin` | plugin | Regista-o em `plugins` — reclama o nome `basalt:queue` |
| `dispatched` | `CapturedJob[]` | `{ queue, job, payload, context, options }` por despacho, por ordem |
| `assertDispatched(job, predicate?)` | `(JobDefinition \| string, fn?) => CapturedJob` | Devolve a primeira correspondência; lança `QueueAssertionError` se não houver |
| `assertNothingDispatched()` | `() => void` | Lança (nomeando o que foi despachado) se algo tiver sido enfileirado |
| `drain()` | `() => Promise<number>` | Corre o backlog pendente pelos handlers reais, com o contexto restaurado |

`time`:

| Membro | Tipo | Objetivo |
| --- | --- | --- |
| `travel(duration)` | `(DurationInput) => void` | Soma ao offset — `'15d'`, `'2h'`, `90_000` |
| `travelTo(date)` | `(Date) => void` | Define o offset para que o "agora" seja esse instante |
| `restore()` | `() => void` | Desfaz o patch a `Date` e zera o offset. Obrigatório no `afterEach` |

## Modos de falha e resolução de problemas

| Erro | Código | HTTP | Quando |
| --- | --- | --- | --- |
| `Error: createTestApp({ adapter: 'express' }) requires @basaltkit/express …` | — | boot | `adapter: 'express'`/`'hono'` sem o peer opcional (e a respetiva framework) instalado |
| `UnknownTokenError` | `DI_UNKNOWN_TOKEN` | — | `await app.server()` num adaptador que não é Fastify, ou um pedido sem plugin de adaptador em `plugins` |
| `PluginDependencyError` | `PLUGIN_DEPENDENCY` | boot | `Duplicate plugin` — `fakeMailer().plugin` ao lado do `mailerPlugin`, ou `fakeQueue().plugin` ao lado do `queuePlugin` |
| `UnguardedRouteMetaError` | `HTTP_UNGUARDED_ROUTE_META` | boot | Uma rota em teste declara `meta.auth` / `meta.can` / `meta.teamRole` mas a app de teste não registou o plugin que a impõe |
| `TenantRequiredError` | `TENANT_REQUIRED` | 400 | Código com scope de tenant correu sem tenant — chama `.asTenant('acme')` |
| `NotATeamMemberError` | `TEAM_NOT_A_MEMBER` | 403 | Uma rota `meta.teamRole` correu sem utilizador **ou** sem tenant em contexto, ou o membro nunca foi semeado |
| `InvalidCanMetaError` | `PERMISSION_META_INVALID` | 500 | Uma rota declara `meta.can` com uma forma que o guard não consegue impor — todos os pedidos falham fechados |
| `JobNotRegisteredError` | `QUEUE_JOB_NOT_REGISTERED` | — | `job.dispatch()` de um job nunca passado a `fakeQueue({ jobs })` |
| `MailAssertionError` | `TEST_MAIL_ASSERTION` | — | O `assertSent` / `assertNothingSent` falhou |
| `QueueAssertionError` | `TEST_QUEUE_ASSERTION` | — | O `assertDispatched` / `assertNothingDispatched` falhou |

- **Um teste passa sozinho e falha na suite** — é quase sempre o relógio. O
  `time` é global ao processo; acrescenta `afterEach(() => time.restore())` ao
  ficheiro que viaja.
- **O `assertDispatched` não encontra nada apesar de o trabalho ter acontecido**
  — registaste o `queuePlugin` real. Sem ligação Redis, ele recai no driver
  **sync**, que corre os jobs inline: o efeito acontece, mas nada é capturado.
  Regista antes o `fakeQueue().plugin`.
- **`403`/`401` numa rota onde acabaste de personificar** — a personificação
  preenche o contexto, não satisfaz os guards. Regista o plugin que impõe
  (`authPlugin` / `permissionsPlugin` / `teamsPlugin`) *e* semeia a atribuição ou
  o membro através de `app.container`.
- **A suite fica pendurada, ou os testes Express deixam portas abertas** — falta
  um `await app.shutdown()`. É ele que fecha o socket efémero e corre o shutdown
  de drivers/ligações; põe-no no `afterEach`.
- **`TENANT_REQUIRED` em código que "obviamente" tem tenant** — o tenant só
  existe dentro de um pedido. Chamadas a serviços feitas diretamente sobre
  `app.container` correm fora do enricher, por isso passa o tenant
  explicitamente ou envolve-as num pedido. Vê [Tenancy](/pt/guide/tenancy).

## Para onde a seguir

- [Adaptadores HTTP](/pt/guide/adapters) — o contrato neutro que faz de
  `adapter: 'express' | 'hono'` uma mudança de uma linha.
- [Filas e jobs](/pt/guide/queues) — `defineJob`, retentativas e os drivers por
  trás do `fakeQueue`.
- [Notificações e mail](/pt/guide/notifications) — os mails que o `fakeMailer`
  renderiza.
- [Equipas](/pt/guide/teams) e [Autorização](/pt/guide/authorization) — os guards
  que exercitas com `actingAs` / `asTenant`.
- [Construir um SaaS de notas](/pt/cookbook/notes-saas) — o harness usado ponta
  a ponta.
