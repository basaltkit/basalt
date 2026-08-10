# @basaltkit/subscriptions-proxypay

[ProxyPay](https://developer.proxypay.co.ao) payment gateway driver for [`@basaltkit/subscriptions`](https://github.com/Zebedeu/basalt/tree/main/packages/subscriptions) — **reference-based Multicaixa / EMIS payments for Angola (AOA)**.

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
  webhookSecret: process.env.PROXYPAY_WEBHOOK_SECRET, // HMAC-SHA256, optional
})

// Create a payment — reserves a reference and returns what to show the customer.
const instruction = await payments.createPayment({
  billableId: 'acme',        // echoed back on the webhook (custom_fields.billable_id)
  amount: 5000,              // 5000,00 Kz
  reference: 'invoice_2026_08',
  expiresAt: Date.now() + 3 * 24 * 60 * 60 * 1000,
})

// instruction.reference = { entity: '00123', reference: '900000001', amount: 5000 }
// → show "Entidade 00123 · Referência 900000001 · 5.000,00 Kz"
```

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

`verifyWebhook` throws `WebhookInvalidError` (HTTP 400) on a bad signature and returns `null` for non-payment events.

## API surface used

- `POST /reference_ids` — reserve the next reference id
- `PUT /references/{id}` — activate it with `amount`, `custom_fields`, `end_datetime`
- `GET /references/{id}` — status poll (`getPayment`, a webhook fallback)
- ProxyPay `payment` webhook → `payment.succeeded`

## Recurring billing

ProxyPay has no card-on-file recurring charge. Model recurring by creating **one payment (reference) per period** — issue the next reference when the current period ends (or on an invoice), and activate the period when its `payment.succeeded` arrives.

## Notes & testing

- Amounts are AOA in the major unit (`5000` = 5.000,00 Kz), formatted to two decimals for ProxyPay.
- The **fetch client is injectable** (`options.fetch`) — the global `fetch` is used by default. No hard HTTP dependency.
- **Webhook auth** varies by ProxyPay account setup. This driver verifies an HMAC-SHA256 of the raw body against a signature header when `webhookSecret` is set; if your account secures the callback with HTTP Basic auth instead, verify that at the route and omit `webhookSecret`.
- Verify the exact `/reference_ids` response shape and webhook signature scheme against **your ProxyPay sandbox** — the driver handles the common shapes but every account's setup should be confirmed against real credentials.
