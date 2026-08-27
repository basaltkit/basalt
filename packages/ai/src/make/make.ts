import {
  FileExistsError,
  generateResource,
  names,
  registerResourceInApp,
  writeGenerated,
  type GeneratedFile,
} from '@basaltkit/generator/resource'
import type { ProjectContext } from '../context/project.js'
import type { ArchitecturePlan, PlanEntity } from '../plan/types.js'
import { MAKE_SCHEMA_VERSION } from '../schema/index.js'
import { throwIfAborted } from '../generate.js'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { unifiedDiff } from './diff.js'
import { domainFields, injectPrismaFields, injectZodFields } from './fields.js'
import {
  externalRelationTargets,
  injectPrismaRelations,
  inverseRelationLines,
  relationFieldLines,
  relationForeignKeys,
} from './relations.js'
import { injectOpenApiMeta } from './openapi.js'
import { renderPermissionsFile } from './permissions.js'
import { renderPrismaRepository } from './repository.js'
import {
  extractModelBlock,
  mergeModelsIntoSchema,
  readSchema,
  runPrismaPush,
  writeSchema,
  type ModelBlock,
} from './schema.js'
import { injectAuditPlugin, injectAuditService, injectPermissionGuards } from './wire.js'
import type {
  MakeOptions,
  MakePreview,
  MakeResult,
  Migration,
  ResourceBuild,
  ReviewItem,
  ReviewResult,
  SchemaMerge,
} from './types.js'

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
  throwIfAborted(options.signal)
  const baseDir = options.baseDir ?? process.cwd()
  const prismaDefault = ctx.stack.orm === 'prisma'

  const resources: ResourceBuild[] = []
  for (const entity of entities) {
    throwIfAborted(options.signal)
    options.onProgress?.({ message: `Building ${entity.name}…` })
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

  // Merge the generated models into prisma/schema.prisma (idempotent), and
  // optionally run `prisma db push` — removing the biggest manual step.
  const { schema, migration } = await mergeSchema(resources, baseDir, options)

  const followUps = buildFollowUps(plan, resources, schema, migration)
  const review = reviewBuild(ctx, plan, resources, schema, migration)
  // Safe preview (dry-run only): stat every target and attach a unified diff, so a
  // caller sees exactly what an apply would create/overwrite before anything is written.
  const preview = options.dryRun ? await buildPreview(resources, baseDir) : undefined
  return {
    schemaVersion: MAKE_SCHEMA_VERSION,
    request: plan.request,
    dryRun: options.dryRun === true,
    resources,
    ...(schema ? { schema } : {}),
    ...(migration ? { migration } : {}),
    followUps,
    review,
    ...(preview ? { preview } : {}),
  }
}

async function mergeSchema(
  resources: ResourceBuild[],
  baseDir: string,
  options: MakeOptions,
): Promise<{ schema: SchemaMerge | undefined; migration: Migration | undefined }> {
  const prismaResources = resources.filter((r) => r.prisma)
  if (prismaResources.length === 0) return { schema: undefined, migration: undefined }

  const schemaPath = options.schemaPath ?? 'prisma/schema.prisma'
  const blocks = prismaResources
    .map((r) => r.files.find((f) => f.path.endsWith('.prisma')))
    .map((f) => (f ? extractModelBlock(f.content) : null))
    .filter((b): b is ModelBlock => b !== null)

  const existing = await readSchema(baseDir, schemaPath)
  if (existing === null) {
    return { schema: { path: schemaPath, found: false, merged: [], skipped: [], written: false }, migration: undefined }
  }

  const outcome = mergeModelsIntoSchema(existing, blocks)
  const schema: SchemaMerge = {
    path: schemaPath,
    found: true,
    merged: outcome.merged,
    skipped: outcome.skipped,
    written: false,
  }

  if (options.dryRun) return { schema, migration: undefined }

  if (outcome.merged.length > 0) {
    await writeSchema(baseDir, schemaPath, outcome.content)
    schema.written = true
  }

  if (options.migrate && (schema.written || outcome.skipped.length > 0)) {
    const push = await runPrismaPush(baseDir)
    return { schema, migration: { ok: push.ok, output: push.output } }
  }
  return { schema, migration: undefined }
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
  // Domain fields plus the synthetic FK columns from belongs-to relations.
  const effectiveFields = [...entity.fields, ...relationForeignKeys(entity)]
  // Drop the generator's base `name` column when the entity has its own fields
  // and none is literally `name` (else keep it as the label field).
  const removeName = domainFields(effectiveFields).length > 0 && !effectiveFields.some((f) => f.name.toLowerCase() === 'name')
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
      const withFields = injectPrismaFields(file.content, effectiveFields, tenantScoped, removeName)
      // Real Prisma relations: FK column (above), @relation field + inverse fields.
      const withRelations = injectPrismaRelations(
        withFields.content,
        relationFieldLines(entity),
        inverseRelationLines(entity.name, plan.entities),
      )
      augmented = augmented || withFields.injected || withRelations.injected
      return { ...file, content: withRelations.content }
    }
    if (file.path.endsWith('.schema.ts')) {
      const result = injectZodFields(file.content, effectiveFields, removeName)
      augmented = augmented || result.injected
      return { ...file, content: result.content }
    }
    if (file.path.endsWith('.repository.ts') && opts.prisma) {
      // Replace the generator's repository with a complete mapper (all domain
      // fields + FK columns) + explicit tenant scoping when tenant-scoped.
      const content = renderPrismaRepository(entity.name, effectiveFields, {
        softDelete: opts.softDelete,
        tenantScoped,
        keepName,
      })
      return { ...file, content }
    }
    if (file.path.endsWith('.routes.ts')) {
      let content = file.content
      if (wireGuards) {
        const result = injectPermissionGuards(content, guardPrefix)
        content = result.content
        guarded = guarded || result.injected
      }
      // OpenAPI enrichment: summary + tags on every route (merges with the guard meta).
      content = injectOpenApiMeta(content, entity.name).content
      return { ...file, content }
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

  // Declare the resource's permissions + a grant helper (closes the RBAC loop).
  if (guarded) {
    const kebab = names(entity.name).kebab
    out.push({ path: `src/modules/${kebab}/${kebab}.permissions.ts`, content: renderPermissionsFile(entity.name) })
  }

  return { files: out, augmented, guarded, audited }
}

function buildFollowUps(
  plan: ArchitecturePlan,
  resources: ResourceBuild[],
  schema: SchemaMerge | undefined,
  migration: Migration | undefined,
): string[] {
  const followUps: string[] = []
  const prismaResources = resources.filter((r) => r.prisma)
  if (prismaResources.length > 0) {
    if (!schema?.found) {
      const list = prismaResources.map((r) => `src/modules/${kebab(r.name)}/${kebab(r.name)}.prisma`).join(', ')
      followUps.push(
        `Add the generated model(s) (${list}) to prisma/schema.prisma, then run \`npx prisma db push\` and restart the server.`,
      )
    } else if (migration) {
      followUps.push(
        migration.ok
          ? 'Restart the server so it loads the regenerated Prisma client.'
          : '`prisma db push` failed — check the output, fix it, and re-run `npx prisma db push`.',
      )
    } else {
      followUps.push(
        'Run `npx prisma db push` (or re-run `ai:make --migrate`) to create the table(s) + regenerate the client, then restart the server.',
      )
    }
  }
  const external = externalRelationTargets(plan.entities)
  if (external.length > 0) {
    followUps.push(
      `Relations reference model(s) not in this plan (${external.join(', ')}). Add the inverse field ` +
        '(e.g. `items <This>[]`) to those existing models in schema.prisma so Prisma can validate the relation.',
    )
  }
  const guardedResources = resources.filter((r) => r.guarded)
  const audited = resources.some((r) => r.audited)
  if (plan.permissions.length > 0 && guardedResources.length === 0) {
    followUps.push(`Register RBAC permissions (${plan.permissions.join(', ')}) and guard the routes.`)
  } else if (guardedResources.length > 0) {
    const helpers = guardedResources.map((r) => `grant${names(r.name).pascal}Permissions(store, 'admin')`).join(', ')
    followUps.push(`Grant permissions to your roles during seed/setup — call ${helpers} (declared in each module's *.permissions.ts).`)
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
  schema: SchemaMerge | undefined,
  migration: Migration | undefined,
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
        ? { label: 'Permissions', status: 'pass', detail: 'routes guarded + permissions declared in *.permissions.ts (grant via the helper)' }
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

  // Migration — auto-merged into schema.prisma; `--migrate` runs prisma db push.
  if (resources.some((r) => r.prisma)) {
    if (migration?.ok) {
      items.push({ label: 'Migration', status: 'pass', detail: 'model merged into schema.prisma + prisma db push ran' })
    } else if (migration) {
      items.push({ label: 'Migration', status: 'fail', detail: 'prisma db push failed — see output' })
    } else if (schema?.found) {
      items.push({ label: 'Migration', status: 'warn', detail: 'model merged into schema.prisma — run npx prisma db push' })
    } else {
      items.push({ label: 'Migration', status: 'warn', detail: 'add the model to schema.prisma + run npx prisma db push' })
    }
  }

  return { items, ok: !items.some((i) => i.status === 'fail') }
}

function hasTenantId(resource: ResourceBuild): boolean {
  const model = resource.files.find((f) => f.path.endsWith('.prisma'))
  if (!model) return false
  return /^[ \t]*tenantId[ \t]+/m.test(model.content)
}

async function readFileOrNull(target: string): Promise<string | null> {
  try {
    return await readFile(target, 'utf8')
  } catch {
    return null
  }
}

/** Stat every generated file and build a per-file plan (create|overwrite) with a unified diff. */
async function buildPreview(resources: ResourceBuild[], baseDir: string): Promise<MakePreview> {
  const perFile: MakePreview['perFile'] = []
  const clashes: string[] = []
  for (const resource of resources) {
    for (const file of resource.files) {
      const existing = await readFileOrNull(join(baseDir, file.path))
      const action: 'create' | 'overwrite' = existing !== null ? 'overwrite' : 'create'
      if (existing !== null) clashes.push(file.path)
      perFile.push({ path: file.path, action, diff: unifiedDiff(existing ?? '', file.content, file.path) })
    }
  }
  return { perFile, clashes }
}

function kebab(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .toLowerCase()
}
