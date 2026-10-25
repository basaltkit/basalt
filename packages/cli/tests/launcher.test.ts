import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { detectPackageManager, findProject, LAUNCHER_ENV, launchCommand, runLauncher } from '../src/launcher.js'

const base = mkdtempSync(join(tmpdir(), 'basalt-launcher-'))
afterAll(() => rmSync(base, { recursive: true, force: true }))

let count = 0
/** A fresh directory with these files (`package.json` given as an object). */
function project(files: Record<string, string | object>): string {
  const dir = join(base, `p${(count += 1)}`)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), typeof content === 'string' ? content : JSON.stringify(content))
  }
  mkdirSync(dir, { recursive: true })
  return dir
}

const lines = () => {
  const out: string[] = []
  return { out, push: (line: string) => out.push(line) }
}

describe('findProject', () => {
  it('finds the nearest package.json with a basalt script, from a subdirectory', () => {
    const dir = project({ 'package.json': { scripts: { basalt: 'tsx bin/basalt.ts' } }, 'pnpm-lock.yaml': '', 'src/modules/x.ts': '' })
    expect(findProject(join(dir, 'src', 'modules'))).toEqual({ root: dir, script: 'tsx bin/basalt.ts', pm: 'pnpm' })
  })

  it('skips a package.json without the script (a workspace root, a nested package) and keeps walking', () => {
    const dir = project({
      'package.json': { scripts: { basalt: 'create-basalt --project' } },
      'web/package.json': { scripts: { dev: 'vite' } },
      'broken/package.json': '{ not json',
    })
    expect(findProject(join(dir, 'web'))?.root).toBe(dir)
    expect(findProject(join(dir, 'broken'))?.root).toBe(dir)
  })

  it('finds nothing outside an app, and ignores an empty script', () => {
    expect(findProject(project({ 'package.json': { scripts: { basalt: ' ' } } }))).toBeUndefined()
  })
})

describe('detectPackageManager', () => {
  it('reads packageManager before any lockfile', () => {
    expect(detectPackageManager(project({ 'package.json': { packageManager: 'bun@1.2.0' }, 'package-lock.json': '' }))).toBe('bun')
  })

  it('reads the lockfile of each kind', () => {
    expect(detectPackageManager(project({ 'package.json': {}, 'pnpm-lock.yaml': '' }))).toBe('pnpm')
    expect(detectPackageManager(project({ 'package.json': {}, 'yarn.lock': '' }))).toBe('yarn')
    expect(detectPackageManager(project({ 'package.json': {}, 'bun.lock': '' }))).toBe('bun')
    expect(detectPackageManager(project({ 'package.json': {}, 'package-lock.json': '' }))).toBe('npm')
  })

  it('uses the workspace manager for an app inside a workspace, and npm when nothing says', () => {
    const workspace = project({ 'package.json': { packageManager: 'pnpm@12.11.2' }, 'apps/api/package.json': { scripts: { basalt: 'x' } } })
    expect(detectPackageManager(join(workspace, 'apps', 'api'))).toBe('pnpm')
    expect(detectPackageManager(project({ 'package.json': {} }))).toBe('npm')
  })
})

describe('launchCommand', () => {
  it('passes the arguments through as given — npm alone needs a -- first', () => {
    const args = ['ai:make', 'an invoices module', '--dry-run', '--', 'x']
    expect(launchCommand('pnpm', args)).toEqual({ command: 'pnpm', args: ['run', '--silent', 'basalt', ...args] })
    expect(launchCommand('npm', args)).toEqual({ command: 'npm', args: ['run', '--silent', 'basalt', '--', ...args] })
    expect(launchCommand('yarn', args)).toEqual({ command: 'yarn', args: ['run', 'basalt', ...args] })
    expect(launchCommand('bun', args)).toEqual({ command: 'bun', args: ['run', 'basalt', ...args] })
  })
})

describe('runLauncher', () => {
  it('outside an app: says so with the way out, and exits 1', async () => {
    const error = lines()
    expect(await runLauncher(['ai:make', 'x'], { cwd: project({}), error: error.push })).toBe(1)
    expect(error.out[0]).toContain('no Basalt app here')
    expect(error.out.join('\n')).toContain('npm create basalt@latest')
  })

  it('outside an app, --version prints the launcher version', async () => {
    const log = lines()
    expect(await runLauncher(['--version'], { cwd: project({}), log: log.push })).toBe(0)
    expect(log.out[0]).toMatch(/^basalt launcher \d+\.\d+\.\d+ \(@basaltkit\/cli\)$/)
  })

  it('refuses a basalt script that would call the launcher again', async () => {
    const dir = project({ 'package.json': { scripts: { basalt: 'basalt' } } })
    const error = lines()
    expect(await runLauncher([], { cwd: dir, env: { ...process.env, [LAUNCHER_ENV]: dir }, error: error.push })).toBe(1)
    expect(error.out[0]).toContain('runs `basalt` again')
  })

  const show = [
    "const { writeFileSync } = require('node:fs')",
    'writeFileSync(process.env.OUT, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), root: process.env.' + LAUNCHER_ENV + ' }))',
    'process.exit(Number(process.env.CODE ?? 0))',
  ].join('\n')

  async function realRun(pm: 'npm' | 'pnpm', code: number) {
    const dir = project({
      'package.json': { name: 'acme', private: true, scripts: { basalt: 'node show.cjs' } },
      [pm === 'npm' ? 'package-lock.json' : 'pnpm-lock.yaml']: pm === 'npm' ? '{}' : '',
      'show.cjs': show,
      'src/deep/.keep': '',
    })
    const out = join(dir, 'seen.json')
    const exit = await runLauncher(['ai:make', 'an invoices module', '--dry-run', '--', 'x'], {
      cwd: join(dir, 'src', 'deep'),
      env: { ...process.env, OUT: out, CODE: String(code) },
    })
    return { dir, exit, seen: JSON.parse(readFileSync(out, 'utf8')) as { argv: string[]; cwd: string; root: string } }
  }

  it('runs the app\'s basalt script through npm, from a subdirectory, with the arguments and the exit code intact', async () => {
    const { dir, exit, seen } = await realRun('npm', 3)
    expect(exit).toBe(3)
    expect(seen.argv).toEqual(['ai:make', 'an invoices module', '--dry-run', '--', 'x'])
    expect(seen.root).toBe(dir)
  }, 30_000)

  const hasPnpm = spawnSync('pnpm', ['--version'], { encoding: 'utf8' }).status === 0
  it.skipIf(!hasPnpm)('does the same through pnpm', async () => {
    const { exit, seen } = await realRun('pnpm', 0)
    expect(exit).toBe(0)
    expect(seen.argv).toEqual(['ai:make', 'an invoices module', '--dry-run', '--', 'x'])
  }, 30_000)
})
