import { join } from 'node:path'
import { processName, type Pm2Runtime } from './config.js'
import { DeployError, type DeployContext, type Finding } from './context.js'
import { envFile } from './env-step.js'
import { freePort, listeners } from './ports.js'

/**
 * The PM2 runtime. It only ever names `<app>-…` (C4) — there is no `all`.
 */

export interface Pm2Process {
  name: string
  pid: number
  cwd: string
  status: string
}

export async function pm2List(ctx: DeployContext): Promise<Pm2Process[] | undefined> {
  const result = await ctx.host.exec('pm2', ['jlist'])
  if (result.code !== 0) return undefined
  // pm2 may print a banner or an update notice before the JSON.
  const start = result.stdout.indexOf('[')
  if (start === -1) return []
  try {
    const raw = JSON.parse(result.stdout.slice(start)) as Array<{ name?: string; pid?: number; pm2_env?: { pm_cwd?: string; status?: string } }>
    return raw.map((p) => ({ name: String(p.name ?? ''), pid: Number(p.pid ?? 0), cwd: String(p.pm2_env?.pm_cwd ?? ''), status: String(p.pm2_env?.status ?? '') }))
  } catch {
    return []
  }
}

const PORT_FROM = 3000

const pm2Of = (ctx: DeployContext): Pm2Runtime => {
  if (ctx.config.runtime.kind !== 'pm2') throw new Error('not a pm2 runtime')
  return ctx.config.runtime
}

/** The port the app listens on: the compose upstream's, or PM2's (`auto` picks a free one). */
export async function resolvePort(ctx: DeployContext, values: Map<string, string>): Promise<number> {
  if (ctx.config.runtime.kind === 'compose') return ctx.config.runtime.upstream.port
  const runtime = pm2Of(ctx)
  if (typeof runtime.port === 'number') return runtime.port
  const current = Number(values.get('PORT'))
  if (Number.isInteger(current) && current > 0) return current
  return freePort(ctx.host, PORT_FROM, runtime.avoid)
}

/** `--env-file`, dotenv or `process.loadEnvFile` in the script: the app loads its environment itself. */
const LOADS_ENV = /--env-file|dotenv|loadEnvFile/

/**
 * With `loadEnv: false` the process gets NODE_ENV, PORT and HOST only, so the
 * app must read its environment itself. A script that shows no loader is
 * flagged — a warning, since the loader may live in the code.
 */
async function ownEnvFindings(ctx: DeployContext): Promise<Finding[]> {
  const runtime = pm2Of(ctx)
  if (runtime.loadEnv !== false) return []
  let scripts: Record<string, string> = {}
  try {
    scripts = (JSON.parse((await ctx.host.readFile(join(ctx.dir, 'package.json'))) ?? '{}') as { scripts?: Record<string, string> }).scripts ?? {}
  } catch {
    return [] // C9 reports an unreadable package.json
  }
  const command = scripts[runtime.script]
  if (command === undefined || LOADS_ENV.test(command)) return []
  return [{
    id: 'env', level: 'warning',
    message: `pm2({ loadEnv: false }): the "${runtime.script}" script (${command}) shows no .env loader, and pm2 starts the app with NODE_ENV, PORT and HOST only`,
    fix: `drop loadEnv: false (the runtime then gives the app ${ctx.config.env.file ?? '.env'}), or load it in the script: node --env-file-if-exists=.env …`,
  }]
}

export async function pm2Preflight(ctx: DeployContext, port: number): Promise<Finding[]> {
  const findings: Finding[] = []
  const name = processName(ctx.config)
  const processes = await pm2List(ctx)
  if (processes === undefined) {
    return [{ id: 'C9', level: 'error', message: 'pm2 is not available to this user', fix: 'npm i -g pm2 (as the app user), then pm2 startup' }]
  }
  const ours = processes.find((p) => p.name === name)
  findings.push(...await ownEnvFindings(ctx))
  // C3 — `pm2 restart` reuses the directory the process was started in. One
  // started from an old clone kept running old code after every deploy.
  if (ours && ours.cwd !== ctx.dir) {
    findings.push({ id: 'C3', level: 'warning', message: `${name} runs from ${ours.cwd}, not ${ctx.dir}: it will be re-created here, not restarted` })
  }
  // C1 — the port must be free or ours. "Ours" includes the process above
  // even from its old directory: it is about to be replaced.
  const ourDirs = new Set([ctx.dir, ...(ours ? [ours.cwd] : [])])
  for (const listener of (await listeners(ctx.host)).filter((l) => l.port === port)) {
    let foreign = listener.pids.length === 0
    for (const pid of listener.pids) {
      const cwd = await ctx.host.readlink(`/proc/${pid}/cwd`)
      if (cwd === undefined || !ourDirs.has(cwd)) foreign = true
    }
    if (foreign) {
      findings.push({
        id: 'C1',
        level: 'error',
        message: `port ${port} (PORT in .env) is already taken by a process that is not ${name} (on ${listener.address})`,
        fix: 'pick another: put "port": <n> in /etc/basalt/<app>.json, or remove PORT from .env to pick a free one',
      })
      break
    }
  }
  return findings
}

/**
 * The preload that gives the app its `env.file` (`pm2({ loadEnv })`, default on).
 *
 * pm2 records the environment it is given — in the daemon and, on `pm2 save`,
 * in `~/.pm2/dump.pm2` — so the values must never be in it. Only the file's
 * path is (`BASALT_ENV_FILE`), with this program in `NODE_OPTIONS`. Node runs
 * it before the app's first module, in every node process of the tree: it
 * acts only where pm2 set `pm_id`, which pm2 sets in the processes it manages
 * and not in its own CLI or daemon. There `process.loadEnvFile` fills in what
 * is not exported yet — NODE_ENV, PORT and HOST above still win, as with
 * `--env-file`. A file that cannot be read stops the app with one line, never
 * a boot without its secrets. (`--env-file` itself is not allowed in
 * NODE_OPTIONS, so a preload it is.)
 */
const PRELOAD_SOURCE = [
  'const file=process.env.BASALT_ENV_FILE;',
  'if(file&&process.env.pm_id!==undefined){',
  'try{process.loadEnvFile(file)}',
  'catch(error){process.stderr.write(`[basalt-deploy] env.file ${file} is not readable (${error?.code??error?.message})\\n`);process.exit(1)}',
  '}',
].join('')

/** `NODE_OPTIONS` splits on spaces: the program travels percent-encoded, as a data: URL. */
export const ENV_PRELOAD = `--import=data:text/javascript,${encodeURIComponent(PRELOAD_SOURCE)}`

/**
 * What the process is started with: a minimal environment, never the
 * operator's shell (a stray variable there would override the `.env` — dotenv
 * and `--env-file` never overwrite) and never the `.env`'s secrets (`pm2 save`
 * writes the process environment to `~/.pm2/dump.pm2`). The values reach the
 * app through {@link ENV_PRELOAD}: pm2 only ever holds the file's path. With
 * `loadEnv: false` the app reads its environment itself.
 */
export function processEnv(ctx: DeployContext, env: Map<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of ['NODE_ENV', 'PORT', 'HOST']) {
    const value = env.get(key)
    if (value !== undefined) out[key] = value
  }
  if (pm2Of(ctx).loadEnv !== false) {
    out['BASALT_ENV_FILE'] = envFile(ctx)
    // NODE_OPTIONS from the file would come too late for node itself: pass it on.
    const own = env.get('NODE_OPTIONS')?.trim()
    out['NODE_OPTIONS'] = own ? `${own} ${ENV_PRELOAD}` : ENV_PRELOAD
  }
  const pm2Home = ctx.host.env['PM2_HOME']
  if (pm2Home) out['PM2_HOME'] = pm2Home
  return out
}

/** Starts, restarts or re-creates the process; says which. */
export async function pm2Release(ctx: DeployContext, env: Map<string, string>): Promise<string> {
  const { host } = ctx
  const name = processName(ctx.config)
  const options = { cwd: ctx.dir, env: processEnv(ctx, env), inheritEnv: false }
  const ours = (await pm2List(ctx))?.find((p) => p.name === name)
  if (ours && ours.cwd !== ctx.dir) {
    host.out.info(`pm2 delete ${name} (it ran from ${ours.cwd})`)
    await must(ctx, ['delete', name], options)
  }
  let done: string
  if (ours && ours.cwd === ctx.dir) {
    await must(ctx, ['restart', name, '--update-env'], options)
    done = `${name} restarted`
  } else {
    await must(ctx, ['start', ctx.pm, '--name', name, '--cwd', ctx.dir, '--', 'run', pm2Of(ctx).script], options)
    done = ours ? `${name} re-created in ${ctx.dir}` : `${name} started`
  }
  await must(ctx, ['save'], options)
  return `${done} (${ctx.pm} run ${pm2Of(ctx).script}, port ${env.get('PORT') ?? '?'})`
}

async function must(ctx: DeployContext, args: string[], options: { cwd: string; env: Record<string, string>; inheritEnv: boolean }) {
  const result = await ctx.host.exec('pm2', args, options)
  if (result.code !== 0) throw new DeployError(`pm2 ${args.slice(0, 2).join(' ')} failed: ${result.stderr.trim() || result.stdout.trim()}`)
}
