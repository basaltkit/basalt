import { processName } from './config.js'
import { DeployError, type DeployContext, type Finding } from './context.js'
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

export async function resolvePort(ctx: DeployContext, values: Map<string, string>): Promise<number> {
  const runtime = ctx.config.runtime
  if (typeof runtime.port === 'number') return runtime.port
  const current = Number(values.get('PORT'))
  if (Number.isInteger(current) && current > 0) return current
  return freePort(ctx.host, PORT_FROM, runtime.avoid)
}

export async function pm2Preflight(ctx: DeployContext, port: number): Promise<Finding[]> {
  const findings: Finding[] = []
  const name = processName(ctx.config)
  const processes = await pm2List(ctx)
  if (processes === undefined) {
    return [{ id: 'C9', level: 'error', message: 'pm2 is not available to this user', fix: 'npm i -g pm2 (as the app user), then pm2 startup' }]
  }
  const ours = processes.find((p) => p.name === name)
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
 * What the process is started with: a minimal environment, never the
 * operator's shell (a stray variable there would override the `.env` — dotenv
 * and `--env-file` never overwrite) and never the `.env`'s secrets (`pm2 save`
 * writes the process environment to `~/.pm2/dump.pm2`). The app reads its own
 * `.env`, as it does in development; only what PM2 itself must know is passed.
 */
export function processEnv(host: DeployContext['host'], env: Map<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of ['NODE_ENV', 'PORT', 'HOST']) {
    const value = env.get(key)
    if (value !== undefined) out[key] = value
  }
  const pm2Home = host.env['PM2_HOME']
  if (pm2Home) out['PM2_HOME'] = pm2Home
  return out
}

/** Starts, restarts or re-creates the process. */
export async function pm2Release(ctx: DeployContext, env: Map<string, string>): Promise<void> {
  const { host } = ctx
  const name = processName(ctx.config)
  const options = { cwd: ctx.dir, env: processEnv(host, env), inheritEnv: false }
  const ours = (await pm2List(ctx))?.find((p) => p.name === name)
  if (ours && ours.cwd !== ctx.dir) {
    host.out.info(`pm2 delete ${name} (it ran from ${ours.cwd})`)
    await must(ctx, ['delete', name], options)
  }
  if (ours && ours.cwd === ctx.dir) {
    await must(ctx, ['restart', name, '--update-env'], options)
  } else {
    await must(ctx, ['start', ctx.pm, '--name', name, '--cwd', ctx.dir, '--', 'run', ctx.config.runtime.script], options)
  }
  await must(ctx, ['save'], options)
}

async function must(ctx: DeployContext, args: string[], options: { cwd: string; env: Record<string, string>; inheritEnv: boolean }) {
  const result = await ctx.host.exec('pm2', args, options)
  if (result.code !== 0) throw new DeployError(`pm2 ${args.slice(0, 2).join(' ')} failed: ${result.stderr.trim() || result.stdout.trim()}`)
}
