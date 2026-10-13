import { apachePreflight } from './apache.js'
import { caddyPreflight } from './caddy.js'
import { backupDatabase, backupDir, restoreCommand } from './backup.js'
import { lockfileFindings, tlsFindings, toolingFindings } from './checks.js'
import { composeBuild, composeEnv, composeHealthy, composeOf, composePreflight, composeRelease, composeStatus, logFindings, pruneImages } from './compose.js'
import { definedEntries, isBranchName, processName, REMOTE_NAME } from './config.js'
import { DeployAbortedError, DeployError, errors, report, RUN_COMMAND, throwIfAborted, type AbortState, type DeployContext, type Finding } from './context.js'
import { checkSchema, coercionFindings, policyFindings } from './env-check.js'
import { answerQuestions, describeEnv, envFile, envMirrors, envModeFindings, mirrorFindings, planEnv, readEnv, secureEnvModes, syntaxFindings, writeEnv, type EnvPlan } from './env-step.js'
import { envValues } from './dotenv.js'
import { applyInfra, describeInfra, dockerPostgres, maintainServices, planInfra, type InfraPlan } from './infra.js'
import { appRoleOf, describeServices, dumpContainer, dumpUrlKey, externalOf, externalPostgres, grantTenantSchemas } from './services.js'
import { pm2List, pm2Preflight, pm2Release, resolvePort } from './pm2.js'
import { clearHold, lastGood, migrationNames, readHold, readReleases, recordRelease, writeHold, type Release } from './state.js'
import { acquireLock, describeHolder, readLock } from './lock.js'
import { auditOf } from './audit.js'

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
  /** Who runs it, for the lock and the release record. Default `$USER`. */
  actor?: string
  /** Deploy the commit a manual rollback left (the hold), deliberately. */
  unhold?: boolean
  /**
   * Run as root anyway. Refused by default: a deploy as root builds and runs
   * the app's code (and deploy.config.ts) as root, and leaves root-owned files
   * the app user can no longer replace.
   */
  allowRoot?: boolean
}

/** run, env and rollback are the app user's (RFC 0006 §11.4): never root unless asked. */
export function refuseRoot(host: DeployContext['host'], command: string, allowRoot = false): void {
  if (host.uid() !== 0 || allowRoot) return
  throw new DeployError(`${command} runs as the app user, not root: it builds and runs the app's code. Run it as that user (sudo -u <user> -H …), or pass --allow-root if this server really has no other`)
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

/**
 * The remote and branch a deploy fetches, checked again here (a config built
 * in code may skip validateConfig): each reaches git as an argument, and a
 * name starting with `-` would be an option (`--upload-pack=<cmd>`). The
 * fetch names both refs in full, after `--`.
 */
export function gitTarget(ctx: DeployContext): { remote: string; branch: string; head: string; tracking: string } {
  const remote = ctx.config.remote ?? 'origin'
  const branch = ctx.config.branch ?? 'main'
  if (!REMOTE_NAME.test(remote)) throw new DeployError(`remote "${remote}" is not a git remote name`)
  if (!isBranchName(branch)) throw new DeployError(`branch "${branch}" is not a plain git branch name`)
  return { remote, branch, head: `refs/heads/${branch}`, tracking: `refs/remotes/${remote}/${branch}` }
}

async function step<T>(ctx: DeployContext, title: string, run: () => Promise<T>): Promise<T> {
  throwIfAborted(ctx)
  ctx.host.out.step(title)
  return run()
}


/**
 * The deploy lock around a command that changes the server, and its signal
 * handling: the first SIGINT/SIGTERM/SIGHUP stops an `abortable` command at
 * the next step boundary (the command puts back what it changed); one that
 * is not finishes first. The lock is released in every case.
 */
async function locked<T>(ctx: DeployContext, command: string, options: RunOptions, abortable: boolean, body: () => Promise<T>): Promise<T> {
  refuseRoot(ctx.host, command, options.allowRoot)
  const audit = auditOf(ctx.host, options.actor)
  const release = await acquireLock(ctx.host, ctx.stateDir, command, audit.actor)
  ctx.audit = audit
  const abort: AbortState = { deferred: !abortable }
  ctx.abort = abort
  const off = ctx.host.onSignal((signal) => {
    abort.signal = signal
    ctx.host.out.warn(abort.deferred
      ? `${signal}: ${command} cannot stop safely at this point — it finishes, then exits (a second ${signal} stops it at once)`
      : `${signal}: stopping after this step; what the deploy changed is put back (a second ${signal} stops it at once)`)
  })
  try {
    return await body()
  } finally {
    off()
    delete ctx.abort
    delete ctx.audit
    await release()
  }
}

// ── the runtime: PM2 on the host, or a compose project ────────────────────

const isCompose = (ctx: DeployContext) => ctx.config.runtime.kind === 'compose'

async function runtimePreflight(ctx: DeployContext, port: number, sha: string): Promise<Finding[]> {
  return isCompose(ctx) ? composePreflight(ctx, sha) : pm2Preflight(ctx, port)
}

async function release(ctx: DeployContext, values: Map<string, string>, sha: string): Promise<string> {
  return isCompose(ctx) ? composeRelease(ctx, sha) : pm2Release(ctx, values)
}

function describeRelease(ctx: DeployContext, port: number): string {
  if (!isCompose(ctx)) return `pm2 ${processName(ctx.config)} on 127.0.0.1:${port}`
  const rt = composeOf(ctx)
  return `docker compose -p ${ctx.config.app} up -d (${rt.images.map((i) => `${i.tag}:<sha>`).join(', ')}); ${rt.upstream.service} on 127.0.0.1:${port}`
}

const logsHint = (ctx: DeployContext) => isCompose(ctx)
  ? `docker compose -p ${ctx.config.app} logs ${composeOf(ctx).upstream.service} --tail=50`
  : `pm2 logs ${processName(ctx.config)}`

// ── hooks (RFC 0006 §13.3) ─────────────────────────────────────────────────

async function runHooks(ctx: DeployContext, which: 'infra' | 'verify', values: Map<string, string>, sha: string): Promise<void> {
  const hooks = ctx.config.hooks?.[which] ?? []
  if (hooks.length === 0) return
  const env = {
    ...Object.fromEntries(values),
    ...(isCompose(ctx) ? composeEnv(ctx, sha) : {}),
    DEPLOY_SHA: sha,
    DEPLOY_APP: ctx.config.app,
  }
  for (const [command, ...args] of hooks) {
    ctx.host.out.info(`${which} hook: ${[command, ...args].join(' ')}`)
    const result = await ctx.host.exec(command as string, args, { cwd: ctx.dir, env, stream: true })
    if (result.code !== 0) throw new DeployError(`${which} hook \`${[command, ...args].join(' ')}\` failed (exit ${result.code})`)
  }
  ctx.host.out.ok(`${hooks.length} ${which} hook(s) passed`)
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
  findings.push(...await envModeFindings(ctx))
  const port = await resolvePort(ctx, values)
  findings.push(...await toolingFindings(ctx))
  findings.push(...await lockfileFindings(ctx))
  const head = (await ctx.host.exec('git', ['rev-parse', 'HEAD'], { cwd: ctx.dir })).stdout.trim()
  findings.push(...await runtimePreflight(ctx, port, head))
  findings.push(...await mirrorFindings(ctx))
  if (ctx.config.proxy?.kind === 'apache') findings.push(...await apachePreflight(ctx, port))
  if (ctx.config.proxy?.kind === 'caddy') findings.push(...await caddyPreflight(ctx, port))
  if (!options.skip?.includes('tls')) findings.push(...await tlsFindings(ctx))
  findings.push(...await backupFindings(ctx, values, options))
  return { findings, port, values }
}

/** The dump's container running — found now, not after the build, minutes later. */
async function backupFindings(ctx: DeployContext, values: Map<string, string>, options: RunOptions): Promise<Finding[]> {
  const container = ctx.config.backup?.container
  // An external infra.postgres is checked with the rest of the infra.
  if (!container || !backupDecision(ctx.config, values, options.skip ?? []).run) return []
  const running = await ctx.host.exec('docker', ['inspect', '--format', '{{.State.Running}}', container])
  if (running.stdout.trim() === 'true') return []
  return [{
    id: 'backup',
    level: 'error',
    message: running.code === 0 ? `backup.container ${container} is not running` : `backup.container ${container} does not exist (or docker is not available to this user)`,
    fix: `docker start ${container}, or deploy with --skip=backup`,
  }]
}

const LOCKFILES = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock']

async function gitFindings(ctx: DeployContext, options: RunOptions): Promise<Finding[]> {
  const findings = await dirtyFindings(ctx)
  if (findings.some((f) => f.message.endsWith('is not a git checkout'))) return findings
  const branch = (await ctx.host.exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: ctx.dir })).stdout.trim()
  const wanted = ctx.config.branch ?? 'main'
  if (branch !== wanted) findings.push({ id: 'git', level: 'error', message: `the checkout is on "${branch}", the deploy tracks "${wanted}"`, fix: `git checkout ${wanted}` })
  if (!options.skip?.includes('fetch')) findings.push(...await remoteFindings(ctx))
  return findings
}

/** Tracked files modified on the server: a deploy (or a rollback's reset) would discard them. */
async function dirtyFindings(ctx: DeployContext): Promise<Finding[]> {
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
  return findings
}

const CREDENTIALS = /terminal prompts disabled|could not read (Username|Password)|Authentication failed|Permission denied \(publickey|Host key verification failed|Invalid username or (password|token)/i

/** Can the fetch reach the branch without asking anyone for anything? */
async function remoteFindings(ctx: DeployContext): Promise<Finding[]> {
  const { remote, branch, head } = gitTarget(ctx)
  const probe = await ctx.host.exec('git', ['ls-remote', '--exit-code', '--', remote, head], { cwd: ctx.dir, env: NO_PROMPT })
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
  // An app migrating by its own command does not also get `prisma migrate deploy` unasked.
  if (config.migrate?.command) return config.migrate.central === true
  return config.migrate?.central ?? (config.build?.prisma?.length ?? 0) > 0
}

const migratesAnything = (config: DeployContext['config']) =>
  Boolean(config.migrate?.command) || migratesCentral(config) || Boolean(config.migrate?.tenants)

/**
 * The `.env` as the migration and the dump see it — they run on the host:
 * container addresses (`@myapp-pg:5432`) become the published 127.0.0.1 ones,
 * then `migrate.env` on top.
 */
export function migrationValues(config: DeployContext['config'], values: Map<string, string>, hostUrls: Array<[string, string]> = []): Map<string, string> {
  const onHost = new Map([...values].map(([key, value]) => {
    let rewritten = value
    for (const [from, to] of hostUrls) rewritten = rewritten.replace(`@${from}`, `@${to}`).replace(`//${from}`, `//${to}`)
    return [key, rewritten] as const
  }))
  const extra = config.migrate?.env?.(onHost) ?? {}
  return new Map([...onHost, ...definedEntries(extra)])
}

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
  if (dumpContainer(config)) return { run: true }
  const url = migrationValues(config, values).get(dumpUrlKey(config)) ?? ''
  return /^postgres(ql)?:\/\//.test(url) ? { run: true } : { run: false, why: 'no Postgres database in the .env' }
}

// ── the building blocks ────────────────────────────────────────────────────

async function prepareEnv(ctx: DeployContext, port: number): Promise<{ env: EnvPlan; infra: InfraPlan }> {
  const document = await readEnv(ctx)
  const infra = await planInfra(ctx, envValues(document))
  const env = planEnv(ctx, document, port, infra.env)
  ctx.hostUrls = infra.hostUrls ?? []
  ctx.values = env.values
  return { env, infra }
}

async function build(ctx: DeployContext, values: Map<string, string>, sha: string): Promise<void> {
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
  if (ctx.config.build?.script) await run(['run', ctx.config.build.script], { env: values })
  if (ctx.config.build?.web) await run(['--dir', ctx.config.build.web, 'run', 'build'], { env: values })
  if (isCompose(ctx)) await composeBuild(ctx, sha)
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

async function migrate(ctx: DeployContext, raw: Map<string, string>): Promise<void> {
  const { host, pm } = ctx
  const values = migrationValues(ctx.config, raw, ctx.hostUrls)
  const env = { cwd: ctx.dir, stream: true, env: Object.fromEntries(values) }
  const command = ctx.config.migrate?.command
  if (command) {
    host.out.info(command.join(' '))
    const result = await host.exec(command[0] as string, command.slice(1), env)
    if (result.code !== 0) throw new DeployError(`${command.join(' ')} failed (exit ${result.code})`)
  }
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
  if (!migratesAnything(ctx.config)) host.out.info('nothing to migrate (no build.prisma, no migrate.tenants, no migrate.command)')
}

/** Compose: the upstream service healthy and nothing restarting; then, any runtime, the loopback URL. */
async function healthCheck(ctx: DeployContext, port: number, sha: string): Promise<{ ok: true } | { ok: false; why: string }> {
  if (isCompose(ctx)) {
    const services = await composeHealthy(ctx, sha)
    if (!services.ok) return services
    ctx.host.out.ok(`${composeOf(ctx).upstream.service} healthy; no service restarting`)
  }
  if (await healthy(ctx, port)) return { ok: true }
  return { ok: false, why: `the app does not answer on http://127.0.0.1:${port}${ctx.config.health?.path ?? '/health'}` }
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

/** `verify.logs` and `verify.http` (RFC 0007 §6); throws what failed, which rolls the release back. */
async function verifyDeclared(ctx: DeployContext, sha: string, port: number, since: Date): Promise<void> {
  const verify = ctx.config.verify
  if (!verify) return
  const problems: string[] = []
  if (verify.logs && Object.keys(verify.logs).length) {
    if (!isCompose(ctx)) throw new DeployError('verify.logs reads compose service logs: it needs runtime: compose(…)')
    const found = await logFindings(ctx, sha, since)
    problems.push(...found)
    if (found.length === 0) ctx.host.out.ok(`logs of ${Object.keys(verify.logs).join(', ')}: clean since the release`)
  }
  for (const check of verify.http ?? []) {
    const expect = check.expect ?? 200
    const answer = await ctx.host.httpGet(`http://127.0.0.1:${port}${check.path}`, { host: ctx.config.domain })
    if ('status' in answer && answer.status === expect) ctx.host.out.ok(`${check.path}: ${expect}`)
    else problems.push(`${check.path}: ${'status' in answer ? `HTTP ${answer.status}` : answer.error}, expected ${expect}`)
  }
  if (problems.length > 0) throw new DeployError(`verify: ${problems.join('; ')}`)
}

async function publicHealthy(ctx: DeployContext): Promise<Finding | undefined> {
  const { config } = ctx
  if (config.health?.public === false || (config.proxy?.kind !== 'apache' && config.proxy?.kind !== 'caddy')) return undefined
  const url = `https://${config.domain}${config.proxy.apiPrefix.replace(/\/$/, '')}${config.health?.path ?? '/health'}`
  const answer = await ctx.host.httpGet(url, { timeoutMs: 10_000 })
  if ('status' in answer && answer.status >= 200 && answer.status < 400) {
    ctx.host.out.ok(url)
    return undefined
  }
  return {
    id: 'health',
    level: 'error',
    message: `the app answers on 127.0.0.1 but not at ${url} (${'status' in answer ? `HTTP ${answer.status}` : answer.error}) — the proxy, DNS or TLS, not the code`,
    fix: config.proxy.kind === 'caddy' ? 'the [C1]/[C2]/[C8] findings above, then: journalctl -u caddy -n 50' : 'the [C1]/[C2]/[vhost] findings above, then: apachectl -S',
  }
}

/** Puts the code on disk back to `sha` and rebuilds it. Does not restart anything. */
async function restoreCode(ctx: DeployContext, sha: string, values: Map<string, string>): Promise<void> {
  ctx.host.out.step(`restoring the code to ${sha.slice(0, 7)}`)
  await git(ctx, ['reset', '--hard', sha])
  await build(ctx, values, sha)
  await settleLockfile(ctx)
}

/** The env step's summary: what changed, or that nothing did. */
function reportEnv(ctx: DeployContext, plan: EnvPlan): void {
  const lines = describeEnv(plan)
  if (lines.length === 0) ctx.host.out.ok(`${ctx.config.env.file ?? '.env'} unchanged`)
  for (const line of lines) ctx.host.out.info(line)
}

/** Writes the `.env` and puts its mode (and its mirrors') back to 0600. */
async function writeEnvSecure(ctx: DeployContext, plan: EnvPlan): Promise<void> {
  await writeEnv(ctx, plan)
  for (const file of await secureEnvModes(ctx)) ctx.host.out.ok(`${file} is 0600 again (other users could read it)`)
}

async function infraStep(ctx: DeployContext, infra: InfraPlan, values: Map<string, string>): Promise<void> {
  stopOnErrors(ctx, await applyInfra(ctx, infra), 'infra')
  const external = externalOf(ctx.config)
  const adopted = [external?.postgres?.container, external?.redis?.container, external?.minio?.container].filter(Boolean)
  if (infra.services.length > 0) ctx.host.out.ok(`${infra.services.map((s) => s.container).join(', ')} healthy; credentials accepted`)
  else if (adopted.length > 0) ctx.host.out.ok(`${adopted.join(', ')} running (external)`)
  else ctx.host.out.ok('nothing to start (external infra)')
  for (const line of await maintainServices(ctx, infra, values)) ctx.host.out.ok(line)
}

/** The app role on every company schema, after the companies' migrations (RFC 0007 §11.3). */
async function tenantGrants(ctx: DeployContext, infra: InfraPlan, values: Map<string, string>): Promise<void> {
  const role = appRoleOf(ctx.config)
  if (!role || !ctx.config.migrate?.tenants) return
  const pg = ctx.config.infra?.kind === 'docker' ? dockerPostgres(infra) : externalPostgres(ctx, values)
  if (pg) ctx.host.out.ok(await grantTenantSchemas(ctx, pg, role))
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
    options.skip?.includes('fetch') ? 'fetch: skipped' : ((t) => `fetch: git fetch -- ${t.remote} ${t.head}:${t.tracking} && git merge --ff-only ${t.tracking}`)(gitTarget(ctx)),
    ...describeEnv(env).map((l) => `env: ${l}`),
    ...describeInfra(infra).map((l) => `infra: ${l}`),
    ...describeServices(config).map((l) => `infra: ${l}`),
    `build: ${pm} install (frozen), ${(config.build?.prisma ?? []).map((c) => `prisma generate --config ${c}`).join(', ') || 'no prisma'}${config.build?.script ? `, ${pm} run ${config.build.script}` : ''}${config.build?.web ? `, ${config.build.web} build` : ''}${isCompose(ctx) ? `, docker build ${composeOf(ctx).images.map((i) => i.tag).join(', ')} (skipped when the commit's tag exists)` : ''}`,
    ...(config.hooks?.infra ?? []).map((h) => `infra hook: ${h.join(' ')}`),
    `validate: ${config.env.schema ?? '(no schema configured)'} against the new .env`,
    ((decision) => decision.run
      ? `backup: pg_dump${dumpContainer(config) ? ` inside ${dumpContainer(config)}` : ''} → ${backupDir(ctx)} (keep ${config.backup?.keep ?? 10})`
      : `backup: skipped (${decision.why})`)(backupDecision(config, checked.values, options.skip ?? [])),
    `migrate: ${[config.migrate?.command?.join(' ') ?? '', migratesCentral(config) ? 'prisma migrate deploy' : '', config.migrate?.tenants ? 'tenant:migrate' : ''].filter(Boolean).join(' + ') || 'nothing configured'}`,
    ...(isCompose(ctx) && composeOf(ctx).attach ? [`attach: ${Object.entries(composeOf(ctx).attach ?? {}).map(([c, n]) => `${c} → ${n.join(', ')}`).join('; ')}`] : []),
    ...(isCompose(ctx) ? (composeOf(ctx).jobs ?? []).map((j) => `job: ${j.service}${j.command ? ` ${j.command.join(' ')}` : ''}${j.once ? ` (unless ${j.once.exists} exists)` : ''}`) : []),
    `release: ${describeRelease(ctx, checked.port)}`,
    `health: http://127.0.0.1:${checked.port}${config.health?.path ?? '/health'} (Host: ${config.domain})${(config.proxy?.kind === 'apache' || config.proxy?.kind === 'caddy') && config.health?.public !== false ? `, then https://${config.domain}${config.proxy.apiPrefix}${config.health?.path ?? '/health'}` : ''}`,
  ]
  for (const hook of config.hooks?.verify ?? []) lines.push(`verify hook: ${hook.join(' ')}`)
  if (config.verify?.logs) lines.push(`verify: no ${[...new Set(Object.values(config.verify.logs).flat())].join(' / ')} in the logs of ${Object.keys(config.verify.logs).join(', ')}`)
  for (const check of config.verify?.http ?? []) lines.push(`verify: ${check.path} answers ${check.expect ?? 200}`)
  for (const line of lines) host.out.info(line)
  return errors([...checked.findings, ...infra.findings]).length > 0 ? 1 : 0
}

/** `basalt-deploy env` — the .env and the infra only (first setup, before `install`). */
export async function envCommand(ctx: DeployContext, options: RunOptions = {}): Promise<number> {
  return locked(ctx, 'env', options, true, () => envLocked(ctx))
}

async function envLocked(ctx: DeployContext): Promise<number> {
  const document = await readEnv(ctx)
  stopOnErrors(ctx, [...syntaxFindings(document, ctx.config.env.file ?? '.env'), ...await envModeFindings(ctx)], '.env')
  const port = await resolvePort(ctx, envValues(document))
  const { env, infra } = await step(ctx, 'env', () => prepareEnv(ctx, port))
  stopOnErrors(ctx, infra.findings, 'infra')
  const missing = await answerQuestions(ctx, env)
  if (missing.length > 0) throw new DeployError(`no answer for ${missing.join(', ')} (no terminal to ask): set them in the environment of this command`)
  reportEnv(ctx, env)
  await writeEnvSecure(ctx, env)
  await step(ctx, 'infra', () => infraStep(ctx, infra, env.values))
  await step(ctx, 'validate', () => validateStep(ctx, env.values))
  ctx.host.out.ok(isCompose(ctx) ? `${envFile(ctx)} ready` : `.env ready (PORT=${port})`)
  return 0
}

export async function run(ctx: DeployContext, options: RunOptions = {}): Promise<number> {
  return locked(ctx, 'run', options, true, () => runLocked(ctx, options))
}

async function runLocked(ctx: DeployContext, options: RunOptions): Promise<number> {
  const { host, config } = ctx
  const skip = new Set(options.skip ?? [])

  const checked = await step(ctx, 'preflight', () => preflight(ctx, options))
  stopOnErrors(ctx, checked.findings, 'preflight')
  const { port } = checked

  const previous = await git(ctx, ['rev-parse', 'HEAD'])
  if (!skip.has('fetch')) {
    const target = gitTarget(ctx)
    await step(ctx, 'fetch', async () => {
      await git(ctx, ['fetch', '--quiet', '--', target.remote, `${target.head}:${target.tracking}`], { noPrompt: !host.interactive() })
      await refuseHeld(ctx, await git(ctx, ['rev-parse', '--verify', '--end-of-options', `${target.tracking}^{commit}`]), options)
      await git(ctx, ['merge', '--ff-only', target.tracking])
    })
  } else {
    await refuseHeld(ctx, previous, options)
  }
  const sha = await git(ctx, ['rev-parse', 'HEAD'])
  host.out.info(sha === previous ? `already at ${sha.slice(0, 7)}` : `${previous.slice(0, 7)} → ${sha.slice(0, 7)}`)
  const applied = sha === previous ? [] : migrationNames((await git(ctx, ['diff', '--name-only', previous, sha])).split('\n'))
  const record: Release = { sha, previous, at: host.now().toISOString(), user: host.env['USER'] ?? String(host.uid()), status: 'failed', migrations: applied }

  // From here a failure puts the code on disk back before it is reported.
  const lockfileSaid = { warned: false }
  let values = checked.values
  let infra: InfraPlan = { services: [], env: [], findings: [], secrets: {} }
  let migrating = false
  try {
    // Again on the code the fetch brought: preflight saw the commit before it.
    if (sha !== previous) stopOnErrors(ctx, await lockfileFindings(ctx), `the incoming commit ${sha.slice(0, 7)}`)
    const prepared = await step(ctx, 'env', () => prepareEnv(ctx, port))
    infra = prepared.infra
    stopOnErrors(ctx, infra.findings, 'infra')
    const missing = await answerQuestions(ctx, prepared.env)
    if (missing.length > 0) throw new DeployError(`no answer for ${missing.join(', ')} (no terminal to ask): set them in the environment of this command`)
    reportEnv(ctx, prepared.env)
    await writeEnvSecure(ctx, prepared.env)
    values = prepared.env.values

    await step(ctx, 'infra', async () => { await infraStep(ctx, infra, values); await runHooks(ctx, 'infra', values, sha) })
    await step(ctx, 'build', async () => { await build(ctx, values, sha); await settleLockfile(ctx, lockfileSaid) })
    await step(ctx, 'validate', () => validateStep(ctx, values))
    const backup = backupDecision(config, values, skip)
    if (backup.run) {
      record.backup = await step(ctx, 'backup', () => backupDatabase(ctx, migrationValues(config, values, infra.hostUrls), infra, sha))
      host.out.ok(record.backup)
    } else {
      host.out.step('backup')
      host.out.info(`skipped: ${backup.why}`)
    }
    migrating = true
    await step(ctx, 'migrate', async () => { await migrate(ctx, values); await tenantGrants(ctx, infra, values); await settleLockfile(ctx, lockfileSaid) })
    migrating = false
    // The last point where a signal stops the deploy: from the release on, it finishes.
    throwIfAborted(ctx)
  } catch (error) {
    if (sha !== previous) await restoreCode(ctx, previous, values).catch((e: unknown) => host.out.error(`could not restore the code: ${(e as Error).message}`))
    record.note = (error as Error).message
    const signal = ctx.abort?.signal
    if (migrating) {
      // The code is back; the database may not be — a migration does not undo itself.
      record.status = 'failed-migration'
      host.out.error(`the migration failed: the database may be part-way migrated, and the code is back on ${previous.slice(0, 7)}`)
      if (record.backup) host.out.info(`to put the database back as it was before this deploy: ${restoreCommand(ctx, infra, record.backup, values)}`)
      else host.out.warn('no dump was taken before this migration (backup skipped): restore from your own backups if needed')
    } else if (signal) record.status = 'aborted'
    await recordRelease(ctx, record).catch(() => undefined)
    // A terminal's SIGINT reaches the child too: its failure is the signal's.
    if (signal && !(error instanceof DeployAbortedError)) throw new DeployAbortedError(signal, (error as Error).message)
    throw error
  }
  if (ctx.abort) ctx.abort.deferred = true

  const destructive = applied.filter((name) => config.destructive?.includes(name))
  const recover = async (why: string): Promise<number> => {
    host.out.error(why)
    if (destructive.length > 0 || sha === previous) {
      if (destructive.length > 0) host.out.error(`not rolled back automatically: ${destructive.join(', ')} ${destructive.length === 1 ? 'is' : 'are'} marked destructive`)
      if (record.backup) host.out.info(`database before this release: ${restoreCommand(ctx, infra, record.backup, values)}`)
      record.note = why
      await recordRelease(ctx, record)
      return 1
    }
    const back = await rollbackTo(ctx, previous, values, port)
    record.status = 'rolled-back'
    record.note = why
    await recordRelease(ctx, record)
    if (!back.ok) {
      // The previous commit does not answer either: never a rollback target again.
      await recordRelease(ctx, { ...record, sha: previous, previous: sha, at: host.now().toISOString(), status: 'rollback-unhealthy', migrations: [], note: back.why })
    }
    return 1
  }

  const releasedAt = host.now()
  try {
    host.out.ok(await step(ctx, 'release', () => release(ctx, values, sha)))
  } catch (error) {
    return recover((error as Error).message)
  }
  const health = await step(ctx, 'health', () => healthCheck(ctx, port, sha))
  if (!health.ok) return recover(health.why)
  host.out.ok(`http://127.0.0.1:${port}${config.health?.path ?? '/health'}`)
  // Through the proxy, under the health step: a failure here is the proxy,
  // DNS or TLS — reported at the end, never rolled back.
  const publicProblem = await publicHealthy(ctx)
  if (config.hooks?.verify?.length || config.verify) {
    try {
      await step(ctx, 'verify', async () => {
        await runHooks(ctx, 'verify', values, sha)
        await verifyDeclared(ctx, sha, port, releasedAt)
      })
    } catch (error) {
      return recover((error as Error).message)
    }
  }

  record.status = publicProblem ? 'public-unreachable' : 'ok'
  // A healthy release on purpose: whatever a rollback held is behind us.
  await clearHold(ctx)
  // `pnpm run start`, launched by PM2 in the checkout, may rewrite it too.
  await settleLockfile(ctx, lockfileSaid)
  await step(ctx, 'record', () => recordRelease(ctx, record))
  if (isCompose(ctx) && !publicProblem) await retainImages(ctx)
  if (publicProblem) {
    report(host, [publicProblem])
    return 1
  }
  host.out.ok(`${config.app} ${sha.slice(0, 7)} is live at https://${config.domain}`)
  return 0
}

/** Compose: keep the images of the last `keepImages` healthy releases; remove older ones of these tags only. */
async function retainImages(ctx: DeployContext): Promise<void> {
  const keep = composeOf(ctx).keepImages
  const releases = await readReleases(ctx)
  const shas = [...new Set([...releases].reverse().filter((r) => r.status === 'ok').map((r) => r.sha))].slice(0, keep)
  const removed = await pruneImages(ctx, shas)
  if (removed.length > 0) ctx.host.out.info(`removed ${removed.length} image(s) of releases older than the last ${keep}: ${removed.join(', ')}`)
}

/** `run` will not redeploy the commit a manual rollback left, unless asked to (`--unhold`). */
async function refuseHeld(ctx: DeployContext, incoming: string, options: RunOptions): Promise<void> {
  const hold = await readHold(ctx)
  if (!hold || hold.sha !== incoming) return
  if (options.unhold) {
    ctx.host.out.warn(`deploying ${incoming.slice(0, 7)} although a rollback held it (--unhold)`)
    return
  }
  throw new DeployError(`${incoming.slice(0, 7)} is held: ${hold.note} by ${hold.actor || 'someone'} at ${hold.at} — nothing was changed. Push a fix (the hold ends when the branch moves on), or deploy it anyway with --unhold`)
}

async function rollbackTo(ctx: DeployContext, sha: string, values: Map<string, string>, port: number): Promise<{ ok: true } | { ok: false; why: string }> {
  // Compose: the images of `sha` exist (kept by retention), so the rebuild
  // inside restoreCode skips them — a rollback is not a new build.
  await restoreCode(ctx, sha, values)
  ctx.host.out.step(`release ${sha.slice(0, 7)}`)
  ctx.host.out.ok(await release(ctx, values, sha))
  const health = await healthCheck(ctx, port, sha)
  if (health.ok) ctx.host.out.ok(`back on ${sha.slice(0, 7)}`)
  else ctx.host.out.error(`${sha.slice(0, 7)} does not answer either (${health.why}) — ${logsHint(ctx)}`)
  return health
}

/** `basalt-deploy rollback [--to=<sha>]` — code only; the database stays as it is. */
export async function rollback(ctx: DeployContext, to?: string, options: RunOptions = {}): Promise<number> {
  return locked(ctx, 'rollback', options, false, () => rollbackLocked(ctx, to, options))
}

async function rollbackLocked(ctx: DeployContext, to: string | undefined, options: RunOptions): Promise<number> {
  // The reset below would discard edits on the server, as a deploy would.
  stopOnErrors(ctx, await dirtyFindings(ctx), 'rollback')
  const current = await git(ctx, ['rev-parse', 'HEAD'])
  const releases = await readReleases(ctx)
  let wanted: string | undefined
  if (to !== undefined) {
    if (!/^[0-9a-f]{7,40}$/.test(to)) throw new DeployError(`--to=${to}: a commit sha (7 to 40 hex digits)`)
    const resolved = await ctx.host.exec('git', ['rev-parse', '--verify', '--quiet', '--end-of-options', `${to}^{commit}`], { cwd: ctx.dir })
    if (resolved.code !== 0) throw new DeployError(`--to=${to} is not a commit in this checkout`)
    wanted = resolved.stdout.trim()
  }
  // The last healthy release before this one; on the first recorded deploy,
  // the commit it was deployed over.
  const target = wanted ?? lastGood(releases, current)?.sha ?? [...releases].reverse().find((r) => r.sha === current)?.previous
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
  const back = await rollbackTo(ctx, target, values, port)
  const at = ctx.host.now().toISOString()
  const note = `manual rollback from ${current.slice(0, 7)}`
  await recordRelease(ctx, {
    sha: target, previous: current, at, user: ctx.host.env['USER'] ?? '', migrations: [],
    status: back.ok ? 'ok' : 'rollback-unhealthy',
    note: back.ok ? note : `${note}; ${target.slice(0, 7)} does not answer either: ${back.why}`,
  })
  // Whatever the outcome, the commit rolled away from is not redeployed by the next scheduled run.
  await writeHold(ctx, { sha: current, at, actor: ctx.audit?.actor ?? '', note: `rolled back to ${target.slice(0, 7)}` })
  ctx.host.out.info(`${current.slice(0, 7)} is held: \`run\` will not deploy it again until the branch moves on (or --unhold)`)
  if (!back.ok) {
    ctx.host.out.error(`the rollback did not bring a healthy release: ${target.slice(0, 7)} is recorded as rollback-unhealthy — try another with --to=<sha>`)
    return 1
  }
  return 0
}

export async function status(ctx: DeployContext): Promise<number> {
  const { host } = ctx
  const releases = (await readReleases(ctx)).slice(-10).reverse()
  host.out.step(`${ctx.config.app} — last ${releases.length} release(s)`)
  const lock = await readLock(host, ctx.stateDir)
  if (!lock) host.out.info('no deploy running')
  else if (lock.corrupt) host.out.warn(`${lock.path} is not a deploy lock (empty or unreadable): deploys are refused until it is removed`)
  else if (lock.stale) host.out.warn(`stale lock: ${describeHolder(lock.holder!)} — that process is gone; the next deploy takes it over`)
  else host.out.info(`deploy running: ${describeHolder(lock.holder!)}`)
  const hold = await readHold(ctx)
  if (hold) host.out.warn(`held: ${hold.sha.slice(0, 7)} (${hold.note}, by ${hold.actor || 'someone'} at ${hold.at}) — run will not deploy it again; --unhold to override`)
  for (const r of releases) host.out.info(`${r.at}  ${r.sha.slice(0, 7)}  ${r.status.padEnd(18)} ${r.actor && r.actor !== r.user ? `${r.actor} (${r.user})` : r.user}${r.client ? ` from ${r.client}` : ''}${r.migrations.length ? `  +${r.migrations.length} migration(s)` : ''}${r.note ? `  — ${r.note}` : ''}`)
  if (isCompose(ctx)) {
    const head = (await ctx.host.exec('git', ['rev-parse', 'HEAD'], { cwd: ctx.dir })).stdout.trim()
    for (const line of await composeStatus(ctx, head)) host.out.info(line)
    return 0
  }
  const process = (await pm2List(ctx))?.find((p) => p.name === processName(ctx.config))
  host.out.info(process ? `pm2 ${process.name}: ${process.status} (pid ${process.pid}, ${process.cwd})` : `pm2 ${processName(ctx.config)}: not running`)
  return 0
}
