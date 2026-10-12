import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { DeployContext, Finding } from './context.js'

/**
 * The `.env` against the app's own `defineEnv(...)` (RFC 0006 §6.2), before
 * anything is touched — a bad value is a diagnosis here, a crash loop after
 * the restart.
 *
 * It runs in a child process that sees ONLY the file's values (plus PATH and
 * HOME): the operator's shell must not mask a key the server will not have.
 * The child reports names, never values.
 */

const MARK = '@@basalt-deploy@@'

const PROBE = `
const mark = ${JSON.stringify(MARK)}
try {
  const m = await import(process.env.BASALT_DEPLOY_SCHEMA)
  const env = m.env ?? m.default
  const trueKeys = env && typeof env === 'object' ? Object.entries(env).filter(([, v]) => v === true).map(([k]) => k) : []
  console.log('\\n' + mark + JSON.stringify({ ok: true, trueKeys }))
} catch (error) {
  const report = Array.isArray(error?.report) ? error.report : [String(error?.message ?? error).split('\\n')[0]]
  console.log('\\n' + mark + JSON.stringify({ ok: false, name: String(error?.name ?? 'Error'), report }))
}
`

export interface SchemaResult {
  findings: Finding[]
  /** Keys whose parsed value is `true` (for C6). */
  trueKeys: string[]
}

export async function checkSchema(ctx: DeployContext, values: Map<string, string>): Promise<SchemaResult> {
  const schema = ctx.config.env.schema
  if (!schema) return { findings: [], trueKeys: [] }
  const { host } = ctx
  const useTsx = /\.[cm]?ts$/.test(schema) && await host.exists(join(ctx.dir, 'node_modules', 'tsx'))
  const args = [...(useTsx ? ['--import', 'tsx'] : []), '--input-type=module', '-e', PROBE]
  const result = await host.exec(process.execPath, args, {
    cwd: ctx.dir,
    inheritEnv: false,
    env: { ...Object.fromEntries(values), BASALT_DEPLOY_SCHEMA: pathToFileURL(join(ctx.dir, schema)).href },
  })
  const line = result.stdout.split('\n').find((l) => l.startsWith(MARK))
  if (!line) {
    return {
      trueKeys: [],
      findings: [{ id: 'env', level: 'error', message: `could not load ${schema} (exit ${result.code}): ${result.stderr.trim().split('\n').slice(-3).join(' / ')}` }],
    }
  }
  const parsed = JSON.parse(line.slice(MARK.length)) as { ok: true; trueKeys: string[] } | { ok: false; name: string; report: string[] }
  if (parsed.ok) return { findings: [], trueKeys: parsed.trueKeys }
  const fix = `set it in ${ctx.config.env.file ?? '.env'}, or in deploy.config.ts (fixed/ask/generate)`
  return {
    trueKeys: [],
    findings: parsed.report.map((issue): Finding => ({
      id: 'env',
      level: 'error',
      message: `${schema}: ${issue}`,
      ...(parsed.name === 'EnvValidationError' ? { fix } : {}),
    })),
  }
}

const FALSY = new Set(['0', 'false', 'no', 'off'])

/**
 * C6 — a value written to turn something OFF that the schema reads as ON.
 * `z.coerce.boolean()` is `Boolean(string)`: every non-empty string is true,
 * "0" and "false" included. `PAYCO_FAKE="0"` switched the fake payment
 * gateway on in production. Generic on purpose: it needs no list of boolean
 * keys, only the parsed result (prefixed names — `MY_APP_FLAG` for `FLAG` —
 * are matched too).
 */
export function coercionFindings(values: Map<string, string>, trueKeys: string[]): Finding[] {
  const findings: Finding[] = []
  for (const key of trueKeys) {
    for (const [raw, value] of values) {
      if ((raw === key || raw.endsWith(`_${key}`)) && FALSY.has(value.trim().toLowerCase())) {
        findings.push({
          id: 'C6',
          level: 'error',
          message: `${raw}="${value}" is read as TRUE by the app's schema (a coerced boolean treats every non-empty string as true)`,
          fix: `remove ${raw} from the file to turn it off, and use z.stringbool() in the schema`,
        })
      }
    }
  }
  return findings
}

/** C10 — forbidden keys absent, fixed keys equal. */
export function policyFindings(ctx: DeployContext, values: Map<string, string>): Finding[] {
  const findings: Finding[] = []
  for (const key of ctx.config.env.forbid ?? []) {
    if (values.has(key)) findings.push({ id: 'C10', level: 'error', message: `${key} must not exist in the production .env`, fix: `basalt-deploy env removes it` })
  }
  for (const [key, value] of Object.entries(ctx.config.env.fixed ?? {})) {
    if (values.get(key) !== value) findings.push({ id: 'C10', level: 'error', message: `${key} differs from deploy.config.ts`, fix: `basalt-deploy env corrects it` })
  }
  return findings
}
