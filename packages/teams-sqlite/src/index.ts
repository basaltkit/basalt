import { DatabaseSync } from 'node:sqlite'
import type {
  Invitation,
  InvitationStore,
  Membership,
  MembershipStore,
  TeamRole,
} from '@machize/teams'

/**
 * Durable, SQLite-backed implementations of the `@machize/teams` stores
 * (memberships and invitations), on Node's built-in `node:sqlite` — zero
 * external dependencies. The single-node reference backend for teams; the
 * production (Postgres/MySQL) counterpart is `@machize/teams-prisma`.
 *
 * Requires Node 22.5+ (stable and flag-free on Node 24; `--experimental-sqlite`
 * on 22.x).
 */

type Bindable = null | number | bigint | string | Uint8Array
const orNull = <T extends Bindable>(v: T | undefined): T | null => (v === undefined ? null : v)

/** Open (or create) a teams database and apply the schema. `:memory:` for tests. */
export function openTeamsDatabase(location = ':memory:'): DatabaseSync {
  const db = new DatabaseSync(location)
  migrate(db)
  return db
}

/** Idempotent schema — safe to run on every open. */
export function migrate(db: DatabaseSync): void {
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS team_memberships (
      tenant_id  TEXT NOT NULL,
      user_id    TEXT NOT NULL,
      role       TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS team_invitations (
      id          TEXT PRIMARY KEY,
      tenant_id   TEXT NOT NULL,
      email       TEXT NOT NULL,
      role        TEXT NOT NULL,
      token       TEXT NOT NULL UNIQUE,
      invited_by  TEXT,
      expires_at  INTEGER NOT NULL,
      accepted_at INTEGER,
      revoked_at  INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_invitations_token ON team_invitations (token);
    CREATE INDEX IF NOT EXISTS idx_invitations_pending ON team_invitations (tenant_id, email);
  `)
}

// --- memberships ------------------------------------------------------------

interface MembershipRow {
  tenant_id: string
  user_id: string
  role: string
  created_at: number
}

const toMembership = (r: MembershipRow): Membership => ({
  tenantId: r.tenant_id,
  userId: r.user_id,
  role: r.role,
  createdAt: r.created_at,
})

export class SqliteMembershipStore implements MembershipStore {
  constructor(private readonly db: DatabaseSync) {}

  async add(membership: Membership): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO team_memberships (tenant_id, user_id, role, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(tenant_id, user_id) DO UPDATE SET role = excluded.role, created_at = excluded.created_at`,
      )
      .run(membership.tenantId, membership.userId, membership.role, membership.createdAt)
  }

  async find(tenantId: string, userId: string): Promise<Membership | null> {
    const row = this.db
      .prepare('SELECT * FROM team_memberships WHERE tenant_id = ? AND user_id = ?')
      .get(tenantId, userId) as MembershipRow | undefined
    return row ? toMembership(row) : null
  }

  async list(tenantId: string): Promise<Membership[]> {
    const rows = this.db
      .prepare('SELECT * FROM team_memberships WHERE tenant_id = ? ORDER BY created_at')
      .all(tenantId) as unknown as MembershipRow[]
    return rows.map(toMembership)
  }

  async setRole(tenantId: string, userId: string, role: TeamRole): Promise<void> {
    this.db
      .prepare('UPDATE team_memberships SET role = ? WHERE tenant_id = ? AND user_id = ?')
      .run(role, tenantId, userId)
  }

  async remove(tenantId: string, userId: string): Promise<void> {
    this.db.prepare('DELETE FROM team_memberships WHERE tenant_id = ? AND user_id = ?').run(tenantId, userId)
  }
}

// --- invitations ------------------------------------------------------------

interface InvitationRow {
  id: string
  tenant_id: string
  email: string
  role: string
  token: string
  invited_by: string | null
  expires_at: number
  accepted_at: number | null
  revoked_at: number | null
}

const toInvitation = (r: InvitationRow): Invitation => {
  const inv: Invitation = {
    id: r.id,
    tenantId: r.tenant_id,
    email: r.email,
    role: r.role,
    token: r.token,
    expiresAt: r.expires_at,
  }
  if (r.invited_by !== null) inv.invitedBy = r.invited_by
  if (r.accepted_at !== null) inv.acceptedAt = r.accepted_at
  if (r.revoked_at !== null) inv.revokedAt = r.revoked_at
  return inv
}

export class SqliteInvitationStore implements InvitationStore {
  constructor(private readonly db: DatabaseSync) {}

  async create(invitation: Invitation): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO team_invitations
           (id, tenant_id, email, role, token, invited_by, expires_at, accepted_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        invitation.id,
        invitation.tenantId,
        invitation.email,
        invitation.role,
        invitation.token,
        orNull(invitation.invitedBy),
        invitation.expiresAt,
        orNull(invitation.acceptedAt),
        orNull(invitation.revokedAt),
      )
  }

  async findByToken(token: string): Promise<Invitation | null> {
    const row = this.db
      .prepare('SELECT * FROM team_invitations WHERE token = ?')
      .get(token) as InvitationRow | undefined
    return row ? toInvitation(row) : null
  }

  async findById(id: string): Promise<Invitation | null> {
    const row = this.db
      .prepare('SELECT * FROM team_invitations WHERE id = ?')
      .get(id) as InvitationRow | undefined
    return row ? toInvitation(row) : null
  }

  async listPending(tenantId: string): Promise<Invitation[]> {
    const rows = this.db
      .prepare(
        'SELECT * FROM team_invitations WHERE tenant_id = ? AND accepted_at IS NULL AND revoked_at IS NULL ORDER BY expires_at',
      )
      .all(tenantId) as unknown as InvitationRow[]
    return rows.map(toInvitation)
  }

  async findPending(tenantId: string, email: string): Promise<Invitation | null> {
    const row = this.db
      .prepare(
        'SELECT * FROM team_invitations WHERE tenant_id = ? AND email = ? AND accepted_at IS NULL AND revoked_at IS NULL',
      )
      .get(tenantId, email) as InvitationRow | undefined
    return row ? toInvitation(row) : null
  }

  async markAccepted(id: string, at: number): Promise<void> {
    this.db.prepare('UPDATE team_invitations SET accepted_at = ? WHERE id = ?').run(at, id)
  }

  async revoke(id: string, at: number): Promise<void> {
    this.db.prepare('UPDATE team_invitations SET revoked_at = ? WHERE id = ?').run(at, id)
  }
}

// --- convenience ------------------------------------------------------------

export interface SqliteTeamsStores {
  db: DatabaseSync
  memberships: SqliteMembershipStore
  invitations: SqliteInvitationStore
}

/**
 * Open a database (or reuse a `DatabaseSync`) and return both team stores wired
 * to it, named to drop straight into `teamsPlugin`:
 *
 * ```ts
 * const t = sqliteTeamsStores('./data/teams.db')
 * teamsPlugin({ memberships: t.memberships, invitations: t.invitations })
 * ```
 */
export function sqliteTeamsStores(dbOrLocation: DatabaseSync | string = ':memory:'): SqliteTeamsStores {
  const db = typeof dbOrLocation === 'string' ? openTeamsDatabase(dbOrLocation) : dbOrLocation
  if (typeof dbOrLocation !== 'string') migrate(db)
  return {
    db,
    memberships: new SqliteMembershipStore(db),
    invitations: new SqliteInvitationStore(db),
  }
}
