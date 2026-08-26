<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

# @basaltkit/subscriptions-pdf

Render [`@basaltkit/subscriptions`](https://www.npmjs.com/package/@basaltkit/subscriptions)
invoices to **PDF** with [pdfkit](https://pdfkit.org) — the printable counterpart
of the core's `renderInvoiceHtml`, from the same `Invoice` object. It lives in
this satellite so the core stays dependency-free.

```bash
pnpm add @basaltkit/subscriptions-pdf   # pulls in pdfkit
```

```ts
import { writeFile } from 'node:fs/promises'
import { renderInvoicePdf } from '@basaltkit/subscriptions-pdf'

const invoice = await invoices.finalize(draft.id)          // a @basaltkit/subscriptions Invoice
const pdf = await renderInvoicePdf(invoice, { businessName: 'Acme Inc' })
await writeFile('invoice.pdf', pdf)                         // pdf is a Buffer
```

`renderInvoicePdf(invoice, options?)` returns a `Promise<Buffer>`:

| Option | Default | |
| --- | --- | --- |
| `businessName` | `'Invoice'` | Name printed in the header. |
| `locale` | `'en-US'` | Locale for money formatting (amounts stay in the invoice's currency). |

The layout mirrors the HTML/text renderers: header (number + status + billable),
a line-item table, and the subtotal / discount / tax / total / amount-due block,
plus any `notes`. Serve it over HTTP with `reply.header('content-type',
'application/pdf').send(pdf)`.
