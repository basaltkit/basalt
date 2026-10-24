import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ENV_PRELOAD } from '../src/pm2.js'

// The preload runs in real node: what pm2 starts, and what pm2 itself is.
const dir = mkdtempSync(join(tmpdir(), 'basalt-preload-'))
const file = join(dir, 'app.env')
writeFileSync(file, 'SECRET=from-file\nNODE_ENV=development\n')
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const SHOW = 'console.log(JSON.stringify({ secret: process.env.SECRET ?? null, nodeEnv: process.env.NODE_ENV ?? null }))'

function node(env: Record<string, string>, program = SHOW) {
  const result = spawnSync(process.execPath, ['-e', program], {
    env: { PATH: process.env['PATH'] ?? '', NODE_OPTIONS: ENV_PRELOAD, ...env },
    encoding: 'utf8',
  })
  return { code: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() }
}

describe('ENV_PRELOAD', () => {
  it('loads the env.file in a process pm2 manages (pm_id), and an exported variable still wins', () => {
    const run = node({ BASALT_ENV_FILE: file, pm_id: '0', NODE_ENV: 'production' })
    expect(run.code).toBe(0)
    expect(JSON.parse(run.stdout)).toEqual({ secret: 'from-file', nodeEnv: 'production' })
  })

  it('loads nothing outside pm2-managed processes: the pm2 CLI and daemon never hold the values', () => {
    const run = node({ BASALT_ENV_FILE: file })
    expect(JSON.parse(run.stdout)).toEqual({ secret: null, nodeEnv: null })
  })

  it('stops the app with one line when the file cannot be read, never a boot without its secrets', () => {
    const run = node({ BASALT_ENV_FILE: join(dir, 'missing.env'), pm_id: '0' })
    expect(run.code).toBe(1)
    expect(run.stdout).toBe('')
    expect(run.stderr).toBe(`[basalt-deploy] env.file ${join(dir, 'missing.env')} is not readable (ENOENT)`)
  })

  it('reaches the processes the app starts (pnpm run → node, workers)', () => {
    const child = `require('node:child_process').execFileSync(process.execPath, ['-e', ${JSON.stringify(SHOW)}], { stdio: 'inherit' })`
    const run = node({ BASALT_ENV_FILE: file, pm_id: '0' }, child)
    expect(JSON.parse(run.stdout)).toMatchObject({ secret: 'from-file' })
  })
})
