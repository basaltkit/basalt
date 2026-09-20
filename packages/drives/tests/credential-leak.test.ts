import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import {
  DriveContentTooLargeError,
  DriveHostNotAllowedError,
  DriveRateLimitedError,
} from '../src/errors.js'
import { createDriveFetch, type Transport } from '../src/fetch.js'
import { importItem } from '../src/import.js'
import type { DriveContent, DriveItem, DriveListOptions, DrivePage, DriveSession } from '../src/provider.js'
import { syncConnection } from '../src/sync.js'
import { FakeDriveProvider } from '../src/testing.js'
import { harness, recordingSink } from './helpers.js'

/**
 * The credential-leak surface, attacked rather than asserted.
 *
 * A provider download URL — Graph's `@microsoft.graph.downloadUrl`, Google's
 * signed `googleusercontent.com` redirect target — **is a bearer credential for
 * the file**: whoever holds the string can read the bytes, with no token and no
 * account. `tests/audit-phase2.test.ts` pins the three refusals the audit fixed.
 * This file pins the rest of the surface: a multi-hop chain, the two error
 * paths that read a provider body, and — the one nothing covered — everything
 * the engine **writes down**: the connection row, its cursor, the import ledger
 * and every hook payload an app routes to a logger or to `@basaltkit/audit`.
 */

/** Graph's shape: the credential is in the query, and the whole string is the token. */
const PRESIGNED =
  'https://cdn.test/personal/finance/_layouts/15/download.aspx?' +
  'UniqueId=f1&tempauth=eyJ0eXAiOiJKV1QifQ.SUPER_SECRET_DOWNLOAD_TOKEN&Translate=false'
/** Google's shape: a different host, a different spelling, the same problem. */
const GOOGLE_SIGNED =
  'https://doc-04-7g-docs.googleusercontent.com/docs/securesc/abc/download/f1?' +
  'e=download&sig=GOOGLE_SIGNED_CDN_SECRET'
const SECRETS = ['SUPER_SECRET_DOWNLOAD_TOKEN', 'tempauth', 'GOOGLE_SIGNED_CDN_SECRET', 'sig=']

/**
 * Everything a caught error can carry out of the package: the message an app
 * logs, the `details` `@basaltkit/http` serialises into a response body and
 * `@basaltkit/audit` stores, the `cause` chain a serialiser walks, and node's
 * own `error.input` (which `ERR_INVALID_URL` uses for the offending string).
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

const expectNoSecret = (text: string): void => {
  for (const secret of SECRETS) expect(text).not.toContain(secret)
}

const body = (text: string, status = 200, headers: Record<string, string> = {}): ReturnType<Transport> =>
  Promise.resolve({ status, headers, body: Readable.from([Buffer.from(text)]) })

describe('a pre-signed download URL survives no hop of a redirect chain', () => {
  /** Records what each hop was actually handed. */
  const chain = (hops: readonly string[]) => {
    const seen: { host: string; headers: Record<string, string> }[] = []
    const transport: Transport = (url, init) => {
      seen.push({ host: url.host, headers: { ...init.headers } })
      const next = hops[seen.length - 1]
      return next === undefined ? body('bytes') : body('', 302, { location: next })
    }
    return { seen, transport }
  }

  it('drops the bearer at the first cross-host hop and never restores it', async () => {
    // Graph's `/content` answers 302 to a CDN, and some tenants' CDNs answer a
    // second 302 to a regional one. The token must die at the first hop, and a
    // later hop back onto an allowed host must not resurrect it.
    const { seen, transport } = chain([PRESIGNED, GOOGLE_SIGNED])
    const fetch = createDriveFetch({
      allowedHosts: ['graph.test', 'cdn.test', '.googleusercontent.com'],
      provider: 'microsoft',
      transport,
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    })

    const response = await fetch('https://graph.test/v1.0/me/drive/items/f1/content', {
      headers: { authorization: 'Bearer GRAPH-WIDE-TOKEN', cookie: 'sid=abc', 'x-trace': 'keep-me' },
    })
    response.destroy()

    expect(seen.map((hop) => hop.host)).toEqual(['graph.test', 'cdn.test', 'doc-04-7g-docs.googleusercontent.com'])
    expect(seen[0]!.headers['authorization']).toBe('Bearer GRAPH-WIDE-TOKEN')
    for (const hop of seen.slice(1)) {
      expect(hop.headers['authorization']).toBeUndefined()
      expect(hop.headers['cookie']).toBeUndefined()
      // Only credentials are dropped. A correlation header is not one, and
      // stripping it would make a cross-host download untraceable.
      expect(hop.headers['x-trace']).toBe('keep-me')
    }
  })

  it('does not quote the chain when a hop leaves the allowlist', async () => {
    // The refusal an operator sees for a CDN that redirected somewhere it
    // should not. It must name the host and stop there: the URL it declined to
    // follow is itself the credential.
    const { transport } = chain([PRESIGNED])
    const fetch = createDriveFetch({
      allowedHosts: ['graph.test'],
      provider: 'microsoft',
      transport,
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    })

    const error = await fetch('https://graph.test/v1.0/me/drive/items/f1/content').catch((e: unknown) => e)

    expect(error).toBeInstanceOf(DriveHostNotAllowedError)
    expectNoSecret(exposureOf(error))
    expect((error as Error).message).toContain('cdn.test')
  })

  it('does not quote the chain when it is too long', async () => {
    const { transport } = chain([PRESIGNED, PRESIGNED, PRESIGNED, PRESIGNED])
    const fetch = createDriveFetch({
      allowedHosts: ['graph.test', 'cdn.test'],
      provider: 'microsoft',
      maxRedirects: 2,
      transport,
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    })

    const error = await fetch('https://graph.test/v1.0/me/drive/items/f1/content').catch((e: unknown) => e)

    expect(error).toBeInstanceOf(DriveHostNotAllowedError)
    expectNoSecret(exposureOf(error))
    expect((error as Error).message).toContain('redirect depth')
  })

  it('does not quote a Location that cannot be parsed', async () => {
    // A `Location` is provider-controlled data and can itself be a pre-signed
    // URL, so a malformed one must not be echoed back while being refused.
    const transport: Transport = () => body('', 302, { location: `::not a url::${PRESIGNED}` })
    const fetch = createDriveFetch({
      allowedHosts: ['graph.test'],
      provider: 'microsoft',
      transport,
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    })

    const error = await fetch('https://graph.test/v1.0/me/drive/items/f1/content').catch((e: unknown) => e)

    expect(error).toBeInstanceOf(DriveHostNotAllowedError)
    expectNoSecret(exposureOf(error))
  })
})

describe('the two error paths that read a provider body', () => {
  const fetchTo = (transport: Transport, retryAfterFromBody?: (b: string) => number | undefined) =>
    createDriveFetch({
      allowedHosts: ['.googleusercontent.com'],
      provider: 'google',
      maxBytes: 16,
      transport,
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      ...(retryAfterFromBody ? { retryAfterFromBody } : {}),
    })

  it('keeps a throttle refusal clean even when the body quotes the URL', async () => {
    // The CDN error page that quotes the request it refused — the realistic
    // shape, and the reason nothing from a 429 body reaches an error except a
    // number the adapter's own parser produced.
    const seen: string[] = []
    const fetch = fetchTo(
      () => body(JSON.stringify({ error: { message: `rate limited for ${GOOGLE_SIGNED}`, retry_after: 2 } }), 429),
      (text) => {
        seen.push(text)
        return 2000
      },
    )

    const error = await fetch(GOOGLE_SIGNED).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(DriveRateLimitedError)
    expect((error as DriveRateLimitedError).retryAfterMs).toBe(2000)
    // The parser really was handed the body — the point is that only its
    // *number* survives into the error.
    expect(seen[0]).toContain('GOOGLE_SIGNED_CDN_SECRET')
    expectNoSecret(exposureOf(error))
  })

  it('keeps an over-size refusal clean', async () => {
    const fetch = fetchTo(() => body(`x`.repeat(64)))
    const response = await fetch(GOOGLE_SIGNED)
    const error = await response.text().catch((e: unknown) => e)

    expect(error).toBeInstanceOf(DriveContentTooLargeError)
    expectNoSecret(exposureOf(error))
  })
})

/**
 * An adapter shaped like the two real ones that use a pre-signed URL: it asks
 * the provider for the credential and spends it immediately, and the URL never
 * appears in an item, a listing or anything it returns.
 */
class PresignedDrive extends FakeDriveProvider {
  /** Set to put the credential where a careless adapter would put it. */
  leakIntoRaw = false

  override async list(session: DriveSession, options: DriveListOptions): Promise<DrivePage<DriveItem>> {
    const page = await super.list(session, options)
    if (!this.leakIntoRaw) return page
    return { ...page, items: page.items.map((item) => ({ ...item, raw: { downloadUrl: PRESIGNED } })) }
  }

  override async download(session: DriveSession, item: DriveItem): Promise<DriveContent> {
    // The pre-signed URL is fetched with no `authorization`, exactly as
    // `drives-microsoft` does, and is never kept.
    const response = await session.fetch(PRESIGNED, { headers: { accept: '*/*' } })
    void item
    return { stream: response.body, contentType: 'text/plain', size: 5 }
  }
}

describe('nothing the engine writes down carries it', () => {
  const FILES = [
    { externalId: 'f1', name: 'invoice.pdf', contentType: 'text/plain', content: 'bytes' },
    { externalId: 'f2', name: 'receipt.pdf', contentType: 'text/plain', content: 'bytes' },
  ]

  const build = (leakIntoRaw = false) => {
    const events: { name: string; payload: unknown }[] = []
    const fake = new PresignedDrive({
      name: 'fake',
      files: FILES,
      allowedHosts: ['cdn.test'],
      deltaIncludesExisting: false,
      pageSize: 1,
    })
    fake.leakIntoRaw = leakIntoRaw
    /** Flipped mid-test to make the CDN resolve somewhere the guard refuses. */
    let address = '93.184.216.34'
    const h = harness({
      drives: {
        providers: [fake],
        transport: () => body('bytes'),
        lookup: async () => [{ address, family: 4 }],
        hooks: {
          emit: async (name: string, payload: unknown) => {
            events.push({ name, payload })
          },
        } as never,
      },
    })
    /** `connect()` from the shared helpers exchanges against the harness's own fake. */
    const connectTo = async (tenantId: string) =>
      h.drives.connect({
        provider: 'fake',
        label: 'Drive Finance',
        tenantId,
        tokens: await fake.authorization.exchange({
          code: 'good',
          redirectUri: 'https://app.test/callback',
          codeVerifier: 'v',
          fetch: null as never,
        }),
      })
    return {
      h,
      fake,
      events,
      connectTo,
      breakDns: () => {
        address = '10.0.0.5'
      },
    }
  }

  it('does not reach the connection row, its cursor, the ledger or any hook', async () => {
    const { h, events, connectTo } = build()
    const view = await connectTo('acme')

    const tasks: { item: DriveItem }[] = []
    // A ceiling below the corpus, so the run parks a resume point in
    // `connection.cursor` — the field the audit added and the one most likely
    // to accumulate whatever an adapter last touched.
    const first = await syncConnection(h.drives, view.id, {
      tenantId: 'acme',
      maxPages: 1,
      enqueue: async (task) => {
        tasks.push(task)
      },
    })
    expect(first.truncated).toBe(true)

    await syncConnection(h.drives, view.id, {
      tenantId: 'acme',
      enqueue: async (task) => {
        tasks.push(task)
      },
    })

    const { sink, seen } = recordingSink()
    for (const task of tasks) {
      await importItem(h.drives, view.id, task.item, sink, { tenantId: 'acme' })
    }
    expect(seen.map((s) => s.body)).toEqual(tasks.map(() => 'bytes'))

    // Everything that outlives the request, and everything an app routes to a
    // logger or to `@basaltkit/audit`.
    const persisted = JSON.stringify(await h.store.list('acme'))
    const ledger = JSON.stringify(await h.ledger.list('acme', view.id))
    const emitted = JSON.stringify(events)
    const enqueued = JSON.stringify(tasks)

    expect(events.map((e) => e.name)).toContain('drive:item_imported')
    for (const written of [persisted, ledger, emitted, enqueued]) expectNoSecret(written)
    // Named separately, because a cursor is the one persisted field an adapter
    // fills in with a string of its own choosing.
    const row = (await h.store.list('acme'))[0]!
    expectNoSecret(String(row.cursor ?? ''))
  })

  it('reports a failed download without the URL it failed on', async () => {
    const { h, events, connectTo, breakDns } = build()
    const view = await connectTo('acme')
    const tasks: { item: DriveItem }[] = []
    await syncConnection(h.drives, view.id, {
      tenantId: 'acme',
      enqueue: async (task) => {
        tasks.push(task)
      },
    })

    // The CDN now resolves to a private address — a DNS hiccup, or a hostile
    // answer. The refusal travels all the way out through `importItem`.
    breakDns()
    const error = await importItem(h.drives, view.id, tasks[0]!.item, async () => ({ targetId: 't' }), {
      tenantId: 'acme',
    }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(DriveHostNotAllowedError)
    expectNoSecret(exposureOf(error))
    expectNoSecret(JSON.stringify(events))
    expectNoSecret(JSON.stringify(await h.store.list('acme')))
  })

  it('passes DriveItem.raw through untouched — which is why every adapter scrubs it', async () => {
    // The honest boundary. `raw` is the adapter's own passthrough and the
    // engine does not inspect it, so an adapter that copies a provider payload
    // wholesale hands the credential to the app's sink and to whatever the sink
    // stores. Each shipped adapter builds `raw` from an allowlist instead, and
    // asserts so in its own tests; this pins why that is load-bearing rather
    // than tidy.
    const { h, connectTo } = build(true)
    const view = await connectTo('acme')
    const tasks: { item: DriveItem }[] = []
    await syncConnection(h.drives, view.id, {
      tenantId: 'acme',
      enqueue: async (task) => {
        tasks.push(task)
      },
    })

    let raw: unknown
    await importItem(
      h.drives,
      view.id,
      tasks[0]!.item,
      async (input) => {
        raw = input.item.raw
        input.content?.stream.destroy()
        return { targetId: 't' }
      },
      { tenantId: 'acme' },
    )

    expect(raw).toEqual({ downloadUrl: PRESIGNED })
    // And still nowhere the engine itself owns.
    expectNoSecret(JSON.stringify(await h.ledger.list('acme', view.id)))
    expectNoSecret(String((await h.store.list('acme'))[0]!.cursor ?? ''))
  })
})
