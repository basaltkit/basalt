# @basaltkit/subscriptions-appypay

[AppyPay](https://www.appypay.co.ao) payment gateway driver for [`@basaltkit/subscriptions`](https://github.com/Zebedeu/basalt/tree/main/packages/subscriptions) — **Multicaixa Express (push), reference and card payments for Angola (AOA)**.

Where [`@basaltkit/subscriptions-proxypay`](https://github.com/Zebedeu/basalt/tree/main/packages/subscriptions-proxypay) is reference-only, AppyPay adds **push** (the customer approves on their phone via Multicaixa Express) and **card** flows — all behind the same `PaymentGateway` contract, so your checkout and webhook code doesn't change.

> ⚠️ **Pre-release (0.x).** The AppyPay-specific wire details — token/charge URLs, request/response field names, the payment-method enum, and the webhook signature scheme — are **not yet validated against the live AppyPay API**. They live in the `APPYPAY_WIRE` block and are marked `TODO(verify)` in the source. The `PaymentGateway` mapping, OAuth token caching and HMAC verification are stable. **Do not use in production until validated against the AppyPay sandbox.**

## Installation

```bash
pnpm add @basaltkit/subscriptions @basaltkit/subscriptions-appypay
```

## Usage

```ts
import { AppyPayGateway } from '@basaltkit/subscriptions-appypay'

const payments = new AppyPayGateway({
  clientId: process.env.APPYPAY_CLIENT_ID!,
  clientSecret: process.env.APPYPAY_CLIENT_SECRET!,
  tokenUrl: process.env.APPYPAY_TOKEN_URL!, // OAuth2 client-credentials endpoint
  sandbox: process.env.NODE_ENV !== 'production',
  defaultMethod: 'reference', // 'express' | 'reference' | 'card'
  webhookSecret: process.env.APPYPAY_WEBHOOK_SECRET, // if AppyPay signs callbacks
})

// Reference payment (Multicaixa)
const ref = await payments.createPayment({ billableId: 'acme', amount: 5000, reference: 'order_1' })
// ref.reference = { entity, reference, amount } — show it to the customer

// Multicaixa Express (push to the customer's phone)
const push = await payments.createPayment({
  billableId: 'acme',
  amount: 5000,
  reference: 'order_2',
  customer: { phone: '+244923000000' },
  metadata: { appypay_method: 'express' },
})
// push.push = { phone } — the prompt was sent; confirmation arrives by webhook
```

### Receiving the webhook

```ts
app.post('/webhooks/appypay', async (request, reply) => {
  const raw = request.rawBody // the exact bytes — needed for signature verification
  const event = payments.verifyWebhook(raw, request.headers['x-signature'])
  if (event?.type === 'payment.succeeded') {
    await activate(event.billableId!, event.paymentId)
  }
  reply.code(200).send()
})
```

`verifyWebhook` throws `WebhookInvalidError` (HTTP 400) on a bad signature, and returns `null` for a verified event that isn't a terminal payment.

## Picking a method

Per request via `metadata.appypay_method` (`'express' | 'reference' | 'card'`), or set `defaultMethod` on the gateway. `express` requires `customer.phone`.

| Method | Returns | Customer experience |
| --- | --- | --- |
| `express` | `push: { phone }` | Approves the prompt in Multicaixa Express |
| `reference` | `reference: { entity, reference, amount }` | Pays the reference at an ATM / app |
| `card` | `url` | Redirected to a hosted card page |

## Before production — `TODO(verify)` against the AppyPay sandbox

Confirm and correct these in `src/index.ts` (grouped in `APPYPAY_WIRE` + inline `TODO(verify)`):

1. **OAuth2** token endpoint URL and whether a `scope`/`resource` is required.
2. **Charge** endpoint path and request field names (`merchantTransactionId`, `amount`, `currency`, `paymentMethod`, `paymentInfo.phoneNumber`, `metadata`).
3. **`paymentMethod` enum** values for express / reference / card.
4. **Charge response** field names used to build the instruction (`id`, `entity`, `reference`, `redirectUrl`).
5. **Webhook**: payload shape, the `status` strings (paid vs failed), the signature header name and scheme (HMAC vs Basic vs bearer).
6. **Sandbox host** URL.

Validate exactly as the ProxyPay driver was: a small live charge + a real webhook capture.

## Notes

- Amounts are AOA in the major unit (`5000` = 5.000,00 Kz), sent as a two-decimal number.
- The **fetch client is injectable** (`options.fetch`) — the global `fetch` is used by default. No hard HTTP dependency.
- Use `FakePaymentGateway` from `@basaltkit/subscriptions` to test your checkout/webhook without a network.
