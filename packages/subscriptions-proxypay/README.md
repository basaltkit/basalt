<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

# @basaltkit/subscriptions-proxypay

[ProxyPay](https://developer.proxypay.co.ao) payment gateway driver for [`@basaltkit/subscriptions`](https://github.com/basaltkit/basalt/tree/main/packages/subscriptions) — **reference-based Multicaixa / EMIS payments for Angola (AOA)**.

Basalt's `BillingGateway` models card subscriptions (Stripe/Paddle). Angolan providers work differently: the customer pays a **Reference** at an ATM, Multicaixa Express, or a bank app using your account's fixed **Entity**, and the gateway confirms by webhook. This driver implements the `PaymentGateway` contract for that model.

## Installation

```bash
pnpm add @basaltkit/subscriptions @basaltkit/subscriptions-proxypay
```

## Usage

```ts
import { ProxyPayGateway } from '@basaltkit/subscriptions-proxypay'

const payments = new ProxyPayGateway({
  apiKey: process.env.PROXYPAY_API_KEY!,   // Authorization: Token <key>
  entity: process.env.PROXYPAY_ENTITY!,    // your Multicaixa Entity (Entidade)
  sandbox: process.env.NODE_ENV !== 'production',
  // webhookSecret defaults to apiKey (what ProxyPay signs with); override or set '' to disable.
})

// Create a payment — reserves a reference and returns what to show the customer.
const instruction = await payments.createPayment({
  billableId: 'acme',        // echoed back on the webhook (custom_fields.billable_id)
  amount: 5000,              // 5000,00 Kz
  expiresAt: Date.now() + 3 * 24 * 60 * 60 * 1000,
})

// instruction.reference = { entity: '00123', reference: '900000001', amount: 5000 }
// → show "Entidade 00123 · Referência 900000001 · 5.000,00 Kz"
```

> **Bring your own reference:** pass a numeric `reference` (e.g. an order id that
> is a valid ProxyPay reference) to use it directly and skip the `POST /reference_ids`
> reserve call. Omit it to have the driver reserve the next available id for you.

### Receiving the webhook

Point your ProxyPay webhook at a route and translate it:

```ts
app.post('/webhooks/proxypay', async (request, reply) => {
  const raw = request.rawBody // the exact bytes — needed for signature verification
  const event = payments.verifyWebhook(raw, request.headers['x-signature'])
  if (event?.type === 'payment.succeeded') {
    // event.billableId, event.amount, event.reference, event.paymentId
    await activatePeriod(event.billableId!)
  }
  reply.code(200).send()
})
```

`verifyWebhook` throws `WebhookInvalidError` (HTTP 400) on a bad signature and returns `null` when the payload carries no `reference_id` (i.e. it isn't a payment callback). ProxyPay posts a **flat** payment object — top-level `reference_id`, `amount`, `id`, `custom_fields` — signed with HMAC-SHA256 in the `x-signature` header.

## API surface used

- `POST /reference_ids` — reserve the next reference id (skipped if you pass a `reference`)
- `PUT /references/{id}` — activate it with `amount`, `custom_fields`, `end_datetime` (**required** — defaults to `expiryDays` from now, 30 days, when `expiresAt` is omitted)
- ProxyPay `payment` webhook → `payment.succeeded`

## Recurring billing

ProxyPay has no card-on-file recurring charge. Model recurring by creating **one payment (reference) per period** — issue the next reference when the current period ends (or on an invoice), and activate the period when its `payment.succeeded` arrives.

## Notes & testing

- Amounts are AOA in the major unit (`5000` = 5.000,00 Kz), sent to ProxyPay as a two-decimal-rounded number.
- The **fetch client is injectable** (`options.fetch`) — the global `fetch` is used by default. No hard HTTP dependency.
- **Webhook auth**: ProxyPay signs the callback with your API key (HMAC-SHA256 of the raw body, hex, in the `x-signature` header), so `webhookSecret` defaults to `apiKey` and verification is on by default. Override `webhookSecret` if you configured a custom secret, or set it to `''` to disable (e.g. if you secure the callback with HTTP Basic auth on the URL instead).
- Verify the exact `/reference_ids` response shape and webhook signature scheme against **your ProxyPay sandbox** — the driver handles the common shapes but every account's setup should be confirmed against real credentials.
