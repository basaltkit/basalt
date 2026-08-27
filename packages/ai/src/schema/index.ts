/**
 * Runtime schemas for the AI layer's public data contracts. `@basaltkit/ai` is a
 * dev-only package, so taking a `zod` dependency here is acceptable — these
 * schemas exist so out-of-process consumers (notably the forthcoming dev-only
 * `@basaltkit/ai-mcp` bridge) can (a) validate tool inputs/outputs and (b) derive
 * JSON Schema to advertise as MCP `inputSchema`/`outputSchema`.
 *
 * The schemas mirror the exported TypeScript interfaces exactly. `parsePlan` and
 * `parseReview` route their already-coerced output through them (validate *after*
 * tolerant coercion — the model's raw text is never fed to `.parse()` directly).
 */
import { z } from 'zod'

/** Bump when the serialized shape of a plan changes incompatibly. */
export const PLAN_SCHEMA_VERSION = 1
/** Bump when the serialized shape of a make result changes incompatibly. */
export const MAKE_SCHEMA_VERSION = 1

// --- Provider-agnostic scalars ---------------------------------------------

const DatabaseSchema = z.enum(['postgresql', 'mysql', 'sqlite']).nullable()

// --- ProjectContext (context/project.ts) -----------------------------------

export const DetectedStackSchema = z.object({
  http: z.enum(['fastify']).nullable(),
  orm: z.enum(['prisma']).nullable(),
  database: DatabaseSchema,
  tenancy: z.boolean(),
  auth: z.boolean(),
  rbac: z.boolean(),
  subscriptions: z.boolean(),
  payments: z.boolean(),
  storage: z.boolean(),
  queue: z.boolean(),
  search: z.boolean(),
  audit: z.boolean(),
  events: z.boolean(),
  scheduler: z.boolean(),
  logger: z.boolean(),
  ai: z.boolean(),
})

export const PrismaModelSchema = z.object({
  name: z.string(),
  fields: z.array(z.string()),
  tenantScoped: z.boolean(),
})

export const PrismaInfoSchema = z.object({
  provider: DatabaseSchema,
  models: z.array(PrismaModelSchema),
})

export const AppFileInfoSchema = z.object({
  path: z.string(),
  plugins: z.array(z.string()),
  fastifyLoggerConfigured: z.boolean(),
  memorySources: z.array(z.string()),
  pluginCalls: z.array(z.string()),
})

export const ServerFileInfoSchema = z.object({
  path: z.string(),
  connectsAtBoot: z.boolean(),
  startsServer: z.boolean(),
})

export const EnvFileInfoSchema = z.object({
  path: z.string(),
  appSecretDefault: z.string().nullable(),
  redisUrlDefault: z.string().nullable(),
})

export const ProjectContextSchema = z.object({
  root: z.string(),
  installed: z.array(z.string()),
  stack: DetectedStackSchema,
  prisma: PrismaInfoSchema.nullable(),
  app: AppFileInfoSchema.nullable(),
  server: ServerFileInfoSchema.nullable(),
  env: EnvFileInfoSchema.nullable(),
})

// --- Diagnostics + AnalysisReport (doctor/types.ts, analyze/run.ts) --------

export const SeveritySchema = z.enum(['error', 'warning', 'info'])

export const DiagnosticCategorySchema = z.enum([
  'security',
  'database',
  'observability',
  'tenancy',
  'performance',
  'durability',
  'config',
])

export const DiagnosticSchema = z.object({
  id: z.string(),
  title: z.string(),
  severity: SeveritySchema,
  category: DiagnosticCategorySchema,
  detected: z.string(),
  recommended: z.string(),
  reason: z.string(),
  fix: z.string().optional(),
  docs: z.string().optional(),
})

export const AnalysisReportSchema = z.object({
  root: z.string(),
  capabilities: z.array(z.string()),
  installed: z.array(z.string()),
  database: z.string().nullable(),
  models: z.array(z.string()),
  tenantScopedModels: z.array(z.string()),
  unscopedModels: z.array(z.string()),
  diagnostics: z.array(DiagnosticSchema),
})

// --- ArchitecturePlan (plan/types.ts) --------------------------------------

export const PlanFieldSchema = z.object({
  name: z.string(),
  type: z.string(),
  enum: z.array(z.string()).optional(),
})

export const PlanRelationSchema = z.object({
  name: z.string(),
  model: z.string(),
})

export const PlanEntitySchema = z.object({
  name: z.string(),
  fields: z.array(PlanFieldSchema),
  tenantScoped: z.boolean(),
  relations: z.array(PlanRelationSchema).optional(),
})

export const PlanStepKindSchema = z.enum([
  'generator',
  'schema',
  'migration',
  'service',
  'routes',
  'permissions',
  'audit',
  'test',
  'docs',
  'other',
])

export const PlanStepSchema = z.object({
  order: z.number(),
  title: z.string(),
  kind: PlanStepKindSchema,
  detail: z.string(),
  command: z.string().optional(),
  files: z.array(z.string()).optional(),
})

export const ArchitecturePlanSchema = z.object({
  schemaVersion: z.number().int().default(PLAN_SCHEMA_VERSION),
  request: z.string(),
  summary: z.string(),
  entities: z.array(PlanEntitySchema),
  steps: z.array(PlanStepSchema),
  permissions: z.array(z.string()),
  auditEvents: z.array(z.string()),
  tenantScoped: z.boolean(),
  warnings: z.array(z.string()),
})

// --- MakeResult (make/types.ts) --------------------------------------------

export const GeneratedFileSchema = z.object({
  path: z.string(),
  content: z.string(),
})

export const SchemaMergeSchema = z.object({
  path: z.string(),
  found: z.boolean(),
  merged: z.array(z.string()),
  skipped: z.array(z.string()),
  written: z.boolean(),
})

export const MigrationSchema = z.object({
  ok: z.boolean(),
  output: z.string(),
})

export const ResourceBuildSchema = z.object({
  name: z.string(),
  prisma: z.boolean(),
  softDelete: z.boolean(),
  files: z.array(GeneratedFileSchema),
  augmented: z.boolean(),
  guarded: z.boolean(),
  audited: z.boolean(),
  written: z.array(z.string()),
  registered: z.boolean(),
  note: z.string().optional(),
})

export const ReviewStatusSchema = z.enum(['pass', 'warn', 'fail'])

export const ReviewItemSchema = z.object({
  label: z.string(),
  status: ReviewStatusSchema,
  detail: z.string(),
})

export const ReviewResultSchema = z.object({
  items: z.array(ReviewItemSchema),
  ok: z.boolean(),
})

export const FilePreviewSchema = z.object({
  path: z.string(),
  action: z.enum(['create', 'overwrite']),
  diff: z.string(),
})

export const MakePreviewSchema = z.object({
  perFile: z.array(FilePreviewSchema),
  clashes: z.array(z.string()),
})

export const MakeResultSchema = z.object({
  schemaVersion: z.number().int().default(MAKE_SCHEMA_VERSION),
  request: z.string(),
  dryRun: z.boolean(),
  resources: z.array(ResourceBuildSchema),
  schema: SchemaMergeSchema.optional(),
  migration: MigrationSchema.optional(),
  followUps: z.array(z.string()),
  review: ReviewResultSchema,
  preview: MakePreviewSchema.optional(),
})

// --- AgentReview (review/types.ts) -----------------------------------------

export const ReviewIssueSchema = z.object({
  dimension: z.string(),
  severity: z.enum(['error', 'warning']),
  message: z.string(),
})

export const AgentReviewSchema = z.object({
  approved: z.boolean(),
  summary: z.string(),
  issues: z.array(ReviewIssueSchema),
})

// --- JSON Schema derivation -------------------------------------------------

/**
 * Convert one of the exported zod schemas to JSON Schema (Draft 2020-12), for an
 * out-of-process consumer to advertise as an MCP tool `inputSchema`/`outputSchema`.
 */
export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema) as Record<string, unknown>
}
