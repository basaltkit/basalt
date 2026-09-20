import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { DriveHostNotAllowedError } from '../src/errors.js'
import { createDriveFetch, type Transport } from '../src/fetch.js'
import { handleNotification } from '../src/notifications.js'
import { syncConnection, type DriveImportTask } from '../src/sync.js'
import { connect, harness } from './helpers.js'

/**
 * Regressions found auditing the phase-2 contract changes.
 *
 * Each one is a place where a vendor difference, or the cost of accommodating
 * it, was left implicit — and where the implicit version is wrong rather than
 * merely undocumented.
 */

const ok = (body: string, status = 200, headers: Record<string, string> = {}): ReturnType<Transport> =>
  Promise.resolve({ status, headers, body: Readable.from([Buffer.from(body)]) })

/**
 * A pre-signed download URL, in the shape the two vendors that use one produce
 * it: the credential is in the **query**, and the whole string is a bearer
 * token for the file.
 */
const PRESIGNED =
  'https://contoso-my.sharepoint.com/personal/x/_layouts/download.aspx?' +
  'UniqueId=abc&tempauth=eyJ0eXAiOiJKV1QiLCJhbGciOiJub25lIn0.SUPER_SECRET_DOWNLOAD_TOKEN&Translate=false'
const PRESIGNED_TOKEN = 'SUPER_SECRET_DOWNLOAD_TOKEN'

describe('a pre-signed download URL never reaches an error, a log or a hook', () => {
  /**
   * Everything that could carry it out of the package: the message an app logs,
   * the `details` `@basaltkit/http` serialises into a response body and
   * `@basaltkit/audit` stores, and whatever `util.inspect`/`JSON.stringify`
   * would print from a caught error — `cause` included.
   */
  const exposureOf = (error: unknown): string => {
    const own = error as Error & { details?: unknown; cause?: unknown; input?: unknown }
    return [
      own?.message ?? '',
      String(own?.stack ?? ''),
      JSON.stringify(own?.details ?? null),
      JSON.stringify(own?.input ?? null),
      own?.cause instanceof Error ? own.cause.message : JSON.stringify(own?.cause ?? null),
      JSON.stringify(error, Object.getOwnPropertyNames(Object(error))),
    ].join('\n')
  }

  const guardedTo = (lookup: () => Promise<{ address: string; family?: number }[]>) =>
    createDriveFetch({
      allowedHosts: ['graph.microsoft.com', '.sharepoint.com'],
      provider: 'microsoft',
      transport: () => ok('{}'),
      lookup,
    })

  it('is not in the refusal when the content host resolves to a private address', async () => {
    // A hostile or misconfigured DNS answer for the CDN. The guard is right to
    // refuse; the refusal must not quote the credential it refused to spend.
    const fetch = guardedTo(async () => [{ address: '10.0.0.5', family: 4 }])
    const error = await fetch(PRESIGNED).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(DriveHostNotAllowedError)
    expect(exposureOf(error)).not.toContain(PRESIGNED_TOKEN)
    expect(exposureOf(error)).not.toContain('tempauth')
    // The host is the diagnostic an operator needs, and it is not a credential.
    expect((error as Error).message).toContain('contoso-my.sharepoint.com')
  })

  it('is not in the refusal when the content host cannot be resolved at all', async () => {
    // The routine case: a DNS hiccup on the CDN, on a path that runs for every
    // single download.
    const fetch = guardedTo(async () => {
      throw new Error('getaddrinfo EAI_AGAIN')
    })
    const error = await fetch(PRESIGNED).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(DriveHostNotAllowedError)
    expect(exposureOf(error)).not.toContain(PRESIGNED_TOKEN)
  })

  it('is not in the refusal when the URL is malformed', async () => {
    const fetch = guardedTo(async () => [{ address: '93.184.216.34', family: 4 }])
    const error = await fetch(`::${PRESIGNED}`).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(DriveHostNotAllowedError)
    expect(exposureOf(error)).not.toContain(PRESIGNED_TOKEN)
  })

  it('does not reach drive:sync_failed, which forwards the message verbatim', async () => {
    const events: { reason: string }[] = []
    const h = harness({
      // A listing pass, so the failure is raised where an adapter raises it.
      provider: { deltaIncludesExisting: false },
      drives: {
        hooks: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          emit: async (name: string, payload: any) => {
            if (name === 'drive:sync_failed') events.push(payload as { reason: string })
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      },
    })
    const view = await connect(h, { tenantId: 'acme' })
    // The adapter reaches the network through the same guarded door, so the
    // refusal it raises is the one an app's hook handler is handed.
    h.fake.failNextListWith = (await createDriveFetch({
      allowedHosts: ['.sharepoint.com'],
      provider: 'microsoft',
      transport: () => ok('{}'),
      lookup: async () => [{ address: '10.0.0.5', family: 4 }],
    })(PRESIGNED).catch((e: unknown) => e)) as Error

    await syncConnection(h.drives, view.id, { tenantId: 'acme', enqueue: async () => {} }).catch(() => {})

    expect(events).toHaveLength(1)
    expect(events[0]!.reason).not.toContain(PRESIGNED_TOKEN)
  })
})

describe('a redirect to another host does not carry the caller’s credentials', () => {
  const hops = (target: string): Transport => async (url) =>
    url.hostname === 'graph.microsoft.com'
      ? ok('', 302, { location: target })
      : ok('{"ok":true}')

  const headersSeen: Record<string, string>[] = []
  const recording =
    (target: string): Transport =>
    async (url, init) => {
      headersSeen.push(init.headers)
      return hops(target)(url, init, null)
    }

  it('drops authorization, cookie and proxy-authorization on a cross-host hop', async () => {
    headersSeen.length = 0
    const fetch = createDriveFetch({
      allowedHosts: ['graph.microsoft.com', '.sharepoint.com'],
      provider: 'microsoft',
      transport: recording('https://contoso-my.sharepoint.com/download'),
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    })

    await fetch('https://graph.microsoft.com/v1.0/me/drive/items/1/content', {
      headers: {
        // Deliberately the capitalised spelling: only one of the two being
        // dropped would be worse than neither.
        Authorization: 'Bearer GRAPH_BEARER_TOKEN',
        Cookie: 'session=abc',
        'proxy-authorization': 'Basic xyz',
        accept: '*/*',
      },
    })

    expect(headersSeen).toHaveLength(2)
    const second = Object.fromEntries(Object.entries(headersSeen[1]!).map(([k, v]) => [k.toLowerCase(), v]))
    expect(second['authorization']).toBeUndefined()
    expect(second['cookie']).toBeUndefined()
    expect(second['proxy-authorization']).toBeUndefined()
    // Everything that is not a credential still travels.
    expect(second['accept']).toBe('*/*')
  })

  it('keeps them on a same-host hop, which is not a disclosure', async () => {
    headersSeen.length = 0
    const fetch = createDriveFetch({
      allowedHosts: ['graph.microsoft.com'],
      provider: 'microsoft',
      transport: async (url, init) => {
        headersSeen.push(init.headers)
        return url.pathname.endsWith('/content') ? ok('', 302, { location: '/v1.0/final' }) : ok('{}')
      },
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    })

    await fetch('https://graph.microsoft.com/v1.0/me/drive/items/1/content', {
      headers: { authorization: 'Bearer GRAPH_BEARER_TOKEN' },
    })

    expect(headersSeen[1]!['authorization']).toBe('Bearer GRAPH_BEARER_TOKEN')
  })
})

describe('a backfill bigger than one run’s ceiling', () => {
  /**
   * The `deltaIncludesExisting: false` path is Google's, and Google is the
   * vendor with the largest corpora. A first sync that cannot get past
   * `maxItems` in a single run has to resume, or every run re-walks the same
   * first page and nothing past it is ever imported.
   */
  const bigDrive = () =>
    harness({
      provider: {
        deltaIncludesExisting: false,
        pageSize: 2,
        files: Array.from({ length: 6 }, (_, i) => ({ externalId: `f${i + 1}`, name: `${i + 1}.txt` })),
      },
    })

  it('resumes where it stopped instead of re-walking the same page for ever', async () => {
    const h = bigDrive()
    const view = await connect(h, { tenantId: 'acme' })
    const seen: string[][] = []

    for (let run = 0; run < 3; run++) {
      const tasks: DriveImportTask[] = []
      await syncConnection(h.drives, view.id, {
        tenantId: 'acme',
        maxPages: 1,
        enqueue: async (task) => void tasks.push(task),
      })
      seen.push(tasks.map((t) => t.item.externalId))
    }

    // Before the fix every run reported the same two files: the listing page
    // cursor was local to the run and the connection cursor was cleared, so the
    // walk restarted from the top and f3…f6 were never seen at all.
    expect(seen[0]).toEqual(['f1', 'f2'])
    expect(seen[1]).toEqual(['f3', 'f4'])
    expect(seen[2]).toEqual(['f5', 'f6'])
  })

  it('only switches to the change feed once the whole listing has been walked', async () => {
    const h = bigDrive()
    const view = await connect(h, { tenantId: 'acme' })

    const first = await syncConnection(h.drives, view.id, { tenantId: 'acme', maxPages: 1, enqueue: async () => {} })
    expect(first.mode).toBe('listing')
    expect(first.truncated).toBe(true)

    const second = await syncConnection(h.drives, view.id, { tenantId: 'acme', maxPages: 1, enqueue: async () => {} })
    // Still backfilling: jumping to the feed here would skip f5 and f6 for ever.
    expect(second.mode).toBe('listing')

    await syncConnection(h.drives, view.id, { tenantId: 'acme', maxPages: 1, enqueue: async () => {} })
    const fourth = await syncConnection(h.drives, view.id, { tenantId: 'acme', enqueue: async () => {} })
    expect(fourth.mode).toBe('delta')
  })

  it('delivers everything that changed during a multi-run backfill', async () => {
    // The at-least-once argument has to survive resumption: the delta cursor is
    // taken before the FIRST listing page and held across every run, so an edit
    // made half-way through is re-delivered by the first delta run.
    const h = bigDrive()
    const view = await connect(h, { tenantId: 'acme' })

    await syncConnection(h.drives, view.id, { tenantId: 'acme', maxPages: 1, enqueue: async () => {} })
    h.fake.edit('f1', 'edited during the backfill')

    // Two more runs finish the walk (f3…f6); the run after that is the first
    // delta run, and it is the one that has to replay the edit.
    for (let run = 0; run < 2; run++) {
      await syncConnection(h.drives, view.id, { tenantId: 'acme', maxPages: 1, enqueue: async () => {} })
    }

    const tasks: DriveImportTask[] = []
    const final = await syncConnection(h.drives, view.id, {
      tenantId: 'acme',
      enqueue: async (task) => void tasks.push(task),
    })
    expect(final.mode).toBe('delta')
    expect(tasks.map((t) => t.item.externalId)).toContain('f1')
  })

  it('re-primes from scratch when the stored backfill state is unreadable', async () => {
    const h = bigDrive()
    const view = await connect(h, { tenantId: 'acme' })
    await syncConnection(h.drives, view.id, { tenantId: 'acme', maxPages: 1, enqueue: async () => {} })

    // Corrupt the payload, keep the marker: this is the shape a half-written
    // row or a truncated column actually has.
    const stored = (await h.store.find('acme', view.id))!
    const marker = stored.cursor!.slice(0, stored.cursor!.indexOf(':') + 1)
    expect(marker).toContain('backfill')
    await h.store.update('acme', view.id, { cursor: `${marker}@@corrupt@@` })

    const tasks: DriveImportTask[] = []
    const run = await syncConnection(h.drives, view.id, {
      tenantId: 'acme',
      maxPages: 1,
      enqueue: async (task) => void tasks.push(task),
    })
    // Fail safe: a state we cannot read means we do not know how far we got, so
    // the walk restarts rather than skipping whatever the unreadable half named.
    expect(run.mode).toBe('listing')
    expect(tasks.map((t) => t.item.externalId)).toEqual(['f1', 'f2'])
  })
})

describe('drive:disconnected says what actually happened at the provider', () => {
  /**
   * `revoked: false` meant three different things: we were told not to try, the
   * adapter has nothing to try (Graph has no revocation endpoint at all), and we
   * tried and failed. The first two are final; the third is worth retrying. The
   * guide's own example branches on the boolean and tells the user to go and
   * remove consent by hand, which is the wrong instruction for the third.
   */
  const capture = () => {
    const events: { revoked: boolean; revocation: string }[] = []
    const hooks = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      emit: async (name: string, payload: any) => {
        if (name === 'drive:disconnected') events.push(payload)
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    return { events, hooks }
  }

  it('reports "revoked" when the provider accepted the revocation', async () => {
    const { events, hooks } = capture()
    const h = harness({ drives: { hooks } })
    const view = await connect(h, { tenantId: 'acme' })
    await h.drives.disconnect(view.id, { tenantId: 'acme' })
    expect(events[0]).toMatchObject({ revoked: true, revocation: 'revoked' })
  })

  it('reports "unsupported" when the adapter has no revocation endpoint to call', async () => {
    // Microsoft Graph. There is nothing to try, and there never will be: the
    // grant lives until the user removes it in their account portal.
    const { events, hooks } = capture()
    const h = harness({ drives: { hooks } })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (h.fake.authorization as any).revoke
    const view = await connect(h, { tenantId: 'acme' })
    await h.drives.disconnect(view.id, { tenantId: 'acme' })
    expect(events[0]).toMatchObject({ revoked: false, revocation: 'unsupported' })
  })

  it('reports "failed" when the provider was asked and did not answer', async () => {
    // Dropbox or Google, briefly down. The grant may well still be live, and
    // the right operator action is to retry — not to send the user to a portal.
    const { events, hooks } = capture()
    const h = harness({ drives: { hooks } })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(h.fake.authorization as any).revoke = async () => {
      throw new Error('provider unavailable')
    }
    const view = await connect(h, { tenantId: 'acme' })
    await h.drives.disconnect(view.id, { tenantId: 'acme' })
    expect(events[0]).toMatchObject({ revoked: false, revocation: 'failed' })
  })

  it('reports "skipped" when the caller asked for a local-only disconnect', async () => {
    const { events, hooks } = capture()
    const h = harness({ drives: { hooks } })
    const view = await connect(h, { tenantId: 'acme' })
    await h.drives.disconnect(view.id, { tenantId: 'acme', revoke: false })
    expect(events[0]).toMatchObject({ revoked: false, revocation: 'skipped' })
  })
})

describe('an adapter written against the phase-1 contract', () => {
  it('still compiles and still behaves', async () => {
    // The compile half is `tests/phase1-adapter-compat.ts`, type-checked by the
    // package's own `tsc --noEmit`: no `deltaIncludesExisting`, no
    // `retryAfterFromBody`, no `accountIds`, a removal with a required
    // `externalId`, and a `refresh` that reads only `refreshToken`.
    const { phase1Adapter } = await import('./phase1-adapter-compat.js')

    // Omitting `deltaIncludesExisting` is the SAFE direction, not the silent
    // one: the engine backfills with a listing pass rather than trusting a
    // change feed that may start at "now".
    expect(phase1Adapter.deltaIncludesExisting).toBeUndefined()

    // A phase-1 removal still resolves a ledger entry, because it still has an id.
    const change = (await phase1Adapter.delta!({} as never, 'c')).changes[0]!
    expect(change).toEqual({ type: 'removed', externalId: 'gone' })

    // A phase-1 verification result still matches on the secret alone.
    const verified = phase1Adapter.verifyNotification!({
      method: 'POST',
      headers: {},
      query: {},
      body: Buffer.alloc(0),
    })
    expect(verified).toEqual({ secret: 'channel-secret', changed: true })

    // And it is refreshed with the extra input it never asked for, harmlessly.
    expect(await phase1Adapter.authorization.refresh({ refreshToken: 'r', fetch: null as never })).toEqual({
      accessToken: 'a-r',
    })
  })

  /**
   * The assertions above are about the adapter's own return values. This one is
   * about what the **engine** does with them, which is where the three breaking
   * reshapes actually bite: an outcome that became a list, a throw that became
   * a return, and a removal field that became optional. A phase-1 adapter knew
   * about none of them, so each is exercised through the engine rather than
   * inspected on the adapter.
   */
  it('still works through the engine on all three reshaped paths', async () => {
    const { phase1Adapter } = await import('./phase1-adapter-compat.js')
    const h = harness({ drives: { providers: [phase1Adapter] } })
    const view = await h.drives.connect({
      provider: 'legacy',
      label: 'Legacy',
      tenantId: 'acme',
      tokens: await phase1Adapter.authorization.exchange({
        code: 'good',
        redirectUri: 'https://app.test/callback',
        codeVerifier: 'v',
        fetch: null as never,
      }),
    })
    // The subscription the phase-1 `verifyNotification` result names. Written
    // straight to the store because this adapter has no `watch` — itself a
    // phase-1 shape the engine still has to cope with.
    await h.store.update('acme', view.id, { watch: { id: 'w1', secret: 'channel-secret' } })
    const connection = (await h.store.find('acme', view.id))!
    const input = { method: 'POST', headers: {}, query: {}, body: Buffer.alloc(0) }

    // Reshape 1 — `DriveNotificationOutcome.connection` became `connections`.
    // A phase-1 result carries one secret and no `accountIds`, and still has to
    // arrive as a one-element list.
    const matched = await handleNotification(h.drives, input, { provider: 'legacy', connections: [connection] })
    expect(matched.connections.map((c) => c.id)).toEqual([view.id])
    expect(matched.shouldSync).toBe(true)

    // Reshape 2 — a verified-but-unmatched notification used to throw. An app
    // that wrapped this call in a try/catch now gets a resolved promise, and
    // the difference has to be visible in `reason` rather than as an exception.
    const unmatched = await handleNotification(h.drives, input, { provider: 'legacy', connections: [] })
    expect(unmatched.shouldSync).toBe(false)
    expect(unmatched.connections).toEqual([])
    expect(unmatched.reason).toBe('unmatched')

    // Reshape 3 — `DriveRemoval.externalId` became optional. A phase-1 removal
    // still carries one, so it must still resolve a ledger row rather than
    // being reported as the id-less kind Dropbox produces.
    await h.ledger.record({
      tenantId: 'acme',
      connectionId: view.id,
      externalId: 'gone',
      version: 'v1',
      targetId: 'target-1',
      strategy: 'copy',
      importedAt: h.now(),
    })
    const removals: unknown[] = []
    const onRemoved = async (removal: unknown): Promise<void> => {
      removals.push(removal)
    }
    // Two runs: with `deltaIncludesExisting` undefined the engine backfills
    // with a listing pass first and only reaches the change feed afterwards.
    await syncConnection(h.drives, view.id, { tenantId: 'acme', enqueue: async () => {}, onRemoved })
    const second = await syncConnection(h.drives, view.id, { tenantId: 'acme', enqueue: async () => {}, onRemoved })

    expect(second.mode).toBe('delta')
    expect(removals).toEqual([{ tenantId: 'acme', connectionId: view.id, externalId: 'gone', targetId: 'target-1' }])
  })
})
