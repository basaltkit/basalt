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

  it('writes stdin to the child and closes it (SQL with a password never goes in argv)', async () => {
    const host = nodeHost(quiet)
    const script = 'let t="";process.stdin.on("data",(c)=>t+=c).on("end",()=>console.log(t.toUpperCase()))'
    expect((await host.exec(process.execPath, ['-e', script], { stdin: "alter role x password 'pw';" })).stdout.trim()).toBe("ALTER ROLE X PASSWORD 'PW';")
  })
})

describe('the real host: files, network, terminal', () => {
  it('copies, links, lists, stats and removes', async () => {
    const host = nodeHost(quiet)
    const sub = join(dir, 'fs')
    await host.mkdir(sub, 0o700)
    await host.writeFile(join(sub, 'a'), 'x', 0o644)
    await host.copyFile(join(sub, 'a'), join(sub, 'b'), 0o600)
    await host.symlink('a', join(sub, 'link'))
    expect((await host.list(sub)).sort()).toEqual(['a', 'b', 'link'])
    expect(await host.stat(join(sub, 'link'))).toEqual({ kind: 'symlink', size: expect.any(Number) })
    expect((await host.stat(sub))?.kind).toBe('dir')
    expect(await host.readlink(join(sub, 'link'))).toBe('a')
    expect(await host.readlink(join(sub, 'a'))).toBeUndefined()
    expect(await host.readFile(join(sub, 'missing'))).toBeUndefined()
    expect(await host.stat(join(sub, 'missing'))).toBeUndefined()
    expect(await host.exists(join(sub, 'b'))).toBe(true)
    await host.remove(join(sub, 'b'))
    expect(await host.exists(join(sub, 'b'))).toBe(false)
    expect(await host.list(join(sub, 'missing'))).toEqual([])
    expect(host.randomHex(4)).toMatch(/^[0-9a-f]{8}$/)
    expect(host.now()).toBeInstanceOf(Date)
    expect(typeof host.uid()).toBe('number')
    await host.sleep(1)
  })

  it('GETs with an explicit Host header and never throws', async () => {
    const { createServer } = await import('node:http')
    const seen: string[] = []
    const server = createServer((req, res) => { seen.push(String(req.headers.host)); res.statusCode = 204; res.end() })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    try {
      const host = nodeHost(quiet)
      expect(await host.httpGet(`http://127.0.0.1:${port}/health`, { host: 'lexfirma.aipro.ao' })).toEqual({ status: 204 })
      expect(seen).toEqual(['lexfirma.aipro.ao'])
    } finally {
      server.close()
    }
    expect(await nodeHost(quiet).httpGet(`http://127.0.0.1:${port}/health`, { timeoutMs: 500 })).toHaveProperty('error')
  })

  it('reports a TLS endpoint that does not answer instead of throwing', async () => {
    expect(await nodeHost(quiet).tlsCertificate('basalt-deploy.invalid')).toHaveProperty('error')
  })

  it('without a terminal: prompts return nothing, confirmations are no', async () => {
    const host = nodeHost(quiet)
    const tty = process.stdin.isTTY
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true })
    try {
      expect(await host.prompt('token', { secret: true })).toBeUndefined()
      expect(await host.confirm('sure?')).toBe(false)
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: tty, configurable: true })
    }
  })

  it('prints steps and findings to its stream, uncoloured when it is not a terminal', async () => {
    const { consoleOutput } = await import('../src/host.js')
    const lines: string[] = []
    const stream = { isTTY: false, write: (s: string) => { lines.push(s); return true } } as unknown as NodeJS.WriteStream
    const out = consoleOutput(stream)
    out.step('preflight'); out.info('i'); out.ok('o'); out.warn('w'); out.error('e')
    expect(lines.join('')).toBe('\n==> preflight\n    i\n    ok o\n    warning w\n    error e\n')
  })
})
