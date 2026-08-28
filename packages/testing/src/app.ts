import type { AddressInfo } from 'node:net'
import {
  createApp,
  definePlugin,
  ensureMetadata,
  BasaltApp,
  type Container,
  type CreateAppOptions,
} from '@basaltkit/core'
import { FASTIFY, type RequestEnricher } from '@basaltkit/fastify'
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify'

export interface TestActor {
  id: string
  email?: string
  [key: string]: unknown
}

export interface TestRequestOptions {
  payload?: unknown
  headers?: Record<string, string>
  /** Impersonate a user for this request (overrides actingAs). */
  user?: TestActor
  /** Impersonate a tenant for this request (overrides asTenant). */
  tenant?: string | { id: string; [key: string]: unknown }
}

/** Which HTTP adapter drives the test requests. Default: 'fastify'. */
export type TestAdapterName = 'fastify' | 'express' | 'hono'

/**
 * Adapter-neutral response every driver returns. Fastify's inject response
 * satisfies it structurally (statusCode/headers/body/json()), so suites written
 * against the default adapter read responses exactly as before; the Express and
 * Hono drivers build the same shape from a real fetch Response.
 */
export interface TestResponse {
  statusCode: number
  headers: Record<string, string | number | string[] | undefined>
  body: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json<T = any>(): T
}

export interface CreateTestAppOptions extends CreateAppOptions {
  /**
   * HTTP adapter to drive requests through. Pass the matching adapter plugin
   * (`fastifyPlugin`/`expressPlugin`/`honoPlugin`) in `plugins` yourself — the
   * harness only decides how requests are dispatched:
   *
   * - 'fastify' (default): in-process via `inject()` — no socket.
   * - 'express': real `listen(0)` on 127.0.0.1 + fetch (Express has no inject);
   *   the socket is closed on `shutdown()`.
   * - 'hono': in-process via `hono.fetch(new Request(…))` — no socket.
   *
   * 'express' and 'hono' need `@basaltkit/express` / `@basaltkit/hono`
   * installed (optional peers of this package); the default needs nothing new.
   */
  adapter?: TestAdapterName
}

/**
 * Test-only impersonation: createTestApp prepends an enricher that reads
 * the x-test-user / x-test-tenant headers set by the request helpers. The
 * 'http:enrichers' bucket is framework-neutral, so impersonation works
 * identically on every adapter. Never register this plugin in a real app.
 */
const impersonationPlugin = definePlugin({
  name: 'basalt:testing:impersonation',
  register({ container }) {
    const enricher: RequestEnricher = ({ request, context }) => {
      const rawUser = request.headers['x-test-user']
      if (typeof rawUser === 'string') context.user = JSON.parse(rawUser)
      const rawTenant = request.headers['x-test-tenant']
      if (typeof rawTenant === 'string') context.tenant = JSON.parse(rawTenant)
    }
    ensureMetadata(container).add('http:enrichers', enricher)
  },
})

interface DispatchRequest {
  method: string
  url: string
  headers: Record<string, string>
  payload?: unknown
}

/** What a connected adapter driver provides: dispatch + optional teardown. */
interface ConnectedDriver {
  dispatch(request: DispatchRequest): Promise<TestResponse>
  close?(): Promise<void>
}

// ---- drivers -------------------------------------------------------------

/** Fastify: light-my-request inject — in-process, no socket, sync-json reply. */
function connectFastify(container: Container): ConnectedDriver {
  const server = container.get(FASTIFY)
  return {
    dispatch: ({ method, url, headers, payload }) =>
      server.inject({
        method: method as never,
        url,
        headers,
        ...(payload !== undefined ? { payload: payload as never } : {}),
      }),
  }
}

/** Serialize a payload the way fastify's inject does: objects become JSON. */
function bodyInit(
  method: string,
  headers: Record<string, string>,
  payload: unknown,
): { headers: Record<string, string>; body?: string } {
  if (payload === undefined || method === 'GET' || method === 'HEAD') return { headers }
  if (typeof payload === 'string') return { headers, body: payload }
  return { headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(payload) }
}

/** Build the neutral response from a fetch Response (Express/Hono drivers). */
async function toTestResponse(response: Response): Promise<TestResponse> {
  const body = await response.text()
  const headers: Record<string, string | string[]> = {}
  response.headers.forEach((value, key) => {
    headers[key] = value
  })
  const cookies = response.headers.getSetCookie()
  if (cookies.length > 0) headers['set-cookie'] = cookies
  return {
    statusCode: response.status,
    headers,
    body,
    json: <T,>() => JSON.parse(body) as T,
  }
}

/**
 * Express: unlike Fastify/Hono it has no in-process dispatch, so the driver
 * listens on an ephemeral 127.0.0.1 port and fetches; `close()` (called by
 * `TestApp.shutdown()`) tears the socket down.
 */
async function connectExpress(container: Container): Promise<ConnectedDriver> {
  const { EXPRESS } = await loadAdapter('express')
  const server = container.get(EXPRESS).listen(0, '127.0.0.1')
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  const { port } = server.address() as AddressInfo
  const base = `http://127.0.0.1:${port}`
  return {
    dispatch: async ({ method, url, headers, payload }) =>
      toTestResponse(await fetch(`${base}${url}`, { method, ...bodyInit(method, headers, payload) })),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}

/** Hono: in-process `hono.fetch(new Request(…))` — no socket. */
async function connectHono(container: Container): Promise<ConnectedDriver> {
  const { HONO } = await loadAdapter('hono')
  const hono = container.get(HONO)
  return {
    dispatch: async ({ method, url, headers, payload }) =>
      toTestResponse(
        await hono.fetch(new Request(`http://basalt.test${url}`, { method, ...bodyInit(method, headers, payload) })),
      ),
  }
}

/**
 * The non-default adapters are optional peers — resolve them lazily so the
 * fastify path never loads (or requires installing) Express/Hono, and a
 * missing install fails with an actionable message instead of a bare
 * ERR_MODULE_NOT_FOUND.
 */
async function loadAdapter(name: 'express'): Promise<typeof import('@basaltkit/express')>
async function loadAdapter(name: 'hono'): Promise<typeof import('@basaltkit/hono')>
async function loadAdapter(name: 'express' | 'hono'): Promise<unknown> {
  try {
    return name === 'express' ? await import('@basaltkit/express') : await import('@basaltkit/hono')
  } catch (error) {
    throw new Error(
      `createTestApp({ adapter: '${name}' }) requires @basaltkit/${name} (an optional peer of ` +
        `@basaltkit/testing) and the ${name} framework itself. Install them as devDependencies.`,
      { cause: error },
    )
  }
}

/**
 * Only the non-default adapters connect eagerly (Express must `listen`).
 * The fastify driver stays lazy — resolved on the first request — so apps
 * booted without any HTTP plugin (mailer/queue-only tests) keep working
 * exactly as before.
 */
function connect(adapter: TestAdapterName, container: Container): Promise<ConnectedDriver> | undefined {
  switch (adapter) {
    case 'fastify':
      return undefined
    case 'express':
      return connectExpress(container)
    case 'hono':
      return connectHono(container)
  }
}

// ---- harness -------------------------------------------------------------

export class TestApp<Res extends TestResponse = LightMyRequestResponse> {
  private defaultUser: TestActor | undefined
  private defaultTenant: TestRequestOptions['tenant'] | undefined
  private driver: ConnectedDriver | undefined

  constructor(readonly app: BasaltApp, driver?: ConnectedDriver) {
    this.driver = driver
  }

  get container(): Container {
    return this.app.container
  }

  /**
   * The raw Fastify instance — only meaningful on the default adapter; on
   * Express/Hono resolve the `EXPRESS`/`HONO` token from `container` instead.
   */
  get server(): FastifyInstance {
    return this.container.get(FASTIFY)
  }

  /** Sets the default authenticated user for subsequent requests. */
  actingAs(user: TestActor): this {
    this.defaultUser = user
    return this
  }

  /** Sets the default tenant for subsequent requests. */
  asTenant(tenant: string | { id: string }): this {
    this.defaultTenant = tenant
    return this
  }

  async request(
    method: NonNullable<InjectOptions['method']>,
    url: string,
    options: TestRequestOptions = {},
  ): Promise<Res> {
    const user = options.user ?? this.defaultUser
    const tenant = options.tenant ?? this.defaultTenant
    const headers: Record<string, string> = { ...options.headers }
    if (user) headers['x-test-user'] = JSON.stringify(user)
    if (tenant) {
      headers['x-test-tenant'] = JSON.stringify(typeof tenant === 'string' ? { id: tenant } : tenant)
    }
    // Instantiating TestApp directly (without createTestApp) keeps the old
    // fastify-inject behavior — connect lazily on first use.
    this.driver ??= connectFastify(this.container)
    return this.driver.dispatch({
      method: String(method),
      url,
      headers,
      ...(options.payload !== undefined ? { payload: options.payload } : {}),
    }) as Promise<Res>
  }

  get(url: string, options?: TestRequestOptions) {
    return this.request('GET', url, options)
  }
  post(url: string, payload?: unknown, options?: TestRequestOptions) {
    return this.request('POST', url, { ...options, payload })
  }
  put(url: string, payload?: unknown, options?: TestRequestOptions) {
    return this.request('PUT', url, { ...options, payload })
  }
  patch(url: string, payload?: unknown, options?: TestRequestOptions) {
    return this.request('PATCH', url, { ...options, payload })
  }
  delete(url: string, options?: TestRequestOptions) {
    return this.request('DELETE', url, options)
  }

  async shutdown(): Promise<void> {
    await this.driver?.close?.()
    return this.app.shutdown()
  }
}

/**
 * Boots an app with the impersonation enricher prepended.
 *
 * Pass `adapter` to drive requests through Express or Hono instead of the
 * default Fastify inject — the same suite then runs unchanged on any adapter
 * (the neutral 'http:enrichers'/'http:guards' buckets make impersonation and
 * guards behave identically).
 */
export async function createTestApp(
  options?: CreateAppOptions & { adapter?: 'fastify' },
): Promise<TestApp>
export async function createTestApp(options: CreateTestAppOptions): Promise<TestApp<TestResponse>>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function createTestApp(options: CreateTestAppOptions = {}): Promise<TestApp<any>> {
  const { adapter = 'fastify', ...appOptions } = options
  const app = createApp({
    ...appOptions,
    plugins: [impersonationPlugin, ...(appOptions.plugins ?? [])],
  })
  await app.boot()
  const driver = connect(adapter, app.container)
  return new TestApp(app, driver ? await driver : undefined)
}
