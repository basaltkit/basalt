import { METADATA } from '@basaltkit/core'
// The zod-free subpath: `basalt routes` must not pull the HTTP runtime in.
import { describeRoutes, findUnguardedRoutes, type RouteRequirement, type RouteRow } from '@basaltkit/http/route-table'
import { defineCommand, type CommandDefinition } from './command.js'
import { devCommand } from './dev.js'
import { upgradeCommand } from './upgrade.js'
import { publishCommand } from './publish.js'

/** Route entries written by HTTP adapters into the 'http:routes' bucket. */
export interface RouteMetadata {
  method: string
  url: string
  /** The route's declared `meta` (guards, rate limit, tenancy…). */
  meta?: Record<string, unknown> | undefined
  [key: string]: unknown
}

/** Schedule entries written by the scheduler into the 'schedule:entries' bucket. */
export interface ScheduleMetadata {
  name: string
  cron: string
  timezone: string
}

const REQUIREMENTS: readonly RouteRequirement[] = ['auth', 'can']

/** What `--unguarded` cannot see — printed with its result and repeated in the docs. */
export const UNGUARDED_SCOPE_NOTE =
  'Checks route meta only: an app-wide rate limit, URL-based tenancy (tenancyPlugin `required.except`), ' +
  'app hooks/middleware and edge routes (health, metrics, openapi) are invisible to it.'

/**
 * Compiles an `--allow` pattern. `*` matches within one path segment, `**`
 * across segments. A pattern with a space (`'POST /webhooks/*'`) also matches
 * the method; one without matches the URL on any method.
 */
export function routeAllowPattern(pattern: string): (row: Pick<RouteRow, 'method' | 'url'>) => boolean {
  const trimmed = pattern.trim()
  const space = trimmed.indexOf(' ')
  const method = space === -1 ? undefined : trimmed.slice(0, space).toUpperCase()
  const glob = space === -1 ? trimmed : trimmed.slice(space + 1).trim()
  const source = glob
    .split('**')
    .map((part) =>
      part
        .split('*')
        .map((literal) => literal.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('[^/]*'),
    )
    .join('.*')
  const regex = new RegExp(`^${source}$`)
  return (row) => (method === undefined || row.method === method) && regex.test(row.url)
}

const cell = (value: unknown): string => {
  if (value === null) return ''
  if (Array.isArray(value)) return value.join(', ')
  return String(value)
}

/** Table rows for `basalt routes`: one column per guard, blank when undeclared. */
function tableRows(rows: readonly RouteRow[]): Record<string, string>[] {
  return rows.map((row) => ({
    method: row.method,
    url: row.url,
    auth: cell(row.auth),
    can: cell(row.can),
    rateLimit: cell(row.rateLimit),
    tenant: cell(row.tenant),
    guards: cell(row.guards),
  }))
}

/**
 * `basalt routes [--json] [--unguarded --require=auth,can [--allow=<glob,...>]]`
 *
 * Lists the HTTP routes the app registered with the guards each declares in
 * `meta` (auth, can, rateLimit, tenant, and the other guarded keys). `--json`
 * prints the {@link RouteRow} array for CI and scripts. `--unguarded` lists
 * the routes that do not declare the `--require`d guards and exits 1 when
 * there is any — route META only (see {@link UNGUARDED_SCOPE_NOTE}).
 */
export const routesCommand = defineCommand({
  name: 'routes',
  description: 'List HTTP routes with their declared guards (--json, --unguarded --require=auth,can)',
  handle({ container, io, flags }) {
    const routes = container.has(METADATA)
      ? container.get(METADATA).get<RouteMetadata>('http:routes')
      : []
    const rows = describeRoutes(routes)
    const json = flags['json'] === true

    if (flags['unguarded'] === true) {
      const required = typeof flags['require'] === 'string' ? flags['require'].split(',').map((r) => r.trim()).filter(Boolean) : []
      const unknown = required.filter((r) => !REQUIREMENTS.includes(r as RouteRequirement))
      if (required.length === 0 || unknown.length > 0) {
        io.error(
          unknown.length > 0
            ? `Unknown --require value(s): ${unknown.join(', ')}. Use auth and/or can.`
            : '--unguarded needs an explicit --require=auth,can (or just auth / can).',
        )
        return 2
      }
      const patterns = typeof flags['allow'] === 'string' ? flags['allow'].split(',').filter((p) => p.trim()).map(routeAllowPattern) : []
      const offenders = findUnguardedRoutes(rows, {
        require: required as RouteRequirement[],
        allow: (row) => patterns.some((matches) => matches(row)),
      })
      if (json) {
        io.log(JSON.stringify(offenders.map(({ row, missing }) => ({ ...row, missing }))))
      } else if (offenders.length === 0) {
        io.log(`All ${rows.length} route(s) declare ${required.join(' + ')} (or opt out explicitly).`)
        io.log(UNGUARDED_SCOPE_NOTE)
      } else {
        io.error(`${offenders.length} route(s) do not declare ${required.join(' + ')}:`)
        io.table(offenders.map(({ row, missing }) => ({ method: row.method, url: row.url, missing: missing.join(', ') })))
        io.log(UNGUARDED_SCOPE_NOTE)
      }
      return offenders.length > 0 ? 1 : 0
    }

    if (json) {
      io.log(JSON.stringify(rows))
      return
    }
    if (rows.length === 0) {
      io.log('No routes registered.')
      return
    }
    io.table(tableRows(rows))
  },
})

export const scheduleListCommand = defineCommand({
  name: 'schedule:list',
  description: 'List scheduled tasks and their cron expressions',
  handle({ container, io }) {
    const entries = container.has(METADATA)
      ? container.get(METADATA).get<ScheduleMetadata>('schedule:entries')
      : []
    if (entries.length === 0) {
      io.log('No scheduled tasks.')
      return
    }
    io.table(entries.map(({ name, cron, timezone }) => ({ name, cron, timezone })))
  },
})

export function builtinCommands(): CommandDefinition[] {
  return [routesCommand, scheduleListCommand, devCommand, upgradeCommand, publishCommand]
}
