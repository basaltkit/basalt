import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createClient, endpoint } from '../src/index.js'

/**
 * Security invariant: a path parameter fills exactly ONE path segment of the
 * endpoint it was declared for. It must never be able to walk the request to a
 * different same-origin endpoint (which would still carry the caller's bearer
 * token), and one placeholder must never be substituted into another whose
 * name merely starts with the same characters.
 */
const spy = () => {
  const urls: string[] = []
  const fetch = async (url: string) => {
    urls.push(url)
    return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return { urls, fetch: fetch as unknown as typeof globalThis.fetch }
}

const api = (fetch: typeof globalThis.fetch) =>
  createClient(
    {
      member: endpoint({
        method: 'GET',
        path: '/tenants/:tenant/members/:id',
        params: z.object({ tenant: z.string(), id: z.string() }),
      }),
      pair: endpoint({
        method: 'GET',
        path: '/orgs/:orgId/:org',
        params: z.object({ org: z.string(), orgId: z.string() }),
      }),
    },
    { baseUrl: 'https://api.test', fetch, getToken: () => 'secret-token' },
  )

describe('path params cannot escape their segment', () => {
  it.each(['..', '.', ''])('rejects the dot-segment / empty value %j before any request is sent', async (value) => {
    const { urls, fetch } = spy()
    await expect(api(fetch).member({ params: { tenant: 'acme', id: value } })).rejects.toMatchObject({
      name: 'BasaltClientError',
      code: 'CLIENT_INVALID_PARAM',
    })
    expect(urls).toEqual([])
  })

  it('rejects a missing param instead of sending the literal placeholder', async () => {
    const { urls, fetch } = spy()
    await expect(
      api(fetch).member({ params: { tenant: 'acme' } as unknown as { tenant: string; id: string } }),
    ).rejects.toMatchObject({ code: 'CLIENT_INVALID_PARAM' })
    expect(urls).toEqual([])
  })

  it('encodes slashes and encoded dot-segments so they stay inside one segment', async () => {
    const { urls, fetch } = spy()
    await api(fetch).member({ params: { tenant: 'acme', id: '../../admin' } })
    await api(fetch).member({ params: { tenant: 'acme', id: '%2e%2e' } })
    expect(urls[0]).toBe('https://api.test/tenants/acme/members/..%2F..%2Fadmin')
    expect(urls[1]).toBe('https://api.test/tenants/acme/members/%252e%252e')
    for (const url of urls) expect(new URL(url).pathname.startsWith('/tenants/acme/members/')).toBe(true)
  })

  it('substitutes whole placeholder names, not prefixes', async () => {
    const { urls, fetch } = spy()
    // With substring replacement, `:org` would consume the prefix of `:orgId`.
    await api(fetch).pair({ params: { org: 'a', orgId: 'b' } })
    expect(urls[0]).toBe('https://api.test/orgs/b/a')
  })

  it('does not re-expand a placeholder that appears inside a substituted value', async () => {
    const { urls, fetch } = spy()
    await api(fetch).member({ params: { tenant: ':id', id: 'x' } })
    expect(urls[0]).toBe('https://api.test/tenants/%3Aid/members/x')
  })
})

describe('literal colons inside a segment are not placeholders', () => {
  const custom = (fetch: typeof globalThis.fetch) =>
    createClient(
      {
        batch: endpoint({ method: 'POST', path: '/v1/items:batch' }),
        action: endpoint({ method: 'POST', path: '/v1/resource:action' }),
        archive: endpoint({
          method: 'POST',
          path: '/v1/items/:id:archive',
          params: z.object({ id: z.string() }),
        }),
      },
      { baseUrl: 'https://api.test', fetch },
    )

  it('passes Google-style custom methods through untouched', async () => {
    const { urls, fetch } = spy()
    await custom(fetch).batch({})
    await custom(fetch).action({})
    expect(urls).toEqual(['https://api.test/v1/items:batch', 'https://api.test/v1/resource:action'])
  })

  it('substitutes a segment-leading placeholder followed by a literal custom method', async () => {
    const { urls, fetch } = spy()
    await custom(fetch).archive({ params: { id: 'p1' } })
    expect(urls[0]).toBe('https://api.test/v1/items/p1:archive')
  })

  it.each(['..', '.', ''])('still rejects %j next to a custom method', async (value) => {
    const { urls, fetch } = spy()
    await expect(custom(fetch).archive({ params: { id: value } })).rejects.toMatchObject({
      code: 'CLIENT_INVALID_PARAM',
    })
    expect(urls).toEqual([])
  })
})
