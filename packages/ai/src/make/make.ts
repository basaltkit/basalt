import {
  FileExistsError,
  generateResource,
  names,
  registerResourceInApp,
  writeGenerated,
  type GeneratedFile,
} from '@basaltkit/generator'
import type { ProjectContext } from '../context/project.js'
import type { ArchitecturePlan, PlanEntity } from '../plan/types.js'
import { domainFields, injectPrismaFields, injectZodFields } from './fields.js'
import { renderPrismaRepository } from './repository.js'
import { injectAuditPlugin, injectAuditService, injectPermissionGuards } from './wire.js'
import type { MakeOptions, MakeResult, ResourceBuild, ReviewItem, ReviewResult } from './types.js'

/**
 * Execute an {@link ArchitecturePlan}: scaffold each entity via the official
 * generator, inject the plan's domain fields, write + auto-wire, then run a
 * deterministic review gate. Read-only when `dryRun` is set.
 *
 * Hybrid by design (the locked decision): the generator produces the
 * on-convention vertical; we only augment it with fields the plan already
 * decided. No destructive operations — never overwrites without `force`, never
 * touches the database, never deletes.
 */
export async function runMake(
  ctx: ProjectContext,
  plan: ArchitecturePlan,
  options: MakeOptions = {},
): Promise<MakeResult> {
  const entities = plan.entities.filter((e) => e.name.trim() !== '')
  if (entities.length === 0) {
    throw new Error('ai:make — the plan has no entity to generate.')
  }
  const baseDir = options.baseDir ?? process.cwd()
  const prismaDefault = ctx.stack.orm === 'prisma'

  const resources: ResourceBuild[] = []
  for (const entity of entities) {
    const gen = findGeneratorCommand(plan, entity.name)
    const prisma = options.prisma ?? gen?.prisma ?? prismaDefault
    const softDelete = options.softDelete ?? gen?.softDelete ?? false

    const generated = generateResource(entity.name, { prisma, softDelete })
    const { files, augmented, guarded, audited } = augmentFiles(generated, entity, plan, ctx, { prisma, softDelete })

    const build: ResourceBuild = {
      name: entity.name,
      prisma,
      softDelete,
      files,
      augmented,
      guarded,
      audited,
      written: [],
      registered: false,
    }

    if (!options.dryRun) {
      try {
        build.written = await writeGenerated(files, {
          baseDir,
          ...(options.force ? { force: true } : {}),
        })
        const reg = await registerResourceInApp(entity.name, { baseDir })
        build.registered = reg.registered
        if (!reg.registered && reg.reason && reg.reason !== 'already registered') {
          build.note = `not auto-wired: ${reg.reason}`
        }
      } catch (error) {
        if (error instanceof FileExistsError) {
          build.note = error.message.split('\n')[0] ?? error.message
        } else {
          throw error
        }
      }
    }

    resources.push(build)
  }

  const followUps = buildFollowUps(plan, resources)
  const review = reviewBuild(ctx, plan, resources)
  return { request: plan.request, dryRun: options.dryRun === true, resources, followUps, review }
}

interface GeneratorInvocation {
  name: string
  prisma: boolean
  softDelete: boolean
}

/** Find the plan's generator step for an entity and parse its flags — the plan is the source of truth. */
function findGeneratorCommand(plan: ArchitecturePlan, entityName: string): GeneratorInvocation | null {
  for (const step of plan.steps) {
    if (step.kind !== 'generator' || !step.command) continue
    const parsed = parseGeneratorCommand(step.command)
    if (parsed && parsed.name.toLowerCase() === entityName.toLowerCase()) return parsed
  }
  return null
}

function parseGeneratorCommand(command: string): GeneratorInvocation | null {
  const match = /make:resource\s+(\w+)([^\n]*)/.exec(command)
  if (!match || !match[1]) return null
  const rest = match[2] ?? ''
  return { name: match[1], prisma: /--prisma\b/.test(rest), softDelete: /--soft-delete\b/.test(rest) }
}

function augmentFiles(
  files: GeneratedFile[],
  entity: PlanEntity,
  plan: ArchitecturePlan,
  ctx: ProjectContext,
  opts: { prisma: boolean; softDelete: boolean },
): { files: GeneratedFile[]; augmented: boolean; guarded: boolean; audited: boolean } {
  const tenantScoped = ctx.stack.tenancy && entity.tenantScoped
  // Drop the generator's base `name` column when the entity has its own fields
  // and none is literally `name` (else keep it as the label field).
  const removeName = domainFields(entity.fields).length > 0 && !entity.fields.some((f) => f.name.toLowerCase() === 'name')
  const keepName = !removeName
  // Per-entity permission namespace — so each entity in a multi-entity plan is
  // guarded by its own permission, not a shared one from permissions[0].
  const guardPrefix = names(entity.name).pluralKebab
  const wireGuards = ctx.stack.rbac && plan.permissions.length > 0
  const wireAudit = ctx.stack.audit && plan.auditEvents.length > 0
  let augmented = false
  let guarded = false
  let audited = false

  const out = files.map((file) => {
    if (file.path.endsWith('.prisma')) {
      const result = injectPrismaFields(file.content, entity.fields, tenantScoped, removeName)
      augmented = augmented || result.injected
      return { ...file, content: result.content }
    }
    if (file.path.endsWith('.schema.ts')) {
      const result = injectZodFields(file.content, entity.fields, removeName)
      augmented = augmented || result.injected
      return { ...file, content: result.content }
    }
    if (file.path.endsWith('.repository.ts') && opts.prisma) {
      // Replace the generator's repository with a complete mapper (all domain
      // fields) + explicit tenant scoping when tenant-scoped.
      const content = renderPrismaRepository(entity.name, entity.fields, {
        softDelete: opts.softDelete,
        tenantScoped,
        keepName,
      })
      return { ...file, content }
    }
    if (file.path.endsWith('.routes.ts') && wireGuards) {
      const result = injectPermissionGuards(file.content, guardPrefix)
      guarded = guarded || result.injected
      return { ...file, content: result.content }
    }
    if (file.path.endsWith('.service.ts') && wireAudit) {
      const result = injectAuditService(file.content, entity.name, plan.auditEvents)
      audited = audited || result.injected
      return { ...file, content: result.content }
    }
    if (file.path.endsWith('.plugin.ts') && wireAudit) {
      const result = injectAuditPlugin(file.content, entity.name)
      return { ...file, content: result.content }
    }
    return file
  })
  return { files: out, augmented, guarded, audited }
}

function buildFollowUps(plan: ArchitecturePlan, resources: ResourceBuild[]): string[] {
  const followUps: string[] = []
  const prismaResources = resources.filter((r) => r.prisma)
  if (prismaResources.length > 0) {
    const list = prismaResources
      .map((r) => `src/modules/${kebab(r.name)}/${kebab(r.name)}.prisma`)
      .join(', ')
    followUps.push(
      `Copy the generated model(s) (${list}) into prisma/schema.prisma, then run ` +
        '`npx prisma db push` (or `prisma migrate dev`) to create the table(s) and regenerate the client — then restart the server.',
    )
  }
  const withRelations = plan.entities.filter((e) => e.relations && e.relations.length > 0)
  if (withRelations.length > 0) {
    followUps.push(
      'Relations are generated as foreign-key String columns (e.g. `<name>Id`). Add Prisma `@relation` in schema.prisma if you need referential integrity.',
    )
  }
  const guarded = resources.some((r) => r.guarded)
  const audited = resources.some((r) => r.audited)
  if (plan.permissions.length > 0 && !guarded) {
    followUps.push(`Register RBAC permissions (${plan.permissions.join(', ')}) and guard the routes.`)
  } else if (guarded) {
    followUps.push(`Grant the permissions (${plan.permissions.join(', ')}) to the roles that should have them.`)
  }
  if (plan.auditEvents.length > 0 && !audited) {
    followUps.push(`Emit audit events (${plan.auditEvents.join(', ')}) on create/update/delete.`)
  }
  return followUps
}

function reviewBuild(
  ctx: ProjectContext,
  plan: ArchitecturePlan,
  resources: ResourceBuild[],
): ReviewResult {
  const items: ReviewItem[] = []

  // Tenant isolation — the gate the spec cares most about.
  if (ctx.stack.tenancy) {
    const tenantEntities = plan.entities.filter((e) => e.tenantScoped)
    if (tenantEntities.length === 0) {
      items.push({ label: 'Tenant isolation', status: 'warn', detail: 'no entity marked tenant-scoped — confirm that is intended' })
    } else {
      const missing = resources.filter(
        (r) => plan.entities.find((e) => e.name === r.name)?.tenantScoped && !hasTenantId(r),
      )
      items.push(
        missing.length === 0
          ? { label: 'Tenant isolation', status: 'pass', detail: 'tenantId present on tenant-scoped models' }
          : { label: 'Tenant isolation', status: 'fail', detail: `missing tenantId: ${missing.map((r) => r.name).join(', ')}` },
      )
    }
  } else {
    items.push({ label: 'Tenant isolation', status: 'pass', detail: 'tenancy is off — not applicable' })
  }

  // Validation + routes.
  const hasRoutes = resources.every((r) => r.files.some((f) => f.path.endsWith('.routes.ts')))
  const hasSchema = resources.every((r) => r.files.some((f) => f.path.endsWith('.schema.ts')))
  items.push(
    hasRoutes && hasSchema
      ? { label: 'Validation & routes', status: 'pass', detail: 'Zod schema + typed routes generated' }
      : { label: 'Validation & routes', status: 'fail', detail: 'schema or routes missing' },
  )

  // Tests.
  const hasTests = resources.every((r) => r.files.some((f) => f.path.endsWith('.test.ts')))
  items.push(
    hasTests
      ? { label: 'Tests', status: 'pass', detail: 'a test file was generated per resource' }
      : { label: 'Tests', status: 'fail', detail: 'no test generated' },
  )

  // Permissions — auto-wired as route meta.can guards when RBAC is enabled.
  if (plan.permissions.length > 0) {
    const guarded = resources.some((r) => r.guarded)
    items.push(
      guarded
        ? { label: 'Permissions', status: 'pass', detail: 'routes guarded with meta.can (grant them to roles)' }
        : {
            label: 'Permissions',
            status: 'warn',
            detail: ctx.stack.rbac ? 'planned but not auto-wired' : 'RBAC (@basaltkit/permissions) not enabled — wire manually',
          },
    )
  }

  // Audit — auto-wired into the service/plugin when audit is enabled.
  if (plan.auditEvents.length > 0) {
    const audited = resources.some((r) => r.audited)
    items.push(
      audited
        ? { label: 'Audit', status: 'pass', detail: 'AUDIT.record() wired into create/update/delete' }
        : {
            label: 'Audit',
            status: 'warn',
            detail: ctx.stack.audit ? 'planned but not auto-wired' : 'audit (@basaltkit/audit) not enabled — wire manually',
          },
    )
  }

  // Migration is always manual (generator emits a snippet, not the live schema).
  if (resources.some((r) => r.prisma)) {
    items.push({ label: 'Migration', status: 'warn', detail: 'add the model to schema.prisma + run npx prisma db push' })
  }

  return { items, ok: !items.some((i) => i.status === 'fail') }
}

function hasTenantId(resource: ResourceBuild): boolean {
  const model = resource.files.find((f) => f.path.endsWith('.prisma'))
  if (!model) return false
  return /^[ \t]*tenantId[ \t]+/m.test(model.content)
}

function kebab(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .toLowerCase()
}
