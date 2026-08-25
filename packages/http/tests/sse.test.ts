import { describe, expect, it, vi } from 'vitest'
import { sse, isSseResponse, encodeSseEvent, driveSse, sseProducerOf, type SseSink } from '../src/index.js'

describe('encodeSseEvent', () => {
  it('encodes a bare data string', () => {
    expect(encodeSseEvent('hello')).toBe('data: hello\n\n')
  })
  it('encodes event/id/retry and JSON data across data: lines', () => {
    expect(encodeSseEvent({ event: 'tick', id: '7', retry: 3000, data: { n: 1 } })).toBe(
      'event: tick\nid: 7\nretry: 3000\ndata: {"n":1}\n\n',
    )
    expect(encodeSseEvent({ data: 'a\nb' })).toBe('data: a\ndata: b\n\n')
  })
})

function mockSink() {
  const frames: string[] = []
  let ended = false
  let closeListener: (() => void) | undefined
  const sink: SseSink = {
    write: (f) => {
      frames.push(f)
    },
    end: () => { ended = true },
    onClose: (l) => { closeListener = l },
  }
  return { sink, frames, isEnded: () => ended, disconnect: () => closeListener?.() }
}

describe('sse() + driveSse', () => {
  it('marks a producer response and drives it to the sink', async () => {
    const resp = sse((stream) => {
      stream.send({ event: 'a', data: 1 })
      stream.send('bye')
      stream.close()
    })
    expect(isSseResponse(resp)).toBe(true)

    const { sink, frames, isEnded } = mockSink()
    await driveSse((resp as any)[Symbol.for('basalt.sse')], sink)
    expect(frames).toEqual(['event: a\ndata: 1\n\n', 'data: bye\n\n'])
    expect(isEnded()).toBe(true)
  })

  it('ends the sink when the producer finishes, and stops sending after client disconnect', async () => {
    const seen: boolean[] = []
    const { sink, frames, isEnded, disconnect } = mockSink()
    await driveSse(async (stream) => {
      stream.onClose(() => seen.push(true))
      stream.send('one')
      disconnect() // client goes away
      stream.send('two') // ignored — closed
      expect(stream.closed).toBe(true)
    }, sink)
    expect(frames).toEqual(['data: one\n\n'])
    expect(seen).toEqual([true])
    expect(isEnded()).toBe(false) // client disconnected — we don't end() a gone connection
  })
})

describe('encodeSseEvent — injection hardening (security)', () => {
  it('H4: strips CR/LF from the id so it cannot inject extra SSE fields/events', () => {
    const frame = encodeSseEvent({
      event: 'tick',
      id: '1\nevent: adminMessage\ndata: {"grantAdmin":true}',
      data: 'ok',
    })
    // The forged fields must NOT appear as their own SSE lines — the injected
    // newlines are stripped, flattening everything onto the single id line.
    expect(frame.split('\n').some((l) => l.startsWith('event: adminMessage'))).toBe(false)
    expect(frame).toContain('id: 1event: adminMessagedata: {"grantAdmin":true}') // flattened, inert
    // exactly one event line and one id line
    expect(frame.match(/^event: /gm)?.length).toBe(1)
    expect(frame.match(/^id: /gm)?.length).toBe(1)
  })

  it('H4: strips CR/LF from a custom event name', () => {
    const frame = encodeSseEvent({ event: 'a\nevent: b', data: 'x' })
    expect(frame.match(/^event: /gm)?.length).toBe(1)
  })

  it('H4: re-prefixes every data line, splitting on \\r, \\n and \\r\\n', () => {
    const frame = encodeSseEvent({ data: 'line1\rline2\nline3\r\nline4' })
    const dataLines = frame.split('\n').filter((l) => l.startsWith('data: '))
    expect(dataLines).toEqual(['data: line1', 'data: line2', 'data: line3', 'data: line4'])
    // no bare (unprefixed) content line leaks through
    for (const l of frame.replace(/\n\n$/, '').split('\n')) {
      expect(l === '' || l.includes(': ')).toBe(true)
    }
  })
})

describe('SSE backpressure (security)', () => {
  it('M4: send() returns false when the sink signals a full buffer', async () => {
    const results: boolean[] = []
    const resp = sse((stream) => {
      results.push(stream.send({ data: 1 }))
      results.push(stream.send({ data: 2 }))
    })
    const frames: string[] = []
    let n = 0
    const sink: SseSink = {
      write: (f) => {
        frames.push(f)
        return ++n < 2 // first write ok, second signals saturation
      },
      end: () => {},
      onClose: () => {},
    }
    await driveSse(sseProducerOf(resp), sink)
    expect(results).toEqual([true, false])
  })
})

describe('SSE edge hardening — heartbeat & max duration (security)', () => {
  it('sends comment pings on the heartbeat interval', async () => {
    vi.useFakeTimers()
    const frames: string[] = []
    const sink: SseSink = { write: (f) => { frames.push(f) }, end: () => {}, onClose: () => {} }
    // a producer that never resolves — the heartbeat must fire on its own
    const resp = sse((stream) => new Promise<void>(() => { void stream }), { heartbeatMs: 1000 })
    const drive = driveSse(sseProducerOf(resp), sink)
    await vi.advanceTimersByTimeAsync(3500)
    const pings = frames.filter((f) => f.startsWith(': '))
    expect(pings.length).toBe(3) // 3 beats in 3.5s
    vi.useRealTimers()
    void drive
  })

  it('closes the stream after maxDurationMs', async () => {
    vi.useFakeTimers()
    let ended = false
    const sink: SseSink = { write: () => {}, end: () => { ended = true }, onClose: () => {} }
    const resp = sse((stream) => new Promise<void>(() => { void stream }), { maxDurationMs: 5000 })
    const drive = driveSse(sseProducerOf(resp), sink)
    await vi.advanceTimersByTimeAsync(4999)
    expect(ended).toBe(false)
    await vi.advanceTimersByTimeAsync(2)
    expect(ended).toBe(true) // capped
    vi.useRealTimers()
    void drive
  })
})
