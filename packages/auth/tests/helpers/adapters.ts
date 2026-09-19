import { createApp, type BasaltPlugin } from '@basaltkit/core'
import { FASTIFY, fastifyPlugin } from '@basaltkit/fastify'
import type { BasaltRoute } from '@basaltkit/http'
import type { PasswordHasher } from '../../src/index.js'

/**
 * A cheap, deterministic hasher for HTTP-level tests — scrypt is deliberately
 * slow and adds nothing to what these tests assert.
 */
export const fastHasher: PasswordHasher = {
  hash: async (password) => `plain:${password}`,
  verify: async (password, hash) => hash === `plain:${password}`,
}

export type AdapterName = 'fastify' | 'express' | 'hono'

export interface Call {
  method: string
  url: string
  headers?: Record<string, string>
  payload?: unknown
}

export interface Res {
  status: number
  body: any // eslint-disable-line @typescript-eslint/no-explicit-any
  headers: Record<string, string | string[] | undefined>
}

export interface Harness {
  call(req: Call): Promise<Res>
  close(): Promise<void>
}

// Express and Hono are not dependencies of @basaltkit/auth; the cross-adapter
// cases load the workspace builds when they exist and are skipped otherwise.
// The enforcement under test lives in the shared enricher/guard pipeline.
type AdapterModule = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const load = async (pkg: 'express' | 'hono'): Promise<AdapterModule | null> => {
  try {
    return (await import(new URL(`../../../${pkg}/dist/index.js`, import.meta.url).href)) as AdapterModule
  } catch {
    return null
  }
}
export const expressModule = await load('express')
export const honoModule = await load('hono')
export const availableAdapters: AdapterName[] = [
  'fastify',
  ...(expressModule ? (['express'] as const) : []),
  ...(honoModule ? (['hono'] as const) : []),
]

const parse = (text: string): unknown => {
  try {
    return text ? JSON.parse(text) : undefined
  } catch {
    return text
  }
}

export async function boot(adapter: AdapterName, plugins: BasaltPlugin[], routes: BasaltRoute[]): Promise<Harness> {
  if (adapter === 'fastify') {
    const app = await createApp({ plugins: [...plugins, fastifyPlugin({ routes })] }).boot()
    const server = app.container.get(FASTIFY)
    return {
      async call({ method, url, headers, payload }) {
        const res = await server.inject({
          method: method as 'GET',
          url,
          ...(headers ? { headers } : {}),
          ...(payload !== undefined ? { payload: payload as object } : {}),
        })
        return { status: res.statusCode, body: parse(res.body), headers: res.headers as Res['headers'] }
      },
      close: () => app.shutdown(),
    }
  }
  if (adapter === 'hono') {
    const mod = honoModule!
    const app = await createApp({ plugins: [...plugins, mod['honoPlugin']({ routes })] }).boot()
    const hono = app.container.get(mod['HONO']) as { request(url: string, init: RequestInit): Promise<Response> }
    return {
      async call({ method, url, headers, payload }) {
        const res = await hono.request(`http://localhost${url}`, {
          method,
          headers: { ...(payload !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
          ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
        })
        return { status: res.status, body: parse(await res.text()), headers: Object.fromEntries(res.headers) }
      },
      close: () => app.shutdown(),
    }
  }
  const mod = expressModule!
  const app = await createApp({ plugins: [...plugins, mod['expressPlugin']({ routes })] }).boot()
  const server = (app.container.get(mod['EXPRESS']) as { listen(port: number, host: string): import('node:http').Server }).listen(
    0,
    '127.0.0.1',
  )
  await new Promise<void>((resolve) => server.once('listening', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    async call({ method, url, headers, payload }) {
      const res = await fetch(`http://127.0.0.1:${port}${url}`, {
        method,
        redirect: 'manual',
        headers: { ...(payload !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
        ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
      })
      return { status: res.status, body: parse(await res.text()), headers: Object.fromEntries(res.headers) }
    },
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await app.shutdown()
    },
  }
}
