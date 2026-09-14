---
'@basaltkit/mailer-smtp': patch
---

Accept both nodemailer 9 and 10 as the peer dependency (`^9.0.0 || ^10.0.0`). The development dependency moved to nodemailer 10; applications still on nodemailer 9 keep a valid peer range instead of getting an unmet-peer warning on upgrade.
