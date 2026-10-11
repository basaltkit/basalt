import { createRequire } from 'node:module'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { applyOverrides, DeployConfigError, parseOverrides, validateConfig, type DeployConfig } from './config.js'
import { DeployError, detectPackageManager, resolveStateDir, type DeployContext } from './context.js'
import { nodeHost, type Host } from './host.js'
import { envCommand, install, plan, rollback, run, SKIPPABLE, status, type Skippable } from './pipeline.js'

export const USAGE = `basalt-deploy — deploy this Basalt app on this server (RFC 0006)

  basalt-deploy plan              what a run would do; changes nothing
  basalt-deploy run               fetch, .env, infra, build, backup, migrate, restart, health
  basalt-deploy env               the .env and the dedicated infra only (first setup)
  basalt-deploy rollback [--to=<sha>]   back to the last healthy release (code only)
  basalt-deploy status            the last releases and the process
  sudo basalt-deploy install --user=<name>   once per server: vhost, state directory

Options:
  --config=<file>     default deploy.config.ts
  --overrides=<file>  server-local values, default /etc/basalt/<app>.json
  --skip=<steps>      ${SKIPPABLE.join(', ')} (comma-separated); --no-fetch = --skip=fetch
  -h, --help
`

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
  return {
    config,
    dir,
    host,
    pm: await detectPackageManager(host, dir),
    envPath: join(dir, config.env.file ?? '.env'),
    stateDir: await resolveStateDir(host, config, dir),
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
    let config = await loadConfig(cwd, flags.values.get('config') ?? 'deploy.config.ts')
    validateConfig(config)
    const overridesPath = flags.values.get('overrides') ?? `/etc/basalt/${config.app}.json`
    const overrides = await host.readFile(overridesPath)
    if (overrides !== undefined) config = validateConfig(applyOverrides(config, parseOverrides(overrides, overridesPath)))
    const ctx = await createContext(host, cwd, config)

    switch (flags.command) {
      case 'plan': return await plan(ctx, { skip })
      case 'run': return await run(ctx, { skip })
      case 'env': return await envCommand(ctx)
      case 'rollback': return await rollback(ctx, flags.values.get('to'))
      case 'status': return await status(ctx)
      case 'install': return await install(ctx, flags.values.get('user') ?? host.env['SUDO_USER'])
      default:
        host.out.error(`unknown command "${flags.command}"`)
        process.stdout.write(USAGE)
        return 1
    }
  } catch (error) {
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

