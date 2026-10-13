import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { bootstrap } from './bootstrap.js'
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
import { envCommand, plan, refuseRoot, rollback, run, SKIPPABLE, status, type Skippable } from './pipeline.js'

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

As root, with a copy of the tool root owns — never the checkout's node_modules:
  cd / && sudo -H npx --yes --package=@basaltkit/deploy@<exact version> -- basalt-deploy <command>
  bootstrap --user=<name> [--dir=<checkout>] [--dry-run] [--proxy=…] [--swap-gb=<n>] [--no-firewall]
                     a fresh Ubuntu/Debian server, once: Docker, Node, pnpm; as the user
                     pnpm install, env, install-plan; then swap, ufw, Caddy and install
  install --plan=<file> --user=<name>
                     once per server: state directory, proxy site, env file ownership

Run the app user's commands with \`node\`, not \`pnpm exec\`: pnpm ≥ 12 may rewrite
pnpm-lock.yaml on any command it runs. As root, nothing loads deploy.config.ts.

Exit codes: 0 done · 1 failed (or refused) · 3 another deploy holds the lock · 130 stopped by a signal

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
  values: Map<string, string>
  switches: Set<string>
}

function parse(argv: string[]): Flags {
  const values = new Map<string, string>()
  const switches = new Set<string>()
  let command = ''
  for (const arg of argv) {
    if (arg === '-h' || arg === '--help') { switches.add('help'); continue }
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg)
    if (match) {
      if (match[2] === undefined) switches.add(match[1] as string)
      else values.set(match[1] as string, match[2])
      continue
    }
    if (!command) command = arg
  }
  return { command, values, switches }
}

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

export async function main(argv: string[], host: Host = nodeHost(), cwd: string = process.cwd()): Promise<number> {
  const flags = parse(argv)
  if (flags.switches.has('help') || !flags.command || flags.command === 'help') {
    process.stdout.write(USAGE)
    return flags.command && flags.command !== 'help' ? 1 : 0
  }
  const skip: Skippable[] = []
  for (const name of (flags.values.get('skip') ?? '').split(',').filter(Boolean)) {
    if (!(SKIPPABLE as readonly string[]).includes(name)) {
      host.out.error(`--skip=${name}: only ${SKIPPABLE.join(', ')} can be skipped`)
      return 1
    }
    skip.push(name as Skippable)
  }
  if (flags.switches.has('no-fetch')) skip.push('fetch')

  try {
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
      const dirFlag = flags.values.get('dir')
      return await bootstrap(host, dirFlag ? resolve(cwd, dirFlag) : cwd, {
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
    const ctx = await createContext(host, cwd, config)
    const actor = { ...(flags.values.has('actor') ? { actor: flags.values.get('actor') as string } : {}), allowRoot }

    switch (flags.command) {
      case 'plan': return await plan(ctx, { skip })
      case 'run': return await run(ctx, { ...actor, skip, unhold: flags.switches.has('unhold') })
      case 'env': return await envCommand(ctx, actor)
      case 'rollback': return await rollback(ctx, flags.values.get('to'), actor)
      case 'status': return await status(ctx)
      case 'install-plan': return await writeInstallPlan(host, ctx, cwd, flags.values.get('out'))
      default:
        host.out.error(`unknown command "${flags.command}"`)
        process.stdout.write(USAGE)
        return 1
    }
  } catch (error) {
    // Distinct codes a wrapper (cron, CI) can act on: 3 = another deploy holds the lock.
    if (error instanceof DeployLockedError) {
      host.out.error(error.message)
      return EXIT_LOCKED
    }
    if (error instanceof DeployAbortedError) {
      host.out.error(error.message)
      return EXIT_ABORTED
    }
    if (error instanceof DeployError) {
      host.out.error(error.message)
      return 1
    }
    if (error instanceof DeployConfigError) {
      host.out.error(error.message)
      return 1
    }
    // Anything else is a bug or an environment we did not foresee: say what
    // failed, keep the stack for BASALT_DEBUG=1.
    host.out.error(`unexpected: ${(error as Error).message ?? String(error)}`)
    if (host.env['BASALT_DEBUG']) host.out.info((error as Error).stack ?? '')
    return 1
  }
}

