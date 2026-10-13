import { expect } from 'vitest'
import { main, processIO, type CliIO } from '../src/cli.js'
import { parseEvent, type DeployEvent } from '../src/protocol.js'
import type { FakeHost } from './fake-host.js'

export { ACME_CONFIG } from './acme-config.js'

/** stdin: lines given up front, then EOF — or a channel the test feeds and closes. */
export function stdinOf(lines: string[] = []): AsyncIterable<string> {
  return (async function* () { for (const line of lines) yield `${line}\n` })()
}

export function liveStdin(): { source: AsyncIterable<string>; send(line: string): void; close(): void } {
  const queue: Array<string | null> = []
  let wake: (() => void) | undefined
  const push = (item: string | null) => { queue.push(item); wake?.(); wake = undefined }
  return {
    source: (async function* () {
      for (;;) {
        while (queue.length === 0) await new Promise<void>((resolve) => { wake = resolve })
        const item = queue.shift() as string | null
        if (item === null) return
        yield item
      }
    })(),
    send: (line) => push(`${line}\n`),
    close: () => push(null),
  }
}

export const answer = (key: string, value: string) => JSON.stringify({ v: 1, type: 'answer', id: `env.${key}`, value })

export interface JsonRun {
  code: number
  events: DeployEvent[]
  /** Everything written to stdout. */
  raw: string
  stderr: string
}

/** `main(argv)` with a fake stdin/stdout; every stdout line must be a valid event. */
export async function runJson(argv: string[], host: FakeHost, dir: string, stdin: AsyncIterable<string> = stdinOf()): Promise<JsonRun> {
  const out: string[] = []
  const err: string[] = []
  const real = processIO()
  const io: CliIO = { write: (text) => out.push(text), stdin: () => stdin, capture: (sink) => real.capture(sink), stderr: (text) => err.push(text) }
  const code = await main(argv, host, dir, io)
  const raw = out.join('')
  const events = raw.split('\n').filter(Boolean).map((line) => {
    const parsed = parseEvent(line)
    if (!parsed.ok) throw new Error(`not an event: ${line} (${parsed.error})`)
    return parsed.value
  })
  return { code, events, raw, stderr: err.join('') }
}

/** The protocol's framing: hello first, done last with the exit code, seq 0…n, nothing else. */
export function expectFramed(result: JsonRun): void {
  const { events, code } = result
  expect(events[0]?.type).toBe('hello')
  expect(events.at(-1)).toMatchObject({ type: 'done', exitCode: code })
  expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i))
  expect(events.filter((e) => e.type === 'done')).toHaveLength(1)
  expect(result.raw.endsWith('\n')).toBe(true)
}

export const ofType = <T extends DeployEvent['type']>(events: DeployEvent[], type: T) => events.filter((e): e is Extract<DeployEvent, { type: T }> => e.type === type)

/** Every string anywhere in the events. */
export function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(strings)
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings)
  return []
}
