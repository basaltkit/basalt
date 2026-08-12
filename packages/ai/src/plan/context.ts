import type { ProjectContext } from '../context/project.js'

/**
 * Compact, relevant-only project summary for the planner (spec §18 Context
 * Engineering — never ship the whole project to the model). Surfaces exactly what
 * the Architect needs to ground a plan: enabled capabilities, existing models and
 * the generator's flags.
 */
export function buildPlanContext(ctx: ProjectContext): string {
  const s = ctx.stack
  const caps = [
    s.http ? `HTTP: ${s.http}` : null,
    s.orm ? `ORM: ${s.orm}` : null,
    s.database ? `database: ${s.database}` : null,
    s.tenancy ? 'tenancy: ENABLED — tenant-owned models must carry tenantId' : 'tenancy: off',
    s.auth ? 'auth: enabled' : null,
    s.rbac ? 'RBAC: enabled — register <resource>.view/create/update/delete' : null,
    s.audit ? 'audit: enabled — emit <resource>.created/updated/deleted' : null,
    s.subscriptions ? 'subscriptions: enabled' : null,
    s.payments ? 'payments: enabled' : null,
    s.queue ? 'queue: enabled' : null,
    s.search ? 'search: enabled' : null,
    s.events ? 'events: enabled' : null,
    s.scheduler ? 'scheduler: enabled' : null,
    s.storage ? 'storage: enabled' : null,
  ].filter((line): line is string => line !== null)

  const models =
    ctx.prisma && ctx.prisma.models.length > 0
      ? ctx.prisma.models.map((m) => `${m.name}${m.tenantScoped ? ' (tenantId)' : ''}`).join(', ')
      : '(none)'

  const lines = [
    'PROJECT STACK:',
    ...caps.map((c) => `- ${c}`),
    '',
    `EXISTING PRISMA MODELS: ${models}`,
    '',
    'GENERATOR: `basalt make:resource <Name>` — flags: --prisma, --soft-delete, --no-register, --dir, --force.',
  ]
  if (ctx.app) lines.push(`APP FILE: ${ctx.app.path} (wired plugins: ${ctx.app.plugins.join(', ') || 'none'}).`)
  return lines.join('\n')
}
