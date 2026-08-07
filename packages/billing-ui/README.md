# @machize/billing-ui

Página HTML self-contained de **subscrição** para o [`@machize/subscriptions`](https://www.npmjs.com/package/@machize/subscriptions): mostra o plano atual e os planos disponíveis, permite **subscrever/trocar** (Checkout hospedado) e **gerir a faturação** (Customer Portal) — **zero dependências, sem build**. Precisas deste módulo quando queres uma página de "planos & faturação" pronta a usar.

## O que este módulo resolve

O `@machize/subscriptions` já trata dos planos, do Checkout e do Portal. Este módulo é a **UI**: uma página que lê o estado atual da subscrição, apresenta os planos em cartões, e liga os botões ao Checkout (subscrever/trocar) e ao Customer Portal (gerir cartão/cancelar).

## Instalação

```bash
pnpm add @machize/billing-ui @machize/subscriptions
```

Depende do `@machize/core`, `@machize/fastify` e `@machize/subscriptions`.

## Começar em 5 minutos

```ts
import { createApp } from '@machize/core'
import { subscriptionsPlugin, billingRoutes, definePlans, StripeBillingGateway } from '@machize/subscriptions'
import { billingUiRoutes } from '@machize/billing-ui'
import { fastifyPlugin } from '@machize/fastify'

const plans = definePlans({
  free: { price: 0, features: { projects: 3 } },
  pro: { price: 29, trial: '14d', features: { projects: 50, api: true } },
})

const app = await createApp({
  plugins: [
    subscriptionsPlugin({ plans, gateway: new StripeBillingGateway({ /* … */ }), fallbackPlan: 'free' }),
    fastifyPlugin({
      routes: [
        ...billingRoutes({ successUrl: 'https://app/ok', cancelUrl: 'https://app/billing' }), // POST /billing/checkout, /billing/portal
        ...billingUiRoutes({ plans }),  // GET /billing/ui + /billing/info
      ],
    }),
  ],
}).boot()
```

Abre **`/billing/ui`** (autenticado). A página mostra o plano atual (com estado e trial), lista os planos e liga os botões ao Checkout/Portal.

## Rotas

`billingUiRoutes({ plans, path?, apiBase?, title?, headers? })` adiciona:

| Rota | Descrição |
|---|---|
| `GET /billing/ui` | A página HTML. |
| `GET /billing/info` | `{ subscription, plans }` para o tenant atual. |

O Checkout e o Portal (`POST /billing/checkout`, `/billing/portal`) vêm do `billingRoutes()` do `@machize/subscriptions` — monta-os também.

## Tenancy e autenticação

A página faz `fetch` same-origin (assume sessão autenticada). Para **tenancy por header**, injeta o header:

```ts
billingUiRoutes({ plans, headers: { 'x-tenant-id': 'acme' } })
```

Apps por subdomínio não precisam de nada.

## Referência da API

- `billingUiRoutes({ plans, path?, apiBase?, title?, headers? })` — as rotas (`plans` é o mesmo objeto que deste ao `subscriptionsPlugin`).
- `billingPageHtml(options)` — o HTML como string, para servires à tua maneira.

## Como se liga aos outros módulos

- **`@machize/subscriptions`** — planos, Checkout, Portal, estado da subscrição.
- **`@machize/tenancy` / `@machize/auth`** — resolvem o tenant e o utilizador.
