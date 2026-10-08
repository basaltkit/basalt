import { redactCredentials } from './assert-migrated.js'

/**
 * What a database failure means and the one command that fixes it.
 *
 * The errors a multi-tenant app actually meets on a bad morning do not talk
 * about the problem: `permission denied for schema public` arrives as a
 * driver error with an adapter stack trace and reads like an application bug;
 * `P3005 The database schema is not empty` points at a documentation page.
 * Each has a one-line answer — this maps the error to it.
 */
export interface DbErrorDiagnosis {
  code: 'DB_PERMISSION_DENIED' | 'DB_NOT_EMPTY_BASELINE' | 'DB_UNREACHABLE' | 'DB_NOT_MIGRATED'
  /** What went wrong, in plain words (credentials redacted). */
  cause: string
  /** The command or change that fixes it. */
  fix: string
}

export interface DescribeDbErrorOptions {
  /**
   * The connection URL in use, so a fix can name the database role
   * (`GRANT … TO <role>`). Only the user name is read; nothing is printed
   * from the URL otherwise.
   */
  url?: string
  /** The database role, when known without a URL (e.g. `SELECT current_user`). Wins over `url`. */
  role?: string
}

interface ErrorShape {
  code?: unknown
  errorCode?: unknown
  meta?: { code?: unknown; message?: unknown; database_error?: unknown } | null
  message?: unknown
  stderr?: unknown
  stdout?: unknown
  cause?: unknown
  errors?: unknown
}

/** Every code and message on the error, its `cause` chain and an AggregateError's members. */
function collect(error: unknown, codes: string[], texts: string[], depth = 0): void {
  if (error == null || depth > 4) return
  if (typeof error === 'string') {
    texts.push(error)
    return
  }
  if (typeof error !== 'object') return
  const e = error as ErrorShape
  for (const code of [e.code, e.errorCode, e.meta?.code]) {
    if (typeof code === 'string' || typeof code === 'number') codes.push(String(code))
  }
  for (const text of [e.message, e.meta?.message, e.meta?.database_error, e.stderr, e.stdout]) {
    if (typeof text === 'string' && text) texts.push(text)
  }
  collect(e.cause, codes, texts, depth + 1)
  if (Array.isArray(e.errors)) for (const item of e.errors) collect(item, codes, texts, depth + 1)
}

const quoteRole = (user: string): string =>
  /^[a-z_][a-z0-9_$]*$/.test(user) ? user : `"${user.replace(/"/g, '""')}"`

/** The database role (given, or from a connection URL), or a placeholder. */
function roleOf(options: DescribeDbErrorOptions): string {
  if (options.role) return quoteRole(options.role)
  if (!options.url) return '<app_role>'
  try {
    const user = decodeURIComponent(new URL(options.url).username)
    return user ? quoteRole(user) : '<app_role>'
  } catch {
    return '<app_role>'
  }
}

const UNREACHABLE_CODES = new Set(['P1001', 'P1002', 'ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ETIMEDOUT', 'EAI_AGAIN'])

/** First line of the message that carries the match, trimmed and redacted. */
function lineWith(texts: string[], pattern: RegExp): string | undefined {
  for (const text of texts) {
    for (const line of text.split('\n')) {
      if (pattern.test(line)) return redactCredentials(line.trim()).slice(0, 300)
    }
  }
  return undefined
}

/**
 * Maps a database error to its meaning and fix, or `undefined` when it is not
 * one of the failures below (the caller then shows the error as it is):
 *
 * | code | recognised from | fix |
 * | --- | --- | --- |
 * | `DB_PERMISSION_DENIED` | SQLSTATE `42501` (also inside Prisma `P2010`/`meta`), `P1010`, "permission denied for …" | the `GRANT` for the app role |
 * | `DB_NOT_EMPTY_BASELINE` | `P3005` | baseline with `prisma migrate resolve --applied` |
 * | `DB_UNREACHABLE` | `P1001`/`P1002`/`P1000`/`P1003`, `ECONNREFUSED`, `ENOTFOUND`, … | check the URL / start the database |
 * | `DB_NOT_MIGRATED` | `P2021`, SQLSTATE `42P01` / MySQL `1146` | run the migrations |
 *
 * Accepts anything: a Prisma error, a driver error, an `execFile` failure of
 * the Prisma CLI (its stderr is read), or a plain message string. Credentials
 * in a quoted message are redacted.
 */
export function describeDbError(error: unknown, options: DescribeDbErrorOptions = {}): DbErrorDiagnosis | undefined {
  const codes: string[] = []
  const texts: string[] = []
  collect(error, codes, texts)
  const all = texts.join('\n')
  const has = (code: string): boolean => codes.includes(code) || new RegExp(`\\b${code}\\b`).test(all)

  const denied = /permission denied for (schema|table|relation|sequence|database|function)\s+"?([^\s"]+)"?/i.exec(all)
  if (has('42501') || has('P1010') || denied || /was denied access on the database/i.test(all)) {
    const role = roleOf(options)
    const kind = denied?.[1]?.toLowerCase()
    const object = denied?.[2]
    let fix: string
    if (kind === 'schema' && object) {
      fix = `GRANT USAGE ON SCHEMA ${object} TO ${role};  -- plus CREATE ON SCHEMA ${object} for the role that runs migrations`
    } else if (kind === 'table' || kind === 'relation') {
      fix = `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role};  -- or the schema that holds ${object ?? 'it'}`
    } else if (kind === 'sequence') {
      fix = `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role};`
    } else {
      fix = `Grant ${role} the privileges it needs (e.g. GRANT USAGE ON SCHEMA public TO ${role};), as the database owner.`
    }
    return {
      code: 'DB_PERMISSION_DENIED',
      cause:
        (lineWith(texts, /permission denied|denied access/i) ?? 'The database refused the query: permission denied.') +
        ' — the role in the connection URL lacks a privilege (often lost when a schema was dropped and recreated).',
      fix: `${fix} Re-run your idempotent grants script after any reset or restore.`,
    }
  }

  if (has('P3005')) {
    return {
      code: 'DB_NOT_EMPTY_BASELINE',
      cause:
        'The database already has tables but no migration history (Prisma P3005): migrate deploy will not touch a non-empty schema it did not create.',
      fix:
        'Baseline it: `prisma migrate resolve --applied <migration_name>` for every migration already reflected in the schema, then `prisma migrate deploy`.',
    }
  }

  if (codes.some((code) => UNREACHABLE_CODES.has(code)) || has('P1001') || has('P1002') ||
      /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|Can't reach database server/.test(all)) {
    return {
      code: 'DB_UNREACHABLE',
      cause: lineWith(texts, /reach|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|EAI_AGAIN|timed out/i) ??
        'The database did not answer.',
      fix: 'Check DATABASE_URL (host, port) and that the database server is running and reachable from here.',
    }
  }
  if (has('P1000') || /authentication failed/i.test(all)) {
    return {
      code: 'DB_UNREACHABLE',
      cause: 'The database rejected the credentials (authentication failed).',
      fix: 'Check the user and password in DATABASE_URL.',
    }
  }
  if (has('P1003') || /database "?[^\s"]+"? does not exist/i.test(all)) {
    return {
      code: 'DB_UNREACHABLE',
      cause: lineWith(texts, /does not exist/i) ?? 'The database named in the URL does not exist.',
      fix: 'Check the database name in DATABASE_URL, or create it (`prisma migrate dev` creates it in development).',
    }
  }

  if (has('P2021') || codes.includes('42P01') || codes.includes('1146') ||
      /relation "?[^\s"]+"? does not exist|table [^\s]+ does not exist|no such table/i.test(all)) {
    return {
      code: 'DB_NOT_MIGRATED',
      cause: lineWith(texts, /does not exist|no such table/i) ?? 'A table the app needs does not exist.',
      fix:
        'Run the migrations: `prisma migrate deploy` for the central database, `pnpm basalt tenant:migrate` for tenant schemas/databases — or check that DATABASE_URL points at the database you meant.',
    }
  }
  return undefined
}
