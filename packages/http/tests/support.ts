import { createApp, definePlugin, type MachizePlugin } from '@machize/core'
import { HTTP_SERVER, HttpServerCollector, type HttpReply, type HttpRequest } from '../src/index.js'

export const makeRequest = (over: Partial<HttpRequest> = {}): HttpRequest => ({
  method: 'GET',
  url: '/',
  headers: {},
  params: {},
  query: {},
  body: undefined,
  raw: {},
  ...over,
})

/** Minimal HttpReply that records what a hook/handler did to it. */
export class FakeReply implements HttpReply {
  statusCode = 200
  sent = false
  payload: unknown
  raw: unknown = {}
  readonly headers: Record<string, string> = {}

  code(status: number): this {
    this.statusCode = status
    return this
  }
  header(name: string, value: string): this {
    this.headers[name.toLowerCase()] = value
    return this
  }
  send(payload?: unknown): unknown {
    this.sent = true
    this.payload = payload
    return this
  }
}

/** Boots an app that provides a shared HttpServerCollector as HTTP_SERVER,
 *  so neutral edge plugins can be tested without any framework adapter. */
export async function bootWith(collector: HttpServerCollector, plugins: MachizePlugin[]): Promise<void> {
  const provider = definePlugin({
    name: 'test:http-server',
    register({ container }) {
      container.singleton(HTTP_SERVER, () => collector)
    },
  })
  await createApp({ plugins: [provider, ...plugins] }).boot()
}
