import { randomUUID } from 'node:crypto'
import { BasaltError } from '@basaltkit/core'
import { assertMinorUnits, formatMoney } from './money.js'
import { planPrice, type BillingPeriod, type PlanDefinition } from './plans.js'

/**
 * Invoices — the billing depth on top of `Subscriptions`. A subscription tells
 * you *what* a tenant is entitled to; an invoice is the immutable record of
 * *what they were charged* for a period: line items, discount, tax, totals and
 * a payment status. Pure domain (no HTTP, no gateway) — so it works the same
 * regardless of the HTTP adapter or payment driver in front of it.
 *
 * Lifecycle: `draft` → (finalize) → `open` → (markPaid) → `paid`. A draft or
 * open invoice can be `void`ed. All amounts are integer minor units (cents).
 */
export type InvoiceStatus = 'draft' | 'open' | 'paid' | 'void' | 'uncollectible'

/** An input line — `amount` is derived, never supplied. */
export interface NewLineItem {
  description: string
  /** Default 1. */
  quantity?: number
  /** Price per unit in minor units (integer). */
  unitAmount: number
  metadata?: Record<string, unknown>
}

export interface InvoiceLineItem {
  description: string
  quantity: number
  unitAmount: number
  /** quantity × unitAmount, minor units. */
  amount: number
  metadata?: Record<string, unknown>
}

export interface Invoice {
  id: string
  /** Human number (e.g. `INV-2026-0001`), assigned on finalize. Empty while draft. */
  number: string
  billableId: string
  currency: string
  status: InvoiceStatus
  lineItems: InvoiceLineItem[]
  /** Sum of line amounts. */
  subtotal: number
  /** Minor units, ≥ 0, ≤ subtotal. */
  discount: number
  /** Minor units, ≥ 0. */
  tax: number
  /** subtotal − discount + tax. */
  total: number
  amountPaid: number
  /** total − amountPaid. */
  amountDue: number
  periodStart?: number
  periodEnd?: number
  createdAt: number
  finalizedAt?: number
  dueAt?: number
  paidAt?: number
  voidedAt?: number
  /** Link to the `PaymentRecord.id` / gateway reference that settled it. */
  paymentId?: string
  gatewayRef?: string
  notes?: string
  metadata?: Record<string, unknown>
}

export class InvoiceNotFoundError extends BasaltError {
  readonly status = 404
  constructor(id: string) {
    super('INVOICE_NOT_FOUND', `Invoice "${id}" was not found.`)
  }
}

export class InvoiceStateError extends BasaltError {
  readonly status = 409
  constructor(from: InvoiceStatus, action: string) {
    super('INVOICE_INVALID_STATE', `Cannot ${action} an invoice in "${from}" state.`)
  }
}

export interface InvoiceStore {
  save(invoice: Invoice): Promise<void>
  get(id: string): Promise<Invoice | null>
  /** Newest first. */
  forBillable(billableId: string): Promise<Invoice[]>
  /** Atomically allocate the next human-readable invoice number. */
  nextNumber(prefix: string, year: number): Promise<string>
}

/** In-memory store — per-process. Back it with your database in production. */
export class MemoryInvoiceStore implements InvoiceStore {
  private readonly records = new Map<string, Invoice>()
  private readonly counters = new Map<number, number>()

  async save(invoice: Invoice): Promise<void> {
    this.records.set(invoice.id, structuredClone(invoice))
  }
  async get(id: string): Promise<Invoice | null> {
    const found = this.records.get(id)
    return found ? structuredClone(found) : null
  }
  async forBillable(billableId: string): Promise<Invoice[]> {
    return [...this.records.values()]
      .filter((i) => i.billableId === billableId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((i) => structuredClone(i))
  }
  async nextNumber(prefix: string, year: number): Promise<string> {
    const next = (this.counters.get(year) ?? 0) + 1
    this.counters.set(year, next)
    return `${prefix}-${year}-${String(next).padStart(4, '0')}`
  }
}

export interface DraftInvoiceInput {
  billableId: string
  currency: string
  lineItems: NewLineItem[]
  /** Absolute discount in minor units. Clamped to [0, subtotal]. */
  discount?: number
  /** Absolute tax (minor units) or a `{ rate }` (0.14 = 14% of subtotal − discount). */
  tax?: number | { rate: number }
  periodStart?: number
  periodEnd?: number
  /** Days until due; sets `dueAt` when finalized. */
  dueInDays?: number
  notes?: string
  metadata?: Record<string, unknown>
}

export interface InvoicesOptions {
  store?: InvoiceStore
  /** Invoice-number prefix. Default `INV`. */
  numberPrefix?: string
  /** Default tax rate applied when a draft omits `tax`. 0.14 = 14%. Default 0. */
  taxRate?: number
  now?: () => number
  idFactory?: () => string
}

const round = (n: number): number => Math.round(n)

/** Build a concrete line (with derived `amount`) from a `NewLineItem`. */
function toLine(input: NewLineItem): InvoiceLineItem {
  const quantity = input.quantity ?? 1
  assertMinorUnits(input.unitAmount, 'unitAmount')
  return {
    description: input.description,
    quantity,
    unitAmount: input.unitAmount,
    amount: input.unitAmount * quantity,
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
  }
}

/**
 * Recompute all money fields from `lineItems`, `discount` and `tax`. Keeps the
 * invoice internally consistent after any edit.
 */
function recompute(invoice: Invoice): void {
  invoice.subtotal = invoice.lineItems.reduce((sum, l) => sum + l.amount, 0)
  invoice.discount = Math.min(Math.max(0, round(invoice.discount)), invoice.subtotal)
  invoice.tax = Math.max(0, round(invoice.tax))
  invoice.total = invoice.subtotal - invoice.discount + invoice.tax
  invoice.amountDue = Math.max(0, invoice.total - invoice.amountPaid)
}

export class Invoices {
  private readonly store: InvoiceStore
  private readonly prefix: string
  private readonly taxRate: number
  private readonly now: () => number
  private readonly newId: () => string

  constructor(options: InvoicesOptions = {}) {
    this.store = options.store ?? new MemoryInvoiceStore()
    this.prefix = options.numberPrefix ?? 'INV'
    this.taxRate = options.taxRate ?? 0
    this.now = options.now ?? (() => Date.now())
    this.newId = options.idFactory ?? (() => randomUUID())
  }

  /** Create a `draft` invoice with computed totals. No number is assigned yet. */
  async draft(input: DraftInvoiceInput): Promise<Invoice> {
    const now = this.now()
    const lineItems = input.lineItems.map(toLine)
    const subtotal = lineItems.reduce((sum, l) => sum + l.amount, 0)
    const discount = Math.min(Math.max(0, round(input.discount ?? 0)), subtotal)
    const taxable = subtotal - discount
    const tax =
      input.tax === undefined
        ? round(taxable * this.taxRate)
        : typeof input.tax === 'number'
          ? round(input.tax)
          : round(taxable * input.tax.rate)

    const invoice: Invoice = {
      id: this.newId(),
      number: '',
      billableId: input.billableId,
      currency: input.currency,
      status: 'draft',
      lineItems,
      subtotal,
      discount,
      tax,
      total: taxable + tax,
      amountPaid: 0,
      amountDue: taxable + tax,
      createdAt: now,
      ...(input.periodStart !== undefined ? { periodStart: input.periodStart } : {}),
      ...(input.periodEnd !== undefined ? { periodEnd: input.periodEnd } : {}),
      ...(input.dueInDays !== undefined ? { dueAt: now + input.dueInDays * 86_400_000 } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    }
    await this.store.save(invoice)
    return invoice
  }

  /** Append a line to a `draft` and recompute. */
  async addLine(id: string, line: NewLineItem): Promise<Invoice> {
    const invoice = await this.require(id)
    if (invoice.status !== 'draft') throw new InvoiceStateError(invoice.status, 'add a line to')
    invoice.lineItems.push(toLine(line))
    recompute(invoice)
    await this.store.save(invoice)
    return invoice
  }

  /** Finalize a `draft` → `open`, assigning the sequential invoice number. */
  async finalize(id: string): Promise<Invoice> {
    const invoice = await this.require(id)
    if (invoice.status !== 'draft') throw new InvoiceStateError(invoice.status, 'finalize')
    const year = new Date(this.now()).getUTCFullYear()
    invoice.number = await this.store.nextNumber(this.prefix, year)
    invoice.status = 'open'
    invoice.finalizedAt = this.now()
    await this.store.save(invoice)
    return invoice
  }

  /** Mark an `open` invoice `paid`. Records the settling payment reference. */
  async markPaid(
    id: string,
    settlement: { paymentId?: string; gatewayRef?: string; paidAt?: number } = {},
  ): Promise<Invoice> {
    const invoice = await this.require(id)
    if (invoice.status !== 'open') throw new InvoiceStateError(invoice.status, 'pay')
    invoice.status = 'paid'
    invoice.amountPaid = invoice.total
    invoice.amountDue = 0
    invoice.paidAt = settlement.paidAt ?? this.now()
    if (settlement.paymentId !== undefined) invoice.paymentId = settlement.paymentId
    if (settlement.gatewayRef !== undefined) invoice.gatewayRef = settlement.gatewayRef
    await this.store.save(invoice)
    return invoice
  }

  /** Void a `draft` or `open` invoice (a paid one cannot be voided — refund instead). */
  async void(id: string): Promise<Invoice> {
    const invoice = await this.require(id)
    if (invoice.status !== 'draft' && invoice.status !== 'open') {
      throw new InvoiceStateError(invoice.status, 'void')
    }
    invoice.status = 'void'
    invoice.voidedAt = this.now()
    invoice.amountDue = 0
    await this.store.save(invoice)
    return invoice
  }

  async get(id: string): Promise<Invoice | null> {
    return this.store.get(id)
  }
  async list(billableId: string): Promise<Invoice[]> {
    return this.store.forBillable(billableId)
  }

  private async require(id: string): Promise<Invoice> {
    const invoice = await this.store.get(id)
    if (!invoice) throw new InvoiceNotFoundError(id)
    return invoice
  }
}

/**
 * The base subscription line for a plan/period — `planPrice()` as a single unit.
 * Throws for a `'custom'` (sales-led) price, which has no self-serve amount.
 */
export function planLine(
  planName: string,
  plan: PlanDefinition,
  period: BillingPeriod,
): NewLineItem {
  const price = planPrice(plan, period)
  if (price === 'custom') {
    throw new InvoiceStateError('draft', `invoice the custom-priced "${planName}" plan on`)
  }
  const label = planName.charAt(0).toUpperCase() + planName.slice(1)
  return { description: `${label} plan (${period})`, quantity: 1, unitAmount: price }
}

/**
 * A metered-overage line: units consumed above the included allowance, billed at
 * `unitAmount` each. Returns `null` when usage is within the allowance (no line).
 */
export function overageLine(
  feature: string,
  opts: { used: number; included: number; unitAmount: number },
): NewLineItem | null {
  const over = Math.max(0, Math.floor(opts.used) - Math.floor(opts.included))
  if (over <= 0) return null
  assertMinorUnits(opts.unitAmount, 'unitAmount')
  return {
    description: `${feature} overage (${over} × ${opts.included}+ )`,
    quantity: over,
    unitAmount: opts.unitAmount,
    metadata: { feature, used: opts.used, included: opts.included },
  }
}

/** Plain-text invoice — receipts, emails, logs. */
export function renderInvoiceText(invoice: Invoice, locale = 'en-US'): string {
  const m = (n: number) => formatMoney(n, invoice.currency, locale)
  const lines = invoice.lineItems.map(
    (l) => `  ${l.quantity} × ${l.description}  ${m(l.amount)}`,
  )
  const out = [
    `Invoice ${invoice.number || '(draft)'}  ·  ${invoice.status.toUpperCase()}`,
    `Billed to: ${invoice.billableId}`,
    '',
    ...lines,
    '',
    `  Subtotal   ${m(invoice.subtotal)}`,
  ]
  if (invoice.discount > 0) out.push(`  Discount  -${m(invoice.discount)}`)
  if (invoice.tax > 0) out.push(`  Tax        ${m(invoice.tax)}`)
  out.push(`  Total      ${m(invoice.total)}`, `  Due        ${m(invoice.amountDue)}`)
  if (invoice.notes) out.push('', invoice.notes)
  return out.join('\n')
}

/** Minimal self-contained HTML invoice (no external assets). */
export function renderInvoiceHtml(invoice: Invoice, locale = 'en-US'): string {
  const m = (n: number) => formatMoney(n, invoice.currency, locale)
  const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)
  const rows = invoice.lineItems
    .map(
      (l) =>
        `<tr><td>${esc(l.description)}</td><td class="n">${l.quantity}</td><td class="n">${m(l.unitAmount)}</td><td class="n">${m(l.amount)}</td></tr>`,
    )
    .join('')
  const extra = [
    invoice.discount > 0 ? `<tr><th colspan="3">Discount</th><td class="n">-${m(invoice.discount)}</td></tr>` : '',
    invoice.tax > 0 ? `<tr><th colspan="3">Tax</th><td class="n">${m(invoice.tax)}</td></tr>` : '',
  ].join('')
  return `<!doctype html><meta charset="utf-8"><title>Invoice ${esc(invoice.number)}</title>
<style>body{font:14px/1.5 system-ui,sans-serif;max-width:640px;margin:2rem auto;color:#1a1a2e}
h1{font-size:1.25rem}.status{font-size:.75rem;text-transform:uppercase;letter-spacing:.05em;padding:.2em .6em;border-radius:99px;background:#eef}
table{width:100%;border-collapse:collapse;margin-top:1rem}td,th{padding:.5rem;border-bottom:1px solid #e5e7eb;text-align:left}
.n{text-align:right;font-variant-numeric:tabular-nums}tfoot th,tfoot td{border:0}tfoot .total td{font-weight:700;border-top:2px solid #1a1a2e}</style>
<h1>Invoice ${esc(invoice.number || '(draft)')} <span class="status">${invoice.status}</span></h1>
<p>Billed to <strong>${esc(invoice.billableId)}</strong></p>
<table><thead><tr><th>Description</th><th class="n">Qty</th><th class="n">Unit</th><th class="n">Amount</th></tr></thead>
<tbody>${rows}</tbody>
<tfoot><tr><th colspan="3">Subtotal</th><td class="n">${m(invoice.subtotal)}</td></tr>${extra}
<tr class="total"><td colspan="3">Total</td><td class="n">${m(invoice.total)}</td></tr>
<tr><th colspan="3">Amount due</th><td class="n">${m(invoice.amountDue)}</td></tr></tfoot></table>
${invoice.notes ? `<p>${esc(invoice.notes)}</p>` : ''}`
}
