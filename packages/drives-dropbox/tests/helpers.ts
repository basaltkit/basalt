import { Drives, type DriveConnectionView } from '@basaltkit/drives'
import { MemoryDriveConnectionStore, MemoryDriveImportLedger } from '@basaltkit/drives'
import { dropboxDrive, type DropboxDriveOptions } from '../src/index.js'
import { FakeDropbox, type FakeDropboxOptions } from './dropbox-server.js'

export const TEST_KEYS = [{ id: 'k1', key: 'k'.repeat(32) }]
export const TEST_SECRET = 'test-app-secret-value'
export const APP_KEY = 'app-key'
export const APP_SECRET = 'app-secret'

export interface Harness {
  drives: Drives
  dropbox: FakeDropbox
  provider: ReturnType<typeof dropboxDrive>
  store: MemoryDriveConnectionStore
  ledger: MemoryDriveImportLedger
  now(): number
  advance(ms: number): void
}

export function harness(
  options: { server?: FakeDropboxOptions; provider?: Partial<DropboxDriveOptions> } = {},
): Harness {
  let clock = Date.parse('2026-06-01T00:00:00Z')
  const now = (): number => clock
  const dropbox = new FakeDropbox({ appKey: APP_KEY, appSecret: APP_SECRET, ...options.server })
  const provider = dropboxDrive({
    clientId: APP_KEY,
    clientSecret: APP_SECRET,
    now,
    ...options.provider,
  })
  const store = new MemoryDriveConnectionStore()
  const ledger = new MemoryDriveImportLedger()
  const drives = new Drives({
    providers: [provider],
    keys: TEST_KEYS,
    secret: TEST_SECRET,
    store,
    ledger,
    now,
    transport: dropbox.transport,
    // Every real Dropbox host resolves to this public address in tests, so the
    // SSRF guard runs for real rather than being bypassed.
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    retry: { attempts: 3, sleep: async () => {}, random: () => 0 },
  })
  return {
    drives,
    dropbox,
    provider,
    store,
    ledger,
    now,
    advance(ms) {
      clock += ms
    },
  }
}

/** Runs the real OAuth code exchange against the fake and stores the connection. */
export async function connect(
  h: Harness,
  input: { tenantId?: string; label?: string; rootId?: string } = {},
): Promise<DriveConnectionView> {
  const start = h.drives.startAuthorization({
    provider: 'dropbox',
    redirectUri: 'https://app.test/drives/dropbox/callback',
    ...(input.tenantId !== undefined ? { tenantId: input.tenantId } : {}),
  })
  return h.drives.completeAuthorization({
    provider: 'dropbox',
    code: 'good-code',
    redirectUri: 'https://app.test/drives/dropbox/callback',
    state: start.state,
    binding: start.binding,
    label: input.label ?? 'Drive Finance',
    ...(input.tenantId !== undefined ? { tenantId: input.tenantId } : {}),
    ...(input.rootId !== undefined ? { rootId: input.rootId } : {}),
  })
}

export async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer))
  return Buffer.concat(chunks).toString('utf8')
}
