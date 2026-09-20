import { createHmac } from 'node:crypto'
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
import { dropboxDrive } from '../src/index.js'
import { FakeDropbox } from './dropbox-server.js'
import { APP_KEY, APP_SECRET, TEST_KEYS, TEST_SECRET, readAll } from './helpers.js'

/**
 * Multi-provider coexistence.
 *
 * Phase 1 is structurally multi-provider — `Drives` keeps a registry keyed by
 * name and every connection carries its `provider` — but every phase-1 test
 * registered a single adapter, so the property was guaranteed by the shape of
 * the code rather than by anything executable. With two *real* implementations
 * in the tree (the fake and Dropbox) that gap can be closed, and this suite
 * closes it: the same tenant holds connections to both at once, and nothing
 * one provider does reaches the other.
 *
 * The collisions are deliberate. Both providers are given an item whose
 * `externalId` is the same string and whose path is the same path, because
 * "ids are unique" is exactly the assumption a shared ledger or a shared
 * registry would quietly break.
 */

const COLLIDING_ID = 'id:shared'
const COLLIDING_PATH = '/Finance/invoice.pdf'
const DROPBOX_ACCOUNT = 'dbid:AAH-ACME'

function bothProviders() {
  let clock = Date.parse('2026-06-01T00:00:00Z')
  const now = (): number => clock
  const dropboxServer = new FakeDropbox({
    appKey: APP_KEY,
    appSecret: APP_SECRET,
    pageSize: 10,
    files: [{ id: COLLIDING_ID, path: COLLIDING_PATH, content: 'dropbox bytes' }],
  })
  const dropbox = dropboxDrive({ clientId: APP_KEY, clientSecret: APP_SECRET, now })
  const fake = new FakeDriveProvider({
    now,
    name: 'fake',
    accountId: 'fake-account',
    // Same id and same path as the Dropbox file, on purpose.
    files: [{ externalId: COLLIDING_ID, name: 'invoice.pdf', path: COLLIDING_PATH, content: 'fake bytes' }],
  })
  const store = new MemoryDriveConnectionStore()
  const ledger = new MemoryDriveImportLedger()
  const drives = new Drives({
    providers: [fake, dropbox],
    keys: TEST_KEYS,
    secret: TEST_SECRET,
    store,
    ledger,
    now,
    transport: dropboxServer.transport,
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    retry: { attempts: 3, sleep: async () => {}, random: () => 0 },
  })
  return {
    drives,
    fake,
    dropbox,
    dropboxServer,
    store,
    ledger,
    now,
    advance: (ms: number) => {
      clock += ms
    },
  }
}

type World = ReturnType<typeof bothProviders>

async function connectBoth(world: World, tenantId: string): Promise<{ fake: DriveConnectionView; dropbox: DriveConnectionView }> {
  const fakeTokens = await world.fake.authorization.exchange({
    code: 'good',
    redirectUri: 'https://app.test/cb',
    codeVerifier: 'v',
    fetch: async () => {
      throw new Error('unused')
    },
  })
  const fake = await world.drives.connect({ provider: 'fake', label: 'Fake Drive', tokens: fakeTokens, tenantId })

  const start = world.drives.startAuthorization({
    provider: 'dropbox',
    redirectUri: 'https://app.test/drives/dropbox/callback',
    tenantId,
  })
  const dropbox = await world.drives.completeAuthorization({
    provider: 'dropbox',
    code: 'good-code',
    redirectUri: 'https://app.test/drives/dropbox/callback',
    state: start.state,
    binding: start.binding,
    label: 'Dropbox Finance',
    tenantId,
  })
  return { fake, dropbox }
}

describe('two providers, one tenant', () => {
  it('registers both and keeps their connections side by side', async () => {
    const world = bothProviders()
    expect(world.drives.providerNames()).toEqual(['fake', 'dropbox'])
    const { fake, dropbox } = await connectBoth(world, 'acme')

    const all = await world.drives.list({ tenantId: 'acme' })
    expect(all.map((c) => c.provider).sort()).toEqual(['dropbox', 'fake'])
    expect(await world.drives.list({ tenantId: 'acme', provider: 'dropbox' })).toHaveLength(1)
    expect((await world.drives.list({ tenantId: 'acme', provider: 'fake' }))[0]!.id).toBe(fake.id)
    expect((await world.drives.get(dropbox.id, 'acme')).provider).toBe('dropbox')
  })

  it('routes every call to the connection’s own adapter, even when the ids collide', async () => {
    const world = bothProviders()
    const { fake, dropbox } = await connectBoth(world, 'acme')

    const item = { externalId: COLLIDING_ID, name: 'invoice.pdf', kind: 'file' as const }
    const fromFake = await world.drives.download(fake.id, item, { tenantId: 'acme' })
    const fromDropbox = await world.drives.download(dropbox.id, item, { tenantId: 'acme' })

    // Same id, same path, two different files — because the connection, not the
    // id, decides which provider answers.
    expect(await readAll(fromFake.stream)).toBe('fake bytes')
    expect(await readAll(fromDropbox.stream)).toBe('dropbox bytes')
    // The fake never reaches the network; the Dropbox call did.
    expect(world.dropboxServer.requests.some((r) => r.url.includes('/files/download'))).toBe(true)
    expect(world.fake.calls['download']).toBe(1)
  })

  it('syncs each connection through its own change feed', async () => {
    const world = bothProviders()
    const { fake, dropbox } = await connectBoth(world, 'acme')
    const tasks: DriveImportTask[] = []
    const enqueue = async (task: DriveImportTask): Promise<void> => void tasks.push(task)

    await syncConnection(world.drives, fake.id, { tenantId: 'acme', enqueue })
    await syncConnection(world.drives, dropbox.id, { tenantId: 'acme', enqueue })

    expect(tasks.map((t) => t.provider).sort()).toEqual(['dropbox', 'fake'])
    expect(tasks.filter((t) => t.provider === 'fake')[0]!.connectionId).toBe(fake.id)
    expect(tasks.filter((t) => t.provider === 'dropbox')[0]!.connectionId).toBe(dropbox.id)
  })

  it('keeps the dedup ledger distinct for the same external id on two providers', async () => {
    const world = bothProviders()
    const { fake, dropbox } = await connectBoth(world, 'acme')
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
    const dropboxItem = (await world.drives.listItems(dropbox.id, { tenantId: 'acme' })).items[0]!
    expect(fakeItem.externalId).toBe(dropboxItem.externalId)

    const first = await importItem(world.drives, fake.id, fakeItem, sink, { tenantId: 'acme' })
    const second = await importItem(world.drives, dropbox.id, dropboxItem, sink, { tenantId: 'acme' })

    // The ledger is keyed by (tenant, CONNECTION, externalId). A tenant-scoped
    // key would have made the second import look like a duplicate of the first
    // and skipped a real file.
    expect(first.status).toBe('imported')
    expect(second.status).toBe('imported')
    expect(seen.map((s) => s.body)).toEqual(['fake bytes', 'dropbox bytes'])
    expect(await world.ledger.find('acme', fake.id, COLLIDING_ID)).not.toBeNull()
    expect(await world.ledger.find('acme', dropbox.id, COLLIDING_ID)).not.toBeNull()
    expect((await world.ledger.list('acme', fake.id))).toHaveLength(1)
  })

  it('disconnects one provider without touching the other', async () => {
    const world = bothProviders()
    const { fake, dropbox } = await connectBoth(world, 'acme')

    await world.drives.disconnect(dropbox.id, { tenantId: 'acme' })

    expect(await world.store.find('acme', dropbox.id)).toBeNull()
    expect((await world.store.find('acme', fake.id))!.status).toBe('active')
    // The fake's grant was never revoked; only Dropbox's was.
    expect(world.fake.calls['revoke']).toBeUndefined()
    expect(world.dropboxServer.requests.some((r) => r.url.includes('/token/revoke'))).toBe(true)
    await expect(world.drives.listItems(fake.id, { tenantId: 'acme' })).resolves.toBeDefined()
  })

  it('reports an unsupported capability per provider, not globally', async () => {
    const world = bothProviders()
    const { fake, dropbox } = await connectBoth(world, 'acme')

    // Dropbox has no per-connection subscription to register; the fake does.
    await expect(
      watchConnection(world.drives, dropbox.id, { tenantId: 'acme', notificationUrl: 'https://app.test/hook' }),
    ).rejects.toMatchObject({ code: 'DRIVE_UNSUPPORTED' });
    await expect(
      watchConnection(world.drives, fake.id, { tenantId: 'acme', notificationUrl: 'https://app.test/hook' }),
    ).resolves.toBeDefined()

    // And the other way round: the fake refuses uploads, Dropbox accepts them.
    const { Readable } = await import('node:stream')
    await expect(
      world.drives.upload(
        fake.id,
        { name: 'x.txt', contentType: 'text/plain', content: Readable.from([Buffer.from('x')]) },
        { tenantId: 'acme' },
      ),
    ).rejects.toMatchObject({ code: 'DRIVE_UNSUPPORTED' })
    await expect(
      world.drives.upload(
        dropbox.id,
        { name: 'x.txt', contentType: 'text/plain', content: Readable.from([Buffer.from('x')]) },
        { tenantId: 'acme' },
      ),
    ).resolves.toBeDefined()
  })
})

describe('credentials stay bound to one connection', () => {
  it('refreshing one connection never touches another, in either provider', async () => {
    const world = bothProviders()
    const { fake, dropbox } = await connectBoth(world, 'acme')
    const fakeBefore = (await world.store.find('acme', fake.id))!
    const dropboxBefore = (await world.store.find('acme', dropbox.id))!

    world.advance(4 * 60 * 60_000)
    await world.drives.listItems(dropbox.id, { tenantId: 'acme' })

    const fakeAfter = (await world.store.find('acme', fake.id))!
    const dropboxAfter = (await world.store.find('acme', dropbox.id))!
    expect(dropboxAfter.secret).not.toBe(dropboxBefore.secret)
    expect(dropboxAfter.revision).toBeGreaterThan(dropboxBefore.revision)
    // Untouched: same sealed blob, same revision.
    expect(fakeAfter.secret).toBe(fakeBefore.secret)
    expect(fakeAfter.revision).toBe(fakeBefore.revision)
  })

  it('binds a sealed credential to its provider AND its connection', async () => {
    const world = bothProviders()
    const { fake, dropbox } = await connectBoth(world, 'acme')
    const box = new DriveSecretBox(TEST_KEYS)
    const sealed = (await world.store.find('acme', dropbox.id))!.secret
    const context = { tenantId: 'acme', connectionId: dropbox.id, provider: 'dropbox' }

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
    const sealed = (await world.store.find('acme', second.dropbox.id))!.secret

    // "Drive Finance" and "Drive HR" on the same Dropbox account are two rows
    // with two independently sealed credentials.
    expect((await world.store.find('acme', first.dropbox.id))!.secret).not.toBe(sealed)
    expect(() =>
      box.open(sealed, { tenantId: 'acme', connectionId: first.dropbox.id, provider: 'dropbox' }),
    ).toThrow()
  })
})

describe('a notification never crosses a provider boundary', () => {
  function dropboxNotification(accounts: readonly string[]): Parameters<typeof handleNotification>[1] {
    const body = Buffer.from(JSON.stringify({ list_folder: { accounts }, delta: { users: [1] } }))
    return {
      method: 'POST',
      headers: { 'x-dropbox-signature': createHmac('sha256', APP_SECRET).update(body).digest('hex') },
      query: {},
      body,
    }
  }

  it('matches only connections of the provider the route is mounted for', async () => {
    const world = bothProviders()
    const { fake, dropbox } = await connectBoth(world, 'acme')
    const connections = await world.store.list('acme')

    const outcome = await handleNotification(world.drives, dropboxNotification([DROPBOX_ACCOUNT]), {
      provider: 'dropbox',
      connections,
    })

    expect(outcome.connections.map((c) => c.id)).toEqual([dropbox.id])
    expect(outcome.connections.map((c) => c.id)).not.toContain(fake.id)
  })

  it('does not match a fake connection that happens to carry the same account id', async () => {
    const world = bothProviders()
    await connectBoth(world, 'acme')
    // Give the fake connection Dropbox's account id — the collision a
    // provider-blind lookup would fall for.
    const connections = (await world.store.list('acme')).map((c) =>
      c.provider === 'fake' ? { ...c, account: { id: DROPBOX_ACCOUNT } } : c,
    )

    const outcome = await handleNotification(world.drives, dropboxNotification([DROPBOX_ACCOUNT]), {
      provider: 'dropbox',
      connections,
    })

    expect(outcome.connections.every((c) => c.provider === 'dropbox')).toBe(true)
  })

  it('cannot use a fake channel secret to trigger a Dropbox sync', async () => {
    const world = bothProviders()
    const { fake } = await connectBoth(world, 'acme')
    const watch = await watchConnection(world.drives, fake.id, {
      tenantId: 'acme',
      notificationUrl: 'https://app.test/hook',
    })
    const connections = await world.store.list('acme')

    // Verification is the Dropbox adapter's, and it has no idea what a fake
    // channel token is: this cannot even become a candidate lookup.
    await expect(
      handleNotification(world.drives, world.fake.notificationFor(watch.id), {
        provider: 'dropbox',
        connections,
      }),
    ).rejects.toMatchObject({ code: 'DRIVE_NOTIFICATION_INVALID' })
  })
})
