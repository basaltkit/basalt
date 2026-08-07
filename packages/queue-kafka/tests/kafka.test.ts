import { describe, expect, it } from 'vitest'
import { KafkaQueueDriver, type KafkaClient, type KafkaConsumer, type KafkaMessage, type KafkaProducer } from '../src/index.js'

interface Sent {
  topic: string
  messages: { value: string; headers?: Record<string, string> }[]
}

class FakeProducer implements KafkaProducer {
  readonly sent: Sent[] = []
  connected = false
  async connect(): Promise<void> {
    this.connected = true
  }
  async send(record: Sent): Promise<unknown> {
    this.sent.push(record)
    return {}
  }
  async disconnect(): Promise<void> {}
}

class FakeConsumer implements KafkaConsumer {
  readonly topics: string[] = []
  concurrency: number | undefined
  private each: ((p: { topic: string; message: KafkaMessage }) => Promise<void>) | undefined
  private resolveReady!: () => void
  readonly ready = new Promise<void>((r) => (this.resolveReady = r))

  async connect(): Promise<void> {}
  async subscribe(s: { topic: string }): Promise<void> {
    this.topics.push(s.topic)
  }
  async run(config: {
    eachMessage: (p: { topic: string; message: KafkaMessage }) => Promise<void>
    partitionsConsumedConcurrently?: number
  }): Promise<void> {
    this.each = config.eachMessage
    this.concurrency = config.partitionsConsumedConcurrently
    this.resolveReady()
  }
  async disconnect(): Promise<void> {}

  async deliver(topic: string, headers: Record<string, string>, payload: unknown): Promise<void> {
    await this.each?.({ topic, message: { value: JSON.stringify(payload), headers } })
  }
}

class FakeKafka implements KafkaClient {
  readonly prod = new FakeProducer()
  readonly cons = new FakeConsumer()
  producer(): KafkaProducer {
    return this.prod
  }
  consumer(): KafkaConsumer {
    return this.cons
  }
}

const driverWith = (client: FakeKafka) => new KafkaQueueDriver({ brokers: ['x:9092'], client })

describe('KafkaQueueDriver', () => {
  it('is honest about capabilities (no delayed, no priority)', () => {
    expect(new KafkaQueueDriver({ brokers: [] }).capabilities).toEqual({
      delayed: false,
      priority: false,
      retries: true,
      backoff: false,
    })
  })

  it('produces a job to its topic with job headers', async () => {
    const kafka = new FakeKafka()
    await driverWith(kafka).add('welcome', 'send-welcome', { name: 'Ada' }, { attempts: 2 })

    expect(kafka.prod.connected).toBe(true)
    const rec = kafka.prod.sent[0]!
    expect(rec.topic).toBe('welcome')
    expect(JSON.parse(rec.messages[0]!.value)).toEqual({ name: 'Ada' })
    expect(rec.messages[0]!.headers).toMatchObject({ 'x-machize-job': 'send-welcome', 'x-machize-attempt': '1', 'x-machize-attempts': '2' })
  })

  it('subscribes to both the topic and its retry topic', async () => {
    const kafka = new FakeKafka()
    const driver = driverWith(kafka)
    driver.setExecutor(async () => {})
    driver.startWorker('welcome', { concurrency: 4 })
    await kafka.cons.ready
    expect(kafka.cons.topics).toEqual(['welcome', 'welcome.retry'])
    expect(kafka.cons.concurrency).toBe(4)
  })

  it('retries via the retry topic, then dead-letters', async () => {
    const kafka = new FakeKafka()
    const driver = driverWith(kafka)
    driver.setExecutor(async () => {
      throw new Error('boom')
    })
    driver.startWorker('welcome')
    await kafka.cons.ready

    // attempt 1 of 2 → re-produced to welcome.retry as attempt 2
    await kafka.cons.deliver('welcome', { 'x-machize-job': 'send-welcome', 'x-machize-attempt': '1', 'x-machize-attempts': '2' }, { name: 'Ada' })
    const retry = kafka.prod.sent.find((s) => s.topic === 'welcome.retry')!
    expect(retry).toBeTruthy()
    expect(retry.messages[0]!.headers?.['x-machize-attempt']).toBe('2')

    // attempt 2 of 2 → dead-lettered
    await kafka.cons.deliver('welcome.retry', { 'x-machize-job': 'send-welcome', 'x-machize-attempt': '2', 'x-machize-attempts': '2' }, { name: 'Ada' })
    expect(kafka.prod.sent.find((s) => s.topic === 'welcome.dead')).toBeTruthy()
  })

  it('acks (no re-produce) when the job succeeds', async () => {
    const kafka = new FakeKafka()
    const driver = driverWith(kafka)
    const seen: unknown[] = []
    driver.setExecutor(async (name, data) => {
      seen.push([name, data])
    })
    driver.startWorker('welcome')
    await kafka.cons.ready

    await kafka.cons.deliver('welcome', { 'x-machize-job': 'send-welcome', 'x-machize-attempt': '1', 'x-machize-attempts': '1' }, { name: 'Ada' })
    expect(seen).toEqual([['send-welcome', { name: 'Ada' }]])
    expect(kafka.prod.sent).toHaveLength(0) // nothing re-produced
  })
})
