import {
  createApp,
  definePlugin,
  ensureMetadata,
  MachizeApp,
  type Container,
  type CreateAppOptions,
} from '@machize/core'
import { FASTIFY, type RequestEnricher } from '@machize/fastify'
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

/**
 * Test-only impersonation: createTestApp prepends an enricher that reads
 * the x-test-user / x-test-tenant headers set by the request helpers.
 * Never register this plugin in a real app.
 */
const impersonationPlugin = definePlugin({
  name: 'machize:testing:impersonation',
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

export class TestApp {
  private defaultUser: TestActor | undefined
  private defaultTenant: TestRequestOptions['tenant'] | undefined

  constructor(readonly app: MachizeApp) {}

  get container(): Container {
    return this.app.container
  }

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
  ): Promise<LightMyRequestResponse> {
    const user = options.user ?? this.defaultUser
    const tenant = options.tenant ?? this.defaultTenant
    const headers: Record<string, string> = { ...options.headers }
    if (user) headers['x-test-user'] = JSON.stringify(user)
    if (tenant) {
      headers['x-test-tenant'] = JSON.stringify(typeof tenant === 'string' ? { id: tenant } : tenant)
    }
    return this.server.inject({
      method,
      url,
      headers,
      ...(options.payload !== undefined ? { payload: options.payload as never } : {}),
    })
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

  shutdown(): Promise<void> {
    return this.app.shutdown()
  }
}

/** Boots an app with the impersonation enricher prepended. */
export async function createTestApp(options: CreateAppOptions = {}): Promise<TestApp> {
  const app = createApp({
    ...options,
    plugins: [impersonationPlugin, ...(options.plugins ?? [])],
  })
  await app.boot()
  return new TestApp(app)
}
