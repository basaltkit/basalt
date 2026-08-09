import { describe, expect, it } from 'vitest'
import { SqsDelayTooLongError, SqsQueueDriver, type SqsApi, type SqsMessage } from '../src/index.js'

interface Sent {
  queueUrl: string
  body: string
  delaySeconds?: number
  attributes?: Record<string, string>
}

class FakeSqs implements SqsApi {
  readonly sent: Sent[] = []
  readonly deleted: string[] = []
  private batches: SqsMessage[][] = []
  private index = 0
  private release!: () => void
  private readonly closed = new Promise<void>((r) => (this.release = r))

  enqueue(messages: SqsMessage[]): void {
    this.batches.push(messages)
  }
  unblock(): void {
    this.release()
  }
  async sendMessage(input: Sent): Promise<void> {
    this.sent.push(input)
  }
  async deleteMessage(input: { queueUrl: string; receiptHandle: string }): Promise<void> {
    this.deleted.push(input.receiptHandle)
  }
  async receiveMessages(): Promise<SqsMessage[]> {
    if (this.index < this.batches.length) return this.batches[this.index++]!
    await this.closed // behave like a long poll until close()
    return []
  }
}

const makeDriver = (api: SqsApi) => new SqsQueueDriver({ queueUrl: (q) => `https://sqs.test/${q}`, api })
const callHandle = (driver: SqsQueueDriver, queue: string, message: SqsMessage) =>
  (driver as unknown as { handle(q: string, m: SqsMessage): Promise<void> }).handle(queue, message)
const message = (attributes: Record<string, string>, body: unknown, receiptHandle = 'r1'): SqsMessage => ({
  body: JSON.stringify(body),
  receiptHandle,
  attributes,
})
const until = async (predicate: () => boolean) => {
  for (let i = 0; i < 100 && !predicate(); i++) await new Promise((r) => setTimeout(r, 5))
}

describe('SqsQueueDriver', () => {
  it('has delay but not priority in its capabilities', () => {
    expect(makeDriver(new FakeSqs()).capabilities).toEqual({
      delayed: true,
      priority: false,
      retries: true,
      backoff: true,
    })
  })

  it('sends a job with attributes, and DelaySeconds for a delayed job', async () => {
    const sqs = new FakeSqs()
    const driver = makeDriver(sqs)
    await driver.add('welcome', 'send-welcome', { name: 'Ada' }, { attempts: 2, delayMs: 5000 })

    const sent = sqs.sent[0]!
    expect(sent.queueUrl).toBe('https://sqs.test/welcome')
    expect(JSON.parse(sent.body)).toEqual({ name: 'Ada' })
    expect(sent.delaySeconds).toBe(5)
    expect(sent.attributes).toMatchObject({ 'x-basalt-job': 'send-welcome', 'x-basalt-attempts': '2' })
  })

  it('rejects a delay beyond the 15-minute SQS limit', async () => {
    const driver = makeDriver(new FakeSqs())
    await expect(driver.add('welcome', 'j', {}, { attempts: 1, delayMs: 1_000_000 })).rejects.toBeInstanceOf(
      SqsDelayTooLongError,
    )
  })

  it('deletes a message when the job succeeds', async () => {
    const sqs = new FakeSqs()
    const driver = makeDriver(sqs)
    const seen: unknown[] = []
    driver.setExecutor(async (name, data) => {
      seen.push([name, data])
    })
    await callHandle(driver, 'welcome', message({ 'x-basalt-job': 'send-welcome', 'x-basalt-attempt': '1', 'x-basalt-attempts': '1' }, { name: 'Ada' }))

    expect(seen).toEqual([['send-welcome', { name: 'Ada' }]])
    expect(sqs.deleted).toEqual(['r1'])
    expect(sqs.sent).toHaveLength(0)
  })

  it('re-sends with a backoff delay on failure, then dead-letters when exhausted', async () => {
    const sqs = new FakeSqs()
    const driver = makeDriver(sqs)
    driver.setExecutor(async () => {
      throw new Error('boom')
    })

    // attempt 1 of 2 → re-sent to the same queue as attempt 2 with a 2s backoff
    await callHandle(
      driver,
      'welcome',
      message({ 'x-basalt-job': 'j', 'x-basalt-attempt': '1', 'x-basalt-attempts': '2', 'x-basalt-backoff-ms': '2000', 'x-basalt-backoff-type': 'fixed' }, {}),
    )
    const retry = sqs.sent.find((s) => s.queueUrl === 'https://sqs.test/welcome')!
    expect(retry.attributes?.['x-basalt-attempt']).toBe('2')
    expect(retry.delaySeconds).toBe(2)
    expect(sqs.deleted).toEqual(['r1'])

    // attempt 2 of 2 → dead-lettered
    await callHandle(driver, 'welcome', message({ 'x-basalt-job': 'j', 'x-basalt-attempt': '2', 'x-basalt-attempts': '2' }, {}, 'r2'))
    expect(sqs.sent.find((s) => s.queueUrl === 'https://sqs.test/welcome-dead')).toBeTruthy()
    expect(sqs.deleted).toEqual(['r1', 'r2'])
  })

  it('polls and processes a delivered message', async () => {
    const sqs = new FakeSqs()
    sqs.enqueue([message({ 'x-basalt-job': 'send-welcome', 'x-basalt-attempt': '1', 'x-basalt-attempts': '1' }, { name: 'Ada' })])
    const driver = new SqsQueueDriver({ queueUrl: (q) => `https://sqs.test/${q}`, api: sqs, waitTimeSeconds: 0 })
    const seen: unknown[] = []
    driver.setExecutor(async (name, data) => {
      seen.push([name, data])
    })

    driver.startWorker('welcome')
    await until(() => sqs.deleted.length === 1)
    expect(seen).toEqual([['send-welcome', { name: 'Ada' }]])

    sqs.unblock()
    await driver.close()
  })
})
