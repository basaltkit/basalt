import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { AnswerChannel, askedQuestions, ANSWER_TIMEOUT_SECONDS } from './answers.js'
import { bootstrap } from './bootstrap.js'
import { DETACHED_CHILD_ENV, detach } from './detach.js'
import { EventWriter, foreignSink, humanReporter, Redactor, type Reporter } from './events.js'
import { jsonHost, type JsonSession } from './json-host.js'
import { isErrorCode, RUN_ID, type ErrorCode, type EventBody } from './protocol.js'
import { attach, cancel, createRunLog, newRunId, pruneRunLogs } from './runs.js'
import { check } from './check.js'
import { init } from './init.js'
import { applyOverrides, DeployConfigError, parseOverrides, validateConfig, type DeployConfig } from './config.js'
import { DeployAbortedError, DeployError, detectPackageManager, INSTALL_COMMAND, resolveStateDir, rootInstallCommand, type DeployContext } from './context.js'
import { buildInstallPlan, install, readInstallPlan } from './install-plan.js'
import { untrustedToolPaths, USER_NAME } from './trust.js'
import { VERSION } from './version.js'
import { DeployLockedError } from './lock.js'
import { envValues, parseEnv } from './dotenv.js'
import { nodeHost, type Host } from './host.js'
import { envCommand, plan, refuseRoot, rollback, run, SKIPPABLE, status, type ProtocolHooks, type RunOptions, type Skippable } from './pipeline.js'

export const USAGE = `basalt-deploy — deploy this Basalt app on this server (RFC 0006)

As the app user, in the checkout (node node_modules/@basaltkit/deploy/dist/bin.js <command>):
  init --domain=<host> [--tenants=subdomain|none] [--branch=<b>] [--proxy=apache|caddy|none] [--server]
                     writes deploy.config.ts from the project (and, with --server, this server)
  check              the config is valid and types check; no server needed
  plan               what a run would do; changes nothing
  run [--unhold]     fetch, .env, infra, build, backup, migrate, restart, health
                     (--unhold: deploy the commit a rollback held, deliberately)
  env                the .env and the dedicated infra only (first setup)
  rollback [--to=<sha>]   back to the last healthy release (code only); holds the commit it left
  status             the last releases, the process, the lock
  install-plan [--out=<file>|-]
                     what install needs, as data (default <state dir>/install-plan.json);
                     prints the root command for install
  attach <runId> --json [--from-seq=<n>] [--follow]
                     the events of a run (run/env/rollback --json), from any seq
  cancel <runId>     SIGTERM to a detached run (a second cancel stops it at once)

As root, with a copy of the tool root owns — never the checkout's node_modules:
  cd / && sudo -H npx --yes --package=@basaltkit/deploy@<exact version> -- basalt-deploy <command>
  bootstrap --user=<name> --dir=<checkout> [--dry-run] [--proxy=…] [--swap-gb=<n>] [--no-firewall]
                     a fresh Ubuntu/Debian server, once: Docker, Node, pnpm; as the user
                     pnpm install, env, install-plan; then swap, ufw, Caddy and install
  install --plan=<file> --user=<name>
                     once per server: state directory, proxy site, env file ownership

Run the app user's commands with \`node\`, not \`pnpm exec\`: pnpm ≥ 12 may rewrite
pnpm-lock.yaml on any command it runs. As root, nothing loads deploy.config.ts.

Exit codes: 0 done · 1 failed (or refused) · 3 another deploy holds the lock · 130 stopped by a signal
  (a second signal ends the process at once: 130/129/143)

Machine mode (RFC 0008): stdout carries NDJSON events only
  --json[=1]          status, check, plan, run, env, rollback, install-plan, attach, cancel
  --answers=stdin     run/env: answer lines {"v":1,"type":"answer","id":"env.KEY","value":"…"} on stdin
  --answer-timeout=<s>  how long a prompt waits for its answer (1–3600, default 600)
  --detach            run/rollback: in their own session; returns the runId once the lock is held
  --via=ui            recorded as the release's via

Options:
  --config=<file>     default deploy.config.ts
  --overrides=<file>  server-local values, default /etc/basalt/<app>.json
  --allow-root        run an app-user command as root anyway (refused by default)
  --unsafe-tool       let install/bootstrap run from files another user can change (refused by default)
  --actor=<name>      who deploys, recorded with the release (default $BASALT_DEPLOY_ACTOR, else $USER)
  --skip=<steps>      ${SKIPPABLE.join(', ')} (comma-separated); --no-fetch = --skip=fetch
  -h, --help
`

/** Another deploy holds the lock: nothing was done. */
export const EXIT_LOCKED = 3
/** A signal stopped the command at a step boundary. */
export const EXIT_ABORTED = 130

interface Flags {
  command: string
  /** Words after the command (`attach <runId>`). */
  args: string[]
  values: Map<string, string>
  switches: Set<string>
}

function parse(argv: string[]): Flags {
  const values = new Map<string, string>()
  const switches = new Set<string>()
  let command = ''
  const args: string[] = []
  for (const arg of argv) {
    if (arg === '-h' || arg === '--help') { switches.add('help'); continue }
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg)
    if (match) {
      if (match[2] === undefined) switches.add(match[1] as string)
      else values.set(match[1] as string, match[2])
      continue
    }
    if (!command) command = arg
    else args.push(arg)
  }
  return { command, args, values, switches }
}

const COMMANDS = ['init', 'check', 'plan', 'run', 'env', 'rollback', 'status', 'install-plan', 'install', 'bootstrap', 'attach', 'cancel']
/** The commands that take the deploy lock, and so write a run log under --json. */
const LOCKED = new Set(['run', 'env', 'rollback'])

const usage = (message: string, hint?: string) => new DeployError(message, [], 'usage', hint)

/** The files root is about to run: node, and this package's own (its directory and modules). */
async function assertTrustedTool(host: Host, unsafe: boolean): Promise<void> {
  const dir = dirname(fileURLToPath(import.meta.url))
  const modules = (await host.list(dir)).filter((name) => name.endsWith('.js')).map((name) => join(dir, name))
  const problems = await untrustedToolPaths(host, [process.execPath, dir, ...modules])
  if (problems.length === 0) return
  const message = `root would run files another user can change:\n${problems.map((p) => `      - ${p}`).join('\n')}\n    run a copy root owns: ${rootInstallCommand(VERSION, '<plan>', '<user>').replace(/ install --plan=.*$/, ' <command>')}, or a root-owned global install (sudo npm install -g @basaltkit/deploy@${VERSION}) and a root-owned node`
  if (!unsafe) throw new DeployError(message)
  host.out.warn(`--unsafe-tool: ${message}`)
}

/** `install-plan`: the plan as JSON — to stdout (`--out=-`) or a 0600 file — and the root command that reads it. */
async function writeInstallPlan(host: Host, ctx: DeployContext, cwd: string, out: string | undefined): Promise<number> {
  const plan = await buildInstallPlan(ctx, VERSION)
  const text = `${JSON.stringify(plan, null, 2)}\n`
  if (out === '-') {
    process.stdout.write(text)
    return 0
  }
  const path = out ? resolve(cwd, out) : join(ctx.stateDir, 'install-plan.json')
  await host.mkdir(dirname(path), 0o700)
  await host.writeFile(path, text, 0o600)
  host.out.ok(`install plan written to ${path} (data only: root validates it, never runs your code)`)
  host.out.info(`root will: give ${ctx.stateDir.startsWith('/var/lib/basalt/') ? ctx.stateDir : `/var/lib/basalt/${plan.app}`} to you (0700)${plan.envFiles.length ? `, give ${plan.envFiles.join(', ')} to you (0600)` : ''}${plan.proxy.kind !== 'none' && plan.proxy.managed ? `, write the ${plan.proxy.kind} site for ${plan.domain} → 127.0.0.1:${plan.port}` : ''}`)
  const user = host.env['USER'] && USER_NAME.test(host.env['USER']) ? host.env['USER'] : '<this user>'
  host.out.info('then, as an administrator (a pinned copy root owns, never this checkout\'s):')
  host.out.info(`  ${rootInstallCommand(VERSION, path, user)}`)
  host.out.result?.('install-plan', { plan, path, rootCommand: rootInstallCommand(VERSION, path, user) })
  return 0
}

/** Loads deploy.config.ts with the app's own tsx when it has one, else Node's type stripping. */
export async function loadConfig(dir: string, file: string): Promise<DeployConfig> {
  const path = isAbsolute(file) ? file : resolve(dir, file)
  if (/\.[cm]?ts$/.test(path)) {
    try {
      const tsx = createRequire(join(dir, 'package.json')).resolve('tsx/esm/api')
      const api = (await import(pathToFileURL(tsx).href)) as { register?: () => unknown }
      api.register?.()
    } catch {
      // No tsx in the app: Node ≥ 22.18 strips types on its own.
    }
  }
  let loaded: { default?: DeployConfig; config?: DeployConfig }
  try {
    loaded = (await import(pathToFileURL(path).href)) as typeof loaded
  } catch (error) {
    throw new DeployConfigError([`cannot load ${file}: ${(error as Error).message}`])
  }
  const config = loaded.default ?? loaded.config
  if (!config || typeof config !== 'object') throw new DeployConfigError([`${file} must export default defineDeploy({ … })`])
  return config
}

export async function createContext(host: Host, dir: string, config: DeployConfig): Promise<DeployContext> {
  const envPath = resolve(dir, config.env.file ?? '.env')
  const text = await host.readFile(envPath)
  return {
    config,
    dir,
    host,
    pm: await detectPackageManager(host, dir),
    envPath,
    stateDir: await resolveStateDir(host, config, dir),
    // What compose interpolation reads for passEnv in plan, status, rollback.
    ...(text === undefined ? {} : { values: envValues(parseEnv(text)) }),
  }
}

/** The process's own stdin and stdout, which the machine protocol uses (RFC 0008 §3.3). */
export interface CliIO {
  /** stdout as it was before anything replaced `process.stdout.write`. */
  write(text: string): void
  stdin(): AsyncIterable<string | Uint8Array>
  /** Turns writes to `process.stdout` into `sink` calls, until the returned function is called. */
  capture(sink: (text: string) => void): () => void
  /** One plain line on stderr: the event writer itself failed. */
  stderr(text: string): void
}

/** Streams whose reader is gone (EPIPE): written to no more. */
const broken = new WeakSet<object>()
const watched = new WeakSet<object>()

export function processIO(stream: NodeJS.WritableStream = process.stdout, input: AsyncIterable<string | Uint8Array> = process.stdin): CliIO {
  const original = stream.write.bind(stream) as (text: string) => boolean
  if (!watched.has(stream)) {
    watched.add(stream)
    // The SSH client gone: never a crash mid-migration; the run log keeps every event.
    stream.on('error', (error: NodeJS.ErrnoException) => { if (error.code === 'EPIPE') broken.add(stream) })
  }
  return {
    write(text) {
      if (broken.has(stream)) return
      try {
        original(text)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EPIPE') throw error
        broken.add(stream)
      }
    },
    stdin: () => input,
    capture(sink) {
      const previous = stream.write
      stream.write = ((chunk: string | Uint8Array, encoding?: unknown, callback?: unknown) => {
        sink(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
        const done = typeof encoding === 'function' ? encoding : callback
        if (typeof done === 'function') queueMicrotask(() => (done as () => void)())
        return true
      }) as typeof stream.write
      return () => { stream.write = previous }
    },
    stderr: (text) => { process.stderr.write(text) },
  }
}

export async function main(argv: string[], host: Host = nodeHost(), cwd: string = process.cwd(), io: CliIO = processIO()): Promise<number> {
  const flags = parse(argv)
  if (flags.switches.has('json') || flags.values.has('json')) return machine(flags, host, cwd, io)
  if (flags.switches.has('help') || !flags.command || flags.command === 'help') {
    process.stdout.write(USAGE)
    return flags.command && flags.command !== 'help' ? 1 : 0
  }
  return session(flags, host, cwd, humanReporter(host.out))
}

/** What a `--json` session adds to a command (RFC 0008). */
interface Machine {
  json: JsonSession
  writer: EventWriter
  io: CliIO
  /** A detached child (`--run-id` with the marker): its stdout is its run log. */
  child: boolean
  channel?: AnswerChannel
}

/** `--json`: hello first, done last, nothing else on stdout. */
async function machine(flags: Flags, base: Host, cwd: string, io: CliIO): Promise<number> {
  const redactor = new Redactor()
  const given = flags.values.get('run-id')
  const child = given !== undefined && RUN_ID.test(given) && base.env[DETACHED_CHILD_ENV] === '1' && (flags.command === 'run' || flags.command === 'rollback')
  const runId = child ? given : LOCKED.has(flags.command) && !flags.switches.has('detach') ? newRunId(base) : undefined
  const writer = new EventWriter({
    now: () => base.now(),
    stdout: (line) => io.write(line),
    redactor,
    ...(runId ? { runId } : {}),
    stdoutIsRunLog: child,
    expectRunLog: Boolean(runId) && !child,
    onFailure: (message) => io.stderr(`${message}\n`),
  })
  writer.emit({
    type: 'hello', tool: '@basaltkit/deploy', version: VERSION, protocol: 1, command: flags.command, pid: base.pid(), host: base.hostname(),
    ...(child || flags.switches.has('detach') ? { detached: true as const } : {}),
  })
  const timeout = Number(flags.values.get('answer-timeout'))
  const json = jsonHost(base, writer, redactor, { answerTimeoutMs: (Number.isInteger(timeout) && timeout >= 1 && timeout <= 3600 ? timeout : ANSWER_TIMEOUT_SECONDS) * 1000 })
  // deploy.config.ts runs in this process: what it prints is data, never an event.
  const restore = io.capture(foreignSink(writer, () => json.output.current))
  let code: number
  try {
    code = await session(flags, json.host, cwd, writer, { json, writer, io, child })
  } finally {
    restore()
  }
  // attach ends with the run's own exit code; the run's error is in what it replayed.
  if (code !== 0 && !writer.last.error && flags.command !== 'attach') writer.emit(outcomeError(flags.command, writer))
  writer.emit({ type: 'done', exitCode: code })
  writer.close()
  return code
}

/** A command that ended non-zero without throwing says why, with a code (the terminal already read it). */
function outcomeError(command: string, writer: EventWriter): EventBody {
  const result = writer.last.result as { data?: { note?: string; findings?: Array<{ level: string }> } } | undefined
  switch (command) {
    case 'run':
    case 'rollback':
      return { type: 'error', code: 'release-failed', message: result?.data?.note ?? `${command} did not end with a healthy release` }
    case 'plan':
      return { type: 'error', code: 'preflight', message: 'plan: the problems above would stop a run' }
    default:
      return { type: 'error', code: 'failed', message: `${command} failed` }
  }
}

/** The flags that only make sense together (RFC 0008 §3.2); refused before anything runs. */
function checkFlags(flags: Flags, json: boolean, env: Host['env']): void {
  const via = flags.values.get('via')
  if (via !== undefined && via !== 'ui') throw usage('--via takes only ui')
  const protocolOnly = ['answers', 'answer-timeout', 'detach', 'from-seq', 'follow', 'run-id']
  if (!json) {
    for (const name of protocolOnly) if (flags.values.has(name) || flags.switches.has(name)) throw usage(`--${name} needs --json`)
    if (flags.command === 'attach') throw usage('attach speaks only --json: its output is the run\'s events')
    if (flags.command === 'cancel' && !flags.args[0]) throw usage('cancel <runId>')
    return
  }
  const version = flags.values.get('json')
  if (version !== undefined && version !== '1') throw new DeployError(`--json=${version}: this basalt-deploy ${VERSION} speaks protocol 1`, [], 'protocol-version')
  const { command } = flags
  if (command === 'init' || command === 'install' || command === 'bootstrap') {
    throw new DeployError(`${command} does not speak --json: ${command === 'init' ? 'it writes code into the checkout' : 'root\'s confirmations are the control, never a pipe'}`, [], 'unsupported')
  }
  if (flags.switches.has('help') || !command || !COMMANDS.includes(command)) throw usage(command && !flags.switches.has('help') ? `unknown command "${command}"` : 'a command is needed', 'basalt-deploy --help lists them')
  if (flags.switches.has('answers') || (flags.values.has('answers') && flags.values.get('answers') !== 'stdin')) throw usage('--answers takes only stdin')
  if (flags.values.has('answers') && command !== 'run' && command !== 'env') throw usage(`${command} asks nothing: --answers is for run and env`)
  if (flags.values.has('answer-timeout') || flags.switches.has('answer-timeout')) {
    if (!flags.values.has('answers')) throw usage('--answer-timeout needs --answers=stdin')
    if (!/^\d{1,4}$/.test(flags.values.get('answer-timeout') ?? '') || Number(flags.values.get('answer-timeout')) < 1 || Number(flags.values.get('answer-timeout')) > 3600) throw usage('--answer-timeout takes 1 to 3600 seconds')
  }
  if ((flags.switches.has('detach') || flags.values.has('detach')) && command !== 'run' && command !== 'rollback') throw usage(`${command} does not detach: only run and rollback`)
  if ((flags.values.has('from-seq') || flags.switches.has('follow')) && command !== 'attach') throw usage('--from-seq and --follow are for attach')
  if (flags.values.has('from-seq') && !/^\d{1,15}$/.test(flags.values.get('from-seq') ?? '')) throw usage('--from-seq takes a whole number')
  if (flags.values.has('run-id') || flags.switches.has('run-id')) {
    if (env[DETACHED_CHILD_ENV] !== '1') throw usage('--run-id is set by run --detach, never by hand')
    if (!RUN_ID.test(flags.values.get('run-id') ?? '') || (command !== 'run' && command !== 'rollback') || flags.switches.has('detach')) throw usage('--run-id is malformed or misplaced')
  }
  if (command === 'install-plan' && flags.values.get('out') === '-') throw usage('install-plan --json: the plan is in the result event, not on stdout (--out=- is refused)')
  if ((command === 'attach' || command === 'cancel') && !flags.args[0]) throw usage(`${command} <runId>`)
}

/** The flags a detached child gets again — never an answer. */
function forwarded(flags: Flags): string[] {
  const out: string[] = []
  for (const name of ['actor', 'via', 'skip', 'to', 'config', 'overrides']) {
    const value = flags.values.get(name)
    if (value !== undefined) out.push(`--${name}=${value}`)
  }
  for (const name of ['unhold', 'no-fetch', 'allow-root']) if (flags.switches.has(name)) out.push(`--${name}`)
  if (flags.values.has('answers')) out.push('--answers=stdin')
  return out
}

/** One command, as the terminal and the protocol both run it; `reporter` says how it ended. */
async function session(flags: Flags, host: Host, cwd: string, reporter: Reporter, machine?: Machine): Promise<number> {
  try {
    checkFlags(flags, machine !== undefined, host.env)
    const skip: Skippable[] = []
    for (const name of (flags.values.get('skip') ?? '').split(',').filter(Boolean)) {
      if (!(SKIPPABLE as readonly string[]).includes(name)) throw usage(`--skip=${name}: only ${SKIPPABLE.join(', ')} can be skipped`)
      skip.push(name as Skippable)
    }
    if (flags.switches.has('no-fetch')) skip.push('fetch')

    const file = flags.values.get('config') ?? 'deploy.config.ts'
    // Root's commands: never deploy.config.ts, never the checkout's code.
    if (flags.command === 'bootstrap' || flags.command === 'install') {
      if (host.uid() === 0) await assertTrustedTool(host, flags.switches.has('unsafe-tool'))
      if (flags.command === 'install') {
        const planPath = flags.values.get('plan')
        if (!planPath) {
          throw new DeployError(`install reads a plan, never deploy.config.ts: as the app user, in the checkout, run \`${INSTALL_COMMAND}\` — it writes the plan and prints the root command`)
        }
        if (!isAbsolute(planPath)) throw new DeployError('--plan takes an absolute path')
        return await install(host, await readInstallPlan(host, planPath), flags.values.get('user') ?? host.env['SUDO_USER'])
      }
      const proxy = flags.values.get('proxy')
      if (proxy !== undefined && proxy !== 'apache' && proxy !== 'caddy' && proxy !== 'none') throw new DeployError('--proxy is apache, caddy or none')
      const swap = flags.values.get('swap-gb')
      if (swap !== undefined && !/^\d{1,2}$/.test(swap)) throw new DeployError('--swap-gb takes a whole number of GB')
      // Never the working directory: root's commands run from `cd /`, and bootstrap may chown -R it.
      const dirFlag = flags.values.get('dir')
      if (!dirFlag || !isAbsolute(dirFlag)) throw new DeployError('bootstrap needs --dir=<checkout>, an absolute path (the app user\'s clone of the app) — it is never taken from the working directory')
      return await bootstrap(host, dirFlag, {
        user: flags.values.get('user') ?? host.env['SUDO_USER'],
        ...(proxy ? { proxy } : {}),
        ...(swap === undefined ? {} : { swapGb: Number(swap) }),
        ...(flags.switches.has('no-firewall') ? { firewall: false } : {}),
        dryRun: flags.switches.has('dry-run'),
      }, VERSION)
    }
    // Every command below loads deploy.config.ts — code the app user can
    // change. As root that would be the app user's code running as root.
    const allowRoot = flags.switches.has('allow-root')
    refuseRoot(host, flags.command, allowRoot)
    if (flags.command === 'init') {
      const written = await init(host, cwd, flags.values, flags.switches)
      if (written !== 0) return written
      const created = validateConfig(await loadConfig(cwd, file))
      return await check(host, cwd, file, created)
    }
    let config = await loadConfig(cwd, file)
    validateConfig(config)
    if (flags.command === 'check') return await check(host, cwd, file, config)
    const overridesPath = flags.values.get('overrides') ?? `/etc/basalt/${config.app}.json`
    const overrides = await host.readFile(overridesPath)
    if (overrides !== undefined) config = validateConfig(applyOverrides(config, parseOverrides(overrides, overridesPath)))
    if (machine) prepareMachine(machine, flags, config, cwd)
    const ctx = await createContext(host, cwd, config)
    const via = flags.values.get('via') === 'ui' ? { via: 'ui' as const } : {}
    const actor = { ...(flags.values.has('actor') ? { actor: flags.values.get('actor') as string } : {}), allowRoot, ...via }
    const detaching = machine !== undefined && flags.switches.has('detach')
    const options: RunOptions = { ...actor, ...(machine && LOCKED.has(flags.command) && !detaching ? { protocol: await protocolHooks(machine, ctx) } : {}) }
    const detachRequest = (command: 'run' | 'rollback') => ({
      command, forward: forwarded(flags), ...(machine?.channel ? { answers: machine.channel } : {}),
      execPath: process.execPath, binPath: fileURLToPath(new URL('./bin.js', import.meta.url)),
    })

    switch (flags.command) {
      case 'plan': return await plan(ctx, { skip })
      case 'run':
        if (detaching) return await detach(ctx, detachRequest('run'), reporter)
        return await run(ctx, { ...options, skip, unhold: flags.switches.has('unhold') })
      case 'env': return await envCommand(ctx, options)
      case 'rollback':
        if (detaching) return await detach(ctx, detachRequest('rollback'), reporter)
        return await rollback(ctx, flags.values.get('to'), options)
      case 'status': return await status(ctx)
      case 'install-plan': return await writeInstallPlan(host, ctx, cwd, flags.values.get('out'))
      case 'attach': {
        const runId = flags.args[0] as string
        const exit = await attach(host, ctx.stateDir, runId, {
          fromSeq: Number(flags.values.get('from-seq') ?? 0),
          follow: flags.switches.has('follow'),
          emit: (event) => reporter.emit({ type: 'event', event }),
        })
        if (exit !== undefined) return exit
        host.out.info(`run ${runId} is still running: attach --follow waits for its end`)
        return 0
      }
      case 'cancel': {
        const runId = flags.args[0] as string
        const sent = await cancel(host, ctx.stateDir, runId)
        host.out.ok(`SIGTERM sent to run ${runId} (pid ${sent.pid})${sent.second ? ' — the second one: it stops at once, mid-step, and leaves a stale lock' : ' — it stops at the next safe point'}`)
        host.out.result?.('cancel', { runId, pid: sent.pid, signal: 'SIGTERM', second: sent.second })
        return 0
      }
      default:
        host.out.error(`unknown command "${flags.command}"`)
        process.stdout.write(USAGE)
        return 1
    }
  } catch (error) {
    return reportError(error, reporter, host.env['BASALT_DEBUG'] !== undefined && host.env['BASALT_DEBUG'] !== '')
  }
}

/** The config is known: the redactor learns its secret keys, the answers start being read. */
function prepareMachine(machine: Machine, flags: Flags, config: DeployConfig, cwd: string): void {
  machine.json.watchEnv(config, cwd)
  if (!flags.values.has('answers') || machine.channel) return
  const channel = new AnswerChannel(askedQuestions(config.env.ask as Record<string, { secret: boolean }> | undefined), (key, value) => machine.json.secret(key, value))
  channel.start(machine.io.stdin())
  machine.json.useAnswers(channel)
  machine.channel = channel
}

/** A locked command under --json: its run log, the answers checked before the lock, retention after it. */
async function protocolHooks(machine: Machine, ctx: DeployContext): Promise<ProtocolHooks> {
  const { writer, channel, child } = machine
  const runId = writer.runId
  if (runId && !child) {
    if (ctx.host.createLog) machine.writer.attachLog((await createRunLog(ctx.host, ctx.stateDir, runId)).handle)
    else writer.dropBacklog()
  }
  return {
    ...(runId ? { runId } : {}),
    beforeLock: async () => {
      // A detached child's answers are complete (the parent closed its stdin); an attended run's may still come.
      if (channel) await (child ? channel.drain() : channel.settle())
    },
    afterLock: async () => {
      if (runId && ctx.host.readFileRange) await pruneRunLogs(ctx.host, ctx.stateDir, runId)
    },
    afterAnswers: () => {
      for (const key of channel?.finish() ?? []) ctx.host.out.warn(`the answer for ${key} was not needed (already in the .env, or given by the environment): dropped`)
    },
  }
}

/** Every failure, as an `error` event and its exit code — the terminal shows the message, as it always did. */
function reportError(error: unknown, reporter: Reporter, debug: boolean): number {
  // Distinct codes a wrapper (cron, CI) can act on: 3 = another deploy holds the lock.
  if (error instanceof DeployLockedError) {
    reporter.emit({ type: 'error', code: 'locked', message: error.message, ...(error.holder ? { holder: error.holder } : {}) })
    return EXIT_LOCKED
  }
  if (error instanceof DeployAbortedError) {
    reporter.emit({ type: 'error', code: 'aborted', message: error.message })
    return EXIT_ABORTED
  }
  if (error instanceof DeployError) {
    const code: ErrorCode = error.code && isErrorCode(error.code) ? error.code : 'failed'
    reporter.emit({
      type: 'error', code, message: error.message,
      ...(error.hint ? { hint: error.hint } : {}),
      ...(error.findings.length ? { findings: error.findings } : {}),
    })
    return 1
  }
  if (error instanceof DeployConfigError) {
    reporter.emit({ type: 'error', code: 'config', message: error.message })
    return 1
  }
  // Anything else is a bug or an environment we did not foresee: say what
  // failed, keep the stack for BASALT_DEBUG=1.
  reporter.emit({ type: 'error', code: 'unexpected', message: `unexpected: ${(error as Error).message ?? String(error)}` })
  if (debug) reporter.emit({ type: 'log', stream: 'tool', level: 'info', text: (error as Error).stack ?? '', redacted: false })
  return 1
}
