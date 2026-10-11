import { join } from 'node:path'
import { apacheInstall, apachePreflight, vhostPaths } from './apache.js'
import { backupDatabase, restoreCommand } from './backup.js'
import { tlsFindings, toolingFindings } from './checks.js'
import { processName } from './config.js'
import { DeployError, errors, report, type DeployContext, type Finding } from './context.js'
import { checkSchema, coercionFindings, policyFindings } from './env-check.js'
import { answerQuestions, describeEnv, planEnv, readEnv, syntaxFindings, writeEnv, type EnvPlan } from './env-step.js'
import { envValues } from './dotenv.js'
import { applyInfra, describeInfra, planInfra, type InfraPlan } from './infra.js'
import { pm2List, pm2Preflight, pm2Release, resolvePort } from './pm2.js'
import { lastGood, migrationNames, readReleases, recordRelease, type Release } from './state.js'

/**
 * The pipeline (RFC 0006 §4): preflight → fetch → env → infra → build →
 * validate → backup → migrate → release → proxy → health → record.
 *
 * Nothing that runs changes before `release`. A failure up to `migrate` puts
 * the code on disk back (a PM2 crash-restart must not pick up half a deploy);
 * a failure at `release`/`health` rolls the code back and restarts it.
 */

export type Skippable = 'fetch' | 'backup' | 'tls'
export const SKIPPABLE: readonly Skippable[] = ['fetch', 'backup', 'tls']

export interface RunOptions {
  skip?: Skippable[]
}

async function git(ctx: DeployContext, args: string[]): Promise<string> {
  const result = await ctx.host.exec('git', args, { cwd: ctx.dir })
  if (result.code !== 0) throw new DeployError(`git ${args[0]} failed: ${result.stderr.trim()}`)
  return result.stdout.trim()
}

async function step<T>(ctx: DeployContext, title: string, run: () => Promise<T>): Promise<T> {
  ctx.host.out.step(title)
  return run()
}

// ── preflight ──────────────────────────────────────────────────────────────

export interface Preflight {
  findings: Finding[]
  port: number
  values: Map<string, string>
}

export async function preflight(ctx: DeployContext, options: RunOptions = {}): Promise<Preflight> {
  const document = await readEnv(ctx)
  const values = envValues(document)
  const findings: Finding[] = [...syntaxFindings(document, ctx.config.env.file ?? '.env')]
  const port = await resolvePort(ctx, values)
  findings.push(...await toolingFindings(ctx))
  findings.push(...await pm2Preflight(ctx, port))
  if (ctx.config.proxy?.kind === 'apache') findings.push(...await apachePreflight(ctx, port))
  if (!options.skip?.includes('tls')) findings.push(...await tlsFindings(ctx))

  const dirty = await ctx.host.exec('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: ctx.dir })
  if (dirty.code !== 0) {
    findings.push({ id: 'git', level: 'error', message: `${ctx.dir} is not a git checkout` })
  } else {
    if (dirty.stdout.trim()) {
      findings.push({ id: 'git', level: 'error', message: `tracked files are modified on the server:\n${dirty.stdout.trimEnd().split('\n').map((l) => `        ${l}`).join('\n')}`, fix: 'git stash (or commit them where they belong); a deploy builds what is committed' })
    }
    const branch = (await ctx.host.exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: ctx.dir })).stdout.trim()
    const wanted = ctx.config.branch ?? 'main'
    if (branch !== wanted) findings.push({ id: 'git', level: 'error', message: `the checkout is on "${branch}", the deploy tracks "${wanted}"`, fix: `git checkout ${wanted}` })
  }
  return { findings, port, values }
}

function stopOnErrors(ctx: DeployContext, findings: Finding[], what: string): void {
  report(ctx.host, findings)
  const blocking = errors(findings)
  if (blocking.length > 0) throw new DeployError(`${what}: ${blocking.length} problem(s) above — nothing was changed`, blocking)
}

// ── the building blocks ────────────────────────────────────────────────────

async function prepareEnv(ctx: DeployContext, port: number): Promise<{ env: EnvPlan; infra: InfraPlan }> {
  const document = await readEnv(ctx)
  const infra = await planInfra(ctx, envValues(document))
  const env = planEnv(ctx, document, port, infra.env)
  return { env, infra }
}

async function build(ctx: DeployContext, values: Map<string, string>): Promise<void> {
  const { host, pm } = ctx
  const run = async (args: string[], options: { env?: Map<string, string>; unset?: string[] } = {}) => {
    host.out.info(`${pm} ${args.join(' ')}`)
    const result = await host.exec(pm, args, {
      cwd: ctx.dir, stream: true,
      ...(options.env ? { env: Object.fromEntries(options.env) } : {}),
      ...(options.unset ? { unset: options.unset } : {}),
    })
    if (result.code !== 0) throw new DeployError(`${pm} ${args.join(' ')} failed (exit ${result.code})`)
  }
  // NODE_ENV unset: the build needs devDependencies (tsc, prisma, vite).
  // Never a flag for it — they change between majors (pnpm 11 refused --prod=false).
  const frozen = pm === 'npm' ? ['ci'] : pm === 'yarn' ? ['install', '--immutable'] : ['install', '--frozen-lockfile']
  await run(frozen, { unset: ['NODE_ENV'] })
  for (const config of ctx.config.build?.prisma ?? []) await run(['exec', 'prisma', 'generate', '--config', config], { env: values })
  if (ctx.config.build?.web) await run(['--dir', ctx.config.build.web, 'run', 'build'], { env: values })
}

async function validate(ctx: DeployContext, values: Map<string, string>): Promise<Finding[]> {
  const schema = await checkSchema(ctx, values)
  return [...schema.findings, ...coercionFindings(values, schema.trueKeys), ...policyFindings(ctx, values)]
}

async function migrate(ctx: DeployContext, values: Map<string, string>): Promise<void> {
  const { host, pm } = ctx
  const env = { cwd: ctx.dir, stream: true, env: Object.fromEntries(values) }
  if (ctx.config.migrate?.central !== false) {
    host.out.info(`${pm} exec prisma migrate deploy`)
    const central = await host.exec(pm, ['exec', 'prisma', 'migrate', 'deploy'], env)
    if (central.code !== 0) throw new DeployError('prisma migrate deploy failed')
  }
  const tenants = ctx.config.migrate?.tenants
  if (tenants) {
    const args = Array.isArray(tenants) ? ['run', ...tenants] : ['run', 'basalt', ...(pm === 'npm' ? ['--'] : []), 'tenant:migrate']
    host.out.info(`${pm} ${args.join(' ')}`)
    const result = await host.exec(pm, args, env)
    if (result.code !== 0) throw new DeployError('the tenant migrations failed')
  }
}

async function healthy(ctx: DeployContext, port: number): Promise<boolean> {
  const { host, config } = ctx
  const path = config.health?.path ?? '/health'
  const deadline = host.now().getTime() + (config.health?.timeoutSeconds ?? 60) * 1000
  do {
    const answer = await host.httpGet(`http://127.0.0.1:${port}${path}`, { host: config.domain })
    if ('status' in answer && answer.status >= 200 && answer.status < 400) return true
    await host.sleep(2000)
  } while (host.now().getTime() < deadline)
  return false
}

async function publicHealthy(ctx: DeployContext): Promise<Finding | undefined> {
  const { config } = ctx
  if (config.health?.public === false || config.proxy?.kind !== 'apache') return undefined
  const url = `https://${config.domain}${config.proxy.apiPrefix.replace(/\/$/, '')}${config.health?.path ?? '/health'}`
  const answer = await ctx.host.httpGet(url, { timeoutMs: 10_000 })
  if ('status' in answer && answer.status >= 200 && answer.status < 400) return undefined
  return {
    id: 'health',
    level: 'error',
    message: `the app answers on 127.0.0.1 but not at ${url} (${'status' in answer ? `HTTP ${answer.status}` : answer.error}) — the proxy, DNS or TLS, not the code`,
    fix: 'the [C1]/[C2]/[vhost] findings above, then: apachectl -S',
  }
}

/** Puts the code on disk back to `sha` and rebuilds it. Does not restart anything. */
async function restoreCode(ctx: DeployContext, sha: string, values: Map<string, string>): Promise<void> {
  ctx.host.out.step(`restoring the code to ${sha.slice(0, 7)}`)
  await git(ctx, ['reset', '--hard', sha])
  await build(ctx, values)
}

// ── commands ───────────────────────────────────────────────────────────────

export async function plan(ctx: DeployContext, options: RunOptions = {}): Promise<number> {
  const checked = await step(ctx, 'preflight', () => preflight(ctx, options))
  report(ctx.host, checked.findings)
  const { env, infra } = await prepareEnv(ctx, checked.port)
  report(ctx.host, infra.findings)
  const { host, config, pm } = ctx
  host.out.step('plan — nothing below has run')
  const lines = [
    options.skip?.includes('fetch') ? 'fetch: skipped' : `fetch: git fetch ${config.remote ?? 'origin'} ${config.branch ?? 'main'} && git merge --ff-only`,
    ...describeEnv(env).map((l) => `env: ${l}`),
    ...describeInfra(infra).map((l) => `infra: ${l}`),
    `build: ${pm} install (frozen), ${(config.build?.prisma ?? []).map((c) => `prisma generate --config ${c}`).join(', ') || 'no prisma'}${config.build?.web ? `, ${config.build.web} build` : ''}`,
    `validate: ${config.env.schema ?? '(no schema configured)'} against the new .env`,
    options.skip?.includes('backup') || config.backup?.beforeMigrate === false ? 'backup: skipped' : `backup: pg_dump → ${config.backup?.dir ?? 'backups/predeploy'} (keep ${config.backup?.keep ?? 10})`,
    `migrate: ${config.migrate?.central === false ? '' : 'prisma migrate deploy'}${config.migrate?.tenants ? ' + tenant:migrate' : ''}`,
    `release: pm2 ${processName(config)} on 127.0.0.1:${checked.port}`,
    `health: http://127.0.0.1:${checked.port}${config.health?.path ?? '/health'} (Host: ${config.domain})${config.proxy?.kind === 'apache' && config.health?.public !== false ? `, then https://${config.domain}${config.proxy.apiPrefix}${config.health?.path ?? '/health'}` : ''}`,
  ]
  for (const line of lines) host.out.info(line)
  return errors([...checked.findings, ...infra.findings]).length > 0 ? 1 : 0
}

/** `basalt-deploy env` — the .env and the infra only (first setup, before `install`). */
export async function envCommand(ctx: DeployContext): Promise<number> {
  const document = await readEnv(ctx)
  stopOnErrors(ctx, syntaxFindings(document, ctx.config.env.file ?? '.env'), '.env')
  const port = await resolvePort(ctx, envValues(document))
  const { env, infra } = await step(ctx, 'env', () => prepareEnv(ctx, port))
  stopOnErrors(ctx, infra.findings, 'infra')
  const missing = await answerQuestions(ctx, env)
  if (missing.length > 0) throw new DeployError(`no answer for ${missing.join(', ')} (no terminal to ask): set them in the environment of this command`)
  for (const line of describeEnv(env)) ctx.host.out.info(line)
  await writeEnv(ctx, env)
  await step(ctx, 'infra', async () => stopOnErrors(ctx, await applyInfra(ctx, infra), 'infra'))
  await step(ctx, 'validate', async () => stopOnErrors(ctx, await validate(ctx, env.values), 'validate'))
  ctx.host.out.ok(`.env ready (PORT=${port})`)
  return 0
}

export async function run(ctx: DeployContext, options: RunOptions = {}): Promise<number> {
  const { host, config } = ctx
  const skip = new Set(options.skip ?? [])

  const checked = await step(ctx, 'preflight', () => preflight(ctx, options))
  stopOnErrors(ctx, checked.findings, 'preflight')
  const { port } = checked

  const previous = await git(ctx, ['rev-parse', 'HEAD'])
  if (!skip.has('fetch')) {
    await step(ctx, 'fetch', async () => {
      await git(ctx, ['fetch', '--quiet', config.remote ?? 'origin', config.branch ?? 'main'])
      await git(ctx, ['merge', '--ff-only', `${config.remote ?? 'origin'}/${config.branch ?? 'main'}`])
    })
  }
  const sha = await git(ctx, ['rev-parse', 'HEAD'])
  host.out.info(sha === previous ? `already at ${sha.slice(0, 7)}` : `${previous.slice(0, 7)} → ${sha.slice(0, 7)}`)
  const applied = sha === previous ? [] : migrationNames((await git(ctx, ['diff', '--name-only', previous, sha])).split('\n'))
  const release: Release = { sha, previous, at: host.now().toISOString(), user: host.env['USER'] ?? String(host.uid()), status: 'failed', migrations: applied }

  // From here a failure puts the code on disk back before it is reported.
  let values = checked.values
  let infra: InfraPlan = { services: [], env: [], findings: [], secrets: {} }
  try {
    const prepared = await step(ctx, 'env', () => prepareEnv(ctx, port))
    infra = prepared.infra
    stopOnErrors(ctx, infra.findings, 'infra')
    const missing = await answerQuestions(ctx, prepared.env)
    if (missing.length > 0) throw new DeployError(`no answer for ${missing.join(', ')} (no terminal to ask): set them in the environment of this command`)
    for (const line of describeEnv(prepared.env)) host.out.info(line)
    await writeEnv(ctx, prepared.env)
    values = prepared.env.values

    await step(ctx, 'infra', async () => stopOnErrors(ctx, await applyInfra(ctx, infra), 'infra'))
    await step(ctx, 'build', () => build(ctx, values))
    await step(ctx, 'validate', async () => stopOnErrors(ctx, await validate(ctx, values), 'validate'))
    if (!skip.has('backup') && config.backup?.beforeMigrate !== false) {
      release.backup = await step(ctx, 'backup', () => backupDatabase(ctx, values, infra, sha))
      host.out.ok(release.backup)
    }
    await step(ctx, 'migrate', () => migrate(ctx, values))
  } catch (error) {
    if (sha !== previous) await restoreCode(ctx, previous, values).catch((e: unknown) => host.out.error(`could not restore the code: ${(e as Error).message}`))
    release.note = (error as Error).message
    await recordRelease(ctx, release).catch(() => undefined)
    throw error
  }

  const destructive = applied.filter((name) => config.destructive?.includes(name))
  const recover = async (why: string): Promise<number> => {
    host.out.error(why)
    if (destructive.length > 0 || sha === previous) {
      if (destructive.length > 0) host.out.error(`not rolled back automatically: ${destructive.join(', ')} ${destructive.length === 1 ? 'is' : 'are'} marked destructive`)
      if (release.backup) host.out.info(`database before this release: ${restoreCommand(ctx, infra, release.backup)}`)
      release.note = why
      await recordRelease(ctx, release)
      return 1
    }
    await rollbackTo(ctx, previous, values, port)
    release.status = 'rolled-back'
    release.note = why
    await recordRelease(ctx, release)
    return 1
  }

  try {
    await step(ctx, 'release', () => pm2Release(ctx, values))
  } catch (error) {
    return recover((error as Error).message)
  }
  const ok = await step(ctx, 'health', () => healthy(ctx, port))
  if (!ok) return recover(`the app does not answer on http://127.0.0.1:${port}${config.health?.path ?? '/health'}`)
  host.out.ok(`http://127.0.0.1:${port}${config.health?.path ?? '/health'}`)

  const publicProblem = await publicHealthy(ctx)
  release.status = publicProblem ? 'public-unreachable' : 'ok'
  await step(ctx, 'record', () => recordRelease(ctx, release))
  if (publicProblem) {
    report(host, [publicProblem])
    return 1
  }
  host.out.ok(`${config.app} ${sha.slice(0, 7)} is live at https://${config.domain}`)
  return 0
}

async function rollbackTo(ctx: DeployContext, sha: string, values: Map<string, string>, port: number): Promise<void> {
  await restoreCode(ctx, sha, values)
  ctx.host.out.step(`release ${sha.slice(0, 7)}`)
  await pm2Release(ctx, values)
  if (await healthy(ctx, port)) ctx.host.out.ok(`back on ${sha.slice(0, 7)}`)
  else ctx.host.out.error(`${sha.slice(0, 7)} does not answer either — pm2 logs ${processName(ctx.config)}`)
}

/** `basalt-deploy rollback [--to=<sha>]` — code only; the database stays as it is. */
export async function rollback(ctx: DeployContext, to?: string): Promise<number> {
  const current = await git(ctx, ['rev-parse', 'HEAD'])
  const releases = await readReleases(ctx)
  // The last healthy release before this one; on the first recorded deploy,
  // the commit it was deployed over.
  const target = to ?? lastGood(releases, current)?.sha ?? [...releases].reverse().find((r) => r.sha === current)?.previous
  if (!target || target === current) throw new DeployError('no earlier release to go back to; pass --to=<sha>')
  const document = await readEnv(ctx)
  const values = envValues(document)
  const port = await resolvePort(ctx, values)
  const since = migrationNames((await git(ctx, ['diff', '--name-only', target, current])).split('\n'))
  if (since.length > 0) {
    ctx.host.out.warn(`the database keeps the migrations applied since ${target.slice(0, 7)}: ${since.join(', ')}`)
    const destructive = since.filter((name) => ctx.config.destructive?.includes(name))
    if (destructive.length > 0) throw new DeployError(`refused: ${destructive.join(', ')} marked destructive — ${target.slice(0, 7)} cannot run on this schema`)
  }
  await rollbackTo(ctx, target, values, port)
  await recordRelease(ctx, { sha: target, previous: current, at: ctx.host.now().toISOString(), user: ctx.host.env['USER'] ?? '', status: 'ok', migrations: [], note: `manual rollback from ${current.slice(0, 7)}` })
  return 0
}

export async function status(ctx: DeployContext): Promise<number> {
  const { host } = ctx
  const releases = (await readReleases(ctx)).slice(-10).reverse()
  host.out.step(`${ctx.config.app} — last ${releases.length} release(s)`)
  for (const r of releases) host.out.info(`${r.at}  ${r.sha.slice(0, 7)}  ${r.status.padEnd(18)} ${r.user}${r.migrations.length ? `  +${r.migrations.length} migration(s)` : ''}${r.note ? `  — ${r.note}` : ''}`)
  const process = (await pm2List(ctx))?.find((p) => p.name === processName(ctx.config))
  host.out.info(process ? `pm2 ${process.name}: ${process.status} (pid ${process.pid}, ${process.cwd})` : `pm2 ${processName(ctx.config)}: not running`)
  return 0
}

/**
 * `sudo basalt-deploy install` — once per server, by an administrator (RFC
 * 0006 §11.4). Everything that needs root and nothing else: the vhost, the
 * state directory owned by the app user. The app user is never added to the
 * `docker` group (root-equivalent); with dedicated infra it needs rootless
 * Docker, and this says so.
 */
export async function install(ctx: DeployContext, user: string | undefined): Promise<number> {
  const { host, config } = ctx
  if (host.uid() !== 0) throw new DeployError('install needs root: sudo pnpm exec basalt-deploy install --user=<app user>')
  if (!user || user === 'root') throw new DeployError('install needs the unprivileged user the deploys run as: --user=<name> (never root)')
  const port = Number(envValues(await readEnv(ctx)).get('PORT'))
  if (!Number.isInteger(port) || port <= 0) throw new DeployError('no PORT in the .env yet: run `pnpm exec basalt-deploy env` as the app user first')

  const stateDir = `/var/lib/basalt/${config.app}`
  await step(ctx, `state directory ${stateDir}`, async () => {
    await host.mkdir(stateDir, 0o700)
    await host.mkdir(join(stateDir, 'install-backups'), 0o700)
    const local = await host.readFile(join(ctx.dir, '.basalt', 'releases.json'))
    if (local && !(await host.exists(join(stateDir, 'releases.json')))) await host.writeFile(join(stateDir, 'releases.json'), local, 0o600)
    const chown = await host.exec('chown', ['-R', `${user}:`, stateDir])
    if (chown.code !== 0) throw new DeployError(`chown ${user} ${stateDir}: ${chown.stderr.trim()}`)
    if (!(await host.exists(`/etc/basalt/${config.app}.json`))) {
      await host.mkdir('/etc/basalt', 0o755)
      await host.writeFile(`/etc/basalt/${config.app}.json`, '{}\n', 0o644)
    }
  })

  if (config.proxy?.kind === 'apache') {
    await step(ctx, `Apache vhost ${vhostPaths(ctx).file}`, () => apacheInstall(ctx, port, join(stateDir, 'install-backups')))
  }

  if (config.infra?.kind === 'docker') {
    const groups = (await host.exec('id', ['-nG', user])).stdout.split(/\s+/)
    if (groups.includes('docker')) {
      host.out.warn(`${user} is in the docker group: that is root on this machine (a container can mount /). Plan the move to rootless Docker for ${user} (dockerd-rootless-setuptool.sh install); this command will not do it for a server with data in rootful volumes.`)
    } else {
      host.out.info(`dedicated infra runs under ${user}'s rootless Docker: dockerd-rootless-setuptool.sh install (as ${user}), then loginctl enable-linger ${user}`)
    }
  }
  host.out.ok(`installed — from now on, as ${user}: pnpm exec basalt-deploy run`)
  return 0
}
