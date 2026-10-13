import { isAbsolute, join, resolve } from 'node:path'
import type { DeployConfig } from './config.js'
import type { Host } from './host.js'
import type { CheckResult } from './protocol.js'

/**
 * `basalt-deploy check` — the config is valid and types against the app's own
 * env, without touching the server (RFC 0007 §2.2). What CI runs.
 *
 * The runtime checks already ran (the config loaded and `validateConfig`
 * passed). The types are the app's `tsc` on `deploy.config.ts`, with the app's
 * tsconfig but this one file as the only root: an app whose tsconfig covers
 * `src/` only still gets its deploy config checked.
 */
export async function check(host: Host, dir: string, file: string, config: DeployConfig): Promise<number> {
  const started = host.now().getTime()
  let types: CheckResult['types'] | undefined
  try {
    types = await checkTypes(host, dir, file, config)
  } finally {
    // Every step that starts ends, also when checkTypes throws (a read-only checkout).
    host.out.stepEnd?.('check', types === undefined || types === 'failed' ? 'failed' : 'ok', host.now().getTime() - started)
  }
  host.out.result?.('check', { file, app: config.app, runtime: config.runtime.kind, ...(config.proxy ? { proxy: config.proxy.kind } : {}), types })
  return types === 'failed' ? 1 : 0
}

async function checkTypes(host: Host, dir: string, file: string, config: DeployConfig): Promise<CheckResult['types']> {
  host.out.step('check', 'check')
  host.out.ok(`${file}: valid for ${config.app} (${config.runtime.kind}${config.proxy ? `, ${config.proxy.kind}` : ''})`)
  const path = isAbsolute(file) ? file : resolve(dir, file)
  if (!/\.[cm]?ts$/.test(path)) {
    host.out.info('not TypeScript: no types to check')
    return 'not-typescript'
  }
  const tsc = join(dir, 'node_modules', '.bin', 'tsc')
  if (!(await host.stat(tsc))) {
    host.out.warn(`types not checked: no ${tsc} (add typescript to the app's devDependencies)`)
    return 'no-tsc'
  }
  const base = join(dir, 'tsconfig.json')
  const project = {
    ...((await host.stat(base)) ? { extends: base } : {}),
    compilerOptions: {
      noEmit: true, rootDir: dir, composite: false, incremental: false, declaration: false,
      ...((await host.stat(base)) ? {} : { strict: true, module: 'nodenext', moduleResolution: 'nodenext', target: 'es2022', skipLibCheck: true }),
    },
    files: [path],
    include: [],
  }
  // Inside the app's node_modules (ignored by git): tsc finds `types` such as
  // `node` in node_modules/@types of the tsconfig's directory and its parents.
  const cache = join(dir, 'node_modules', '.cache')
  await host.mkdir(cache, 0o755)
  const tsconfig = join(cache, `basalt-deploy-check-${host.randomHex(6)}.json`)
  await host.writeFile(tsconfig, JSON.stringify(project, null, 2), 0o600)
  try {
    const result = await host.exec(tsc, ['-p', tsconfig, '--pretty', 'false'], { cwd: dir })
    if (result.code === 0) {
      host.out.ok(`${file}: types check`)
      return 'ok'
    }
    const errors = `${result.stdout}${result.stderr}`.trim().split('\n').filter(Boolean)
    for (const line of errors) host.out.error(line.startsWith(dir) ? line.slice(dir.length + 1) : line)
    return 'failed'
  } finally {
    await host.remove(tsconfig)
  }
}
