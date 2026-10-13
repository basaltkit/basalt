import { StringDecoder } from 'node:string_decoder'
import { DeployError } from './context.js'
import { MAX_ANSWER_LINE_BYTES, MAX_ANSWER_LINES, parseAnswerLine, type ErrorCode } from './protocol.js'

/**
 * `--answers=stdin` (RFC 0008 §7): answer lines arrive on stdin, are checked
 * one by one as they arrive, and wait until the prompt that needs them. Every
 * rule fails closed: a bad line, an id the config does not ask, a duplicate
 * — the command stops; it never skips a line or guesses.
 *
 * The values are kept here and handed only to the prompt that asks for them:
 * never echoed, never in an event, never in a child's argv or environment.
 */

export interface AskedQuestion {
  key: string
  secret: boolean
}

/** Default `--answer-timeout`, in seconds. */
export const ANSWER_TIMEOUT_SECONDS = 600

export const answerError = (code: ErrorCode, message: string, hint?: string) => new DeployError(message, [], code, hint)

interface Waiter {
  resolve: (value: string | undefined) => void
  reject: (error: Error) => void
}

export class AnswerChannel {
  private readonly pending = new Map<string, string>()
  private readonly consumed = new Set<string>()
  private readonly reprompted = new Set<string>()
  private readonly waiters = new Map<string, Waiter>()
  private readonly eofWaiters: Array<() => void> = []
  private eof = false
  private stopped = false
  private fatal: DeployError | undefined
  private count = 0
  private iterator: AsyncIterator<string | Uint8Array> | undefined

  /**
   * @param questions what `deploy.config.ts` can ask (`env.ask`), by answer id (`env.<KEY>`)
   * @param onSecret called with a secret answer the moment it is parsed — before anything can print it
   */
  constructor(
    private readonly questions: ReadonlyMap<string, AskedQuestion>,
    private readonly onSecret: (key: string, value: string) => void,
  ) {}

  /** Reads `source` to its end in the background. */
  start(source: AsyncIterable<string | Uint8Array>): void {
    this.iterator = source[Symbol.asyncIterator]()
    void this.read()
  }

  /** Answers can still arrive (stdin is open): a refused answer may be asked again. */
  get live(): boolean {
    return !this.eof
  }

  /** stdin read to its end, every line checked (a detached run's answers; the child's before its lock). */
  async drain(): Promise<void> {
    if (!this.eof) await new Promise<void>((resolve) => this.eofWaiters.push(resolve))
    this.throwIfFatal()
  }

  /**
   * Before the lock: the lines already sent have been checked. Waits for the
   * end of stdin, or for what is buffered to be read (a channel left open for
   * live answers does not hold the command up).
   */
  async settle(graceMs = 50): Promise<void> {
    if (!this.eof) {
      let timer: NodeJS.Timeout | undefined
      await Promise.race([
        new Promise<void>((resolve) => this.eofWaiters.push(resolve)),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, graceMs); timer.unref?.() }),
      ])
      if (timer) clearTimeout(timer)
    }
    this.throwIfFatal()
  }

  throwIfFatal(): void {
    if (this.fatal) throw this.fatal
  }

  /** The answer for `id`: buffered, or the next to arrive; `undefined` once stdin ended without it. */
  async take(id: string, timeoutMs: number): Promise<string | undefined> {
    this.throwIfFatal()
    const ready = this.pending.get(id)
    if (ready !== undefined) {
      this.pending.delete(id)
      this.consumed.add(id)
      return ready
    }
    if (this.eof) return undefined
    let timer: NodeJS.Timeout | undefined
    try {
      return await new Promise<string | undefined>((resolve, reject) => {
        this.waiters.set(id, { resolve, reject })
        timer = setTimeout(() => {
          this.waiters.delete(id)
          reject(answerError('answer-timeout', `no answer for ${this.questions.get(id)?.key ?? id} within ${Math.round(timeoutMs / 1000)} s — nothing was written`, 'send the answers up front (plan --json lists the questions), or raise --answer-timeout'))
        }, timeoutMs)
        timer.unref?.()
      })
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /** A buffered answer, without taking it (the detaching parent checks them all up front). */
  peek(id: string): string | undefined {
    return this.pending.get(id)
  }

  /** The buffered answers as lines again — only the named fields — for a detached child's stdin. */
  serialize(): string {
    return [...this.pending].map(([id, value]) => `${JSON.stringify({ v: 1, type: 'answer', id, value })}\n`).join('')
  }

  /** `id` was refused and is asked again: one more answer for it is not a duplicate. */
  expectAgain(id: string): void {
    this.reprompted.add(id)
  }

  /**
   * No more questions: stops reading, and returns the keys answered but never
   * asked (already in the .env, or given by the deploy's environment).
   */
  finish(): string[] {
    this.stopped = true
    void this.iterator?.return?.()
    const left = [...this.pending.keys()].map((id) => this.questions.get(id)?.key ?? id)
    this.pending.clear()
    return left
  }

  private async read(): Promise<void> {
    const decoder = new StringDecoder('utf8')
    let buffer = ''
    try {
      while (!this.stopped) {
        const next = await (this.iterator as AsyncIterator<string | Uint8Array>).next()
        if (next.done || this.stopped) break
        buffer += typeof next.value === 'string' ? next.value : decoder.write(Buffer.from(next.value))
        let newline: number
        while ((newline = buffer.indexOf('\n')) !== -1) {
          this.accept(buffer.slice(0, newline).replace(/\r$/, ''))
          buffer = buffer.slice(newline + 1)
        }
        if (Buffer.byteLength(buffer) > MAX_ANSWER_LINE_BYTES) {
          this.fail(answerError('protocol', `an answer line is larger than ${MAX_ANSWER_LINE_BYTES} bytes`))
          buffer = ''
        }
      }
      if (!this.stopped) {
        buffer += decoder.end()
        if (buffer.trim()) this.accept(buffer.replace(/\r$/, ''))
      }
    } catch (error) {
      this.fail(answerError('protocol', `stdin could not be read: ${(error as Error).message}`))
    } finally {
      this.eof = true
      for (const waiter of this.waiters.values()) waiter.resolve(undefined)
      this.waiters.clear()
      for (const resolve of this.eofWaiters.splice(0)) resolve()
    }
  }

  private accept(line: string): void {
    if (this.fatal || line.trim() === '') return
    if (++this.count > MAX_ANSWER_LINES) return this.fail(answerError('protocol', `more than ${MAX_ANSWER_LINES} answer lines`))
    const parsed = parseAnswerLine(line)
    if (!parsed.ok) return this.fail(answerError('protocol', parsed.error))
    const { id, value } = parsed.value
    const question = this.questions.get(id)
    if (!question) {
      const key = id.slice('env.'.length)
      return this.fail(answerError('answer-unknown', `an answer for ${key}, which deploy.config.ts does not ask (env.ask) — nothing was changed`))
    }
    // Known as a secret before anything else can print it.
    if (question.secret) this.onSecret(question.key, value)
    if (this.pending.has(id) || (this.consumed.has(id) && !this.reprompted.has(id))) {
      return this.fail(answerError('protocol', `two answers for ${question.key}`))
    }
    this.reprompted.delete(id)
    const waiter = this.waiters.get(id)
    if (waiter) {
      this.waiters.delete(id)
      this.consumed.add(id)
      waiter.resolve(value)
      return
    }
    this.pending.set(id, value)
  }

  private fail(error: DeployError): void {
    this.fatal ??= error
    for (const waiter of this.waiters.values()) waiter.reject(error)
    this.waiters.clear()
  }
}

/** The questions a config can ask, by answer id. */
export function askedQuestions(ask: Record<string, { secret: boolean } | undefined> | undefined): Map<string, AskedQuestion> {
  const questions = new Map<string, AskedQuestion>()
  for (const [key, question] of Object.entries(ask ?? {})) {
    if (question) questions.set(`env.${key}`, { key, secret: question.secret })
  }
  return questions
}
