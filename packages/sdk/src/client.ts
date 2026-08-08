import { MachizeClientError } from './errors.js'
import type { Client, Endpoint, EndpointTree } from './endpoint.js'

export type FetchLike = typeof fetch

export interface ClientOptions {
  /** API root, e.g. 'https://api.example.com'. A trailing slash is fine. */
  baseUrl: string
  /** Fetch implementation. Defaults to the global fetch. */
  fetch?: FetchLike
  /** Headers sent on every request (before auth). */
  headers?: Record<string, string>
  /** Current access token — attached as `Authorization: Bearer`. */
  getToken?: () => string | undefined | Promise<string | undefined>
  /**
   * Called once on a 401 to obtain a fresh token; the request is then
   * retried with it. Return null to give up and surface the 401.
   */
  refresh?: () => Promise<string | null>
}

interface CallInput {
  body?: unknown
  query?: Record<string, unknown>
  params?: Record<string, unknown>
}

function isEndpoint(value: unknown): value is Endpoint {
  const candidate = value as Endpoint | undefined
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    typeof candidate.method === 'string' &&
    typeof candidate.path === 'string'
  )
}

/**
 * Builds a typed client from an endpoint tree:
 *
 * const api = createClient(endpoints, { baseUrl, getToken, refresh })
 * const project = await api.projects.create({ body: { name: 'Machize' } })
 */
export function createClient<T extends EndpointTree>(endpoints: T, options: ClientOptions): Client<T> {
  const doFetch = options.fetch ?? globalThis.fetch
  if (!doFetch) throw new Error('No fetch implementation available — pass options.fetch.')

  const build = (node: EndpointTree): Record<string, unknown> => {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(node)) {
      out[key] = isEndpoint(value)
        ? (input?: CallInput) => request(value, input ?? {}, options, doFetch)
        : build(value)
    }
    return out
  }
  return build(endpoints) as Client<T>
}

async function request(
  endpoint: Endpoint,
  input: CallInput,
  options: ClientOptions,
  doFetch: FetchLike,
  overrideToken?: string,
): Promise<unknown> {
  const url = buildUrl(options.baseUrl, endpoint.path, input.params, input.query)

  const token = overrideToken ?? (await options.getToken?.())
  // Only declare a JSON content-type when there is actually a body — a request
  // with no body (e.g. a POST to a bodiless endpoint) that still sends
  // `content-type: application/json` makes a strict server try to parse an empty
  // body and fail.
  const hasBody = input.body !== undefined
  const headers: Record<string, string> = {
    ...(hasBody ? { 'content-type': 'application/json' } : {}),
    ...options.headers,
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  }

  const response = await doFetch(url, {
    method: endpoint.method,
    headers,
    ...(hasBody ? { body: JSON.stringify(input.body) } : {}),
  })

  // Transparent refresh: one retry with a fresh token on a first 401.
  if (response.status === 401 && options.refresh && overrideToken === undefined) {
    const fresh = await options.refresh()
    if (fresh) return request(endpoint, input, options, doFetch, fresh)
  }

  if (response.status === 204) return undefined

  const text = await response.text()
  const json = text ? safeJsonParse(text) : undefined

  if (!response.ok) {
    const error = (json as { error?: { code?: string; message?: string } } | undefined)?.error ?? {}
    throw new MachizeClientError(
      response.status,
      error.code ?? 'HTTP_ERROR',
      error.message ?? (response.statusText || 'Request failed'),
      json,
    )
  }

  if (endpoint.result) {
    const parsed = endpoint.result.safeParse(json)
    if (!parsed.success) {
      throw new MachizeClientError(
        response.status,
        'CLIENT_RESPONSE_MISMATCH',
        'The response did not match the endpoint result schema (client/server drift).',
        parsed.error,
      )
    }
    return parsed.data
  }
  return json
}

function buildUrl(
  baseUrl: string,
  path: string,
  params: Record<string, unknown> | undefined,
  query: Record<string, unknown> | undefined,
): string {
  let resolved = path
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      resolved = resolved.replace(`:${key}`, encodeURIComponent(String(value)))
    }
  }
  const base = baseUrl.replace(/\/+$/, '')
  const search = query ? queryString(query) : ''
  return `${base}${resolved}${search ? `?${search}` : ''}`
}

function queryString(query: Record<string, unknown>): string {
  const pairs: [string, string][] = []
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) {
      for (const item of value) pairs.push([key, String(item)])
    } else {
      pairs.push([key, String(value)])
    }
  }
  return new URLSearchParams(pairs).toString()
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
