import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { prismaSyncCommand } from '../src/sync-command.js'

/**
 * F-19 · `prisma:sync` has to know where a model belongs.
 *
 * The command had one schema path and one flat list of domains. That list mixes
 * domains that live in each tenant's schema (`auth`, `permissions`, `audit`,
 * `activity`, `teams`, `notifications`) with domains that live only in the
 * central one (`tenancy`, `subscriptions`) — and nothing told them apart.
 *
 * So `prisma:sync --yes`, the obvious invocation, wrote `Tenant`,
 * `Subscription` and `Payment` into the schema of every tenant. Those tables
 * must never hold a row; having them there is a place where one tenant's data
 * can land by accident, with nothing to detect it. It was caught by reading a
 * diff, not by the tool.
 *
 * Placement is something the application knows and the command cannot infer, so
 * it is declared.
 */
const projecto = () => {
  const raiz = mkdtempSync(join(tmpdir(), 'basalt-sync-'))
  mkdirSync(join(raiz, 'prisma', 'tenants'), { recursive: true })

  const cabecalho = 'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}\n'
  writeFileSync(join(raiz, 'prisma', 'schema.prisma'), cabecalho)
  writeFileSync(join(raiz, 'prisma', 'tenants', 'schema.prisma'), cabecalho)

  return {
    raiz,
    central: join(raiz, 'prisma', 'schema.prisma'),
    tenant: join(raiz, 'prisma', 'tenants', 'schema.prisma'),
  }
}

const io = () => {
  const linhas: string[] = []
  return {
    linhas,
    io: {
      log: (m: string) => linhas.push(m),
      error: (m: string) => linhas.push(`ERRO ${m}`),
      confirm: async () => true,
    },
  }
}

const correr = async (cwd: string, comando: ReturnType<typeof prismaSyncCommand>, flags = {}) => {
  const anterior = process.cwd()
  process.chdir(cwd)
  const registo = io()
  try {
    const codigo = await comando.handle({ io: registo.io as never, flags, args: [] } as never)
    return { codigo, linhas: registo.linhas }
  } finally {
    process.chdir(anterior)
  }
}

describe('F-19 · declared targets', () => {
  it('writes each domain to the schema it was declared in', async () => {
    const p = projecto()
    const comando = prismaSyncCommand({
      targets: {
        central: { schemaPath: 'prisma/schema.prisma', domains: ['tenancy', 'subscriptions'] },
        tenant: {
          schemaPath: 'prisma/tenants/schema.prisma',
          domains: ['auth', 'permissions', 'audit'],
        },
      },
    })

    await correr(p.raiz, comando, { yes: true })

    const central = readFileSync(p.central, 'utf8')
    const tenant = readFileSync(p.tenant, 'utf8')

    // The exact mistake this exists to stop: central models inside the tenant
    // schema. A `Tenant` table in every tenant's schema is a table that must
    // never have rows.
    expect(tenant).not.toContain('model Tenant ')
    expect(tenant).not.toContain('model Subscription ')

    // And the mirror: tenant models in the central schema would send every
    // tenant's users to `public`.
    expect(central).not.toContain('model AuthUser')
    expect(central).not.toContain('model PermUserRole')
  })

  it('names which target each addition went to', async () => {
    // With one schema the output was unambiguous. With two it has to say.
    const p = projecto()
    const comando = prismaSyncCommand({
      targets: {
        central: { schemaPath: 'prisma/schema.prisma', domains: ['tenancy'] },
        tenant: { schemaPath: 'prisma/tenants/schema.prisma', domains: ['auth'] },
      },
    })

    const { linhas } = await correr(p.raiz, comando, { yes: true })
    const texto = linhas.join('\n')

    expect(texto).toContain('central')
    expect(texto).toContain('tenant')
  })

  it('still honours --only, filtering inside each target', async () => {
    const p = projecto()
    const comando = prismaSyncCommand({
      targets: {
        central: { schemaPath: 'prisma/schema.prisma', domains: ['tenancy', 'subscriptions'] },
        tenant: { schemaPath: 'prisma/tenants/schema.prisma', domains: ['auth', 'audit'] },
      },
    })

    await correr(p.raiz, comando, { yes: true, only: 'auth' })

    const tenant = readFileSync(p.tenant, 'utf8')
    expect(tenant).toContain('model AuthUser')
    // `--only=auth` must not drag audit in just because they share a target.
    expect(tenant).not.toContain('model AuditEntry')
  })

  it('refuses --schema with targets, instead of silently picking one', async () => {
    // `--schema` names a single file; with two declared it cannot mean
    // anything. Guessing would write central models into whichever was named.
    const p = projecto()
    const comando = prismaSyncCommand({
      targets: {
        central: { schemaPath: 'prisma/schema.prisma', domains: ['tenancy'] },
        tenant: { schemaPath: 'prisma/tenants/schema.prisma', domains: ['auth'] },
      },
    })

    const { codigo, linhas } = await correr(p.raiz, comando, {
      yes: true,
      schema: 'prisma/schema.prisma',
    })

    expect(codigo).toBe(1)
    expect(linhas.join('\n')).toMatch(/--schema/)
  })
})

describe('F-19 · without targets, nothing changes', () => {
  it('behaves exactly as before', async () => {
    // Every app on the single-schema shape has to keep working untouched.
    const p = projecto()
    const comando = prismaSyncCommand()

    const { codigo } = await correr(p.raiz, comando, { yes: true, only: 'auth' })
    expect(codigo).toBe(0)

    const central = readFileSync(p.central, 'utf8')
    expect(central).toContain('model AuthUser')
  })
})
