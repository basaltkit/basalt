import type { ProjectContext } from '../context/project.js'
import { runDoctor } from '../doctor/run.js'
import type { Diagnostic } from '../doctor/types.js'

export interface AnalysisReport {
  root: string
  /** Human-readable capability lines, e.g. `'Fastify detected'`. */
  capabilities: string[]
  installed: string[]
  database: string | null
  models: string[]
  tenantScopedModels: string[]
  unscopedModels: string[]
  /** Diagnostics from the doctor rules, summarised into the report. */
  diagnostics: Diagnostic[]
}

/**
 * Static, offline analysis of a project: what's wired, the data model, and the
 * doctor's findings — the data behind the `ai:analyze` report.
 */
export function analyze(ctx: ProjectContext): AnalysisReport {
  const { stack, prisma } = ctx
  const capabilities: string[] = []
  if (stack.http === 'fastify') capabilities.push('Fastify detected')
  if (stack.orm === 'prisma') capabilities.push('Prisma detected')
  if (stack.database) capabilities.push(`${databaseLabel(stack.database)} detected`)
  if (stack.tenancy) capabilities.push('Tenancy enabled')
  if (stack.auth) capabilities.push('Authentication enabled')
  if (stack.rbac) capabilities.push('RBAC enabled')
  if (stack.subscriptions) capabilities.push('Subscriptions enabled')
  if (stack.payments) capabilities.push('Payments enabled')
  if (stack.queue) capabilities.push('Queue enabled')
  if (stack.search) capabilities.push('Search enabled')
  if (stack.audit) capabilities.push('Audit enabled')
  if (stack.events) capabilities.push('Events enabled')
  if (stack.scheduler) capabilities.push('Scheduler enabled')
  if (stack.storage) capabilities.push('Storage enabled')

  const models = prisma?.models ?? []
  return {
    root: ctx.root,
    capabilities,
    installed: ctx.installed,
    database: stack.database,
    models: models.map((m) => m.name),
    tenantScopedModels: models.filter((m) => m.tenantScoped).map((m) => m.name),
    unscopedModels: models.filter((m) => !m.tenantScoped).map((m) => m.name),
    diagnostics: runDoctor(ctx),
  }
}

function databaseLabel(db: NonNullable<ProjectContext['stack']['database']>): string {
  switch (db) {
    case 'postgresql':
      return 'PostgreSQL'
    case 'mysql':
      return 'MySQL'
    case 'sqlite':
      return 'SQLite'
  }
}
