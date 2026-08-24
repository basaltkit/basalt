import PDFDocument from 'pdfkit'
import { formatMoney, type Invoice } from '@basaltkit/subscriptions'

export interface InvoicePdfOptions {
  /** Locale for money formatting (default `'en-US'`). */
  locale?: string
  /** Name printed in the header (your business). Default `'Invoice'`. */
  businessName?: string
}

/**
 * Render a `@basaltkit/subscriptions` {@link Invoice} to a PDF `Buffer` with
 * pdfkit — the printable counterpart of `renderInvoiceHtml`, from the same
 * Invoice object. Kept in this satellite so the core stays dependency-free.
 *
 * ```ts
 * const pdf = await renderInvoicePdf(invoice, { businessName: 'Acme Inc' })
 * await writeFile('invoice.pdf', pdf)
 * ```
 */
export function renderInvoicePdf(invoice: Invoice, options: InvoicePdfOptions = {}): Promise<Buffer> {
  const locale = options.locale ?? 'en-US'
  const m = (n: number) => formatMoney(n, invoice.currency, locale)

  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 })
    const chunks: Buffer[] = []
    doc.on('data', (c: Buffer) => chunks.push(c))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    const left = doc.page.margins.left
    const right = doc.page.width - doc.page.margins.right
    const width = right - left

    // Header
    doc.fontSize(20).font('Helvetica-Bold').text(options.businessName ?? 'Invoice', left, 50)
    doc
      .fontSize(10)
      .font('Helvetica')
      .text(`Invoice ${invoice.number || '(draft)'}`, left, 80)
      .text(`Status: ${invoice.status.toUpperCase()}`)
      .text(`Billed to: ${invoice.billableId}`)
    doc.moveDown()

    // Line-item table
    const top = doc.y + 10
    const cols = { desc: left, qty: left + width * 0.55, unit: left + width * 0.7, amount: right - 90 }
    doc.font('Helvetica-Bold').fontSize(10)
    doc.text('Description', cols.desc, top)
    doc.text('Qty', cols.qty, top, { width: 40, align: 'right' })
    doc.text('Unit', cols.unit, top, { width: 60, align: 'right' })
    doc.text('Amount', cols.amount, top, { width: 90, align: 'right' })
    doc
      .moveTo(left, top + 14)
      .lineTo(right, top + 14)
      .stroke()

    doc.font('Helvetica').fontSize(10)
    let y = top + 22
    for (const line of invoice.lineItems) {
      doc.text(line.description, cols.desc, y, { width: width * 0.5 })
      doc.text(String(line.quantity), cols.qty, y, { width: 40, align: 'right' })
      doc.text(m(line.unitAmount), cols.unit, y, { width: 60, align: 'right' })
      doc.text(m(line.amount), cols.amount, y, { width: 90, align: 'right' })
      y = doc.y + 6
    }

    // Totals
    doc
      .moveTo(left, y + 2)
      .lineTo(right, y + 2)
      .stroke()
    y += 10
    const totalRow = (label: string, value: string, bold = false) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10)
      doc.text(label, cols.unit - 60, y, { width: 120, align: 'right' })
      doc.text(value, cols.amount, y, { width: 90, align: 'right' })
      y += 16
    }
    totalRow('Subtotal', m(invoice.subtotal))
    if (invoice.discount > 0) totalRow('Discount', `-${m(invoice.discount)}`)
    if (invoice.tax > 0) totalRow('Tax', m(invoice.tax))
    totalRow('Total', m(invoice.total), true)
    totalRow('Amount due', m(invoice.amountDue), true)

    if (invoice.notes) doc.moveDown().font('Helvetica-Oblique').fontSize(9).text(invoice.notes, left, y + 10, { width })

    doc.end()
  })
}
