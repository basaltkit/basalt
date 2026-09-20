import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import {
  DriveSecretBox,
  Drives,
  MemoryDriveConnectionStore,
  MemoryDriveImportLedger,
  handleNotification,
  importItem,
  syncConnection,
  watchConnection,
  type DriveConnectionView,
  type DriveImportTask,
  type DriveSinkInput,
} from '@basaltkit/drives'
import { FakeDriveProvider } from '@basaltkit/drives/testing'
import { googleDrive } from '../src/index.js'
import { FakeGoogle } from './google-server.js'
import { CLIENT_ID, CLIENT_SECRET, REDIRECT_URI, TEST_KEYS, TEST_SECRET, readAll } from './helpers.js'

/**
 * Multi-provider coexistence, with Google in the picture.
 *
 * Phase 2a closed this gap for the fake + Dropbox; the same properties have to
 * hold for a third adapter, and Google is the one that makes the collisions
 * interesting: it is the only provider so far whose change feed is **account
 * wide**, and the only one whose notifications carry a secret the engine chose
 * — the same correlation the fake uses. So the ids collide *and* the
 * authentication shape collides, which is exactly the pair a provider-blind
 * lookup would fall for.
 */

const COLLIDING_ID = 'shared-id'
const COLLIDING_PATH = '/Finance/invoice.pdf'

function bothProviders() {
  let clock = Date.parse('2026-06-01T00:00:00Z')
  const now = (): number => clock
  const googleServer = new FakeGoogle({
    clientId: CLIENT_ID,
    pageSize: 10,
    files: [{ id: COLLIDING_ID, name: 'invoice.pdf', content: 'google bytes', parents: [] }],
  })
  const google = googleDrive({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, now })
  const fake = new FakeDriveProvider({
    now,
    name: 'fake',
    accountId: 'fake-account',
    // Same id and same path as the Google file, on purpose.
    files: [{ externalId: COLLIDING_ID, name: 'invoice.pdf', path: COLLIDING_PATH, content: 'fake bytes' }],
  })
  const store = new MemoryDriveConnectionStore()
  const ledger = new MemoryDriveImportLedger()
  const drives = new Drives({
    providers: [fake, google],
    keys: TEST_KEYS,
    secret: TEST_SECRET,
    store,
    ledger,
    now,
    transport: googleServer.transport,
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    retry: { attempts: 3, sleep: async () => {}, random: () => 0 },
  })
  return {
    drives,
    fake,
    google,
    googleServer,
    store,
    ledger,
    now,
    advance: (ms: number) => {
      clock += ms
    },
  }
}

type World = ReturnType<typeof bothProviders>

async function connectBoth(world: World, tenantId: string): Promise<{ fake: DriveConnectionView; google: DriveConnectionView }> {
  const fakeTokens = await world.fake.authorization.exchange({
    code: 'good',
    redirectUri: 'https://app.test/cb',
    codeVerifier: 'v',
    fetch: async () => {
      throw new Error('unused')
    },
  })
  const fake = await world.drives.connect({ provider: 'fake', label: 'Fake Drive', tokens: fakeTokens, tenantId })

  const start = world.drives.startAuthorization({ provider: 'google', redirectUri: REDIRECT_URI, tenantId })
  const google = await world.drives.completeAuthorization({
    provider: 'google',
    code: 'good-code',
    redirectUri: REDIRECT_URI,
    state: start.state,
    binding: start.binding,
    label: 'Google Finance',
    tenantId,
  })
  return { fake, google }
}

describe('two providers, one tenant', () => {
  it('registers both and keeps their connections side by side', async () => {
    const world = bothProviders()
    expect(world.drives.providerNames()).toEqual(['fake', 'google'])
    const { fake, google } = await connectBoth(world, 'acme')

    const all = await world.drives.list({ tenantId: 'acme' })
    expect(all.map((c) => c.provider).sort()).toEqual(['fake', 'google'])
    expect(await world.drives.list({ tenantId: 'acme', provider: 'google' })).toHaveLength(1)
    expect((await world.drives.list({ tenantId: 'acme', provider: 'fake' }))[0]!.id).toBe(fake.id)
    expect((await world.drives.get(google.id, 'acme')).provider).toBe('google')
  })

  it('routes every call to the connection’s own adapter, even when the ids collide', async () => {
    const world = bothProviders()
    const { fake, google } = await connectBoth(world, 'acme')

    const item = { externalId: COLLIDING_ID, name: 'invoice.pdf', kind: 'file' as const }
    const fromFake = await world.drives.download(fake.id, item, { tenantId: 'acme' })
    const fromGoogle = await world.drives.download(google.id, item, { tenantId: 'acme' })

    // Same id, two different files — because the connection, not the id,
    // decides which provider answers.
    expect(await readAll(fromFake.stream)).toBe('fake bytes')
    expect(await readAll(fromGoogle.stream)).toBe('google bytes')
    // The fake never reaches the network; the Google call went out and came
    // back through the CDN redirect.
    expect(world.googleServer.requests.some((r) => r.url.includes('alt=media'))).toBe(true)
    expect(world.fake.calls['download']).toBe(1)
  })

  it('syncs each connection through its own change model', async () => {
    const world = bothProviders()
    const { fake, google } = await connectBoth(world, 'acme')
    const tasks: DriveImportTask[] = []
    const enqueue = async (task: DriveImportTask): Promise<void> => void tasks.push(task)

    const fakeRun = await syncConnection(world.drives, fake.id, { tenantId: 'acme', enqueue })
    const googleRun = await syncConnection(world.drives, google.id, { tenantId: 'acme', enqueue })

    // The two adapters disagree about what a start cursor *means*, and the
    // engine honours each one: the fake's feed replays what exists, Google's
    // does not, so Google backfills with a listing first.
    expect(fakeRun.mode).toBe('delta')
    expect(googleRun.mode).toBe('listing')
    expect(tasks.map((t) => t.provider).sort()).toEqual(['fake', 'google'])
    expect(tasks.filter((t) => t.provider === 'fake')[0]!.connectionId).toBe(fake.id)
    expect(tasks.filter((t) => t.provider === 'google')[0]!.connectionId).toBe(google.id)
  })

  it('keeps the dedup ledger distinct for the same external id on two providers', async () => {
    const world = bothProviders()
    const { fake, google } = await connectBoth(world, 'acme')
    const seen: { connectionId: string; body: string | undefined }[] = []
    let counter = 0
    const sink = async (input: DriveSinkInput) => {
      seen.push({
        connectionId: input.connection.id,
        body: input.content ? await readAll(input.content.stream) : undefined,
      })
      return { targetId: `target-${++counter}` }
    }

    const fakeItem = (await world.drives.listItems(fake.id, { tenantId: 'acme' })).items[0]!
    const googleItem = (await world.drives.listItems(google.id, { tenantId: 'acme' })).items[0]!
    expect(fakeItem.externalId).toBe(googleItem.externalId)
    // And their content versions collide in shape but not in meaning: one is a
    // sha256 label, the other an md5 one.
    expect(fakeItem.checksum?.algorithm).toBe('sha256')
    expect(googleItem.checksum?.algorithm).toBe('md5')

    const first = await importItem(world.drives, fake.id, fakeItem, sink, { tenantId: 'acme' })
    const second = await importItem(world.drives, google.id, googleItem, sink, { tenantId: 'acme' })

    // The ledger is keyed by (tenant, CONNECTION, externalId). A tenant-scoped
    // key would have made the second import look like a duplicate of the first
    // and skipped a real file.
    expect(first.status).toBe('imported')
    expect(second.status).toBe('imported')
    expect(seen.map((s) => s.body)).toEqual(['fake bytes', 'google bytes'])
    expect(await world.ledger.find('acme', fake.id, COLLIDING_ID)).not.toBeNull()
    expect(await world.ledger.find('acme', google.id, COLLIDING_ID)).not.toBeNull()
    expect(await world.ledger.list('acme', fake.id)).toHaveLength(1)
  })

  it('disconnects one provider without touching the other', async () => {
    const world = bothProviders()
    const { fake, google } = await connectBoth(world, 'acme')

    await world.drives.disconnect(google.id, { tenantId: 'acme' })

    expect(await world.store.find('acme', google.id)).toBeNull()
    expect((await world.store.find('acme', fake.id))!.status).toBe('active')
    // The fake's grant was never revoked; only Google's was.
    expect(world.fake.calls['revoke']).toBeUndefined()
    expect(world.googleServer.requests.some((r) => r.url.includes('/revoke'))).toBe(true)
    await expect(world.drives.listItems(fake.id, { tenantId: 'acme' })).resolves.toBeDefined()
  })

  it('reports an unsupported capability per provider, not globally', async () => {
    const world = bothProviders()
    const { fake, google } = await connectBoth(world, 'acme')

    // The fake refuses uploads; Google accepts them.
    await expect(
      world.drives.upload(
        fake.id,
        { name: 'x.txt', contentType: 'text/plain', content: Readable.from([Buffer.from('x')]) },
        { tenantId: 'acme' },
      ),
    ).rejects.toMatchObject({ code: 'DRIVE_UNSUPPORTED' })
    await expect(
      world.drives.upload(
        google.id,
        { name: 'x.txt', contentType: 'text/plain', content: Readable.from([Buffer.from('x')]) },
        { tenantId: 'acme' },
      ),
    ).resolves.toBeDefined()
  })
})

describe('credentials stay bound to one connection', () => {
  it('refreshing one connection never touches another, in either provider', async () => {
    const world = bothProviders()
    const { fake, google } = await connectBoth(world, 'acme')
    const fakeBefore = (await world.store.find('acme', fake.id))!
    const googleBefore = (await world.store.find('acme', google.id))!

    world.advance(2 * 60 * 60_000)
    await world.drives.listItems(google.id, { tenantId: 'acme' })

    const fakeAfter = (await world.store.find('acme', fake.id))!
    const googleAfter = (await world.store.find('acme', google.id))!
    expect(googleAfter.secret).not.toBe(googleBefore.secret)
    expect(googleAfter.revision).toBeGreaterThan(googleBefore.revision)
    // Untouched: same sealed blob, same revision.
    expect(fakeAfter.secret).toBe(fakeBefore.secret)
    expect(fakeAfter.revision).toBe(fakeBefore.revision)
  })

  it('binds a sealed credential to its provider AND its connection', async () => {
    const world = bothProviders()
    const { fake, google } = await connectBoth(world, 'acme')
    const box = new DriveSecretBox(TEST_KEYS)
    const sealed = (await world.store.find('acme', google.id))!.secret
    const context = { tenantId: 'acme', connectionId: google.id, provider: 'google' }

    expect(() => box.open(sealed, context)).not.toThrow()
    // Lift the blob into the other provider's row, or the other connection's,
    // or another tenant's: each one fails the GCM tag rather than decrypting.
    expect(() => box.open(sealed, { ...context, provider: 'fake' })).toThrow(/DRIVE_SECRET_MALFORMED|authentication/)
    expect(() => box.open(sealed, { ...context, connectionId: fake.id })).toThrow(/DRIVE_SECRET_MALFORMED|authentication/)
    expect(() => box.open(sealed, { ...context, tenantId: 'globex' })).toThrow(/DRIVE_SECRET_MALFORMED|authentication/)
  })

  it('keeps two connections of the SAME provider independent', async () => {
    const world = bothProviders()
    const first = await connectBoth(world, 'acme')
    const second = await connectBoth(world, 'acme')
    const box = new DriveSecretBox(TEST_KEYS)
    const sealed = (await world.store.find('acme', second.google.id))!.secret

    // "Drive Finance" and "Drive HR" on the same Google account are two rows
    // with two independently sealed credentials.
    expect((await world.store.find('acme', first.google.id))!.secret).not.toBe(sealed)
    expect(() => box.open(sealed, { tenantId: 'acme', connectionId: first.google.id, provider: 'google' })).toThrow()
  })
})

describe('a notification never crosses a provider boundary', () => {
  it('matches only connections of the provider the route is mounted for', async () => {
    const world = bothProviders()
    const { fake, google } = await connectBoth(world, 'acme')
    const watch = await watchConnection(world.drives, google.id, {
      tenantId: 'acme',
      notificationUrl: 'https://app.test/hook',
    })
    await watchConnection(world.drives, fake.id, { tenantId: 'acme', notificationUrl: 'https://app.test/hook' })
    const connections = await world.store.list('acme')

    const outcome = await handleNotification(world.drives, world.googleServer.notificationFor(watch.id), {
      provider: 'google',
      connections,
    })

    expect(outcome.connections.map((c) => c.id)).toEqual([google.id])
    expect(outcome.connections.map((c) => c.id)).not.toContain(fake.id)
  })

  it('does not match a fake connection that happens to hold the SAME channel secret', async () => {
    const world = bothProviders()
    const { fake, google } = await connectBoth(world, 'acme')
    const watch = await watchConnection(world.drives, google.id, {
      tenantId: 'acme',
      notificationUrl: 'https://app.test/hook',
    })
    const googleSecret = (await world.store.find('acme', google.id))!.watch!.secret
    const fakeWatch = await watchConnection(world.drives, fake.id, {
      tenantId: 'acme',
      notificationUrl: 'https://app.test/hook',
    })
    // The collision a provider-blind lookup would fall for: both providers
    // authenticate with a secret WE generated, so give the other connection
    // the identical value and check that the provider filter, not luck, is
    // what keeps them apart.
    await world.store.update('acme', fake.id, { watch: { id: fakeWatch.id, secret: googleSecret } })
    const connections = await world.store.list('acme')

    const outcome = await handleNotification(world.drives, world.googleServer.notificationFor(watch.id), {
      provider: 'google',
      connections,
    })

    expect(outcome.connections.every((c) => c.provider === 'google')).toBe(true)
    expect(outcome.connections.map((c) => c.id)).toEqual([google.id])
  })

  it('cannot use a fake channel notification to trigger a Google sync', async () => {
    const world = bothProviders()
    const { fake } = await connectBoth(world, 'acme')
    const watch = await watchConnection(world.drives, fake.id, {
      tenantId: 'acme',
      notificationUrl: 'https://app.test/hook',
    })
    const connections = await world.store.list('acme')

    // Verification is the Google adapter's, and a fake channel header is not
    // an `X-Goog-Channel-Token`: this cannot even become a candidate lookup.
    await expect(
      handleNotification(world.drives, world.fake.notificationFor(watch.id), { provider: 'google', connections }),
    ).rejects.toMatchObject({ code: 'DRIVE_NOTIFICATION_INVALID' })
  })

  it('cannot use a Google notification to trigger a fake sync', async () => {
    const world = bothProviders()
    const { google } = await connectBoth(world, 'acme')
    const watch = await watchConnection(world.drives, google.id, {
      tenantId: 'acme',
      notificationUrl: 'https://app.test/hook',
    })
    const connections = await world.store.list('acme')

    await expect(
      handleNotification(world.drives, world.googleServer.notificationFor(watch.id), {
        provider: 'fake',
        connections,
      }),
    ).rejects.toMatchObject({ code: 'DRIVE_NOTIFICATION_INVALID' })
  })
})
