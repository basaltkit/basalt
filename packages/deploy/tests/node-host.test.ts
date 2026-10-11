import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { DeployContext } from '../src/context.js'
import { checkSchema } from '../src/env-check.js'
import { nodeHost, type Output } from '../src/host.js'
import { lexfirmaConfig } from './fake-host.js'

const quiet: Output = { step() {}, info() {}, ok() {}, warn() {}, error() {} }
let dir: string
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'basalt-deploy-')) })
afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

const ctxFor = (schema: string): DeployContext => ({
  config: lexfirmaConfig({ env: { schema } }), dir, host: nodeHost(quiet), pm: 'pnpm', envPath: join(dir, '.env'), stateDir: join(dir, '.basalt'),
})

describe('the real host', () => {
  it('validates against the app schema in a child that sees only the .env (not the shell)', async () => {
    // A stand-in for defineEnv: throws the same shape EnvValidationError has.
    await writeFile(join(dir, 'env.mjs'), `
      const report = []
      if (!process.env.DATABASE_URL) report.push('DATABASE_URL: Required')
      if (process.env.LEAK_FROM_SHELL) report.push('LEAK_FROM_SHELL reached the child')
      if (report.length) { const e = new Error('invalid'); e.name = 'EnvValidationError'; e.report = report; throw e }
      export const env = { FAKE: Boolean(process.env.FAKE), DATABASE_URL: process.env.DATABASE_URL }
    `)
    process.env['LEAK_FROM_SHELL'] = '1'
    try {
      const bad = await checkSchema(ctxFor('env.mjs'), new Map())
      expect(bad.findings.map((f) => f.message)).toEqual(['env.mjs: DATABASE_URL: Required'])

      const good = await checkSchema(ctxFor('env.mjs'), new Map([['DATABASE_URL', 'postgresql://x'], ['FAKE', '0']]))
      expect(good.findings).toEqual([])
      expect(good.trueKeys).toEqual(['FAKE'])
    } finally {
      delete process.env['LEAK_FROM_SHELL']
    }
  })

  it('reports a schema module that does not load', async () => {
    const result = await checkSchema(ctxFor('missing.mjs'), new Map())
    expect(result.findings[0]?.message).toMatch(/missing\.mjs/)
  })

  it('writes atomically with the mode set before the content lands, and sends stdout to a 0600 file', async () => {
    const host = nodeHost(quiet)
    const file = join(dir, '.env')
    await host.writeFile(file, 'A=1\n', 0o600)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect(await readFile(file, 'utf8')).toBe('A=1\n')

    const dump = join(dir, 'out.dump')
    const result = await host.exec(process.execPath, ['-e', 'process.stdout.write("PGDMP")'], { stdoutFile: dump })
    expect(result.code).toBe(0)
    expect(await readFile(dump, 'utf8')).toBe('PGDMP')
    expect((await stat(dump)).mode & 0o777).toBe(0o600)
  })

  it('passes secrets in the environment, removes unset keys, and reports a missing command as 127', async () => {
    const host = nodeHost(quiet)
    const before = process.env['NODE_ENV']
    process.env['NODE_ENV'] = 'production'
    try {
      const result = await host.exec(process.execPath, ['-e', 'console.log(process.env.PGPASSWORD, process.env.NODE_ENV)'], { env: { PGPASSWORD: 'pw' }, unset: ['NODE_ENV'] })
      expect(result.stdout.trim()).toBe('pw undefined')
    } finally {
      if (before === undefined) delete process.env['NODE_ENV']
      else process.env['NODE_ENV'] = before
    }
    expect((await host.exec('basalt-no-such-command', [])).code).toBe(127)
  })
})
