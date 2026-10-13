import { execFileSync, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { PassThrough } from 'node:stream'
import tls from 'node:tls'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { compose, validateConfig } from '../src/config.js'
import { muteEcho, probeTls } from '../src/host.js'
import { acmeConfig } from './fake-host.js'

describe('secret prompts (readline internals, guarded)', () => {
  it('on this Node, nothing typed reaches the output — only the question', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    let written = ''
    output.on('data', (chunk: Buffer) => { written += chunk.toString() })
    const rl = createInterface({ input, output, terminal: true })
    expect(muteEcho(rl, (s) => output.write(s))).toBe(true)
    const answer = new Promise<string>((resolve) => rl.question('token: ', resolve))
    input.write('s3cr3t-value\r')
    expect(await answer).toBe('s3cr3t-value')
    rl.close()
    expect(written).toContain('token: ')
    expect(written).not.toContain('s3cr3t')
  })

  it('without the internal it refuses (the caller then does not ask)', () => {
    expect(muteEcho({}, () => undefined)).toBe(false)
    expect(muteEcho({ _writeToOutput: 'x' }, () => undefined)).toBe(false)
  })
})

describe('compose job once.exists (I4)', () => {
  const withJob = (exists: string) => acmeConfig({ runtime: compose({ file: 'c.yml', images: [{ tag: 'acme', dockerfile: 'Dockerfile', env: 'ACME_IMAGE' }], upstream: { service: 'api', port: 3001 }, jobs: [{ service: 'freshclam', once: { exists } }] }) })

  it('only an absolute path pattern', () => {
    expect(() => validateConfig(withJob('/var/lib/clamav/main.c?d'))).not.toThrow()
    for (const bad of ['/x; touch /tmp/p', '/x$(id)', 'relative/*', '/a b', '/x`id`']) expect(() => validateConfig(withJob(bad)), bad).toThrow(/once.exists/)
  })

  it('reaches the shell as $1: expanded as a path, never run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'basalt-deploy-glob-'))
    try {
      await mkdir(join(dir, 'clamav'))
      await writeFile(join(dir, 'clamav', 'main.cvd'), '')
      const ls = (pattern: string) => spawnSync('sh', ['-c', 'ls -d -- $1', 'sh', pattern], { cwd: dir })
      expect(ls(`${dir}/clamav/main.c?d`).status).toBe(0)
      expect(ls(`${dir}/clamav/daily.c?d`).status).not.toBe(0)
      // Even if a pattern slipped past validation, it is data to the shell.
      ls(`${dir}/x;touch ${dir}/pwned`)
      await expect(readFile(join(dir, 'pwned'))).rejects.toThrow(/ENOENT/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

const hasOpenssl = spawnSync('openssl', ['version']).status === 0

describe.skipIf(!hasOpenssl)('C8 on the real host: an untrusted certificate is reported with its names (I1)', () => {
  let dir: string
  let server: tls.Server
  let port: number
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'basalt-deploy-tls-'))
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '2', '-subj', '/CN=acme.example.com', '-addext', 'subjectAltName=DNS:acme.example.com,DNS:*.acme.example.com'], { stdio: 'ignore' })
    server = tls.createServer({ key: await readFile(join(dir, 'key.pem')), cert: await readFile(join(dir, 'cert.pem')) }, (socket) => socket.end())
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as { port: number }).port
  })
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  })

  it('self-signed: trusted false with the reason, the names and the expiry still read', async () => {
    const cert = await probeTls('acme.example.com', { host: '127.0.0.1', port })
    expect('error' in cert).toBe(false)
    if ('error' in cert) return
    expect(cert.trusted).toBe(false)
    expect(cert.trustError).toMatch(/SELF_SIGNED/)
    expect(cert.names).toEqual(['acme.example.com', '*.acme.example.com'])
    expect(cert.validTo.getTime()).toBeGreaterThan(Date.now())
  })

  it('a closed port is an error, not a certificate', async () => {
    const closed = await probeTls('acme.example.com', { host: '127.0.0.1', port: 1, timeoutMs: 2000 })
    expect('error' in closed).toBe(true)
  })
})
