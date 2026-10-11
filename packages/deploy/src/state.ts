import { join } from 'node:path'
import type { DeployContext } from './context.js'

/** One line per release in `<stateDir>/releases.json` (RFC 0006 §8). */
export interface Release {
  sha: string
  previous?: string
  at: string
  user: string
  status: 'ok' | 'rolled-back' | 'failed' | 'public-unreachable'
  /** Migration directories this release applied for the first time. */
  migrations: string[]
  backup?: string
  note?: string
}

const KEEP = 100

export const releasesFile = (ctx: DeployContext) => join(ctx.stateDir, 'releases.json')

export async function readReleases(ctx: DeployContext): Promise<Release[]> {
  const text = await ctx.host.readFile(releasesFile(ctx))
  if (!text) return []
  try {
    const parsed = JSON.parse(text) as unknown
    return Array.isArray(parsed) ? (parsed as Release[]) : []
  } catch {
    return []
  }
}

export async function recordRelease(ctx: DeployContext, release: Release): Promise<void> {
  const releases = [...(await readReleases(ctx)), release].slice(-KEEP)
  await ctx.host.mkdir(ctx.stateDir, 0o700)
  await ctx.host.writeFile(releasesFile(ctx), `${JSON.stringify(releases, null, 2)}\n`, 0o600)
}

/** The last release that ended healthy, other than `sha`. */
export function lastGood(releases: Release[], except: string): Release | undefined {
  return [...releases].reverse().find((r) => r.status === 'ok' && r.sha !== except)
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
