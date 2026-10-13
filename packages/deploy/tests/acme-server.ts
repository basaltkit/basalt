import { renderVhost } from '../src/apache.js'
import { context, DIR, FakeHost, fail, jlist, ok } from './fake-host.js'

export const OLD = 'a'.repeat(40)
export const NEW = 'b'.repeat(40)
export const ENV = `${DIR}/.env`
export const GOOD_ENV = 'NODE_ENV=production\nHOST=127.0.0.1\nPORT=3002\nAPP_SECRET=s3cr3t\nMAILER_URL=\nPAYCO_SECRET_TOKEN=tok-SECRET\nPAYCO_CALLBACK_URL=https://acme.example.com/api/webhooks/payco\n'

export interface Server {
  host: FakeHost
  head: () => string
}

/**
 * A server where Acme is already installed and healthy at OLD, and the
 * remote has NEW. Options break one thing at a time.
 */
export function server(options: {
  dirty?: string
  migrations?: string[]
  buildFails?: boolean
  healthyAt?: (sha: string) => boolean
  publicStatus?: number
  trueKeys?: string[]
  env?: string
  remote?: ReturnType<typeof ok>
} = {}): Server {
  let head = OLD
  const host = new FakeHost().put(ENV, options.env ?? GOOD_ENV, 0o600)
  host.put(`${DIR}/package.json`, JSON.stringify({ packageManager: 'pnpm@11.8.0', engines: { node: '>=22.5.0' } }))
  const ctx = context(host)
  host.put('/etc/apache2/sites-available/acme.conf', renderVhost(ctx, 3002))
  host.files.set('/etc/apache2/sites-enabled/acme.conf', { kind: 'symlink', target: '../sites-available/acme.conf' })
  host.certificates.set('*', { names: ['acme.example.com', '*.acme.example.com'], validTo: new Date('2027-01-01'), trusted: true })
  host.http = (url) => {
    if (url.startsWith('https://')) return { status: options.publicStatus ?? 200 }
    return (options.healthyAt ?? (() => true))(head) ? { status: 200 } : { error: 'ECONNREFUSED' }
  }
  host
    .on(({ command, args }) => {
      if (command !== 'git') return undefined
      const [verb, ...rest] = args
      if (verb === 'status') return ok(options.dirty ?? '')
      if (verb === 'rev-parse') {
        const ref = rest.indexOf('--end-of-options')
        // The remote's branch after a fetch is NEW; a sha given to rollback --to resolves to itself.
        if (ref !== -1) return ok(`${(rest[ref + 1] as string).replace('^{commit}', '').replace(/^refs\/remotes\/.*/, NEW)}\n`)
        return ok(rest[0] === '--abbrev-ref' ? 'master\n' : `${head}\n`)
      }
      if (verb === 'fetch') return ok()
      if (verb === 'check-ignore') return ok()
      if (verb === 'ls-remote') return options.remote ?? ok(`${NEW}\trefs/heads/master\n`)
      if (verb === 'merge') { head = NEW; return ok() }
      if (verb === 'reset') { head = rest[1] as string; return ok() }
      if (verb === 'diff') return ok((options.migrations ?? []).map((m) => `prisma/migrations/${m}/migration.sql`).join('\n'))
      return undefined
    })
    .on(({ command }) => (command === 'ss' ? ok('') : undefined))
    .on(({ command, args }) => (command === 'pm2' && args[0] === 'jlist' ? ok(jlist({ name: 'acme-api', cwd: DIR })) : undefined))
    .on(({ command }) => (command === 'pm2' ? ok() : undefined))
    .on(({ command, args }) => (command === 'node' && args[0] === '--version' ? ok('v24.17.0\n') : undefined))
    .on(({ command, args }) => (command === 'pnpm' && args[0] === '--version' ? ok('11.8.0\n') : undefined))
    .on(({ command, args }) => (command === 'pnpm' && args[0] === 'install' && options.buildFails && head === NEW ? fail('', 1) : undefined))
    .on(({ command }) => (command === 'pnpm' ? ok() : undefined))
    .on(({ command }) => (command === process.execPath
      ? ok(`\n@@basalt-deploy@@${JSON.stringify({ ok: true, trueKeys: options.trueKeys ?? [] })}\n`)
      : undefined))
    .on(({ command }) => (command === 'pg_dump' ? ok('PGDMP-binary') : undefined))
  return { host, head: () => head }
}

