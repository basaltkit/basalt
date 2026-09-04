import { BasaltClientError } from './errors.js'
import type { Client, Endpoint, EndpointTree } from './endpoint.js'

export type FetchLike = typeof fetch

/** Strip trailing '/' without a backtracking regex (avoids ReDoS on long runs). */
function stripTrailingSlashes(s: string): string {
  let end = s.length
  while (end > 0 && s.charCodeAt(end - 1) === 47 /* '/' */) end--
  return s.slice(0, end)
}

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
  /**
   * Cancels the request. Without this a search-as-you-type field fires one
   * request per keystroke and can call none of them off — the last answer to
   * arrive wins, which is not the same as the last one asked for.
   */
  signal?: AbortSignal
  /** Headers for this call only. Merged over the client's, narrower wins. */
  headers?: Record<string, string>
}

/**
 * Bodies the platform already knows how to send.
 *
 * `JSON.stringify` on any of these produces `"{}"` or garbage, and for
 * `FormData` the browser also has to write the multipart boundary itself —
 * which it only does when we leave `content-type` alone.
 */
function isNativeBody(body: unknown): boolean {
  return (
    typeof FormData !== 'undefined' && body instanceof FormData ||
    typeof Blob !== 'undefined' && body instanceof Blob ||
    typeof ArrayBuffer !== 'undefined' && body instanceof ArrayBuffer ||
    typeof ReadableStream !== 'undefined' && body instanceof ReadableStream ||
    typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams
  )
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
 * const project = await api.projects.create({ body: { name: 'Basalt' } })
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
  // A native body carries its own encoding. Declaring `application/json` over
  // a FormData strips the boundary the server needs to split the parts, and
  // `URLSearchParams` already means `application/x-www-form-urlencoded`.
  const nativo = hasBody && isNativeBody(input.body)
  const headers: Record<string, string> = {
    ...(hasBody && !nativo ? { 'content-type': 'application/json' } : {}),
    ...options.headers,
    ...input.headers,
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  }

  /**
   * Montado à parte e tipado uma vez.
   *
   * Com `exactOptionalPropertyTypes`, um spread condicional inline dá um tipo
   * com `body?: X | undefined`, que não encaixa em `RequestInit`. O objeto só
   * ganha a chave quando há valor — o compilador é que não consegue segui-lo
   * através do spread.
   */
  const init: RequestInit = { method: endpoint.method, headers }
  if (hasBody) {
    // Um corpo nativo segue tal como está; o resto vai em JSON.
    // `NonNullable` porque `RequestInit['body']` inclui `undefined`, e com
    // `exactOptionalPropertyTypes` atribuir isso a uma chave opcional é erro —
    // aqui já sabemos que há corpo.
    init.body = nativo
      ? (input.body as NonNullable<RequestInit['body']>)
      : JSON.stringify(input.body)
  }
  if (input.signal) init.signal = input.signal

  const response = await doFetch(url, init)

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
    throw new BasaltClientError(
      response.status,
      error.code ?? 'HTTP_ERROR',
      error.message ?? (response.statusText || 'Request failed'),
      json,
    )
  }

  if (endpoint.result) {
    const parsed = endpoint.result.safeParse(json)
    if (!parsed.success) {
      throw new BasaltClientError(
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
  const base = stripTrailingSlashes(baseUrl)
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
