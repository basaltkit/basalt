import { Readable } from 'node:stream'
import { Drives, type DrivesOptions } from '../src/drives.js'
import type { Transport } from '../src/fetch.js'
import { FakeDriveProvider, type FakeDriveProviderOptions } from '../src/testing.js'
import { MemoryDriveConnectionStore, MemoryDriveImportLedger } from '../src/store.js'

/** No provider adapter in these tests reaches the network; this proves it. */
export const forbiddenTransport: Transport = () => {
  throw new Error('the guarded transport must not be reached in these tests')
}

export const TEST_KEYS = [{ id: 'k1', key: 'k'.repeat(32) }]
export const TEST_SECRET = 'test-app-secret-value'

export interface Harness {
  drives: Drives
  fake: FakeDriveProvider
  store: MemoryDriveConnectionStore
  ledger: MemoryDriveImportLedger
  /** Advances the harness clock. */
  advance(ms: number): void
  now(): number
}

export function harness(
  options: {
    provider?: FakeDriveProviderOptions
    drives?: Partial<DrivesOptions>
    tenancyActive?: boolean
  } = {},
): Harness {
  let clock = Date.parse('2026-06-01T00:00:00Z')
  const now = (): number => clock
  const fake = new FakeDriveProvider({ now, ...options.provider })
  const store = new MemoryDriveConnectionStore()
  const ledger = new MemoryDriveImportLedger()
  const drives = new Drives(
    {
      providers: [fake],
      keys: TEST_KEYS,
      secret: TEST_SECRET,
      store,
      ledger,
      now,
      transport: forbiddenTransport,
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      // Deterministic: no sleeping and no jitter in tests.
      retry: { attempts: 3, sleep: async () => {}, random: () => 0 },
      ...options.drives,
    },
    () => options.tenancyActive === true,
  )
  return {
    drives,
    fake,
    store,
    ledger,
    advance(ms) {
      clock += ms
    },
    now,
  }
}

/** Connects a tenant to the fake provider with valid tokens. */
export async function connect(h: Harness, input: { tenantId?: string; label?: string; rootId?: string } = {}) {
  const tokens = await h.fake.authorization.exchange({
    code: 'good',
    redirectUri: 'https://app.test/callback',
    codeVerifier: 'v',
    fetch: async () => {
      throw new Error('unused')
    },
  })
  return h.drives.connect({
    provider: 'fake',
    label: input.label ?? 'Drive Finance',
    tokens,
    ...(input.tenantId !== undefined ? { tenantId: input.tenantId } : {}),
    ...(input.rootId !== undefined ? { rootId: input.rootId } : {}),
  })
}

/** Collects a readable into a string. */
export async function readAll(stream: Readable): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer))
  return Buffer.concat(chunks).toString('utf8')
}

/** A sink that records what it was given. */
export function recordingSink() {
  const seen: { externalId: string; body: string | undefined; strategy: string; version: string }[] = []
  let counter = 0
  return {
    seen,
    sink: async (input: import('../src/import.js').DriveSinkInput) => {
      seen.push({
        externalId: input.item.externalId,
        body: input.content ? await readAll(input.content.stream) : undefined,
        strategy: input.strategy,
        version: input.version,
      })
      return { targetId: `target-${++counter}` }
    },
  }
}
