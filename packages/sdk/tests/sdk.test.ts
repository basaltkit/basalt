import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createClient, endpoint, MachizeClientError, type EndpointOutput } from '../src/index.js'

const Project = z.object({ id: z.string(), name: z.string() })
const Tokens = z.object({ accessToken: z.string(), refreshToken: z.string() })

const api = {
  projects: {
    create: endpoint({ method: 'POST', path: '/projects', body: z.object({ name: z.string() }), result: Project }),
    get: endpoint({ method: 'GET', path: '/projects/:id', params: z.object({ id: z.string() }), result: Project }),
    list: endpoint({
      method: 'GET',
      path: '/projects',
      query: z.object({ limit: z.number().optional() }),
      result: z.array(Project),
    }),
    remove: endpoint({ method: 'DELETE', path: '/projects/:id', params: z.object({ id: z.string() }) }),
  },
  auth: {
    login: endpoint({ method: 'POST', path: '/auth/login', body: z.object({ email: z.string() }), result: Tokens }),
  },
  ping: endpoint({ method: 'GET', path: '/ping' }),
}

interface Recorded {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

function harness(handler: (call: Recorded, n: number) => Response) {
  const calls: Recorded[] = []
  const fetchMock: typeof fetch = async (url, init) => {
    const headers = init?.headers as Record<string, string>
    const recorded: Recorded = {
      url: String(url),
      method: init?.method ?? 'GET',
      headers,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    }
    calls.push(recorded)
    return handler(recorded, calls.length)
  }
  return { calls, fetchMock }
}

const jsonResponse = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })

describe('createClient', () => {
  it('mirrors the endpoint tree and returns parsed, typed results', async () => {
    const { calls, fetchMock } = harness(() => jsonResponse({ id: 'p1', name: 'Machize' }, 201))
    const client = createClient(api, { baseUrl: 'https://api.test/', fetch: fetchMock })

    const project = await client.projects.create({ body: { name: 'Machize' } })
    // typed: EndpointOutput is { id: string; name: string }
    const _check: EndpointOutput<typeof api.projects.create> = project
    void _check
    expect(project).toEqual({ id: 'p1', name: 'Machize' })

    expect(calls[0]).toMatchObject({
      url: 'https://api.test/projects',
      method: 'POST',
      body: { name: 'Machize' },
    })
    expect(calls[0]?.headers['content-type']).toBe('application/json')
  })

  it('substitutes path params and builds the query string', async () => {
    // /projects/:id returns a single project; /projects returns an array
    const { calls, fetchMock } = harness((call) =>
      /\/projects\/[^?]/.test(call.url)
        ? jsonResponse({ id: 'p1', name: 'A' })
        : jsonResponse([{ id: 'p1', name: 'A' }]),
    )
    const client = createClient(api, { baseUrl: 'https://api.test', fetch: fetchMock })

    await client.projects.get({ params: { id: 'p 1/x' } })
    expect(calls[0]?.url).toBe('https://api.test/projects/p%201%2Fx')

    await client.projects.list({ query: { limit: 10 } })
    expect(calls[1]?.url).toBe('https://api.test/projects?limit=10')

    await client.projects.list({ query: {} }) // no limit → no query string
    expect(calls[2]?.url).toBe('https://api.test/projects')
  })

  it('endpoints with no body/query/params take no argument', async () => {
    const { calls, fetchMock } = harness(() => jsonResponse({ ok: true }))
    const client = createClient(api, { baseUrl: 'https://api.test', fetch: fetchMock })
    await client.ping() // input is optional
    expect(calls[0]?.url).toBe('https://api.test/ping')
  })

  it('attaches the bearer token from getToken', async () => {
    const { calls, fetchMock } = harness(() => jsonResponse({ accessToken: 'a', refreshToken: 'r' }))
    const client = createClient(api, {
      baseUrl: 'https://api.test',
      fetch: fetchMock,
      getToken: () => 'token-1',
    })

    await client.auth.login({ body: { email: 'a@b.c' } })
    expect(calls[0]?.headers['authorization']).toBe('Bearer token-1')
  })

  it('transparently refreshes once on 401 and retries with the new token', async () => {
    const { calls, fetchMock } = harness((_call, n) =>
      n === 1 ? jsonResponse({ error: { code: 'AUTH_TOKEN_EXPIRED' } }, 401) : jsonResponse({ id: 'p1', name: 'A' }),
    )
    const refresh = vi.fn(async () => 'token-2')
    const client = createClient(api, {
      baseUrl: 'https://api.test',
      fetch: fetchMock,
      getToken: () => 'token-1',
      refresh,
    })

    const project = await client.projects.get({ params: { id: 'p1' } })
    expect(project.name).toBe('A')
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(calls).toHaveLength(2)
    expect(calls[0]?.headers['authorization']).toBe('Bearer token-1')
    expect(calls[1]?.headers['authorization']).toBe('Bearer token-2')
  })

  it('surfaces the 401 when refresh gives up (returns null), without looping', async () => {
    const { calls, fetchMock } = harness(() => jsonResponse({ error: { code: 'AUTH_TOKEN_EXPIRED' } }, 401))
    const client = createClient(api, {
      baseUrl: 'https://api.test',
      fetch: fetchMock,
      refresh: async () => null,
    })

    await expect(client.projects.get({ params: { id: 'p1' } })).rejects.toMatchObject({
      status: 401,
      code: 'AUTH_TOKEN_EXPIRED',
    })
    expect(calls).toHaveLength(1)
  })

  it('maps non-2xx bodies to MachizeClientError with the stable code', async () => {
    const { fetchMock } = harness(() =>
      jsonResponse({ error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found' } }, 404),
    )
    const client = createClient(api, { baseUrl: 'https://api.test', fetch: fetchMock })

    const error = await client.projects
      .get({ params: { id: 'ghost' } })
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(MachizeClientError)
    expect(error).toMatchObject({ status: 404, code: 'PROJECT_NOT_FOUND', message: 'Project not found' })
  })

  it('returns undefined for 204 responses', async () => {
    const { fetchMock } = harness(() => new Response(null, { status: 204 }))
    const client = createClient(api, { baseUrl: 'https://api.test', fetch: fetchMock })
    expect(await client.projects.remove({ params: { id: 'p1' } })).toBeUndefined()
  })

  it('flags client/server drift when the response fails the result schema', async () => {
    const { fetchMock } = harness(() => jsonResponse({ id: 'p1' })) // missing name
    const client = createClient(api, { baseUrl: 'https://api.test', fetch: fetchMock })
    await expect(client.projects.get({ params: { id: 'p1' } })).rejects.toMatchObject({
      code: 'CLIENT_RESPONSE_MISMATCH',
    })
  })
})
