---
'@basaltkit/notifications': minor
---

SMS & WhatsApp channels. `SmsChannel` delivers notifications over a
provider-agnostic `SmsSender` (implement it with Twilio, Vonage, MessageBird,
AppyPay… — no provider SDK in the framework), and `whatsappChannel()` is the same
channel named `whatsapp` reading `recipient.whatsapp ?? recipient.phone`. Both
honour per-recipient opt-out via `channelPreferences` like every channel.
`Notifiable` gains a named `phone?` field. Wire with
`notificationsPlugin({ channels: [new SmsChannel(sender)] })`.
