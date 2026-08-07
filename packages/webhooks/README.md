# @machize/webhooks

Webhooks de saída para o framework Machize: entrega eventos da tua aplicação a URLs de outros sistemas, com assinatura criptográfica, retries automáticos e subscrições por tenant. Precisas deste módulo quando os *teus clientes* (ou outros serviços) querem ser avisados por HTTP quando algo acontece na tua aplicação.

## O que este módulo resolve

Um **webhook** é uma "chamada de volta" por HTTP: em vez de outro sistema andar constantemente a perguntar "já há novidades?", é a tua aplicação que faz um pedido `POST` ao URL desse sistema no momento em que algo acontece (ex.: "fatura paga"). É assim que serviços como o Stripe ou o GitHub notificam as aplicações dos seus utilizadores — este módulo dá-te o mesmo, mas na direção de saída: a tua aplicação a notificar terceiros.

Fazer isto à mão parece um simples `fetch`, mas os problemas aparecem depressa: o servidor de destino pode estar em baixo (é preciso repetir com intervalo crescente), o destinatário precisa de garantir que o pedido vem mesmo de ti (assinatura HMAC — um código calculado com um segredo partilhado que prova a origem e detecta adulteração), cada cliente quer subscrever só alguns eventos, e num SaaS multi-tenant cada tenant só pode receber os seus próprios eventos.

O módulo divide isto em três peças: o **store** (onde vivem as subscrições — em memória por omissão, base de dados em produção), o **deliverer** (faz o `POST` assinado com retries e backoff exponencial) e o **manager** (junta os dois: ao despachar um evento, encontra os endpoints subscritos e entrega a cada um). Opcionalmente, liga-se ao `@machize/events` para despachar automaticamente eventos de domínio.

## Instalação

```bash
pnpm add @machize/webhooks
```

## Começar em 5 minutos

1. **Regista o plugin** na aplicação:

```ts
// src/app.ts
import { createApp } from '@machize/core'
import { webhooksPlugin } from '@machize/webhooks'

const app = await createApp({
  plugins: [
    webhooksPlugin({ secret: 'whsec_o_meu_segredo' }),
  ],
}).boot()
```

2. **Regista um endpoint** (uma subscrição: o URL de destino e os eventos que quer receber):

```ts
import { WEBHOOKS } from '@machize/webhooks'

const webhooks = app.container.get(WEBHOOKS)

await webhooks.register({
  url: 'https://cliente.example.com/hooks',
  events: ['invoice.*'],        // todos os eventos que começam por "invoice."
  tenantId: 'acme',             // opcional: só eventos deste tenant
})
```

3. **Despacha um evento.** Cada endpoint subscrito recebe um `POST` com JSON assinado:

```ts
const results = await webhooks.dispatch('invoice.paid', { amount: 42 }, 'acme')
console.log(results)
// [{ endpointId: '...', ok: true, status: 200, attempts: 1 }]
```

4. **O que o destinatário recebe** — um `POST` com estes cabeçalhos e corpo:

```
content-type: application/json
x-machize-event: invoice.paid
x-machize-signature: t=1712345678,v1=<hmac-sha256>

{"event":"invoice.paid","data":{"amount":42},"sentAt":"2026-08-07T10:00:00.000Z"}
```

5. **O destinatário verifica a assinatura** com `verifySignature` (mesmo esquema do Stripe: HMAC-SHA256 sobre `timestamp.corpo`, com rejeição de timestamps antigos para impedir *replays*):

```ts
import { verifySignature } from '@machize/webhooks'

// num handler HTTP do lado do destinatário:
const valido = verifySignature(headerAssinatura, corpoBrutoDaRequisicao, 'whsec_o_meu_segredo')
if (!valido) {
  // rejeitar com 400
}
```

## Guia de utilização

### Padrões de eventos

Cada endpoint subscreve uma lista de padrões (`events`):

- `'invoice.paid'` — só esse evento exato;
- `'invoice.*'` — qualquer evento que comece por `invoice.`;
- `'*'` — todos os eventos.

Podes testar um padrão com `matchesEvent(['invoice.*'], 'invoice.paid') // true`.

### Subscrições por tenant

Num SaaS, cada tenant (cliente da tua plataforma) regista os seus endpoints com o seu `tenantId`. Ao despachar com `dispatch(event, data, tenantId)`, só recebem os endpoints desse tenant e os endpoints sem `tenantId` (globais). Um endpoint do tenant `acme` nunca recebe eventos do tenant `globex`.

### Gerir endpoints

```ts
const endpoint = await webhooks.register({ url: 'https://x.example.com/h', events: ['*'] })
await webhooks.list()          // todos os endpoints
await webhooks.list('acme')    // só os do tenant "acme"
await webhooks.unregister(endpoint.id)
```

Para desativar temporariamente sem apagar, guarda o endpoint com `active: false`.

### Despacho automático a partir de eventos de domínio

Com `@machize/events` registado, passa `events` ao plugin e todos os eventos de domínio que correspondam aos padrões são despachados automaticamente — com o tenant lido do contexto do pedido e em modo *fire-and-forget* (quem emite o evento nunca fica bloqueado à espera do HTTP):

```ts
import { createApp } from '@machize/core'
import { defineEvent, EVENTS, eventsPlugin } from '@machize/events'
import { webhooksPlugin } from '@machize/webhooks'

const app = await createApp({
  plugins: [
    eventsPlugin(),
    webhooksPlugin({ secret: 'whsec_...', events: ['invoice.*'] }),
  ],
}).boot()

const InvoicePaid = defineEvent<{ amount: number }>('invoice.paid')
await app.container.get(EVENTS).emit(InvoicePaid, { amount: 42 })
// → entregue a todos os endpoints subscritos a "invoice.*"
```

### Retries e falhas

O deliverer repete apenas falhas transitórias — erros de rede, timeouts e respostas `5xx` — com *backoff exponencial* (espera que duplica a cada tentativa: 500 ms, 1 s, 2 s, ...). Respostas `4xx` são erro do cliente e **não** são repetidas. O resultado de cada entrega é um `DeliveryResult` com `ok`, `status`, `attempts` e `error`.

### Store persistente

O `MemoryWebhookStore` perde tudo ao reiniciar. Em produção, implementa a interface `WebhookStore` sobre a tua base de dados e passa-a ao plugin:

```ts
import { webhooksPlugin, type WebhookStore, type WebhookEndpoint, matchesEvent } from '@machize/webhooks'

class DbWebhookStore implements WebhookStore {
  async forEvent(event: string, tenantId?: string): Promise<WebhookEndpoint[]> { /* SELECT + matchesEvent */ return [] }
  async add(endpoint: Omit<WebhookEndpoint, 'id'> & { id?: string }): Promise<WebhookEndpoint> { /* INSERT */ throw 0 }
  async remove(id: string): Promise<void> { /* DELETE */ }
  async list(tenantId?: string): Promise<WebhookEndpoint[]> { /* SELECT */ return [] }
}

webhooksPlugin({ store: new DbWebhookStore(), secret: 'whsec_...' })
```

## Referência da API

### `class WebhookManager`

`new WebhookManager(store: WebhookStore, deliverer: WebhookDeliverer)` — normalmente obtido via token `WEBHOOKS`.

| Método | Assinatura | Descrição |
|---|---|---|
| `register` | `(endpoint: Omit<WebhookEndpoint,'id'> & { id?: string }) => Promise<WebhookEndpoint>` | Cria uma subscrição (id gerado se omitido) |
| `unregister` | `(id: string) => Promise<void>` | Remove uma subscrição |
| `list` | `(tenantId?: string) => Promise<WebhookEndpoint[]>` | Lista subscrições, opcionalmente por tenant |
| `dispatch` | `(event: string, data: unknown, tenantId?: string) => Promise<DeliveryResult[]>` | Entrega a todos os endpoints subscritos ao evento |

### `interface WebhookEndpoint`

| Campo | Tipo | Obrigatório? | Default | Descrição |
|---|---|---|---|---|
| `id` | `string` | Sim (gerado) | UUID | Identificador da subscrição |
| `url` | `string` | Sim | — | URL de destino do `POST` |
| `events` | `string[]` | Sim | — | Padrões: exato, prefixo (`invoice.*`) ou `*` |
| `tenantId` | `string` | Não | — | Restringe a um tenant; omitido = recebe de todos |
| `secret` | `string` | Não | segredo do deliverer | Segredo de assinatura deste endpoint |
| `active` | `boolean` | Não | `true` | `false` desativa sem apagar |

### `webhooksPlugin(options?: WebhooksPluginOptions)`

Regista o `WebhookManager` sob o token `WEBHOOKS`. Estende `WebhookDelivererOptions` com:

| Opção | Tipo | Obrigatório? | Default | Descrição |
|---|---|---|---|---|
| `store` | `WebhookStore` | Não | `MemoryWebhookStore` | Onde vivem as subscrições |
| `deliverer` | `WebhookDeliverer` | Não | novo, com as opções dadas | Entregador personalizado |
| `events` | `string[]` | Não | `[]` | Padrões de eventos de domínio a despachar automaticamente (requer `@machize/events`) |

### `class WebhookDeliverer`

`new WebhookDeliverer(options?: WebhookDelivererOptions)`. Método: `deliver(endpoint, event, data) => Promise<DeliveryResult>`.

`WebhookDelivererOptions`:

| Opção | Tipo | Obrigatório? | Default | Descrição |
|---|---|---|---|---|
| `secret` | `string` | Não | — | Segredo de assinatura por omissão (o `secret` do endpoint sobrepõe-no) |
| `maxRetries` | `number` | Não | `3` | Repetições depois da primeira tentativa |
| `backoffMs` | `number` | Não | `500` | Espera base em ms, duplicada por tentativa |
| `timeoutMs` | `number` | Não | `10000` | Timeout por tentativa em ms |
| `fetchImpl` | `typeof fetch` | Não | `fetch` global | (Avançado) fetch injetável, para testes |
| `sleep` | `(ms) => Promise<void>` | Não | `setTimeout` | (Avançado) espera injetável, para testes |
| `now` | `() => number` | Não | relógio real | (Avançado) relógio em segundos, para testes |

`DeliveryResult`: `{ endpointId: string, ok: boolean, status?: number, attempts: number, error?: string }`.

### Funções de assinatura

| Função | Assinatura | Descrição |
|---|---|---|
| `signPayload` | `(body: string, secret: string, timestampSeconds: number) => string` | Gera o cabeçalho `t=<unix>,v1=<hmac-sha256>` |
| `verifySignature` | `(header: string, body: string, secret: string, toleranceSeconds = 300, nowSeconds?) => boolean` | Verifica em tempo constante; rejeita timestamps fora da tolerância |
| `matchesEvent` | `(patterns: string[], event: string) => boolean` | Testa se um evento corresponde aos padrões |

### Outros exports

| Export | Tipo | Descrição |
|---|---|---|
| `WEBHOOKS` | token | Chave do `WebhookManager` no contentor |
| `MemoryWebhookStore` | classe | Store em memória (dev/testes) |
| `WebhookStore` | tipo (Avançado) | Contrato para stores persistentes |

## Erros comuns e soluções (FAQ)

**O destinatário diz que a assinatura é inválida** — Ele tem de verificar o HMAC sobre o **corpo bruto** do pedido, byte a byte. Se fizer `JSON.parse` e voltar a serializar, os bytes mudam e a verificação falha. Confirma também que ambos os lados usam o mesmo segredo.

**`verifySignature` devolve `false` com tudo aparentemente certo** — Verifica o relógio: a assinatura expira após `toleranceSeconds` (300 s por omissão). Relógios dessincronizados entre servidores causam rejeições.

**A entrega falhou com `ok: false` e `status: 4xx` sem retries** — Comportamento correto: `4xx` significa erro do lado do destinatário (URL errado, autenticação), e repetir não resolveria. Só `5xx` e erros de rede são repetidos.

**As subscrições desaparecem ao reiniciar a aplicação** — Estás no `MemoryWebhookStore` (o predefinido). Em produção implementa `WebhookStore` sobre a base de dados.

**Configurei `events` no plugin mas nada é despachado** — O despacho automático requer o `eventsPlugin()` de `@machize/events` registado (o plugin declara essa dependência). Confirma também que os padrões em `events` cobrem os nomes dos eventos emitidos, e que existe pelo menos um endpoint subscrito.

**O `dispatch` automático não filtra por tenant** — O tenant é lido do contexto do pedido (`ctx().tenant.id`). Fora de um pedido (ex.: num job), não há tenant no contexto e o evento vai também para endpoints globais; nesse caso despacha manualmente com `webhooks.dispatch(evento, dados, tenantId)`.

## Como se liga aos outros módulos

- **@machize/core** — contentor (token `WEBHOOKS`), `definePlugin` e o contexto de pedido de onde vem o `tenantId` no despacho automático.
- **@machize/events** — a origem dos eventos de domínio; com a opção `events`, o plugin subscreve o bus e converte eventos internos em webhooks de saída.
- **@machize/subscriptions** — sentido oposto: o subscriptions *recebe* webhooks (do Stripe); este módulo *envia* webhooks aos teus clientes. Um padrão comum é reencaminhar os hooks `billing:*` como webhooks de saída.
- **@machize/notifications** — complementar: notifications avisa pessoas, webhooks avisa máquinas.
