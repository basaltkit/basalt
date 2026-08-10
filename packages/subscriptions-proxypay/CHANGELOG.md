# @basaltkit/subscriptions-proxypay

## 1.0.0

### Initial release

- ProxyPay driver for the `@basaltkit/subscriptions` `PaymentGateway` contract —
  reference-based Multicaixa/EMIS payments for Angola (AOA).
- `ProxyPayGateway` implements `createPayment` (reserve + activate a reference,
  returning the Entity + Reference to pay), `verifyWebhook` (HMAC-SHA256 verify +
  translate the `payment` event to `payment.succeeded`), and a best-effort
  `getPayment` status poll. Fetch client is injectable; no hard HTTP dependency.
