import { createServer, type Server, type Socket } from 'node:net'
import { type AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { pinnedRequest } from '../src/pinned-fetch.js'

/**
 * SECURITY INVARIANT: once a webhook receiver has answered with a status line,
 * the delivery releases the socket immediately — a receiver that trickles (or
 * never finishes) its response body cannot hold sockets/FDs open on the sender.
 */
describe('webhook delivery does not drain an unbounded response body', () => {
  let server: Server
  let port: number
  let sockets: Socket[]
  let closed: number

  beforeEach(async () => {
    sockets = []
    closed = 0
    server = createServer((socket) => {
      sockets.push(socket)
      socket.on('close', () => (closed += 1))
      socket.once('data', () => {
        // Headers + a chunked body that never ends (one byte, then silence).
        socket.write('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\na\r\n')
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as AddressInfo).port
  })
  afterEach(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('closes the connection after the status is known, even when the body never ends', async () => {
    const res = await pinnedRequest(
      new URL(`http://hook.example:${port}/h`),
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
      { address: '127.0.0.1', family: 4 },
    )
    expect(res.status).toBe(200)
    // Give the socket a moment to be torn down.
    const deadline = Date.now() + 1000
    while (closed === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
    expect(closed).toBe(1)
  })
})
