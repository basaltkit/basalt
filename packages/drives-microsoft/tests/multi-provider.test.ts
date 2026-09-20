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
import { microsoftDrive } from '../src/index.js'
import { FakeGraph } from './graph-server.js'
import { CLIENT_ID, CLIENT_SECRET, REDIRECT_URI, TEST_KEYS, TEST_SECRET, readAll } from './helpers.js'

/**
 * Multi-provider coexistence, from the other side.
 *
 * Phase 2a closed this gap for Dropbox + the fake. Microsoft is the interesting
 * second case because it disagrees with the fake on the things a shared
 * registry would quietly merge: it **rotates** refresh tokens, it has **no
 * revocation at all**, and its notifications are authenticated by a secret we
 * chose rather than by an account id. If any of that leaked across a provider
 * boundary the failure would be silent — a connection marked invalid, a grant
 * left live, a tenant's drive synced by somebody else's webhook.
 *
 * The collisions are deliberate. Both providers are given an item whose
 * `externalId` is the same string and whose path is the same path, because "ids
 * are unique" is exactly the assumption a shared ledger would break.
 */

const COLLIDING_ID = '01SHARED'
const COLLIDING_PATH = '/invoice.pdf'

function bothProviders() {
  let clock = Date.parse('2026-06-01T00:00:00Z')
  const now = (): number => clock
  const graphServer = new FakeGraph({
    clientId: CLIENT_ID,
    pageSize: 10,
    files: [{ id: COLLIDING_ID, name: 'invoice.pdf', content: 'microsoft bytes' }],
  })
  const microsoft = microsoftDrive({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, now })
  const fake = new FakeDriveProvider({
    now,
    name: 'fake',
    accountId: 'fake-account',
    // Same id and same path as the Graph item, on purpose.
    files: [{ externalId: COLLIDING_ID, name: 'invoice.pdf', path: COLLIDING_PATH, content: 'fake bytes' }],
    supportsUpload: false,
  })
  const store = new MemoryDriveConnectionStore()
  const ledger = new MemoryDriveImportLedger()
  const drives = new Drives({
    providers: [fake, microsoft],
    keys: TEST_KEYS,
    secret: TEST_SECRET,
    store,
    ledger,
    now,
    transport: graphServer.transport,
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    retry: { attempts: 3, sleep: async () => {}, random: () => 0 },
  })
  return {
    drives,
    fake,
    microsoft,
    graphServer,
    store,
    ledger,
    now,
    advance: (ms: number) => {
      clock += ms
    },
  }
}

type World = ReturnType<typeof bothProviders>

async function connectBoth(
  world: World,
  tenantId: string,
): Promise<{ fake: DriveConnectionView; microsoft: DriveConnectionView }> {
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
    provider: 'microsoft',
    redirectUri: REDIRECT_URI,
    tenantId,
  })
  const microsoft = await world.drives.completeAuthorization({
    provider: 'microsoft',
    code: 'good-code',
    redirectUri: REDIRECT_URI,
    state: start.state,
    binding: start.binding,
    label: 'OneDrive Finance',
    tenantId,
  })
  return { fake, microsoft }
}

describe('two providers, one tenant', () => {
  it('registers both and keeps their connections side by side', async () => {
    const world = bothProviders()
    expect(world.drives.providerNames()).toEqual(['fake', 'microsoft'])
    const { fake, microsoft } = await connectBoth(world, 'acme')

    const all = await world.drives.list({ tenantId: 'acme' })
    expect(all.map((c) => c.provider).sort()).toEqual(['fake', 'microsoft'])
    expect(await world.drives.list({ tenantId: 'acme', provider: 'microsoft' })).toHaveLength(1)
    expect((await world.drives.list({ tenantId: 'acme', provider: 'fake' }))[0]!.id).toBe(fake.id)
    expect((await world.drives.get(microsoft.id, 'acme')).provider).toBe('microsoft')
  })

  it('routes every call to the connection’s own adapter, even when the ids collide', async () => {
    const world = bothProviders()
    const { fake, microsoft } = await connectBoth(world, 'acme')

    const item = { externalId: COLLIDING_ID, name: 'invoice.pdf', kind: 'file' as const }
    const fromFake = await world.drives.download(fake.id, item, { tenantId: 'acme' })
    const fromGraph = await world.drives.download(microsoft.id, item, { tenantId: 'acme' })

    // Same id, same path, two different files — because the connection, not the
    // id, decides which provider answers.
    expect(await readAll(fromFake.stream)).toBe('fake bytes')
    expect(await readAll(fromGraph.stream)).toBe('microsoft bytes')
    expect(world.graphServer.requests.some((r) => r.url.includes('graph.microsoft.com'))).toBe(true)
    expect(world.fake.calls['download']).toBe(1)
  })

  it('syncs each connection through its own change feed', async () => {
    const world = bothProviders()
    const { fake, microsoft } = await connectBoth(world, 'acme')
    const tasks: DriveImportTask[] = []
    const enqueue = async (task: DriveImportTask): Promise<void> => void tasks.push(task)

    await syncConnection(world.drives, fake.id, { tenantId: 'acme', enqueue })
    await syncConnection(world.drives, microsoft.id, { tenantId: 'acme', enqueue })

    expect(tasks.map((t) => t.provider).sort()).toEqual(['fake', 'microsoft'])
    expect(tasks.filter((t) => t.provider === 'fake')[0]!.connectionId).toBe(fake.id)
    expect(tasks.filter((t) => t.provider === 'microsoft')[0]!.connectionId).toBe(microsoft.id)
    // Two adapters, two cursor dialects, two rows — and neither cursor is a
    // shape the other could parse.
    expect((await world.store.find('acme', microsoft.id))!.cursor).toMatch(/^basalt\.msgraph\./)
    expect((await world.store.find('acme', fake.id))!.cursor).not.toMatch(/^basalt\.msgraph\./)
  })

  it('keeps the dedup ledger distinct for the same external id on two providers', async () => {
    const world = bothProviders()
    const { fake, microsoft } = await connectBoth(world, 'acme')
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
    const graphItem = (await world.drives.listItems(microsoft.id, { tenantId: 'acme' })).items[0]!
    expect(fakeItem.externalId).toBe(graphItem.externalId)

    const first = await importItem(world.drives, fake.id, fakeItem, sink, { tenantId: 'acme' })
    const second = await importItem(world.drives, microsoft.id, graphItem, sink, { tenantId: 'acme' })

    // The ledger is keyed by (tenant, CONNECTION, externalId). A tenant-scoped
    // key would have made the second import look like a duplicate of the first
    // and skipped a real file.
    expect(first.status).toBe('imported')
    expect(second.status).toBe('imported')
    expect(seen.map((s) => s.body)).toEqual(['fake bytes', 'microsoft bytes'])
    expect(await world.ledger.find('acme', fake.id, COLLIDING_ID)).not.toBeNull()
    expect(await world.ledger.find('acme', microsoft.id, COLLIDING_ID)).not.toBeNull()
    expect(await world.ledger.list('acme', fake.id)).toHaveLength(1)
  })

  it('does not treat two providers’ checksums as comparable', async () => {
    const world = bothProviders()
    const { fake, microsoft } = await connectBoth(world, 'acme')
    const fakeItem = (await world.drives.listItems(fake.id, { tenantId: 'acme' })).items[0]!
    const graphItem = (await world.drives.listItems(microsoft.id, { tenantId: 'acme' })).items[0]!

    // The fake publishes a SHA-256 of the bytes; Graph publishes whatever the
    // account type supports, labelled as itself. An app that compared them
    // across providers would conclude every file differs — which is exactly
    // why the contract carries the algorithm name and not just a digest.
    expect(fakeItem.checksum?.algorithm).toBe('sha256')
    expect(graphItem.checksum).toBeUndefined()
  })

  it('disconnects one provider without touching the other — and revokes only where revoking exists', async () => {
    const world = bothProviders()
    const { fake, microsoft } = await connectBoth(world, 'acme')

    await world.drives.disconnect(microsoft.id, { tenantId: 'acme' })

    expect(await world.store.find('acme', microsoft.id)).toBeNull()
    expect((await world.store.find('acme', fake.id))!.status).toBe('active')
    // The fake's grant was never revoked, and Microsoft's could not be: Graph
    // has no per-application revoke endpoint at all, so `disconnect` reports
    // `revoked: false` and the grant may still be live in the user's account.
    expect(world.fake.calls['revoke']).toBeUndefined()
    expect(world.graphServer.requests.some((r) => /revoke/i.test(r.url))).toBe(false)
    await expect(world.drives.listItems(fake.id, { tenantId: 'acme' })).resolves.toBeDefined()

    // …whereas the fake, which does have one, is asked.
    await world.drives.disconnect(fake.id, { tenantId: 'acme' })
    expect(world.fake.calls['revoke']).toBe(1)
  })

  it('reports an unsupported capability per provider, not globally', async () => {
    const world = bothProviders()
    const { fake, microsoft } = await connectBoth(world, 'acme')

    // The fake refuses uploads; Microsoft accepts small ones.
    await expect(
      world.drives.upload(
        fake.id,
        { name: 'x.txt', contentType: 'text/plain', content: Readable.from([Buffer.from('x')]) },
        { tenantId: 'acme' },
      ),
    ).rejects.toMatchObject({ code: 'DRIVE_UNSUPPORTED' })
    await expect(
      world.drives.upload(
        microsoft.id,
        { name: 'x.txt', contentType: 'text/plain', content: Readable.from([Buffer.from('x')]) },
        { tenantId: 'acme' },
      ),
    ).resolves.toBeDefined()

    // Both support subscriptions, and they are registered independently.
    const fakeWatch = await watchConnection(world.drives, fake.id, {
      tenantId: 'acme',
      notificationUrl: 'https://app.test/hook',
    })
    const graphWatch = await watchConnection(world.drives, microsoft.id, {
      tenantId: 'acme',
      notificationUrl: 'https://app.test/hook',
    })
    expect(fakeWatch.id).not.toBe(graphWatch.id)
    expect(world.graphServer.subscriptions.size).toBe(1)
  })
})

describe('credentials stay bound to one connection', () => {
  it('rotating Microsoft’s refresh token never touches the fake’s row', async () => {
    const world = bothProviders()
    const { fake, microsoft } = await connectBoth(world, 'acme')
    const fakeBefore = (await world.store.find('acme', fake.id))!
    const graphBefore = (await world.store.find('acme', microsoft.id))!

    world.advance(2 * 60 * 60_000)
    await world.drives.listItems(microsoft.id, { tenantId: 'acme' })

    const fakeAfter = (await world.store.find('acme', fake.id))!
    const graphAfter = (await world.store.find('acme', microsoft.id))!
    expect(graphAfter.secret).not.toBe(graphBefore.secret)
    expect(graphAfter.revision).toBeGreaterThan(graphBefore.revision)
    // Untouched: same sealed blob, same revision. A rotation that bled across
    // providers would leave the other connection holding a token its own
    // provider never issued.
    expect(fakeAfter.secret).toBe(fakeBefore.secret)
    expect(fakeAfter.revision).toBe(fakeBefore.revision)
  })

  it('binds a sealed credential to its provider AND its connection', async () => {
    const world = bothProviders()
    const { fake, microsoft } = await connectBoth(world, 'acme')
    const box = new DriveSecretBox(TEST_KEYS)
    const sealed = (await world.store.find('acme', microsoft.id))!.secret
    const context = { tenantId: 'acme', connectionId: microsoft.id, provider: 'microsoft' }

    expect(() => box.open(sealed, context)).not.toThrow()
    // Lift the blob into the other provider's row, or the other connection's,
    // or another tenant's: each one fails the GCM tag rather than decrypting.
    expect(() => box.open(sealed, { ...context, provider: 'fake' })).toThrow(/DRIVE_SECRET_MALFORMED|authentication/)
    expect(() => box.open(sealed, { ...context, connectionId: fake.id })).toThrow(
      /DRIVE_SECRET_MALFORMED|authentication/,
    )
    expect(() => box.open(sealed, { ...context, tenantId: 'globex' })).toThrow(/DRIVE_SECRET_MALFORMED|authentication/)
  })

  it('keeps two connections of the SAME provider independent', async () => {
    const world = bothProviders()
    const first = await connectBoth(world, 'acme')
    const second = await connectBoth(world, 'acme')
    const box = new DriveSecretBox(TEST_KEYS)
    const sealed = (await world.store.find('acme', second.microsoft.id))!.secret

    // "OneDrive Finance" and "OneDrive HR" on the same Microsoft account are
    // two rows with two independently sealed credentials.
    expect((await world.store.find('acme', first.microsoft.id))!.secret).not.toBe(sealed)
    expect(() =>
      box.open(sealed, { tenantId: 'acme', connectionId: first.microsoft.id, provider: 'microsoft' }),
    ).toThrow()
  })
})

describe('a notification never crosses a provider boundary', () => {
  it('matches only connections of the provider the route is mounted for', async () => {
    const world = bothProviders()
    const { fake, microsoft } = await connectBoth(world, 'acme')
    await watchConnection(world.drives, microsoft.id, {
      tenantId: 'acme',
      notificationUrl: 'https://app.test/hook',
    })
    const graphRow = (await world.store.find('acme', microsoft.id))!
    const connections = await world.store.list('acme')

    const outcome = await handleNotification(
      world.drives,
      {
        method: 'POST',
        headers: {},
        query: {},
        body: Buffer.from(
          JSON.stringify({
            value: [
              {
                subscriptionId: graphRow.watch!.id,
                clientState: graphRow.watch!.secret,
                changeType: 'updated',
                resource: 'me/drive/root',
              },
            ],
          }),
        ),
      },
      { provider: 'microsoft', connections },
    )

    expect(outcome.connections.map((c) => c.id)).toEqual([microsoft.id])
    expect(outcome.connections.map((c) => c.id)).not.toContain(fake.id)
  })

  it('does not match a fake connection that happens to carry the same channel secret', async () => {
    const world = bothProviders()
    const { microsoft } = await connectBoth(world, 'acme')
    await watchConnection(world.drives, microsoft.id, {
      tenantId: 'acme',
      notificationUrl: 'https://app.test/hook',
    })
    const graphRow = (await world.store.find('acme', microsoft.id))!
    // Give the fake connection Microsoft's clientState — the collision a
    // provider-blind lookup would fall for.
    const connections = (await world.store.list('acme')).map((c) =>
      c.provider === 'fake' ? { ...c, watch: { ...graphRow.watch! } } : c,
    )

    const outcome = await handleNotification(
      world.drives,
      {
        method: 'POST',
        headers: {},
        query: {},
        body: Buffer.from(
          JSON.stringify({
            value: [{ subscriptionId: graphRow.watch!.id, clientState: graphRow.watch!.secret, changeType: 'updated' }],
          }),
        ),
      },
      { provider: 'microsoft', connections },
    )

    expect(outcome.connections.every((c) => c.provider === 'microsoft')).toBe(true)
  })

  it('cannot use the fake’s account-keyed notification to trigger a Microsoft sync', async () => {
    const world = bothProviders()
    await connectBoth(world, 'acme')
    const connections = await world.store.list('acme')

    // Verification is the Microsoft adapter's, and a Dropbox-shaped
    // account-keyed body is not a Graph notification at all: it cannot even
    // become a candidate lookup.
    await expect(
      handleNotification(world.drives, world.fake.notificationForAccount(['fake-account']), {
        provider: 'microsoft',
        connections,
      }),
    ).rejects.toMatchObject({ code: 'DRIVE_NOTIFICATION_INVALID' })
  })
})
