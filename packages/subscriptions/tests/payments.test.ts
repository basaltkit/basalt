import { describe, expect, it } from 'vitest'
import {
  MemoryPaymentStore,
  PaymentAmountMismatchError,
  PaymentLedger,
  type PaymentEvent,
  type PaymentInstruction,
  type PaymentRequest,
} from '../src/index.js'

const req: PaymentRequest = { billableId: 'acme', amount: 5000, reference: 'order_1' }
const inst: PaymentInstruction = { id: 'pay_1', status: 'pending', raw: { gw: 1 } }
const paid = (over: Partial<PaymentEvent> = {}): PaymentEvent => ({
  id: 'evt_1',
  type: 'payment.succeeded',
  paymentId: 'pay_1',
  amount: 5000,
  ...over,
})

describe('MemoryPaymentStore', () => {
  it('records pending, applies a terminal status, and does not clobber on re-create', async () => {
    const store = new MemoryPaymentStore()
    await store.create({ id: 'p', amount: 100, billableId: 'acme', reference: 'o1' })
    await store.create({ id: 'p', amount: 999 }) // no-op: id exists
    let rec = await store.get('p')
    expect(rec).toMatchObject({ id: 'p', status: 'pending', amount: 100, billableId: 'acme', reference: 'o1' })

    await store.setStatus('p', 'paid', { amount: 100 })
    rec = await store.get('p')
    expect(rec?.status).toBe('paid')
    expect(rec!.updatedAt).toBeGreaterThanOrEqual(rec!.createdAt)
  })

  it('setStatus upserts when the payment was never recorded', async () => {
    const store = new MemoryPaymentStore()
    await store.setStatus('ghost', 'paid', { amount: 42 })
    expect(await store.get('ghost')).toMatchObject({ id: 'ghost', status: 'paid', amount: 42 })
  })
})

describe('PaymentLedger', () => {
  it('records a created payment as pending, then flips it to paid', async () => {
    const ledger = new PaymentLedger()
    await ledger.created(inst, req)
    expect((await ledger.get('pay_1'))?.status).toBe('pending')

    const result = await ledger.apply(paid())
    expect(result.fresh).toBe(true)
    expect(result.record).toMatchObject({ id: 'pay_1', status: 'paid', amount: 5000 })
  })

  it('refuses to mark paid when the confirmed amount differs from the requested one', async () => {
    const ledger = new PaymentLedger()
    await ledger.created(inst, req) // requested 5000

    // an underpayment / forged callback claiming success for only 1000
    await expect(ledger.apply(paid({ amount: 1000 }))).rejects.toBeInstanceOf(PaymentAmountMismatchError)
    expect((await ledger.get('pay_1'))?.status).toBe('pending') // never settled

    // the claim was released, so the correct amount still applies on retry
    const ok = await ledger.apply(paid({ amount: 5000 }))
    expect(ok.fresh).toBe(true)
    expect(ok.record).toMatchObject({ status: 'paid', amount: 5000 })
  })

  it('deduplicates a retried webhook by event id', async () => {
    const ledger = new PaymentLedger()
    await ledger.created(inst, req)

    const first = await ledger.apply(paid())
    const second = await ledger.apply(paid()) // same event.id
    expect(first.fresh).toBe(true)
    expect(second.fresh).toBe(false)
    expect(second.record).toBeUndefined()
  })

  it('maps payment.failed to a failed record', async () => {
    const ledger = new PaymentLedger()
    await ledger.created(inst, req)
    const result = await ledger.apply(paid({ id: 'evt_2', type: 'payment.failed' }))
    expect(result.record?.status).toBe('failed')
  })

  it('emits recorded on created and confirmed once on a fresh apply (not on dedup)', async () => {
    const ledger = new PaymentLedger()
    const recorded: string[] = []
    const confirmed: string[] = []
    ledger.on('recorded', ({ payment }) => {
      recorded.push(payment.id)
    })
    ledger.on('confirmed', ({ record, event }) => {
      confirmed.push(`${event.paymentId}:${record?.status}`)
    })

    await ledger.created(inst, req)
    expect(recorded).toEqual(['pay_1'])

    await ledger.apply(paid())
    await ledger.apply(paid()) // duplicate — must not re-emit
    expect(confirmed).toEqual(['pay_1:paid'])
  })

  it('emits failed for a failed payment', async () => {
    const ledger = new PaymentLedger()
    const seen: string[] = []
    ledger.on('failed', ({ event }) => {
      seen.push(event.paymentId)
    })
    await ledger.created(inst, req)
    await ledger.apply(paid({ id: 'evt-x', type: 'payment.failed' }))
    expect(seen).toEqual(['pay_1'])
  })

  it('a throwing listener does not roll back the payment (reported via onListenerError)', async () => {
    const errors: unknown[] = []
    const ledger = new PaymentLedger({ onListenerError: (e) => errors.push(e) })
    ledger.on('confirmed', () => {
      throw new Error('notify failed')
    })
    await ledger.created(inst, req)
    const result = await ledger.apply(paid())
    expect(result.fresh).toBe(true)
    expect(result.record?.status).toBe('paid') // payment still applied
    expect(errors).toHaveLength(1)
  })

  it('unsubscribe stops further events', async () => {
    const ledger = new PaymentLedger()
    let count = 0
    const off = ledger.on('confirmed', () => {
      count++
    })
    off()
    await ledger.created(inst, req)
    await ledger.apply(paid())
    expect(count).toBe(0)
  })

  it('releases the dedupe claim when persisting throws, so a retry reprocesses', async () => {
    let fail = true
    const flaky = new MemoryPaymentStore()
    const original = flaky.setStatus.bind(flaky)
    flaky.setStatus = async (id, status, patch) => {
      if (fail) {
        fail = false
        throw new Error('db down')
      }
      return original(id, status, patch)
    }
    const ledger = new PaymentLedger({ store: flaky })
    await ledger.created(inst, req)

    await expect(ledger.apply(paid())).rejects.toThrow('db down')
    // same event id must NOT be deduped after a failed apply
    const retry = await ledger.apply(paid())
    expect(retry.fresh).toBe(true)
    expect(retry.record?.status).toBe('paid')
  })
})
