import { describe, expect, it } from 'vitest'
import { Digest, MemoryDigestStore, defineNotification, type DigestBatch } from '../src/index.js'

const Alert = defineNotification<{ n: number }>({
  name: 'usage.alert',
  channels: ['mail'],
  via: { mail: ({ n }) => ({ text: `alert ${n}` }) },
})

describe('Digest', () => {
  it('collects rendered items and flushes them grouped per recipient+channel', async () => {
    const store = new MemoryDigestStore()
    const digest = new Digest({ store, now: () => 1 })

    await digest.collect({ id: 'u1' }, Alert, { n: 1 })
    await digest.collect({ id: 'u1' }, Alert, { n: 2 })
    await digest.collect({ id: 'u2' }, Alert, { n: 9 })

    const batches: DigestBatch[] = []
    const flushed = await digest.flush(async (b) => { batches.push(b) })

    expect(flushed).toBe(2) // u1/mail and u2/mail
    const u1 = batches.find((b) => b.recipientId === 'u1')!
    expect(u1.channel).toBe('mail')
    expect(u1.items.map((i) => (i.message as { text: string }).text)).toEqual(['alert 1', 'alert 2'])
    expect(await store.pending()).toEqual([]) // cleared after flush
  })
})
