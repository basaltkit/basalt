import type { DeployConfig } from '../src/config.js'
import type { DeployContext } from '../src/context.js'
import type { ExecOptions, ExecResult, Host, TlsCertificate } from '../src/host.js'

type Node = { kind: 'file'; content: string; mode: number } | { kind: 'symlink'; target: string } | { kind: 'dir' }

export interface Call {
  command: string
  args: string[]
  options: ExecOptions
}

type Handler = (call: Call) => ExecResult | undefined | Promise<ExecResult | undefined>

export const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' })
export const fail = (stderr = 'failed', code = 1): ExecResult => ({ code, stdout: '', stderr })

/**
 * A server in memory: files, processes (via handlers), a clock, a terminal.
 * Every command is recorded; everything printed is kept in `printed`, so a
 * test can assert that no secret ever reached the screen.
 */
export class FakeHost implements Host {
  files = new Map<string, Node>()
  calls: Call[] = []
  printed: string[] = []
  answers: string[] = []
  prompts: string[] = []
  confirmations: boolean[] = []
  handlers: Handler[] = []
  certificates = new Map<string, TlsCertificate | { error: string }>()
  http: (url: string, host?: string) => { status: number } | { error: string } = () => ({ status: 200 })
  env: Record<string, string | undefined> = { USER: 'deployer' }
  userId = 1000
  tty = false
  clock = new Date('2026-10-11T12:00:00Z').getTime()
  private counter = 0

  out = {
    step: (t: string) => { this.printed.push(`STEP ${t}`) },
    info: (m: string) => { this.printed.push(`INFO ${m}`) },
    ok: (m: string) => { this.printed.push(`OK ${m}`) },
    warn: (m: string) => { this.printed.push(`WARN ${m}`) },
    error: (m: string) => { this.printed.push(`ERROR ${m}`) },
  }

  /** Handlers are tried in the order they were added: register the specific ones first. */
  on(handler: Handler): this {
    this.handlers.push(handler)
    return this
  }

  /** Every printed line, joined — for "never contains" assertions. */
  get transcript(): string {
    return this.printed.join('\n')
  }

  commands(command?: string): string[] {
    return this.calls.filter((c) => command === undefined || c.command === command).map((c) => [c.command, ...c.args].join(' '))
  }

  file(path: string): string | undefined {
    const node = this.files.get(path)
    return node?.kind === 'file' ? node.content : undefined
  }

  mode(path: string): number | undefined {
    const node = this.files.get(path)
    return node?.kind === 'file' ? node.mode : undefined
  }

  put(path: string, content: string, mode = 0o644): this {
    this.files.set(path, { kind: 'file', content, mode })
    return this
  }

  async exec(command: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
    const call = { command, args, options }
    this.calls.push(call)
    for (const handler of this.handlers) {
      const result = await handler(call)
      if (result) {
        if (options.stdoutFile) this.put(options.stdoutFile, result.stdout, 0o600)
        return result
      }
    }
    return fail(`fake: no handler for ${command} ${args.join(' ')}`, 127)
  }

  async readFile(path: string) { return this.file(path) }
  async writeFile(path: string, content: string, mode = 0o644) { this.put(path, content, mode) }
  async copyFile(from: string, to: string, mode?: number) {
    const content = this.file(from)
    if (content === undefined) throw new Error(`ENOENT ${from}`)
    this.put(to, content, mode ?? this.mode(from) ?? 0o644)
  }
  async exists(path: string) { return this.files.has(path) }
  async stat(path: string) {
    const node = this.files.get(path)
    if (!node) return undefined
    return { kind: node.kind, size: node.kind === 'file' ? node.content.length : 0 }
  }
  async readlink(path: string) {
    const node = this.files.get(path)
    return node?.kind === 'symlink' ? node.target : undefined
  }
  async symlink(target: string, path: string) { this.files.set(path, { kind: 'symlink', target }) }
  async mkdir(path: string) { if (!this.files.has(path)) this.files.set(path, { kind: 'dir' }) }
  async remove(path: string) { this.files.delete(path) }
  async list(dir: string) {
    const prefix = `${dir}/`
    // Like readdir: files and subdirectories (a directory exists when a file is under it).
    return [...new Set([...this.files.keys()].filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length).split('/')[0] as string))]
  }
  async prompt(question: string) {
    this.prompts.push(question)
    return this.answers.shift()
  }
  async confirm(question: string) {
    this.prompts.push(question)
    return this.confirmations.shift() ?? false
  }
  randomHex(bytes: number) {
    this.counter++
    return this.counter.toString(16).padStart(bytes * 2, 'a')
  }
  now() { return new Date(this.clock) }
  async sleep(ms: number) { this.clock += ms }
  async tlsCertificate(servername: string) {
    return this.certificates.get(servername) ?? this.certificates.get('*') ?? { error: 'getaddrinfo ENOTFOUND' }
  }
  async httpGet(url: string, options: { host?: string } = {}) { return this.http(url, options.host) }
  uid() { return this.userId }
  interactive() { return this.tty }
}

export const DIR = '/srv/acme'

export function acmeConfig(overrides: Partial<DeployConfig> = {}): DeployConfig {
  return {
    app: 'acme',
    domain: 'acme.example.com',
    tenants: 'subdomain',
    branch: 'master',
    env: {
      schema: 'src/env.ts',
      fixed: { NODE_ENV: 'production', HOST: '127.0.0.1' },
      generate: { APP_SECRET: { kind: 'secret', bytes: 32 } },
      ask: {
        MAILER_URL: { kind: 'question', prompt: 'SMTP URL', secret: true, optional: true },
        PAYCO_SECRET_TOKEN: { kind: 'question', prompt: 'PayCo token', secret: true, optional: false },
      },
      derive: ({ domain }) => ({ PAYCO_CALLBACK_URL: `https://${domain}/api/webhooks/payco` }),
      forbid: ['PAYCO_FAKE'],
    },
    infra: { kind: 'external' },
    build: { prisma: ['prisma.config.ts'], web: 'web' },
    migrate: { central: true, tenants: true },
    runtime: { kind: 'pm2', script: 'start', port: 'auto', avoid: [3000, 3001] },
    proxy: { kind: 'apache', webRoot: 'web/dist', apiPrefix: '/api' },
    health: { path: '/health', timeoutSeconds: 10 },
    ...overrides,
  }
}

export function context(host: FakeHost, config: DeployConfig = acmeConfig()): DeployContext {
  return { config, dir: DIR, host, pm: 'pnpm', envPath: `${DIR}/.env`, stateDir: `${DIR}/.basalt` }
}

/** `ss -ltnpH` output for listeners `[port, pid?]`. */
export function ss(...listeners: Array<[number, number?]>): string {
  return listeners.map(([port, pid]) => `LISTEN 0 511 127.0.0.1:${port} 0.0.0.0:*${pid ? ` users:(("node",pid=${pid},fd=20))` : ''}`).join('\n')
}

/** `pm2 jlist` output. */
export function jlist(...processes: Array<{ name: string; cwd: string; pid?: number; status?: string }>): string {
  return JSON.stringify(processes.map((p) => ({ name: p.name, pid: p.pid ?? 4242, pm2_env: { pm_cwd: p.cwd, status: p.status ?? 'online' } })))
}
