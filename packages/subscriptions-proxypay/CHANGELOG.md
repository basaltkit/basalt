# @basaltkit/subscriptions-proxypay

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
