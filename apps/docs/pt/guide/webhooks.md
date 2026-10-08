# Webhooks

O `@basaltkit/webhooks` entrega webhooks **de saída**: payloads assinados, retries
com backoff, subscrições por tenant e dispatch automático a partir dos teus
eventos de domínio. Está desacoplado do teu domínio — nada no teu código precisa
de saber que existe um endpoint — e do transporte, porque a entrega é um simples
`POST` assinado que qualquer recetor consegue verificar.

[[toc]]

## Modelo mental

Três peças, cada uma substituível:

| Peça | Contrato | O que faz |
| --- | --- | --- |
| **Store** | `WebhookStore` | Onde vivem as subscrições. Responde a "quem quer `invoice.paid` do tenant `acme`?" |
| **Deliverer** | `WebhookDeliverer` | Assina o corpo, valida o URL contra SSRF, faz `POST` e repete falhas transitórias |
| **Manager** | `WebhookManager` (token `WEBHOOKS`) | Regista/lista/remove endpoints e faz `dispatch(event, data)` a todos os que correspondem |

O `dispatch` é o fluxo inteiro: o manager pede ao store os endpoints que
correspondem ao evento *e* ao tenant, entrega cada um ao deliverer e devolve um
`DeliveryResult` por endpoint. Nada é persistido sobre a tentativa — se precisares
de um registo de auditoria, guarda os resultados tu; se precisares que a entrega
sobreviva a um crash, usa o outbox (abaixo).

O scoping por tenant é **anti-alargamento** em todo o lado: um `ctx().tenant.id`
ambiente ganha sempre a um `tenantId` passado pelo chamador, por isso o input do
cliente nunca consegue alargar nem trocar o âmbito.

## Arranque rápido

`webhooksPlugin` regista um `WebhookManager` sob o token `WEBHOOKS`. A única
opção quase obrigatória é um `secret` de assinatura por predefinição:

```ts
import { createApp } from '@basaltkit/core'
import { webhooksPlugin, WEBHOOKS } from '@basaltkit/webhooks'

const app = await createApp({
  plugins: [
    webhooksPlugin({ secret: process.env.WEBHOOK_SECRET }),
  ],
}).boot()

const hooks = app.container.get(WEBHOOKS)

await hooks.register({ url: 'https://customer.example.com/hooks', events: ['invoice.*'] })
await hooks.dispatch('invoice.paid', { id: 'in_1', amount: 42 })
```

O `secret` por predefinição tem de ter pelo menos 16 caracteres
(`MIN_WEBHOOK_SECRET_LENGTH`; o `generateWebhookSecret()` gera um forte) — um mais
curto recusa arrancar. As entregas **nunca saem sem assinatura por
predefinição**: sem secret por endpoint e sem `secret` por predefinição, a
entrega é recusada (`error: 'no signing secret; refusing unsigned delivery'`). O
`allowUnsigned: true` é o opt-out explícito.

O `secret` por predefinição só assina endpoints **sem tenant**. Cada endpoint
ligado a um tenant é assinado com o **seu próprio** secret — o `register()` gera
um quando não o passas — porque um secret partilhado por todos os tenants
permitiria a um tenant forjar webhooks que o recetor de outro tenant aceita. Um
endpoint de tenant guardado sem secret próprio é recusado (`allowSharedSecret:
true` é o opt-out para dados legados).

## Gerir subscrições

Um **endpoint** é uma subscrição: um URL de destino mais os padrões de evento que
quer. Regista, lista e remove-os através do manager:

```ts
const endpoint = await hooks.register({
  url: 'https://customer.example.com/hooks',
  events: ['invoice.*', 'user.created'], // padrões: exato, prefixo `x.*`, ou `*`
  tenantId: 'acme',        // ligado a partir de ctx() quando há tenant no contexto
  secret: 'whsec_acme_...',// opcional; gerado para endpoints de tenant quando omitido
  active: true,            // define false para desativar sem apagar
})
endpoint.secret             // devolvido UMA vez — entrega-o ao cliente agora

await hooks.list()          // todos os endpoints (sem tenant no contexto) — secrets ocultados
await hooks.list('acme')    // só os endpoints do tenant "acme"
await hooks.unregister(endpoint.id)
```

O `register()` devolve o endpoint guardado **incluindo o seu secret de
assinatura** — gerado como `whsec_…` (32 bytes aleatórios) para um endpoint de
tenant, ou para qualquer endpoint quando não há `secret` por predefinição. O
`list()` nunca devolve secrets: cada item é um `WebhookEndpointView` com
`hasSecret: boolean`, por isso uma rota de gestão não os consegue divulgar. Para
trocar um secret sem partir o recetor, usa o `rotateSecret()`
([abaixo](#rodar-um-secret-de-assinatura)).

O `register()` valida o endpoint **antes de o guardar**, para que uma subscrição
que nunca poderia ser entregue seja recusada logo, em vez de falhar em cada
evento: o `url` tem de ser um URL absoluto com um esquema que o deliverer aceite
(`http:`/`https:`, ou o teu `ssrf.allowedSchemes`) e uma porta que a sua
[política de portas](#politica-de-portas) aceite, um `secret` que passes tem de
ter pelo menos 16 caracteres, e `events` tem de ser uma lista não vazia de
padrões não vazios — caso contrário lança `WebhookEndpointInvalidError`
(`WEBHOOK_ENDPOINT_INVALID`, 400). Se o host é público continua a ser decidido na
entrega, onde o DNS é resolvido e a ligação fixada. Um `id` fornecido pelo
chamador que outro âmbito (outro tenant, ou global vs tenant) já detém lança
`WebhookEndpointIdInUseError` (`WEBHOOK_ENDPOINT_ID_IN_USE`, 409); cada store
incluída impõe isto na sua própria escrita, por isso dois registos concorrentes
do mesmo id não se sobrepõem.

O scoping é **anti-alargamento**: dentro de um pedido com tenant no contexto,
`register`, `list`, `unregister` e `dispatch` ficam forçados a esse tenant — um
`tenantId` passado pelo chamador (que pode transportar input do cliente) nunca
consegue alargar ou trocar o âmbito. O argumento explícito e o comportamento
system-wide acima aplicam-se apenas onde não há tenant ambiente (jobs, CLI, apps
single-tenant). `unregister` é um no-op — não um erro — para um endpoint que
pertence a outro tenant. O manager volta a verificar a propriedade ele próprio (o
endpoint tem de aparecer no `list()` desse tenant) antes de chamar
`store.remove`, por isso nem um store cujo `remove` ignore o argumento `tenantId`
pode ser usado para apagar um endpoint de outro tenant.

**Fail-closed quando a tenancy está ativa.** Quando o `tenancyPlugin` está
registado (o seu marcador `'tenancy:active'`), uma chamada de gestão sem tenant
nenhum — sem tenant no contexto e sem `tenantId` explícito — lança
`WebhookTenantRequiredError` (`WEBHOOKS_TENANT_REQUIRED`) em vez de correr sem
âmbito. Isso impede uma rota central de criar um endpoint global que receberia
os eventos de todos os tenants, ou de listar/apagar os endpoints de todos os
tenants. Operações de sistema deliberadas dizem-no explicitamente:

```ts
await hooks.register({ url, events }, { system: true })       // endpoint global, de propósito
await hooks.list(undefined, { system: true })                 // endpoints de todos os tenants
await hooks.unregister(id, { tenantId: 'acme' })              // remoção com âmbito fora do pedido
await hooks.unregister(id, { system: true })                  // remoção sem âmbito, de propósito
```

Os padrões de evento correspondem assim:

- `'invoice.paid'` — apenas esse evento exato
- `'invoice.*'` — qualquer evento que comece por `invoice.`
- `'*'` ou `'**'` — todos os eventos

```ts
import { matchesEvent } from '@basaltkit/webhooks'
matchesEvent(['invoice.*'], 'invoice.paid') // true
```

Só endpoints com `active !== false` recebem entregas; pôr `active` a `false` é a
forma reversível de travar um endpoint de cliente instável.

### Rodar um secret de assinatura

O `rotateSecret()` dá a um endpoint um secret novo **sem partir o seu
recetor**. Durante uma janela de tolerância, cada entrega é assinada com o
secret novo e com o antigo: `t=…,v1=<novo>,v1=<antigo>`. Um recetor que ainda
verifica com o secret antigo continua a funcionar, e pode trocar quando estiver
pronto:

```ts
const { secret } = await hooks.rotateSecret(endpoint.id, {
  graceSeconds: 7 * 86_400, // default 24 h; no máximo 30 dias; 0 = corte imediato
  // secret: 'whsec_…',     // opcional; gerado quando omitido (mín. 16 caracteres)
})
// entrega `secret` ao cliente — o antigo deixa de assinar ao fim de 7 dias
```

O âmbito funciona como no `unregister`: um endpoint fora do tenant ambiente (ou
dado) lança `WebhookEndpointNotFoundError` (`WEBHOOK_ENDPOINT_NOT_FOUND`, 404),
e com tenancy ativa e sem tenant precisa de `{ system: true }`. O secret
anterior nunca é devolvido (e o `list()` redige os dois). Usa `graceSeconds: 0`
depois de uma fuga — o secret antigo deixa logo de assinar. Voltar a registar o
endpoint com o mesmo `id` também termina uma rotação em curso. Um endpoint que
assina com o `secret` por omissão do plugin não tem secret próprio para rodar
(`WebhookEndpointInvalidError`): roda o default na tua configuração, ou regista o
endpoint com o seu próprio secret.

A rotação vive no endpoint como `previousSecret` + `previousSecretExpiresAt`; o
deliverer ignora um secret anterior sem expiração, ou depois de ela passar. O
`webhooks-sqlite` acrescenta as colunas sozinho. O `webhooks-prisma` precisa dos
dois campos no teu schema (`basalt prisma:sync`) antes da primeira rotação.

### Selar secrets em repouso

Por omissão o secret de assinatura de um endpoint é guardado tal como chega,
por isso um dump da base de dados contém a chave de todos os clientes. Passa um
`secretBox` e o manager sela cada secret antes da escrita no store e abre-o
mesmo antes de uma entrega — os stores não dão por nada e persistem a string que
recebem:

```ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { webhooksPlugin, WebhookSecretNotSealedError, type WebhookSecretBox } from '@basaltkit/webhooks'

const key = Buffer.from(process.env.WEBHOOK_SEAL_KEY!, 'base64') // 32 bytes
const aad = (c: { endpointId: string; tenantId?: string | null }) => Buffer.from(`${c.endpointId}\0${c.tenantId ?? ''}`)

const secretBox: WebhookSecretBox = {
  seal(plain, context) {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv).setAAD(aad(context))
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
    return `v1:${Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url')}`
  },
  open(sealed, context) {
    if (!sealed.startsWith('v1:')) throw new WebhookSecretNotSealedError() // uma linha legada em claro
    const raw = Buffer.from(sealed.slice(3), 'base64url')
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12)).setAAD(aad(context))
    decipher.setAuthTag(raw.subarray(12, 28))
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8')
  },
}

webhooksPlugin({ store, secretBox })
```

- **Traz a tua própria criptografia.** O `@basaltkit/webhooks` não traz cifra
  nenhuma: a box pode ser uma chamada a um KMS, um vault, ou o esboço AES-GCM
  acima — qualquer objeto com `seal(plain, context)` e `open(sealed, context)`
  (síncronos ou assíncronos). Um envelope que já uses noutro lado (por exemplo o
  que o teu armazenamento de ficheiros usa para selar chaves) é igualmente válido.
- **Associa o contexto.** O `context` é `{ endpointId, tenantId }`. Metê-lo no
  texto cifrado (additional data do AES-GCM, encryption context de um KMS)
  significa que um secret selado copiado para a linha de outro endpoint deixa de
  abrir.
- **O que é selado.** O `register()` sela o secret que gera ou recebe, o
  `rotateSecret()` sela o secret novo e o anterior. Ambos continuam a **devolver
  o texto em claro** — o único momento em que o entregas ao cliente. O `list()`
  nunca devolve secrets, com ou sem box.
- **Linhas legadas.** As linhas escritas antes de ativares a box guardam texto em
  claro. Continuam a entregar: um valor para o qual o `isSealed(value)` opcional
  devolve `false`, ou cujo `open()` lança `WebhookSecretNotSealedError`, é usado
  tal como está. O próximo `rotateSecret()` (ou novo `register()`) do endpoint
  escreve-o selado.
- **Falhas.** Qualquer outro erro do `open()` faz falhar a entrega desse endpoint
  (`error: 'could not open the endpoint signing secret'`, `retryable: true`, para
  que o outbox volte a tentar depois de uma falha do KMS); a causa é registada
  apenas com o id do endpoint. Um secret anterior já expirado nunca é aberto.

## Fazer dispatch de eventos

`dispatch(event, data, tenantId?)` encontra todos os endpoints subscritos (os do
próprio tenant mais os globais) e entrega um `POST` assinado a cada um,
devolvendo um `DeliveryResult` por endpoint:

```ts
const results = await hooks.dispatch('invoice.paid', { id: 'in_1', amount: 42 }, 'acme')
// [{ endpointId: '...', ok: true, status: 200, attempts: 1 }]
```

O scoping é **fail-closed**. Um dispatch sem tenant — sem tenant em `ctx()` e sem
`tenantId` explícito, como a partir de um job agendado, de um webhook de billing
ou de uma rota central — chega **só a endpoints sem tenant**, nunca a um ligado a
um tenant, por isso os dados de evento de um tenant não se espalham pelos
endpoints de outro. Um broadcast de sistema deliberado faz opt-in explícito (é
ignorado dentro de um contexto de tenant):

```ts
await hooks.dispatch('maintenance.scheduled', { at }, { allTenants: true })
```

O manager volta a aplicar o filtro de tenant ao que o store devolve, por isso um
store personalizado que ignore o argumento `tenantId` não consegue alargar a
entrega.

Cada resultado é `{ endpointId, ok, status?, attempts, error?, retryable? }` —
persiste-o para um registo de auditoria. `retryable` (nas falhas) diz se tentar
mais tarde pode resultar. Uma entrega que lança inesperadamente (por exemplo, uma
linha malformada do store) torna-se um resultado falhado com
`error: 'internal delivery error'` em vez de rejeitar o `dispatch` inteiro. As entregas correm em paralelo — no máximo
`dispatchConcurrency` (default 16) de cada vez — e o `dispatch` só
resolve quando todas terminam, por isso um endpoint que gasta todo o orçamento de
retries atrasa a chamada inteira: faz `dispatch` a partir de um job ou do outbox,
não inline num handler de pedido.

### Tecto de fan-out

Um único `dispatch` recusa um âmbito — um tenant, ou os endpoints sem tenant —
cujos **endpoints ativos subscritos ao evento** excedam
`maxEndpointsPerDispatch` (default 100). Escolher só alguns seria arbitrário,
por isso o âmbito inteiro é recusado e nenhum dos seus endpoints recebe nada.
Cada um recebe um resultado falhado (`attempts: 0`, `retryable: false`,
`error: 'fan-out cap exceeded: …'`), e o `onFanOutExceeded` é chamado uma vez
para esse âmbito (default `console.warn`). Os outros âmbitos do mesmo dispatch —
os endpoints globais ao lado dos de um tenant, ou outros tenants num broadcast
`allTenants` — não são afetados. O outbox trata a recusa como falha permanente
(`onPermanentFailure`).

```ts
webhooksPlugin({
  secret,
  maxEndpointsPerDispatch: 25,  // ou false para desligar
  dispatchConcurrency: 8,
  onFanOutExceeded: ({ event, tenantId, endpoints, limit }) =>
    metrics.increment('webhooks.fanout_refused', { event, tenantId }),
})
```

### O que o destinatário recebe

```
content-type: application/json
x-basalt-event: invoice.paid
x-basalt-delivery: 5f0c…-uuid
x-basalt-signature: t=1712345678,v1=<hmac-sha256(t.body)>

{"id":"5f0c…-uuid","event":"invoice.paid","endpointId":"ep_…","data":{"id":"in_1","amount":42},"sentAt":"2026-08-07T10:00:00.000Z"}
```

O `id` (também em `x-basalt-delivery`) é único por entrega e estável entre os
retries dessa entrega — faz dedup por ele para tornar inofensivo um replay dentro
da janela de tolerância. Através do outbox é derivado do id da entrada do outbox e
do id do endpoint, por isso mantém-se também entre retries do outbox e reinícios;
`dispatch(event, data, { idempotencyKey })` dá a mesma garantia aos teus próprios
jobs. Cada tentativa é assinada com o seu **próprio** timestamp `t`, para que um
retry depois de um backoff longo continue dentro da tolerância do recetor; o corpo
(com o seu `id` e `sentAt`) é idêntico em todas as tentativas. O `endpointId` identifica a subscrição para a qual foi
assinado. Ambos estão dentro do corpo assinado, por isso nenhum pode ser alterado
sem partir a assinatura.

O prefixo `x-basalt` é o default. Produtos white-label podem escolher o seu com
`headerPrefix` (minúsculas, `[a-z][a-z0-9-]{0,31}`, validado quando o deliverer
é construído): `headerPrefix: 'x-acme'` envia `x-acme-event`, `x-acme-delivery`
e `x-acme-signature`. Um recetor lê os mesmos nomes com
`webhookHeaderNames(prefix)`:

```ts
import { verifySignature, webhookHeaderNames } from '@basaltkit/webhooks'

const names = webhookHeaderNames('x-acme') // { event, delivery, signature }
const ok = verifySignature(request.headers[names.signature] as string, body.bytes, secret)
```

## Dispatch automático a partir de eventos de domínio

Liga o bus uma vez e os eventos de domínio correspondentes espalham-se
automaticamente pelos endpoints subscritos — restritos ao tenant a partir do
contexto do pedido e fire-and-forget, para que o emissor nunca bloqueie em HTTP.
Isto requer `@basaltkit/events`:

```ts
import { createApp } from '@basaltkit/core'
import { defineEvent, EVENTS, eventsPlugin } from '@basaltkit/events'
import { webhooksPlugin } from '@basaltkit/webhooks'

const app = await createApp({
  plugins: [
    eventsPlugin(),
    webhooksPlugin({
      secret: process.env.WEBHOOK_SECRET,
      events: ['invoice.*', 'user.created'], // eventos de domínio a reencaminhar
    }),
  ],
}).boot()

const InvoicePaid = defineEvent<{ amount: number }>('invoice.paid')
await app.container.get(EVENTS).emit(InvoicePaid, { amount: 42 })
// → entregue a todos os endpoints subscritos a "invoice.*"
```

::: warning Aviso
O dispatch automático precisa de `eventsPlugin()` registado — o plugin declara
essa dependência quando `events` não está vazio. O tenant vem de
`ctx().tenant.id`; quando emites fora de um pedido (ex. num job) não há tenant no
contexto, por isso o evento chega apenas aos endpoints **globais**. Faz dispatch
manual com um `tenantId` explícito quando precisares de scoping por tenant fora
do caminho do pedido.
:::

Fire-and-forget também quer dizer **silencioso**: o listener faz
`void dispatch(...)`, por isso uma entrega falhada nunca chega ao emissor e nada
volta a tentar depois de gasto o orçamento em processo. É essa a troca — vê o
outbox abaixo quando perder um evento não for aceitável.

## Eventos de integração duráveis (outbox)

O auto-dispatch acima é **fire-and-forget** — uma entrega falhada ou um crash
entre "committed" e "delivered" perde o evento. Para entrega garantida usa o
**outbox**: os eventos de domínio são primeiro escritos num store transacional e
depois um relay publica-os aos subscritores com retries (**at-least-once**).
Requer o `eventsPlugin`.

```ts
import { webhooksPlugin, webhookOutboxPlugin, webhookOutboxDispatch, WEBHOOKS } from '@basaltkit/webhooks'
import { eventsPlugin, OUTBOX } from '@basaltkit/events'

createApp({
  plugins: [
    eventsPlugin(),
    webhooksPlugin({ store }),               // sem `events:` aqui — o outbox captura-os
    webhookOutboxPlugin({
      events: ['invoice.*', 'user.created'], // padrões a capturar (default '**')
      // store: new MyDurableOutboxStore(),  // durável em produção (default em memória)
      intervalMs: 5000,                      // poll do relay; 0 = flush manual via OUTBOX
      batchSize: 50,                         // entradas por flush
      maxAttempts: 10,                       // depois a entrada fica morta
      concurrency: 8,                        // entradas entregues em paralelo por flush
      tenantConcurrency: 4,                  // máx. de entregas em curso por tenant
      dispatchTimeoutMs: 10_000,             // espera máx. por entrada antes de avançar
    }),
  ],
})
```

O `webhookOutboxDispatch` só volta a pôr uma entrada na fila por uma falha
**transitória** (erro de rede, timeout, `5xx`, `408`/`429`). O retry salta os
endpoints que já aceitaram a entrada e reenvia o **mesmo** `id` de entrega aos
restantes — derivado do id da entrada e do id do endpoint, por isso mantém-se
também entre reinícios. Falhas permanentes (URL bloqueado pela guarda SSRF,
redirecionamento, outros `4xx`, secret de assinatura recusado) são reportadas via
`onPermanentFailure` (por omissão `console.warn`) e nunca voltam a pôr a entrada
na fila: repetir não as corrige e só voltaria a entregar a endpoints saudáveis. A
entrega continua **at-least-once** (a lista do que já foi entregue vive em
memória), por isso os subscritores fazem dedup pelo `id`. Uma entrada gravada sem
tenant no contexto chega só a endpoints sem tenant, tal como o `dispatch`.

O endpoint em falha ou pendurado de um tenant não consegue parar todos os
outros, por muitos eventos que emita:

- **Seleção justa.** As entradas em backoff não ocupam o lote (o relay pede mais
  entradas para as saltar), e quando o backlog de um tenant enche uma página
  inteira o relay volta a consultar *excluindo* os tenants já vistos, e depois
  intercala o lote em round-robin por tenant. Cada tenant mantém a sua própria
  ordem de `createdAt`.
- **Limite por tenant.** Um flush entrega até `concurrency` entradas em paralelo
  (default 8), mas um tenant nunca tem mais de `tenantConcurrency` entregas em
  curso (default `ceil(concurrency / 2)`), entre flushes.
- **Flush limitado.** Um flush espera no máximo `dispatchTimeoutMs` (default
  10 s) por uma entrada. Uma entrega mais lenta continua *destacada* — não é
  cancelada, nem falhada, nem reenviada entretanto — e o seu resultado é
  registado quando termina, por isso o relay continua a avançar para todos os
  outros tenants.

Define `concurrency: 1` para entrega estritamente sequencial. Resolve o token `OUTBOX`
para fazer o relay tu mesmo, ex. a partir de um worker de fila em vez do timer:

```ts
await container.get(OUTBOX).flush(webhookOutboxDispatch(container.get(WEBHOOKS)))
```

Suporta o outbox com um `OutboxStore` durável (a tua BD) para não perder nada
entre reinícios — o objetivo do padrão. Vê [Persistência](/pt/guide/persistence).

### Entradas mortas e falhas de flush

Duas falhas diferentes, tratadas em dois sítios diferentes:

- Uma **falha de dispatch por entrada** incrementa os `attempts` da entrada e
  regista `lastError`, depois faz backoff (exponencial a partir de 1 s, com teto
  de 60 s, contabilizado por processo de relay). Ao fim de `maxAttempts`
  (predefinição 10) a entrada fica **morta**: mantém-se no store com o seu
  `lastError` e nunca mais é enviada. O callback `onDead` do `Outbox` dispara uma
  vez — por predefinição escreve em `console.error`, porque um evento de
  integração silenciosamente perdido é o pior resultado possível.
- Uma **falha ao nível do flush** (o próprio `pending()` do store lança) não é um
  problema da entrada. O `onFlushError` do `outboxPlugin` existe para isso.

::: warning O `webhookOutboxPlugin` não expõe `onDead`
Só reencaminha `maxAttempts`, `concurrency`, `tenantConcurrency` e
`dispatchTimeoutMs` para o `Outbox` que constrói, por isso as entradas mortas vão
para `console.error`. Uma falha de flush ao nível do store vai para o seu
`onFlushError` (default `console.error`). Quando precisares de ser alertado por
um evento morto, liga o outbox tu mesmo com o `outboxPlugin` de
`@basaltkit/events` e o `webhookOutboxDispatch` como `dispatch`:
:::

```ts
import { eventsPlugin, outboxPlugin, type OutboxDispatch } from '@basaltkit/events'
import { WEBHOOKS, webhookOutboxDispatch, webhooksPlugin } from '@basaltkit/webhooks'

// Faz o relay pelo WebhookManager do contentor — o que o webhooksPlugin
// construiu, com o teu secretBox e a ligação à tenancy — depois do boot.
let relay: OutboxDispatch = () => {
  throw new Error('webhook relay not ready') // um tick antecipado só repete
}

const app = await createApp({
  plugins: [
    eventsPlugin(),
    webhooksPlugin({ store, secret: process.env.WEBHOOK_SECRET }),
    outboxPlugin({
      store: outboxStore,
      captureEvents: ['invoice.*', 'user.created'],
      intervalMs: 5000,
      dispatch: (entry) => relay(entry),
      maxAttempts: 10,
      onDead: (entry, error) => pager.page(`webhook outbox dead: ${entry.event}`, error),
      onFlushError: (error) => logger.error({ error }, 'outbox flush failed'),
    }),
  ],
}).boot()
relay = webhookOutboxDispatch(app.container.get(WEBHOOKS))
```

Regista **um** dos dois — ambos reclamam o token `OUTBOX`.

## Assinatura e verificação

Cada entrega carrega `X-Basalt-Signature: t=<unix>,v1=<hmac-sha256(t.body)>` — o
mesmo esquema que a Stripe usa. Os recetores recalculam o HMAC sobre
`timestamp.body` e comparam em tempo constante, rejeitando timestamps velhos para
evitar replay:

```ts
import { verifySignature } from '@basaltkit/webhooks'

// no teu recetor, sobre o corpo RAW do pedido (não um objeto reserializado):
const valid = verifySignature(
  req.headers['x-basalt-signature'] as string,
  rawBody,
  process.env.WEBHOOK_SECRET!,
  300, // tolerância em segundos (default) — rejeita timestamps mais velhos que isto
)
if (!valid) return res.status(400).end()
```

::: warning Verifica sobre o corpo raw
O HMAC é calculado sobre os bytes exatos enviados. Se a tua framework fizer parse
do JSON e tu voltares a fazer `JSON.stringify`, os bytes mudam e a verificação
falha. Captura o corpo raw (ex. `express.raw()` no Express) antes do parse.
:::

`signPayload(body, secret, timestampSeconds)` produz o mesmo header se precisares
de assinar manualmente. `verifySignature` devolve `false` para um
header malformado, um `v1` em falta, um timestamp fora da tolerância, um digest
diferente, ou um secret vazio/não definido ou com menos de 16 caracteres (assim um
recetor cuja env var `WEBHOOK_SECRET` falte falha fechado em vez de aceitar um
HMAC calculado com uma chave vazia). Um recetor pode tratá-lo como um único
booleano. A única exceção é um erro de configuração: um `toleranceSeconds` que
não seja um número finito ≥ 0 (ex. `Number(process.env.UNSET)` → `NaN`) ou um
`nowSeconds` não finito lança um `RangeError`, porque de outra forma tornaria
todos os timestamps "frescos" e desligaria em silêncio a proteção anti-replay.

Cada endpoint de tenant tem o seu próprio secret: um recetor verifica com **o
secret que o `register()` devolveu para o seu endpoint**, não com o default da
app.

Um header pode trazer **vários** `v1=` — um emissor a rodar o segredo assina com
o novo e com o antigo (`t=…,v1=<novo>,v1=<antigo>`), como faz a Stripe, e como
faz este deliverer durante a janela de tolerância de um
[`rotateSecret()`](#rodar-um-secret-de-assinatura).
`verifySignature` devolve `true` quando **qualquer** um bate com o teu segredo,
por isso o recetor continua a funcionar quer já tenha trocado de segredo quer
não. Esquemas desconhecidos (ex. `v0=`) são ignorados; um `t` duplicado é
rejeitado.

### Verificar bytes raw

`verifySignature` e `signPayload` aceitam o corpo como `string` **ou** como bytes
(`Buffer` / `Uint8Array`). O HMAC corre sobre `${t}.` seguido dos bytes do corpo —
uma string é primeiro codificada em UTF-8 — por isso uma string e o `Buffer` dos
seus bytes UTF-8 produzem a mesma assinatura, e as assinaturas de strings
existentes não mudam.

Passa os bytes quando o corpo pode não ser UTF-8 válido (um e-mail
`message/rfc822` reencaminhado, um payload binário): descodificá-los primeiro
para string substitui as sequências inválidas e o HMAC deixa de bater. Um
recetor Basalt recebe esses bytes exatos, em todos os adapters, a partir de uma
[rota `rawBody()`](/pt/guide/adapters#corpos-de-pedido-em-bruto-assinaturas-de-webhook):

```ts
import { rawBody, route } from '@basaltkit/http'
import { verifySignature } from '@basaltkit/webhooks'

route({
  method: 'POST',
  url: '/hooks/basalt',
  body: rawBody({ maxBytes: 256 * 1024 }),
  async handler({ body, request, reply }) {
    const ok = verifySignature(
      request.headers['x-basalt-signature'] as string,
      body.bytes, // o Buffer exatamente como chegou
      process.env.WEBHOOK_SECRET!,
    )
    if (!ok) return reply.code(400).send({ error: 'assinatura inválida' })
    const event = JSON.parse(body.text())
    // …
  },
})
```

## Semântica de entrega

- O `timeoutMs` é um prazo por tentativa que cobre **a resolução do host e o
  pedido juntos**. Um servidor DNS que nunca responde faz falhar a tentativa
  (`error: 'host resolution timed out'`, repetível) em vez de reter a entrega —
  ou o flush do outbox que espera por ela — indefinidamente. A tentativa
  seguinte volta a resolver.
- Falhas transitórias (`5xx`, erros de rede, timeouts) fazem retry com backoff
  exponencial — `500ms`, `1s`, `2s`, … até `maxRetries` (default `3`, ou seja
  quatro tentativas no total).
- Erros de cliente (`4xx`) **não** são repetidos — um URL errado ou auth errada
  não se corrigem sozinhos no retry. O resultado leva `error: 'HTTP 404'`. `408` e
  `429` continuam marcados `retryable: true`, para que o outbox os tente mais tarde.
- Os redirecionamentos são **recusados, não seguidos**: um `3xx` termina a
  entrega com `error: 'redirect refused'`. Segui-lo permitiria que um URL público
  e conforme desviasse o pedido para um endereço interno.
- Só a linha de status é lida. O corpo da resposta é descartado e a ligação
  fechada assim que o status é conhecido, por isso um recetor que envie um corpo
  interminável aos poucos não consegue manter sockets abertos.
- Afina o deliverer através das opções do plugin (passam diretamente para o
  `WebhookDeliverer`):

```ts
webhooksPlugin({
  secret: process.env.WEBHOOK_SECRET,
  maxRetries: 5,     // retries após a primeira tentativa (default 3)
  backoffMs: 500,    // espera base, duplicada a cada tentativa (default 500)
  timeoutMs: 10_000, // prazo por tentativa, DNS + pedido (default 10s)
})
```

Para retries duráveis e distribuídos que sobrevivem a um restart a meio da
entrega, conduz `dispatch()` a partir de `@basaltkit/queue` em vez de depender do
loop de retry em processo — vê [Filas e jobs](/pt/guide/queues).

### Telemetria de entrega

Cada resultado traz `durationMs`: o tempo real da entrega inteira, com todas as
tentativas, a resolução DNS e o backoff incluídos. O `status` é o estado HTTP da
última resposta recebida.

Para um registo por tentativa — o que uma página de integrações mostra a um
cliente — passa `onAttempt`. É chamado depois de cada tentativa com
`{ deliveryId, endpointId, tenantId?, event, attempt, ok, status?, durationMs, error?, at }`:

```ts
webhooksPlugin({
  store,
  onAttempt: (a) =>
    deliveryLog.insert({ ...a, at: a.at.toISOString() }), // a tua tabela, a tua retenção
})
```

O hook não é aguardado, e um throw ou uma rejeição são registados e engolidos —
um registo avariado nunca altera uma entrega. Uma entrega recusada antes de
qualquer tentativa (sem secret de assinatura, URL bloqueado pela guarda SSRF,
tecto de fan-out) não produz tentativa; aparece apenas no `DeliveryResult`. O
Basalt não guarda nenhum registo de entregas próprio e nunca lê o corpo da
resposta (é descartado sem ser lido, ver acima), por isso não há excerto de
resposta para registar.

### A guarda SSRF

Os URLs dos endpoints são fornecidos por clientes, por isso cada URL de entrega é
tratado como input hostil. Antes da primeira tentativa o deliverer resolve o
hostname **uma vez** e recusa a entrega se o esquema não for `http:`/`https:`, ou
se *algum* endereço resolvido for loopback, privado (`10/8`, `172.16/12`,
`192.168/16`), link-local (incluindo o endereço de metadados de cloud
`169.254.169.254`), CGNAT, ULA IPv6, documentação (`192.0.2/24`,
`198.51.100/24`, `203.0.113/24`, `2001:db8::/32`, `3fff::/20`), benchmarking
(`198.18/15`), o anycast de relay 6to4 descontinuado (`192.88.99/24`), multicast,
ou de outra forma reservado (`240/4`). O IPv6 é
avaliado sobre o endereço já interpretado, por isso todas as grafias contam: um
literal IPv6 que embute um endereço IPv4 — IPv4-mapped (`[::ffff:127.0.0.1]`,
que o parsing de URL reescreve para `[::ffff:7f00:1]`), IPv4-compatible, NAT64
(`64:ff9b::/96`) ou 6to4 (`2002::/16`) — é avaliado por esse endereço IPv4, e as
gamas Teredo, NAT64 de uso local, discard e de documentação são recusadas.

A mesma guarda está disponível para os teus próprios pedidos de saída como um
cliente em **streaming** — `createGuardedFetch()` — que devolve o corpo (com
limite) em vez de o descartar, por isso serve para descarregar. Ver
[HTTP de saída & SSRF](/pt/guide/security#http-de-saida-ssrf).

### Política de portas

A verificação de endereço público não ajuda quando o alvo é o Redis exposto de
outra pessoa. Por isso a porta também é verificada, antes de qualquer lookup
DNS. Uma entrega só vai para `80`, `443`, ou uma porta a partir de `1024` que não
esteja em `DEFAULT_BLOCKED_PORTS`. Essa lista cobre as portas registadas para
bases de dados, caches, message brokers, planos de controlo de clusters,
proxies e serviços de administração remota: Postgres `5432`, MySQL `3306`, Redis
`6379`, memcached `11211`, MongoDB `27017`, Docker `2375`, etcd `2379`, kubelet
`10250`, Kafka `9092`, Elasticsearch `9200`, Squid `3128`, entre outras. As
restantes portas privilegiadas (`22`, `25`, `110`, `445`, …) são recusadas.
Nenhum destes serviços recebe webhooks, e vários falam protocolos de texto que um
corpo `POST` forjado consegue conduzir entre protocolos. As portas habituais de
recetores (`3000`, `8080`, `8443`, …) são permitidas.

```ts
webhooksPlugin({ secret, ssrf: { allowedPorts: [443] } })        // exatamente estas portas
webhooksPlugin({ secret, ssrf: { allowedPorts: [443, 6379] } })  // a tua própria política
webhooksPlugin({ secret, ssrf: { allowedPorts: 'any' } })        // política desligada
```

A política aplica-se no `register()` (`WebhookEndpointInvalidError`) e em cada
entrega (`port N is not allowed`, `attempts: 0`, `retryable: false`). Também se
aplica com `allowPrivateHosts`, onde os serviços internos estão ainda mais
expostos. Os redirecionamentos nunca são seguidos, por isso um `3xx` também não
chega a uma porta bloqueada. Um `allowedPorts` malformado lança quando o
deliverer é construído.

O socket é depois **fixado** ao endereço que foi validado, para que um DNS
autoritativo hostil não possa devolver um IP público à verificação e um IP
interno no momento da ligação (DNS rebinding). O header `Host` e o SNI de TLS
continuam a levar o hostname original, por isso vhosts e validação de certificado
não são afetados.

Um URL bloqueado é um erro permanente de configuração, não transitório: o
resultado é `{ ok: false, attempts: 0, retryable: false, error: 'Refusing to deliver webhook…' }`
e nada é repetido. Quando o veredito vem do DNS (o host não resolve, ou resolve
para um endereço privado) o `error` é uma única mensagem genérica —
`host does not resolve to an allowed public address` — sem endereço e sem forma
de distinguir os dois casos: quem regista endpoints poderia de outra forma mapear
o teu DNS interno. O endereço resolvido fica em
`WebhookUrlBlockedError.resolvedAddress` para logs do lado do servidor quando
chamas `resolveAndValidate` tu próprio.

::: warning Um `fetchImpl` próprio não fixa o endereço sozinho
O transporte por omissão **não** é o `fetch` global: é um cliente embutido que
liga ao IP validado. Um `fetchImpl` próprio (proxy, instrumentação) recebe esse IP
no objeto init sob `PINNED_ADDRESS`, mas o `fetch` simples ignora-o e volta a
resolver o hostname — reabrindo a janela de rebinding. Mantém a fixação delegando
no `pinnedFetch` exportado, e declara-o:

```ts
import { pinnedFetch } from '@basaltkit/webhooks'

webhooksPlugin({
  secret,
  fetchImpl: async (url, init) => {
    const started = Date.now()
    try { return await pinnedFetch(url, init) } finally { metrics.observe(Date.now() - started) }
  },
  fetchImplPinsAddress: true,
})
```

Sem `fetchImplPinsAddress`, um `fetchImpl` próprio emite um aviso de processo
único (`BASALT_WEBHOOKS_UNPINNED_FETCH`) e o deliverer volta a resolver e a
validar o host antes de cada retry. Isso estreita a janela mas não a fecha — um
cliente sem fixação resolve por si no momento da ligação. Reescrever o URL para o
IP não é feito por ti: o `fetch` simples não consegue definir o SNI de TLS à
parte, por isso a validação do certificado partiria em endpoints `https`.
:::

```ts
// Instalação self-hosted que tem mesmo de entregar a um host interno:
webhooksPlugin({ secret, ssrf: { allowPrivateHosts: true } })

// Só HTTPS (recusa endpoints http:// na entrega):
webhooksPlugin({ secret, ssrf: { allowedSchemes: ['https:'] } })

// Desligar a guarda por completo — não faças isto, a menos que todos os URLs sejam teus:
webhooksPlugin({ secret, ssrf: false })
```

`allowPrivateHosts: true` salta a validação **e** a fixação, para que o resolver
do próprio operador seja respeitado no momento da ligação. O
`assertDeliverableUrl(url)` é exportado se quiseres rejeitar um URL mau no momento
do registo — com um erro claro para o cliente — em vez de na primeira entrega.

## Expor a gestão de endpoints por HTTP

O pacote não traz **nenhuma rota HTTP**: quem pode gerir os endpoints de um
tenant é uma decisão da app, e é uma decisão privilegiada (um endpoint é uma
exportação de dados para fora). Constrói-as sobre o `route()` neutro para que
sirvam de forma idêntica em Fastify, Express e Hono:

```ts
import { route } from '@basaltkit/http'
import { ctx, type Container } from '@basaltkit/core'
import { WEBHOOKS } from '@basaltkit/webhooks'
import { z } from 'zod'

const hooks = () => (ctx().container as Container).get(WEBHOOKS)

export const webhookRoutes = () => [
  route({
    method: 'GET',
    url: '/webhooks/endpoints',
    meta: { auth: true, teamRole: 'admin' },
    // list() nunca inclui secrets de assinatura (`hasSecret` em vez disso)
    async handler() { return { data: await hooks().list() } },
  }),
  route({
    method: 'POST',
    url: '/webhooks/endpoints',
    meta: { auth: true, teamRole: 'admin' },
    body: z.object({ url: z.string().url(), events: z.array(z.string()).min(1) }),
    async handler({ body, reply }) {
      // o tenantId é forçado a partir de ctx() — nunca o leias do corpo. A resposta
      // leva o secret de assinatura gerado — a única vez em que é mostrado.
      return reply.code(201).send(await hooks().register(body))
    },
  }),
]
```

`meta.teamRole` precisa do [`teamsPlugin`](/pt/guide/teams); `meta.auth` precisa
do `authPlugin`. Declarar qualquer um deles sem o respetivo plugin recusa
arrancar com `UnguardedRouteMetaError` (`HTTP_UNGUARDED_ROUTE_META`) em vez de
servir a rota sem guarda — vê o [guia de adaptadores](/pt/guide/adapters).

## Stores de subscrição duráveis

O `MemoryWebhookStore` por omissão esquece cada endpoint no restart — depois de um
redeploy ninguém está subscrito e os eventos param em silêncio. Em produção,
troca por um store durável. O contrato `WebhookStore` é idêntico entre backends,
por isso é uma mudança de uma linha.

### SQLite (nó único, zero dependências)

`@basaltkit/webhooks-sqlite` persiste as subscrições num ficheiro local sobre o
`node:sqlite` embutido do Node (Node 22.5+; sem flag no Node 24).

```ts
import { webhooksPlugin } from '@basaltkit/webhooks'
import { sqliteWebhookStore } from '@basaltkit/webhooks-sqlite'

const webhooks = sqliteWebhookStore('./data/webhooks.db') // ':memory:' por omissão

webhooksPlugin({ store: webhooks.store, secret: process.env.WEBHOOK_SECRET })
```

`sqliteWebhookStore()` abre (ou cria) a base de dados, aplica um schema
idempotente (acrescentando as colunas de rotação de secret a uma tabela criada
por uma versão anterior) e devolve `{ store, db }` — o handle `db` raw fica
exposto se precisares dele.

### Prisma (Postgres/MySQL, multi-instância)

`@basaltkit/webhooks-prisma` partilha um conjunto de subscrições entre instâncias
na base de dados que já corres. Traz o teu próprio `PrismaClient`; o pacote traz
um modelo de referência.

```bash
pnpm add @basaltkit/webhooks @basaltkit/webhooks-prisma
pnpm basalt prisma:sync --push   # adiciona o modelo WebhookEndpoint + cria a tabela
```

```ts
import { webhooksPlugin } from '@basaltkit/webhooks'
import { prismaWebhookStore } from '@basaltkit/webhooks-prisma'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const webhooks = prismaWebhookStore(prisma)

webhooksPlugin({ store: webhooks.store, secret: process.env.WEBHOOK_SECRET })
```

`prisma:sync` descobre todos os pacotes `@basaltkit/*-prisma` instalados e junta
os seus modelos ao teu `schema.prisma`. Liga o store antes de o modelo existir e
ele falha logo, nomeando o modelo em falta — vê
[Persistência](/pt/guide/persistence).

As colunas `previousSecret` / `previousSecretExpiresAt` do modelo guardam uma
[rotação de secret](#rodar-um-secret-de-assinatura). O store só as escreve
quando um endpoint está em rotação, por isso um schema anterior a elas continua
a funcionar até chamares o `rotateSecret()` — sincroniza e migra antes disso.

### Schema por tenant

Com [schema por tenant](/pt/guide/database-per-tenant) tens dois layouts.

**O mais simples: manter as tabelas de webhooks centrais.** Dá ao
`prismaWebhookStore` o cliente central normal. Cada endpoint já guarda o seu
`tenantId` e cada dispatch é delimitado por ele, por isso o isolamento não
depende do schema — e tudo nesta página, incluindo o relay do outbox, funciona
sem alterações. Prefere este layout, a não ser que precises dos endpoints de
cada tenant dentro do seu próprio schema.

**Endpoints por tenant.** Dá ao store Prisma um cliente que se resolve a cada
chamada em vez de um fixo — não é preciso nenhum modo especial do store:

```ts
import { tenantClient } from '@basaltkit/prisma'
import type { PrismaClient } from '@prisma/client'

const webhooks = prismaWebhookStore(tenantClient<PrismaClient>())
webhooksPlugin({ store: webhooks.store, secretBox })
```

Dentro de um pedido, `register()` / `list()` / `dispatch()` chegam ao schema do
tenant ativo (o endpoint continua associado a esse tenant, o que o schema torna
redundante mas inofensivo).

Fora do caminho do pedido, um `dispatch()` delimitado por um `tenantId`
explícito entra nesse tenant **apenas para a pesquisa de endpoints** quando o
`tenancyPlugin` está registado: o `webhooksPlugin` usa o sinal `'tenancy:run'`
da tenancy (`runInTenant`), por isso a leitura do store corre dentro de
`tenancy.run(tenantId)` e resolve o schema do tenant. Os secrets são abertos e
os pedidos enviados depois de esse run terminar, por isso um endpoint lento
nunca prende o cliente do pool desse tenant. Isto cobre o relay do
`webhookOutboxPlugin`, a [receita com
`outboxPlugin`](#entradas-mortas-e-falhas-de-flush), chamadas manuais a
`flush(...)` e os teus próprios jobs:

```ts
webhooksPlugin({ store: webhooks.store, secretBox })
webhookOutboxPlugin({
  store: centralOutboxStore, // a tabela do outbox fica central (cliente normal)
  tenantOnly: true,          // um evento sem tenant não tem endpoint a alcançar aqui
})
```

- **Mantém a tabela do outbox central.** O relay lê-a sem tenant; só a pesquisa
  de endpoints entra no tenant de cada entrada.
- **Define `tenantOnly: true`.** Eventos emitidos sem tenant só encontrariam
  endpoints sem tenant, que um store por tenant não tem — sem esta opção são
  repetidos com `DB_UNAVAILABLE` e acabam mortos.
- **As entradas de um tenant apagado acabam mortas** (`TENANT_NOT_FOUND` do
  `tenancy.run`) em vez de serem entregues.
- **O `secretBox` recebe o `tenantId` explicitamente** no seu contexto e não
  pode ler o tenant ambiente durante a entrega — não há nenhum.
- `register()` / `list()` / `unregister()` / `rotateSecret()` não são envolvidos:
  fora do caminho do pedido, corre-os dentro de `tenancy.run(tenantId, ...)`.

Um job de fila que faz o dispatch à mão continua a ser uma alternativa válida (o
`idempotencyKey` mantém o `id` da entrega estável entre retries). Envolve-o tu
em `tenancy.run`: um worker do `@basaltkit/queue` repõe o tenant do job no
contexto e, com um tenant já no contexto, a pesquisa corre aí e não pelo
`runInTenant`:

```ts
// um job de fila com { tenantId, event, data } vindo do pedido que o emitiu
await tenancy.run(job.tenantId, () =>
  hooks.dispatch(job.event, job.data, { tenantId: job.tenantId, idempotencyKey: job.id }),
)
```

Desativa com `webhooksPlugin({ runInTenant: false })`; sem `tenancyPlugin` (ou
com um `@basaltkit/tenancy` anterior ao sinal `'tenancy:run'`) a pesquisa corre
no contexto de quem chama, como antes.

### Qual backend?

| Store | Pacote | Usar quando |
| --- | --- | --- |
| Memory | `@basaltkit/webhooks` | Dev e testes (perde-se no restart) |
| SQLite | `@basaltkit/webhooks-sqlite` | Um só nó, zero dependências, ficheiro local |
| Prisma | `@basaltkit/webhooks-prisma` | Postgres/MySQL, várias instâncias partilham subscrições |

### Escrever o teu próprio store

Implementa o contrato `WebhookStore` — quatro métodos — sobre qualquer backend:

```ts
import { type WebhookStore, type WebhookEndpoint, matchesEvent } from '@basaltkit/webhooks'

class MyWebhookStore implements WebhookStore {
  // ativos, restritos ao tenant, com padrão de evento correspondido (usa matchesEvent)
  async forEvent(event: string, tenantId?: string): Promise<WebhookEndpoint[]> { /* … */ return [] }
  async add(endpoint: Omit<WebhookEndpoint, 'id'> & { id?: string }): Promise<WebhookEndpoint> { /* … */ throw 0 }
  // quando tenantId é dado, remove SÓ se esse tenant for dono do endpoint
  async remove(id: string, tenantId?: string): Promise<void> { /* … */ }
  async list(tenantId?: string): Promise<WebhookEndpoint[]> { /* … */ return [] }
}

webhooksPlugin({ store: new MyWebhookStore(), secret: process.env.WEBHOOK_SECRET })
```

Duas regras que o store embutido segue e o teu também tem de seguir: `forEvent`
devolve endpoints cujo `tenantId` corresponde **ou é undefined** (os endpoints
globais recebem tudo), e ignora os que têm `active: false`. `remove(id, tenantId)`
tem de ser um no-op silencioso quando o endpoint pertence a outra pessoa — é isso
que torna o âmbito anti-alargamento seguro. Chamado **sem** `tenantId` (ou com
`null` / `''`), o `forEvent` tem de falhar fechado e devolver só endpoints sem
tenant — nunca os de todos os tenants. Um dispatch deliberado com `allTenants` lê
os endpoints através de `list()`, e o manager volta a filtrar todos os
resultados, por isso um store que erre nisto continua sem conseguir alargar a
entrega. O manager também verifica a propriedade antes de chamar `remove`. Uma
linha SQL com `secret` / `tenantId` a `NULL` pode vir como `null`: o deliverer e o
manager tratam `null` exatamente como um campo ausente (um endpoint sem tenant,
assinado com o secret por omissão).

Para suportar a [rotação de secret](#rodar-um-secret-de-assinatura), persiste
`previousSecret` e `previousSecretExpiresAt` (um `Date`), e limpa os dois quando
o `add()` os recebe explicitamente a `undefined`: é assim que um novo registo
termina uma rotação. Um store que os descarte continua a funcionar; as suas
rotações são cortes imediatos.

## Referência de opções

### `webhooksPlugin(options)`

Tudo exceto `store`, `deliverer`, `events`, `secretBox`, `runInTenant` e as três opções de fan-out é reencaminhado para o
`WebhookDeliverer` que constrói (e ignorado se passares o teu próprio
`deliverer`).

| Opção | Tipo | Predefinição | Porquê |
| --- | --- | --- | --- |
| `store` | `WebhookStore` | `MemoryWebhookStore` | Onde vivem as subscrições — troca por `webhooks-sqlite`/`webhooks-prisma`, ou os endpoints desaparecem no restart |
| `deliverer` | `WebhookDeliverer` | construído a partir destas opções | Traz o teu (partilhado com um relay de outbox, ou um duplo de teste) |
| `events` | `string[]` | `[]` (desligado) | Padrões de eventos de domínio a auto-despachar. Não vazio faz o plugin depender de `basalt:events` |
| `maxEndpointsPerDispatch` | `number \| false` | `100` | Máximo de endpoints ativos de um âmbito (tenant, ou sem tenant) por evento; acima disso, esse âmbito é recusado por inteiro ([tecto de fan-out](#tecto-de-fan-out)) |
| `dispatchConcurrency` | `number` | `16` | Entregas que um `dispatch` corre ao mesmo tempo |
| `onFanOutExceeded` | `(info) => void` | `console.warn` | Chamado uma vez por âmbito recusado, com `{ event, tenantId, endpoints, limit }`. Nunca pode lançar |
| `secretBox` | `WebhookSecretBox` | — (guardado tal como chega) | Sela os secrets dos endpoints antes da escrita no store e abre-os em cada entrega ([selar secrets em repouso](#selar-secrets-em-repouso)) |
| `runInTenant` | `TenantRunner \| false` | o sinal `'tenancy:run'` da tenancy, quando presente | Entra no tenant para a pesquisa de endpoints de um `dispatch()` fora do pedido delimitado por `tenantId` ([schema por tenant](#schema-por-tenant)). `false` mantém a pesquisa no contexto de quem chama |
| `secret` | `string` | — | Secret HMAC de assinatura por predefinição (mín. 16 caracteres) para endpoints sem tenant. Os endpoints de tenant usam sempre o seu |
| `allowSharedSecret` | `boolean` | `false` | Opt-out: assinar um endpoint de tenant sem secret próprio com o `secret` por predefinição (senão é recusado) |
| `allowUnsigned` | `boolean` | `false` | Opt-out: enviar sem assinatura quando não há secret nenhum (senão é recusado) |
| `maxRetries` | `number` | `3` | Retries **depois** da primeira tentativa; só `5xx`/rede/timeout são repetidos |
| `backoffMs` | `number` | `500` | Espera base, duplicada por tentativa (500 ms, 1 s, 2 s, …) |
| `timeoutMs` | `number` | `10_000` | Prazo por tentativa que cobre a resolução DNS e o pedido; esgotá-lo conta como falha transitória |
| `ssrf` | `SsrfGuardOptions \| false` | ligado | A guarda do URL de entrega (abaixo). `false` desliga-a por completo |
| `fetchImpl` | `typeof fetch` | transporte fixado embutido (não o `fetch` global) | Cliente HTTP injetado; recebe o endereço validado no objeto init sob o símbolo exportado `PINNED_ADDRESS`. O `fetch` simples ignora-o — delega no `pinnedFetch` para manter a fixação (ver a guarda SSRF) |
| `fetchImplPinsAddress` | `boolean` | `false` | Declara que o teu `fetchImpl` respeita `PINNED_ADDRESS` (ex. embrulha o `pinnedFetch`): silencia o aviso de ligação sem fixação e salta a revalidação antes de cada retry |
| `sleep` | `(ms) => Promise<void>` | `setTimeout` | Sleep de backoff injetável (testes) |
| `now` | `() => number` | `Date.now()/1000` | Relógio injetável em **segundos**, usado no timestamp da assinatura |
| `headerPrefix` | `string` | `'x-basalt'` | Prefixo dos headers `-event` / `-delivery` / `-signature`; minúsculas `[a-z][a-z0-9-]{0,31}`, validado na construção |
| `onAttempt` | `(attempt: WebhookAttempt) => void \| Promise<void>` | — | Chamado depois de cada tentativa ([telemetria de entrega](#telemetria-de-entrega)); não é aguardado, os erros são registados e engolidos |

### `SsrfGuardOptions` (a opção `ssrf`)

| Opção | Tipo | Predefinição | Porquê |
| --- | --- | --- | --- |
| `allowPrivateHosts` | `boolean` | `false` | Entrega self-hosted de confiança a hosts internos. Salta a validação **e** a fixação do endereço |
| `allowedSchemes` | `string[]` | `['https:', 'http:']` | Esquemas de URL permitidos — restringe a `['https:']` para recusar endpoints em texto simples |
| `allowedPorts` | `number[] \| 'any'` | `80`, `443`, `>= 1024` menos `DEFAULT_BLOCKED_PORTS` | A [política de portas](#politica-de-portas). Um array permite exatamente essas portas; `'any'` desliga-a. Aplica-se também com `allowPrivateHosts` |
| `lookup` | `(host) => Promise<{ address, family? }[]>` | `dns.lookup(host, { all: true })` | Resolver injetado (testes) |

### `webhookOutboxPlugin(options)`

| Opção | Tipo | Predefinição | Porquê |
| --- | --- | --- | --- |
| `store` | `OutboxStore` | `MemoryOutboxStore` | Outbox durável — em memória derrota todo o propósito do padrão |
| `events` | `string[]` | `['**']` (todos) | Padrões de eventos de domínio capturados para o outbox |
| `intervalMs` | `number` | `5000` | Intervalo de poll do relay. `0` desliga o timer — faz relay manual através de `OUTBOX` |
| `batchSize` | `number` | `50` | Entradas entregues por flush |
| `maxAttempts` | `number` | `10` | Tentativas antes de a entrada ficar morta (nunca mais enviada) |
| `concurrency` | `number` | `8` | Entradas entregues em paralelo por flush, para que um endpoint lento não bloqueie o lote |
| `tenantConcurrency` | `number` | `ceil(concurrency / 2)` | Máximo de entregas em curso de um tenant ao mesmo tempo, entre flushes |
| `dispatchTimeoutMs` | `number \| false` | `10_000` | Espera máxima por entrada antes de o flush avançar; a entrega continua destacada e o resultado é registado na mesma |
| `onFlushError` | `(error) => void` | `console.error` | Um flush do timer/shutdown falhou ao nível do store. Nunca pode lançar |
| `onPermanentFailure` | `(entry, failures) => void` | `console.warn` | A entrega de uma entrada falhou de forma permanente para alguns endpoints; não são repetidos. Nunca pode lançar |
| `tenantOnly` | `boolean` | `false` | Captura só eventos emitidos dentro de um contexto de tenant. Define-a quando os endpoints vivem por tenant ([schema por tenant](#schema-por-tenant)) |

Não há `onDead` aqui — usa o `outboxPlugin` de `@basaltkit/events` quando
precisares dele, como mostrado acima. O plugin
depende de `basalt:webhooks` e de `basalt:events`, e drena o outbox uma vez no
shutdown (best-effort).

### Helpers de assinatura e SSRF

| Export | Assinatura | Porquê |
| --- | --- | --- |
| `signPayload` | `(body: string \| Uint8Array, secret \| secrets[], timestampSeconds) => string` | Constrói `t=…,v1=…` — assina um payload à mão; um `v1` por secret quando recebe vários (o atual primeiro) |
| `verifySignature` | `(header, body: string \| Uint8Array, secret, toleranceSeconds = 300, nowSeconds?) => boolean` | Verificação em tempo constante num recetor; `true` se qualquer `v1` bater; `false` para um secret com menos de 16 caracteres; só lança `RangeError` para uma tolerância/relógio inválidos |
| `generateWebhookSecret` | `() => string` | Um secret `whsec_…` novo (32 bytes aleatórios) |
| `MIN_WEBHOOK_SECRET_LENGTH` | `16` | Comprimento mínimo do secret, aplicado nos dois lados |
| `assertDeliverableUrl` | `(url, options?) => Promise<void>` | Rejeita um URL inseguro para SSRF no momento do registo; lança `WebhookUrlBlockedError` |
| `resolveAndValidate` | `(url, options?) => Promise<ValidatedTarget>` | A mesma verificação, devolvendo os endereços resolvidos e o que fixar |
| `isPrivateIp` | `(ip) => boolean` | O próprio predicado de gamas; tudo o que não seja um IP público literal é `true` |
| `isPortAllowed` | `(port, allowedPorts?) => boolean` | O predicado da política de portas |
| `DEFAULT_BLOCKED_PORTS` | `readonly number[]` | Portas que a política por omissão recusa a partir de 1024 |
| `matchesEvent` | `(patterns, event) => boolean` | O comparador de padrões, para o `forEvent` de um store próprio |
| `webhookOutboxDispatch` | `(webhooks, options?) => OutboxDispatch` | Adapta um `WebhookManager` a um dispatch de outbox; só lança em falhas transitórias, com ids de entrega estáveis |
| `pinnedFetch` | `(url, init) => Promise<Response>` | Cliente compatível com `fetch` sobre o transporte fixado — o delegado de um `fetchImpl` próprio |
| `webhookHeaderNames` | `(prefix = 'x-basalt') => { event, delivery, signature }` | Os nomes de header que um deliverer com esse `headerPrefix` envia — lê-os no recetor; lança `TypeError` para um prefixo inválido |
| `deriveDeliveryId` | `(idempotencyKey, endpointId) => string` | O `id` de entrega determinístico usado pelo outbox / `idempotencyKey` |
| `createGuardedFetch` | `(options) => (url, init?) => Promise<GuardedResponse>` | Cliente em streaming com guarda SSRF: revalidação e fixação de IP em cada salto, limite de bytes a meio do stream, sem redirect automático, sem descompressão; lança `GuardedFetchError` (`SSRF_BLOCKED` · `BODY_TOO_LARGE` · `TIMEOUT` · `TOO_MANY_REDIRECTS`) |
| `hostAllowed` | `(host, allowed) => boolean` | O predicado da allowlist: host exacto, ou `.sufixo` só para subdomínios |
| `capStream` | `(source, maxBytes, exceeded?) => Readable` | Envolve um stream para que falhe acima de `maxBytes`, destruindo a origem |

## Modos de falha e resolução de problemas

A maioria dos problemas de entrega **não são exceções** — voltam no
`DeliveryResult`, porque um endpoint mau não pode fazer falhar os outros:

| Resultado | `error` | `attempts` | Quando |
| --- | --- | --- | --- |
| Recusa SSRF | `Refusing to deliver webhook to <url>: <reason>` (URL/esquema inválido, IP privado literal) ou `Refusing to deliver webhook: host does not resolve to an allowed public address.` (veredito do DNS) | `0` | Esquema inválido, ou o host é/resolve para um endereço privado, loopback, link-local, CGNAT, ULA ou reservado — ou não resolve |
| Porta bloqueada | `Refusing to deliver webhook to <url>: port N is not allowed.` | `0` | A porta do URL está fora da [política de portas](#politica-de-portas) |
| Tecto de fan-out | `fan-out cap exceeded: …` | `0` | O âmbito tem mais de `maxEndpointsPerDispatch` endpoints para este evento; nenhum deles recebeu nada |
| Sem secret utilizável | `no signing secret; refusing unsigned delivery` / `tenant endpoint has no own secret; …` / `endpoint signing secret is too short …` | `0` | Nada com que assinar, um endpoint de tenant só com o secret partilhado, ou um secret com menos de 16 caracteres |
| Erro de cliente | `HTTP 4xx` | `1` | O recetor rejeitou — nunca repetido inline (`408`/`429` são `retryable` para o outbox) |
| Redirecionamento | `redirect refused` | `1` | O endpoint respondeu `3xx`; segui-lo derrotaria a verificação SSRF |
| Transitório | última mensagem de rede/timeout (`host resolution timed out` quando o DNS esgotou o prazo) | `maxRetries + 1` | `5xx`, erro de ligação ou timeout por tentativa (DNS incluído), repetido com backoff, e ainda a falhar |
| Interno | `internal delivery error` | `0` | O `deliver()` lançou inesperadamente; registado do lado do servidor, os outros endpoints não são afetados |

| Erro | Código | HTTP | Quando |
| --- | --- | --- | --- |
| `WebhookUrlBlockedError` | — (só `name`) | — | Lançado por `assertDeliverableUrl` / `resolveAndValidate`; dentro de `deliver()` é apanhado e transformado no resultado falhado acima |
| `WebhookTenantRequiredError` | `WEBHOOKS_TENANT_REQUIRED` | — | `register` / `list` / `unregister` com tenancy ativa e sem tenant (contexto ou explícito) e sem `{ system: true }` |
| `WebhookEndpointInvalidError` | `WEBHOOK_ENDPOINT_INVALID` | 400 | `register()` com um URL que não é interpretável ou usa um esquema ou porta que o deliverer recusa, um `secret` com menos de 16 caracteres, ou uma lista `events` vazia — nada é guardado. Também `rotateSecret()` com `graceSeconds`/`secret` inválidos, ou num endpoint sem secret próprio |
| `WebhookEndpointNotFoundError` | `WEBHOOK_ENDPOINT_NOT_FOUND` | 404 | `rotateSecret()` num endpoint que não existe no âmbito de quem chama |
| `WebhookEndpointIdInUseError` | `WEBHOOK_ENDPOINT_ID_IN_USE` | 409 | `register()` / `MemoryWebhookStore.add()` com um `id` que outro âmbito já detém (as stores SQL lançam o seu próprio erro com o mesmo código) |
| `UnknownTokenError` | `DI_UNKNOWN_TOKEN` | — | `container.get(WEBHOOKS)` sem o `webhooksPlugin` registado |
| `UnguardedRouteMetaError` | `HTTP_UNGUARDED_ROUTE_META` | arranque | As tuas rotas de gestão de endpoints declaram `meta.auth` / `meta.teamRole` sem o plugin que as impõe |

- **Todas as entregas falham com `attempts: 0` em desenvolvimento** — a guarda
  SSRF está a recusar `localhost` / `127.0.0.1` / um nome `.local`. Usa um túnel
  com hostname público, ou `ssrf: { allowPrivateHosts: true }` só na configuração
  de dev.
- **Os recetores dizem que a assinatura está errada apesar de o secret bater
  certo** — estão a verificar sobre um corpo reserializado. O HMAC cobre os bytes
  exatos; captura o corpo raw antes do parse.
- **Os endpoints desaparecem a cada deploy** — continuas no
  `MemoryWebhookStore`. Passa para `webhooks-sqlite` ou `webhooks-prisma`.
- **Eventos emitidos de um job só chegam a alguns endpoints** — não há tenant em
  `ctx()` fora de um pedido, por isso só os endpoints globais (sem tenant)
  correspondem. Chama `dispatch(event, data, tenantId)` explicitamente (ou corre
  o job dentro do contexto do tenant).
- **Um handler de pedido ficou lento depois de adicionar webhooks** — o
  `dispatch` espera por todas as entregas, retries incluídos (até
  `(maxRetries + 1) × timeoutMs` por endpoint). Move-o para o outbox ou para um
  job de fila.
- **O outbox deixa de entregar um evento e nada aparece onde procuras** —
  atingiu `maxAttempts` e está morto; o `onDead` predefinido escreve em
  `console.error`. Inspeciona o `lastError` na entrada, ou liga o `outboxPlugin`
  com o teu próprio `onDead`.

## Ver também

- [Filas e jobs](/pt/guide/queues) — conduz a entrega a partir de uma fila para retries duráveis.
- [Persistência](/pt/guide/persistence) — stores duráveis, `prisma:sync`, o store do outbox.
- [Equipas](/pt/guide/teams) — quem pode gerir os endpoints de um tenant.
- [Cookbook de SaaS multi-tenant](/pt/cookbook/multi-tenant-saas) — endpoints por tenant numa app real.
