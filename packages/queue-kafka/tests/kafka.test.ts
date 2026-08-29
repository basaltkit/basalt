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
    expect(rec.messages[0]!.headers).toMatchObject({ 'x-basalt-job': 'send-welcome', 'x-basalt-attempt': '1', 'x-basalt-attempts': '2' })
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
    await kafka.cons.deliver('welcome', { 'x-basalt-job': 'send-welcome', 'x-basalt-attempt': '1', 'x-basalt-attempts': '2' }, { name: 'Ada' })
    const retry = kafka.prod.sent.find((s) => s.topic === 'welcome.retry')!
    expect(retry).toBeTruthy()
    expect(retry.messages[0]!.headers?.['x-basalt-attempt']).toBe('2')

    // attempt 2 of 2 → dead-lettered
    await kafka.cons.deliver('welcome.retry', { 'x-basalt-job': 'send-welcome', 'x-basalt-attempt': '2', 'x-basalt-attempts': '2' }, { name: 'Ada' })
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

    await kafka.cons.deliver('welcome', { 'x-basalt-job': 'send-welcome', 'x-basalt-attempt': '1', 'x-basalt-attempts': '1' }, { name: 'Ada' })
    expect(seen).toEqual([['send-welcome', { name: 'Ada' }]])
    expect(kafka.prod.sent).toHaveLength(0) // nothing re-produced
  })
})

describe('infrastructure-fault observability (onError — sibling pattern of rabbitmq/sqs)', () => {
  it('a worker connect failure at boot surfaces via onError, never as an unhandled rejection', async () => {
    const kafka = new FakeKafka()
    kafka.cons.connect = async () => {
      throw new Error('broker unreachable')
    }
    const seen: { error: unknown; info: { source: string; queue?: string } }[] = []
    const driver = new KafkaQueueDriver({
      brokers: ['x:9092'],
      client: kafka,
      onError: (error, info) => seen.push({ error, info }),
    })
    const unhandled: unknown[] = []
    const trap = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', trap)
    try {
      driver.startWorker('mail')
      await new Promise((r) => setTimeout(r, 20))
    } finally {
      process.off('unhandledRejection', trap)
    }
    expect(unhandled).toEqual([])
    expect(seen).toHaveLength(1)
    expect(seen[0]!.info).toEqual({ source: 'consumer', queue: 'mail' })
    expect((seen[0]!.error as Error).message).toBe('broker unreachable')
  })

  it('a failed retry re-publish surfaces via onError AND rethrows (offset must not commit — job not lost)', async () => {
    const kafka = new FakeKafka()
    const seen: { source: string; queue?: string }[] = []
    const driver = new KafkaQueueDriver({
      brokers: ['x:9092'],
      client: kafka,
      onError: (_error, info) => seen.push(info),
    })
    driver.setExecutor(async () => {
      throw new Error('job failed')
    })
    driver.startWorker('mail')
    await kafka.cons.ready
    kafka.prod.send = async () => {
      throw new Error('producer down')
    }
    await expect(
      kafka.cons.deliver('mail', { 'x-basalt-job': 'send', 'x-basalt-attempt': '1', 'x-basalt-attempts': '3' }, { to: 'x' }),
    ).rejects.toThrow('producer down')
    expect(seen).toEqual([{ source: 'producer', queue: 'mail' }])
  })

  it('default onError logs with context instead of crashing (no option passed)', async () => {
    const kafka = new FakeKafka()
    kafka.cons.subscribe = async () => {
      throw new Error('acl denied')
    }
    const driver = driverWith(kafka)
    const unhandled: unknown[] = []
    const trap = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', trap)
    const errors: unknown[][] = []
    const original = console.error
    console.error = (...args: unknown[]) => void errors.push(args)
    try {
      driver.startWorker('mail')
      await new Promise((r) => setTimeout(r, 20))
    } finally {
      console.error = original
      process.off('unhandledRejection', trap)
    }
    expect(unhandled).toEqual([])
    expect(errors.length).toBe(1)
    expect(String(errors[0]![0])).toContain('kafka')
  })
})
