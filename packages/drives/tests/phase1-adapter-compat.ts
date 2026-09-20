/**
 * A third-party adapter written against the **phase-1** contract, verbatim:
 * no `deltaIncludesExisting`, no `retryAfterFromBody`, no `accountIds`, no
 * `secrets`, a removal that carries a required `externalId`, and a `refresh`
 * whose input it only reads `refreshToken` from.
 *
 * This file is type-checked, never run. It is the compile-time half of "an
 * adapter written against phase 1 still works"; `phase1Behaviour` below is the
 * behavioural half, asserted in `audit-phase2.test.ts`'s neighbours.
 */
import type {
  DriveAuthorization,
  DriveContent,
  DriveDelta,
  DriveItem,
  DriveListOptions,
  DriveNotificationInput,
  DriveNotificationResult,
  DrivePage,
  DriveProvider,
  DriveSession,
} from '../src/index.js'

const authorization: DriveAuthorization = {
  authorizeUrl: ({ redirectUri, state, codeChallenge }) =>
    `https://vendor.test/oauth?redirect_uri=${redirectUri}&state=${state}&cc=${codeChallenge}`,
  exchange: async () => ({ accessToken: 'a', refreshToken: 'r' }),
  // Phase 1 signature: reads only `refreshToken`, ignores anything added since.
  refresh: async ({ refreshToken }) => ({ accessToken: `a-${refreshToken}` }),
}

export const phase1Adapter: DriveProvider = {
  name: 'legacy',
  allowedHosts: ['api.vendor.test'],
  authorization,
  async list(_session: DriveSession, _options: DriveListOptions): Promise<DrivePage<DriveItem>> {
    return { items: [] }
  },
  async download(_session: DriveSession, _item: DriveItem): Promise<DriveContent> {
    throw new Error('unused')
  },
  async startDelta(): Promise<string> {
    return 'cursor-0'
  },
  async delta(_session: DriveSession, _cursor: string): Promise<DriveDelta> {
    // A phase-1 removal: `externalId` required and present. Still assignable to
    // the widened `{ externalId?, path? }` shape.
    return { changes: [{ type: 'removed', externalId: 'gone' }], cursor: 'cursor-1', hasMore: false }
  },
  verifyNotification(_input: DriveNotificationInput): DriveNotificationResult {
    // A phase-1 result: a secret we chose, and nothing else.
    return { secret: 'channel-secret', changed: true }
  },
}
