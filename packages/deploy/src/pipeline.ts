import { join } from 'node:path'
import { apacheInstall, apachePreflight, vhostPaths } from './apache.js'
import { backupDatabase, restoreCommand } from './backup.js'
import { lockfileFindings, tlsFindings, toolingFindings } from './checks.js'
import { processName } from './config.js'
import { DeployError, errors, INSTALL_COMMAND, report, RUN_COMMAND, type DeployContext, type Finding } from './context.js'
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

/**
 * Never a credential prompt: one in the middle of a deploy hangs cron and CI,
 * and interrupts a person half-way. With nobody to answer, git fails instead.
 */
const NO_PROMPT = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' }

async function git(ctx: DeployContext, args: string[], options: { noPrompt?: boolean } = {}): Promise<string> {
  const result = await ctx.host.exec('git', args, { cwd: ctx.dir, ...(options.noPrompt ? { env: NO_PROMPT } : {}) })
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
  // First, before any command runs: the tree as the operator left it. A
  // later probe that writes to the checkout would otherwise be blamed on them.
  const findings: Finding[] = [...await gitFindings(ctx, options)]
  const document = await readEnv(ctx)
  const values = envValues(document)
  findings.push(...syntaxFindings(document, ctx.config.env.file ?? '.env'))
  const port = await resolvePort(ctx, values)
  findings.push(...await toolingFindings(ctx))
  findings.push(...await lockfileFindings(ctx))
  findings.push(...await pm2Preflight(ctx, port))
  if (ctx.config.proxy?.kind === 'apache') findings.push(...await apachePreflight(ctx, port))
  if (!options.skip?.includes('tls')) findings.push(...await tlsFindings(ctx))
  return { findings, port, values }
}

const LOCKFILES = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock']

async function gitFindings(ctx: DeployContext, options: RunOptions): Promise<Finding[]> {
  const findings: Finding[] = []
  const dirty = await ctx.host.exec('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: ctx.dir })
  if (dirty.code !== 0) return [{ id: 'git', level: 'error', message: `${ctx.dir} is not a git checkout` }]
  const changed = dirty.stdout.split('\n').map((l) => l.trimEnd()).filter(Boolean)
  if (changed.length > 0) {
    const onlyLockfile = changed.every((l) => LOCKFILES.includes(l.slice(3)))
    findings.push({
      id: 'git',
      level: 'error',
      message: `tracked files are modified on the server:\n${changed.map((l) => `        ${l}`).join('\n')}`,
      fix: onlyLockfile
        ? 'only the lockfile — most likely rewritten by the package manager, not by a person: git checkout -- ' + changed.map((l) => l.slice(3)).join(' ') + ', and commit a lockfile written by the same pnpm as this server'
        : 'git stash (or commit them where they belong); a deploy builds what is committed',
    })
  }
  const branch = (await ctx.host.exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: ctx.dir })).stdout.trim()
  const wanted = ctx.config.branch ?? 'main'
  if (branch !== wanted) findings.push({ id: 'git', level: 'error', message: `the checkout is on "${branch}", the deploy tracks "${wanted}"`, fix: `git checkout ${wanted}` })
  if (!options.skip?.includes('fetch')) findings.push(...await remoteFindings(ctx))
  return findings
}

const CREDENTIALS = /terminal prompts disabled|could not read (Username|Password)|Authentication failed|Permission denied \(publickey|Host key verification failed|Invalid username or (password|token)/i

/** Can the fetch reach the branch without asking anyone for anything? */
async function remoteFindings(ctx: DeployContext): Promise<Finding[]> {
  const remote = ctx.config.remote ?? 'origin'
  const branch = ctx.config.branch ?? 'main'
  const probe = await ctx.host.exec('git', ['ls-remote', '--exit-code', remote, `refs/heads/${branch}`], { cwd: ctx.dir, env: NO_PROMPT })
  if (probe.code === 0) return []
  if (probe.code === 2) return [{ id: 'git', level: 'error', message: `the branch "${branch}" does not exist on ${remote}` }]
  const reason = probe.stderr.trim().split('\n').find((l) => l.trim()) ?? `exit ${probe.code}`
  if (CREDENTIALS.test(probe.stderr)) {
    const fix = 'store them once: git config credential.helper store && git fetch (or a read-only deploy key and an ssh remote)'
    return ctx.host.interactive()
      ? [{ id: 'git', level: 'warning', message: `${remote} needs credentials: the fetch will ask for them`, fix }]
      : [{ id: 'git', level: 'error', message: `${remote} needs credentials and nobody can type them here (no terminal)`, fix }]
  }
  return [{ id: 'git', level: 'warning', message: `could not reach ${remote}: ${reason}`, fix: '--skip=fetch deploys the code already in the checkout' }]
}

function stopOnErrors(ctx: DeployContext, findings: Finding[], what: string): void {
  report(ctx.host, findings)
  const blocking = errors(findings)
  if (blocking.length > 0) throw new DeployError(`${what}: ${blocking.length} problem(s) above — nothing was changed`, blocking)
}

// ── what runs by default ───────────────────────────────────────────────────

/** `prisma migrate deploy` runs when asked to, or — unsaid — when the app generates a Prisma client. */
export function migratesCentral(config: DeployContext['config']): boolean {
  return config.migrate?.central ?? (config.build?.prisma?.length ?? 0) > 0
}

const migratesAnything = (config: DeployContext['config']) => migratesCentral(config) || Boolean(config.migrate?.tenants)

/**
 * Whether the pre-migration dump runs, and why not when it does not. Unsaid,
 * it runs when there is something to migrate AND a Postgres to dump: the
 * dedicated one, or a `postgres…` URL in the `.env`. Explicitly on, a missing
 * database is the backup step's error to report.
 */
export function backupDecision(config: DeployContext['config'], values: Map<string, string>, skip: Iterable<string> = []):
  { run: true } | { run: false; why: string } {
  if ([...skip].includes('backup')) return { run: false, why: '--skip=backup' }
  const wanted = config.backup?.beforeMigrate
  if (wanted === false) return { run: false, why: 'backup.beforeMigrate is false' }
  if (wanted === true) return { run: true }
  if (!migratesAnything(config)) return { run: false, why: 'nothing to migrate' }
  if (config.infra?.kind === 'docker' && config.infra.postgres) return { run: true }
  const url = values.get(config.backup?.urlKey ?? 'DATABASE_URL') ?? ''
  return /^postgres(ql)?:\/\//.test(url) ? { run: true } : { run: false, why: 'no Postgres database in the .env' }
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

/**
 * The deploy leaves the checkout as committed. pnpm ≥ 12 may rewrite the
 * lockfile's `packageManagerDependencies` during `exec`/`run` when the
 * committed one was written by another pnpm; left there, it blocked the
 * NEXT deploy's dirty check. Put back, and said — the fix belongs in the
 * repository, not on the server.
 */
async function settleLockfile(ctx: DeployContext, said?: { warned: boolean }): Promise<void> {
  const status = await ctx.host.exec('git', ['status', '--porcelain', '--untracked-files=no', '--', ...LOCKFILES], { cwd: ctx.dir })
  const rewritten = status.stdout.split('\n').map((l) => l.slice(3).trim()).filter(Boolean)
  if (status.code !== 0 || rewritten.length === 0) return
  await git(ctx, ['checkout', '--', ...rewritten])
  if (said?.warned) return
  if (said) said.warned = true
  report(ctx.host, [{
    id: 'C11',
    level: 'warning',
    message: `${ctx.pm} rewrote ${rewritten.join(', ')} during the deploy; put back to the committed version`,
    fix: `regenerate it with the ${ctx.pm} this server runs (${ctx.pm} install --lockfile-only) and commit it, or every deploy rewrites it`,
  }])
}

async function validate(ctx: DeployContext, values: Map<string, string>): Promise<Finding[]> {
  const schema = await checkSchema(ctx, values)
  return [...schema.findings, ...coercionFindings(values, schema.trueKeys), ...policyFindings(ctx, values)]
}

async function migrate(ctx: DeployContext, values: Map<string, string>): Promise<void> {
  const { host, pm } = ctx
  const env = { cwd: ctx.dir, stream: true, env: Object.fromEntries(values) }
  if (migratesCentral(ctx.config)) {
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
  if (!migratesAnything(ctx.config)) host.out.info('nothing to migrate (no build.prisma, no migrate.tenants)')
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
  await settleLockfile(ctx)
}

/** The env step's summary: what changed, or that nothing did. */
function reportEnv(ctx: DeployContext, plan: EnvPlan): void {
  const lines = describeEnv(plan)
  if (lines.length === 0) ctx.host.out.ok(`${ctx.config.env.file ?? '.env'} unchanged`)
  for (const line of lines) ctx.host.out.info(line)
}

async function infraStep(ctx: DeployContext, infra: InfraPlan): Promise<void> {
  stopOnErrors(ctx, await applyInfra(ctx, infra), 'infra')
  if (infra.services.length === 0) ctx.host.out.ok('nothing to start (external infra)')
  else ctx.host.out.ok(`${infra.services.map((s) => s.container).join(', ')} healthy; credentials accepted${ctx.config.infra?.kind === 'docker' && ctx.config.infra.minio?.buckets.length ? '; buckets in place' : ''}`)
}

async function validateStep(ctx: DeployContext, values: Map<string, string>): Promise<void> {
  stopOnErrors(ctx, await validate(ctx, values), 'validate')
  const schema = ctx.config.env.schema
  ctx.host.out.ok(schema ? `${ctx.config.env.file ?? '.env'} is valid for ${schema}` : `${ctx.config.env.file ?? '.env'}: syntax and policy only (no env.schema configured)`)
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
    ((decision) => decision.run
      ? `backup: pg_dump → ${config.backup?.dir ?? 'backups/predeploy'} (keep ${config.backup?.keep ?? 10})`
      : `backup: skipped (${decision.why})`)(backupDecision(config, checked.values, options.skip ?? [])),
    `migrate: ${[migratesCentral(config) ? 'prisma migrate deploy' : '', config.migrate?.tenants ? 'tenant:migrate' : ''].filter(Boolean).join(' + ') || 'nothing configured'}`,
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
  reportEnv(ctx, env)
  await writeEnv(ctx, env)
  await step(ctx, 'infra', () => infraStep(ctx, infra))
  await step(ctx, 'validate', () => validateStep(ctx, env.values))
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
      await git(ctx, ['fetch', '--quiet', config.remote ?? 'origin', config.branch ?? 'main'], { noPrompt: !host.interactive() })
      await git(ctx, ['merge', '--ff-only', `${config.remote ?? 'origin'}/${config.branch ?? 'main'}`])
    })
  }
  const sha = await git(ctx, ['rev-parse', 'HEAD'])
  host.out.info(sha === previous ? `already at ${sha.slice(0, 7)}` : `${previous.slice(0, 7)} → ${sha.slice(0, 7)}`)
  const applied = sha === previous ? [] : migrationNames((await git(ctx, ['diff', '--name-only', previous, sha])).split('\n'))
  const release: Release = { sha, previous, at: host.now().toISOString(), user: host.env['USER'] ?? String(host.uid()), status: 'failed', migrations: applied }

  // From here a failure puts the code on disk back before it is reported.
  const lockfileSaid = { warned: false }
  let values = checked.values
  let infra: InfraPlan = { services: [], env: [], findings: [], secrets: {} }
  try {
    // Again on the code the fetch brought: preflight saw the commit before it.
    if (sha !== previous) stopOnErrors(ctx, await lockfileFindings(ctx), `the incoming commit ${sha.slice(0, 7)}`)
    const prepared = await step(ctx, 'env', () => prepareEnv(ctx, port))
    infra = prepared.infra
    stopOnErrors(ctx, infra.findings, 'infra')
    const missing = await answerQuestions(ctx, prepared.env)
    if (missing.length > 0) throw new DeployError(`no answer for ${missing.join(', ')} (no terminal to ask): set them in the environment of this command`)
    reportEnv(ctx, prepared.env)
    await writeEnv(ctx, prepared.env)
    values = prepared.env.values

    await step(ctx, 'infra', () => infraStep(ctx, infra))
    await step(ctx, 'build', async () => { await build(ctx, values); await settleLockfile(ctx, lockfileSaid) })
    await step(ctx, 'validate', () => validateStep(ctx, values))
    const backup = backupDecision(config, values, skip)
    if (backup.run) {
      release.backup = await step(ctx, 'backup', () => backupDatabase(ctx, values, infra, sha))
      host.out.ok(release.backup)
    } else {
      host.out.step('backup')
      host.out.info(`skipped: ${backup.why}`)
    }
    await step(ctx, 'migrate', async () => { await migrate(ctx, values); await settleLockfile(ctx, lockfileSaid) })
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
    host.out.ok(await step(ctx, 'release', () => pm2Release(ctx, values)))
  } catch (error) {
    return recover((error as Error).message)
  }
  const ok = await step(ctx, 'health', () => healthy(ctx, port))
  if (!ok) return recover(`the app does not answer on http://127.0.0.1:${port}${config.health?.path ?? '/health'}`)
  host.out.ok(`http://127.0.0.1:${port}${config.health?.path ?? '/health'}`)

  const publicProblem = await publicHealthy(ctx)
  release.status = publicProblem ? 'public-unreachable' : 'ok'
  // `pnpm run start`, launched by PM2 in the checkout, may rewrite it too.
  await settleLockfile(ctx, lockfileSaid)
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
  ctx.host.out.ok(await pm2Release(ctx, values))
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
  if (host.uid() !== 0) throw new DeployError(`install needs root: ${INSTALL_COMMAND}`)
  if (!user || user === 'root') throw new DeployError('install needs the unprivileged user the deploys run as: --user=<name> (never root)')
  const port = Number(envValues(await readEnv(ctx)).get('PORT'))
  if (!Number.isInteger(port) || port <= 0) throw new DeployError(`no PORT in the .env yet: run \`${RUN_COMMAND.replace(/ run$/, ' env')}\` as the app user first`)

  const stateDir = `/var/lib/basalt/${config.app}`
  await step(ctx, `state directory ${stateDir}`, async () => {
    await host.mkdir(stateDir, 0o700)
    await host.mkdir(join(stateDir, 'install-backups'), 0o700)
    const local = await host.readFile(join(ctx.dir, '.basalt', 'releases.json'))
    const target = join(stateDir, 'releases.json')
    let history = 'no release history yet'
    if (await host.exists(target)) {
      history = 'release history kept as it was'
    } else if (local) {
      await host.writeFile(target, local, 0o600)
      const count = (() => { try { const v = JSON.parse(local) as unknown; return Array.isArray(v) ? v.length : 0 } catch { return 0 } })()
      history = `${count} release(s) copied from ${join(ctx.dir, '.basalt', 'releases.json')}`
    }
    const chown = await host.exec('chown', ['-R', `${user}:`, stateDir])
    if (chown.code !== 0) throw new DeployError(`chown ${user} ${stateDir}: ${chown.stderr.trim()}`)
    host.out.ok(`${stateDir} (0700, owned by ${user}); ${history}`)
    const overrides = `/etc/basalt/${config.app}.json`
    if (!(await host.exists(overrides))) {
      await host.mkdir('/etc/basalt', 0o755)
      await host.writeFile(overrides, '{}\n', 0o644)
      host.out.ok(`${overrides} created (server-local overrides, no secrets)`)
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
  host.out.ok(`installed — from now on, as ${user} (not root), in ${ctx.dir}: ${RUN_COMMAND}`)
  return 0
}
