# @basaltkit/subscriptions-proxypay

## 2.0.0

### Major Changes

- **BREAKING: amounts are now integers in minor units** (cents), matching
  `@basaltkit/subscriptions@2.0`. `createPayment` validates the amount is a
  minor-unit integer and converts it to ProxyPay's major-unit decimal (e.g.
  `500000` → `5000.00`); `verifyWebhook` converts ProxyPay's major-unit amount
  back to minor units. `PaymentInstruction.reference.amount` is minor units.
  Requires `@basaltkit/subscriptions` ^2.0.0.

## 1.0.5

### Patch Changes

- Only treat `PaymentRequest.reference` as the ProxyPay reference id when it's
  **numeric**. A logical order id (e.g. the `billableId:plan:timestamp` that
  `RecurringReferenceBilling` sets) is now kept in `custom_fields.reference`
  while ProxyPay assigns a numeric id via `POST /reference_ids` — previously a
  non-numeric reference produced `PUT /references/<non-numeric>` and a 400. The
  numeric-reference fast path (Brilho Total style) is unchanged.

## 1.0.4

### Patch Changes

- **Always send `end_datetime` — ProxyPay requires it.** Creating a reference
  without it returns `400 "é de preenchimento obrigatório"`. `createPayment` now
  always sends `end_datetime`, derived from `PaymentRequest.expiresAt` or a new
  `expiryDays` option (default 30 days from now). Verified against the live API.

## 1.0.3

### Patch Changes

- **Fix `verifyWebhook` for the real ProxyPay payload (critical).** ProxyPay
  posts a **flat** payment object — top-level `reference_id`, `amount`, `id`,
  `custom_fields` (the same shape as a `GET /payments` item), signed with
  HMAC-SHA256 in the `x-signature` header. The previous version expected a nested
  `{ event_type: 'payment', data: {...} }` shape and returned `null` for every
  real callback, so payments were never confirmed. It now reads the flat shape.
- **Default the webhook signing secret to the API key.** ProxyPay signs the
  callback with your API key, so `webhookSecret` now defaults to it and
  verification is on out of the box; pass `webhookSecret: ''` to disable.
- **Send `amount` as a JSON number** (was a `"0.00"` string) and **`end_datetime`
  as a date** (`YYYY-MM-DD`, was a full ISO datetime that could shift a day in
  UTC) — both matching a known-good production integration.
- **Honor a caller-supplied `reference`** as the ProxyPay reference id, skipping
  the extra `POST /reference_ids` round-trip when you already have an id.
- **Add `callbackUrl`** option, echoed on the reference as
  `custom_fields.callback_url`.

## 1.0.2

### Patch Changes

- Remove `getPayment`: ProxyPay `GET /references/{id}` 404s even for active,
  unpaid references, so the poll could report a pending reference as paid.
  Payment confirmation is via the `payment` webhook (`verifyWebhook`). Verified
  the createPayment flow against the live ProxyPay API.

## 1.0.1

### Patch Changes

- Fix reference reservation: ProxyPay uses **POST** `/reference_ids` (1.0.0 used
  GET, which 404s). Verified against the live ProxyPay API.

## 1.0.0

### Initial release

- ProxyPay driver for the `@basaltkit/subscriptions` `PaymentGateway` contract —
  reference-based Multicaixa/EMIS payments for Angola (AOA).
- `ProxyPayGateway` implements `createPayment` (reserve + activate a reference,
  returning the Entity + Reference to pay), `verifyWebhook` (HMAC-SHA256 verify +
  translate the `payment` event to `payment.succeeded`), and a best-effort
  `getPayment` status poll. Fetch client is injectable; no hard HTTP dependency.
