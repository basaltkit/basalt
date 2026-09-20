import {
  Drives,
  MemoryDriveConnectionStore,
  MemoryDriveImportLedger,
  type DriveConnectionView,
} from '@basaltkit/drives'
import { googleDrive, type GoogleDriveOptions } from '../src/index.js'
import { FakeGoogle, type FakeGoogleOptions } from './google-server.js'

export const TEST_KEYS = [{ id: 'k1', key: 'k'.repeat(32) }]
export const TEST_SECRET = 'test-app-secret-value'
export const CLIENT_ID = 'client-id'
export const CLIENT_SECRET = 'client-secret'
export const REDIRECT_URI = 'https://app.test/drives/google/callback'

export interface Harness {
  drives: Drives
  google: FakeGoogle
  provider: ReturnType<typeof googleDrive>
  store: MemoryDriveConnectionStore
  ledger: MemoryDriveImportLedger
  now(): number
  advance(ms: number): void
}

export function harness(
  options: { server?: FakeGoogleOptions; provider?: Partial<GoogleDriveOptions> } = {},
): Harness {
  let clock = Date.parse('2026-06-01T00:00:00Z')
  const now = (): number => clock
  const google = new FakeGoogle({ clientId: CLIENT_ID, ...options.server })
  const provider = googleDrive({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
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
    transport: google.transport,
    // Every Google host resolves to this public address in tests, so the SSRF
    // guard runs for real rather than being bypassed.
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    retry: { attempts: 3, sleep: async () => {}, random: () => 0 },
  })
  return {
    drives,
    google,
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
    provider: 'google',
    redirectUri: REDIRECT_URI,
    ...(input.tenantId !== undefined ? { tenantId: input.tenantId } : {}),
  })
  return h.drives.completeAuthorization({
    provider: 'google',
    code: 'good-code',
    redirectUri: REDIRECT_URI,
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
