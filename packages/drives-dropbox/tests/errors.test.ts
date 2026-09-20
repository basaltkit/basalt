import { describe, expect, it } from 'vitest'
import { isRetryable } from '@basaltkit/drives'
import { errorSummary, retryAfterFromBody, toDropboxError } from '../src/errors.js'
import { connect, harness } from './helpers.js'

const context = { provider: 'dropbox', connectionId: 'conn-1' }

describe('error taxonomy', () => {
  it('maps 401 to credentials that need refreshing', () => {
    const error = toDropboxError(401, JSON.stringify({ error_summary: 'expired_access_token/' }), context)
    expect(error).toMatchObject({ code: 'DRIVE_CREDENTIALS_INVALID' })
  })

  it('maps 403 to access denied, not to "reconnect your account"', () => {
    // A team policy refusal is not fixed by re-consenting, and telling a tenant
    // to reconnect forever over one is worse than saying nothing.
    const error = toDropboxError(403, JSON.stringify({ error_summary: 'access_denied/team_policy' }), context)
    expect(error).toMatchObject({ code: 'DRIVE_ACCESS_DENIED' })
  })

  it('maps 409 path/not_found to a missing item', () => {
    const error = toDropboxError(409, JSON.stringify({ error_summary: 'path/not_found/..' }), {
      ...context,
      externalId: 'id:a',
    })
    expect(error).toMatchObject({ code: 'DRIVE_ITEM_NOT_FOUND' })
  })

  it('maps another 409 to a terminal provider error', () => {
    const error = toDropboxError(409, JSON.stringify({ error_summary: 'path/conflict/file/.' }), context)
    expect(error).toMatchObject({ code: 'DRIVE_PROVIDER_ERROR' })
    expect(isRetryable(error)).toBe(false)
  })

  it('makes a 5xx retryable and a 4xx terminal', () => {
    expect(isRetryable(toDropboxError(503, '', context))).toBe(true)
    expect(isRetryable(toDropboxError(500, '', context))).toBe(true)
    expect(isRetryable(toDropboxError(400, '', context))).toBe(false)
  })

  it('never lets an arbitrary provider body into a serialised error', () => {
    // `details` is put into an HTTP response by @basaltkit/http and stored by
    // @basaltkit/audit, so anything that reaches it is effectively public.
    const hostile = '<html><script>alert(1)</script> Bearer sl.ABC-secret</html>'
    expect(errorSummary(hostile, 502)).toBe('http_502')
    const error = toDropboxError(502, hostile, context)
    expect(JSON.stringify(error)).not.toContain('sl.ABC-secret')
    expect((error as { details?: { summary?: string } }).details?.summary).toBe('http_502')
  })

  it('keeps a genuine error_summary, which is a fixed vocabulary', () => {
    expect(errorSummary(JSON.stringify({ error_summary: 'path/not_found/' }), 409)).toBe('path/not_found/')
  })
})

describe('rate limiting', () => {
  it('honours Retry-After and retries the call', async () => {
    const h = harness({ server: { files: [{ id: 'id:a', path: '/a.txt', content: 'a' }] } })
    const view = await connect(h)
    const waits: number[] = []
    ;(h.drives as unknown as { retry: { sleep: (ms: number) => Promise<void> } }).retry.sleep = async (ms) => {
      waits.push(ms)
    }

    h.dropbox.queue(429, JSON.stringify({ error_summary: 'too_many_requests/' }), { 'retry-after': '7' })
    const page = await h.drives.listItems(view.id)

    expect(page.items).toHaveLength(1)
    expect(waits).toEqual([7000])
  })

  it('reads Dropbox’s own retry_after when it sends no Retry-After header', async () => {
    // Dropbox frequently answers 429 with the hint only in the body. The
    // guarded fetch destroys a rate-limited body before an adapter sees it, so
    // this only works because the provider declares `retryAfterFromBody`.
    const h = harness({ server: { files: [{ id: 'id:a', path: '/a.txt', content: 'a' }] } })
    const view = await connect(h)
    const waits: number[] = []
    ;(h.drives as unknown as { retry: { sleep: (ms: number) => Promise<void> } }).retry.sleep = async (ms) => {
      waits.push(ms)
    }

    h.dropbox.queue(
      429,
      JSON.stringify({ error_summary: 'too_many_requests/..', error: { '.tag': 'too_many_requests', retry_after: 3 } }),
    )
    await h.drives.listItems(view.id)

    expect(waits).toEqual([3000])
  })

  it('parses the hint out of a body and ignores anything else', () => {
    expect(retryAfterFromBody(JSON.stringify({ error: { retry_after: 12 } }))).toBe(12_000)
    expect(retryAfterFromBody(JSON.stringify({ error: { retry_after: 'soon' } }))).toBeUndefined()
    expect(retryAfterFromBody('not json')).toBeUndefined()
    expect(retryAfterFromBody('{}')).toBeUndefined()
  })

  it('gives up rather than holding a worker for an absurd wait', async () => {
    const h = harness({ server: { files: [] } })
    const view = await connect(h)
    h.dropbox.queue(429, '{}', { 'retry-after': '3600' })
    // An hour of Retry-After is the queue's problem, not a worker's.
    await expect(h.drives.listItems(view.id)).rejects.toMatchObject({ code: 'DRIVE_RATE_LIMITED' })
  })
})

describe('reactive refresh', () => {
  it('recovers from a 401 on a token the engine believed was valid', async () => {
    const h = harness({ server: { files: [{ id: 'id:a', path: '/a.txt', content: 'a' }] } })
    const view = await connect(h)

    // The provider expires the token early — clock skew, load shedding, a
    // grant reissued behind our back. The stored expiry still says it is good,
    // so nothing proactive fires.
    const issued = h.dropbox.requests.find((r) => r.url.includes('/oauth2/token'))!
    void issued
    for (const token of ['access-1', 'access-2', 'access-3']) h.dropbox.expireAccessToken(token)

    const page = await h.drives.listItems(view.id)
    expect(page.items).toHaveLength(1)
    // Exactly one refresh: a dead grant must not be able to drive one
    // token-endpoint call per retry attempt.
    expect(h.dropbox.requests.filter((r) => r.url.includes('/oauth2/token') && r.body.includes('refresh_token'))).toHaveLength(1)
  })
})

describe('a cursor Dropbox invalidated', () => {
  it('maps 409 reset/ to the contract’s cursor reset', () => {
    const error = toDropboxError(409, JSON.stringify({ error_summary: 'reset/...', error: { '.tag': 'reset' } }), context)
    expect(error).toMatchObject({ code: 'DRIVE_CURSOR_RESET' })
    // Not retryable: retrying sends the same dead cursor.
    expect(isRetryable(error)).toBe(false)
  })

  it('makes a sync drop the cursor and re-prime on the next run', async () => {
    const h = harness({ server: { files: [{ id: 'id:a', path: '/a.txt', content: 'a' }], pageSize: 10 } })
    const view = await connect(h)
    const { syncConnection } = await import('@basaltkit/drives')
    await syncConnection(h.drives, view.id, { enqueue: async () => {} })
    expect((await h.store.find('default', view.id))!.cursor).toBeTruthy()

    h.dropbox.queue(409, JSON.stringify({ error_summary: 'reset/...', error: { '.tag': 'reset' } }))
    const result = await syncConnection(h.drives, view.id, { enqueue: async () => {} })

    expect(result.reset).toBe(true)
    expect((await h.store.find('default', view.id))!.cursor).toBeUndefined()

    const tasks: { externalId: string }[] = []
    await syncConnection(h.drives, view.id, {
      enqueue: async (task) => void tasks.push({ externalId: task.item.externalId }),
    })
    // Recovered: the feed restarted from the folder rather than stalling.
    expect(tasks.map((t) => t.externalId)).toEqual(['id:a'])
  })
})
