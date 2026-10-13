import { join } from 'node:path'
import { syslogRelease } from './audit.js'
import type { DeployContext } from './context.js'

/** One line per release in `<stateDir>/releases.json` (RFC 0006 §8). */
export interface Release {
  sha: string
  previous?: string
  at: string
  user: string
  /**
   * `aborted`: a signal stopped it before the release (code put back).
   * `failed-migration`: the migration step failed — the database may be
   * part-way; the restore command for `backup` was printed.
   * `rollback-unhealthy`: this commit was released by a rollback and did
   * not answer either — never a rollback target again.
   */
  status: 'ok' | 'rolled-back' | 'failed' | 'failed-migration' | 'public-unreachable' | 'aborted' | 'rollback-unhealthy'
  /** Migration directories this release applied for the first time. */
  migrations: string[]
  backup?: string
  note?: string
  /** Who ran it: `--actor`, `$BASALT_DEPLOY_ACTOR` or `$USER` (`user` is always the OS account). */
  actor?: string
  /** The SSH client address, when run over SSH. */
  client?: string
  /** `ssh`, `ci`, `terminal` or `batch`. */
  via?: string
}

const KEEP = 100

export const releasesFile = (ctx: DeployContext) => join(ctx.stateDir, 'releases.json')

/**
 * The history, from `<stateDir>/releases.json` — or, the first time after
 * `install` created `/var/lib/basalt/<app>`, from the checkout's
 * `.basalt/releases.json` it was kept in before (moved by the next record,
 * as the app user: root never copies a file the app user can point anywhere).
 */
export async function readReleases(ctx: DeployContext): Promise<Release[]> {
  const legacy = join(ctx.dir, '.basalt', 'releases.json')
  const text = (await ctx.host.readFile(releasesFile(ctx))) ?? (releasesFile(ctx) === legacy ? undefined : await ctx.host.readFile(legacy))
  if (!text) return []
  try {
    const parsed = JSON.parse(text) as unknown
    return Array.isArray(parsed) ? (parsed as Release[]) : []
  } catch {
    return []
  }
}

/** Appends a release (stamped with the command's audit fields) — under the deploy lock, so no write is lost. */
export async function recordRelease(ctx: DeployContext, release: Release): Promise<void> {
  const stamped: Release = { ...ctx.audit, ...release }
  const releases = [...(await readReleases(ctx)), stamped].slice(-KEEP)
  await ctx.host.mkdir(ctx.stateDir, 0o700)
  await ctx.host.writeFile(releasesFile(ctx), `${JSON.stringify(releases, null, 2)}\n`, 0o600)
  await syslogRelease(ctx, stamped)
}

/** Statuses that say the commit's code did not answer when released. */
const UNHEALTHY: ReadonlySet<Release['status']> = new Set(['rolled-back', 'rollback-unhealthy'])

/**
 * The last release that ended healthy, other than `sha` — and not a commit
 * that failed its health check AFTER that (a rollback onto it that did not
 * answer, or a redeploy of it that was rolled back).
 */
export function lastGood(releases: Release[], except: string): Release | undefined {
  const unhealthy = new Set<string>()
  for (const release of [...releases].reverse()) {
    if (UNHEALTHY.has(release.status)) { unhealthy.add(release.sha); continue }
    if (release.status === 'ok' && release.sha !== except && !unhealthy.has(release.sha)) return release
  }
  return undefined
}

/**
 * Written by a manual rollback: the commit it left. A scheduled `run` would
 * otherwise fetch and redeploy it at once; it refuses that commit until the
 * branch moves on, or `--unhold`.
 */
export interface Hold {
  sha: string
  at: string
  actor: string
  note: string
}

export const holdFile = (ctx: DeployContext) => join(ctx.stateDir, 'hold.json')

export async function readHold(ctx: DeployContext): Promise<Hold | undefined> {
  const text = await ctx.host.readFile(holdFile(ctx))
  if (!text) return undefined
  try {
    const value = JSON.parse(text) as Partial<Hold>
    return typeof value.sha === 'string' ? { sha: value.sha, at: String(value.at ?? ''), actor: String(value.actor ?? ''), note: String(value.note ?? '') } : undefined
  } catch {
    return undefined
  }
}

export async function writeHold(ctx: DeployContext, hold: Hold): Promise<void> {
  await ctx.host.mkdir(ctx.stateDir, 0o700)
  await ctx.host.writeFile(holdFile(ctx), `${JSON.stringify(hold, null, 2)}\n`, 0o600)
}

export async function clearHold(ctx: DeployContext): Promise<void> {
  if (await ctx.host.exists(holdFile(ctx))) await ctx.host.remove(holdFile(ctx))
}

/** Migration directory names among changed paths (`…/migrations/<name>/migration.sql`). */
export function migrationNames(paths: string[]): string[] {
  const names = new Set<string>()
  for (const path of paths) {
    const match = /(?:^|\/)migrations\/([^/]+)\/[^/]+\.sql$/.exec(path)
    if (match) names.add(match[1] as string)
  }
  return [...names].sort()
}
