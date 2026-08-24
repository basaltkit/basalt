import { describe, expect, it } from 'vitest'
import { sse, isSseResponse, encodeSseEvent, driveSse, type SseSink } from '../src/index.js'

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
    write: (f) => frames.push(f),
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
