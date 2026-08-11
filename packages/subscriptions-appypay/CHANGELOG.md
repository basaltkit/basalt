# @basaltkit/subscriptions-appypay

## 0.1.0

### Initial (pre-release)

- AppyPay driver skeleton for the `@basaltkit/subscriptions` `PaymentGateway`
  contract — Multicaixa Express (push), reference and card payments for Angola.
- `AppyPayGateway` implements `createPayment` (OAuth2 client-credentials token +
  cached, then a charge mapped to `push` / `reference` / `url`) and
  `verifyWebhook` (optional HMAC-SHA256 + payload → `payment.succeeded` /
  `payment.failed`). Fetch client is injectable.
- **Not yet validated against the live AppyPay API.** Provider-specific wire
  details (URLs, request/response field names, method enum, webhook scheme) are
  grouped in `APPYPAY_WIRE` and marked `TODO(verify)`. Pending a sandbox run
  before a 1.0 release.
