import type { GeneratedFile } from '@basaltkit/generator'

export interface MakeOptions {
  /** Skip writing to disk — return what would be generated. */
  dryRun?: boolean
  /** Overwrite existing files instead of refusing. */
  force?: boolean
  /** Project root. Defaults to process.cwd(). */
  baseDir?: string
  /** Force a Prisma-backed resource (default: inferred from the stack). */
  prisma?: boolean
  /** Force soft-delete (default: from the plan's generator command). */
  softDelete?: boolean
}

export interface ResourceBuild {
  name: string
  prisma: boolean
  softDelete: boolean
  /** Generated (and domain-augmented) files. */
  files: GeneratedFile[]
  /** Domain fields were injected into schema/model. */
  augmented: boolean
  /** Permission `meta.can` guards were injected into the routes. */
  guarded: boolean
  /** Audit recording was injected into the service + plugin. */
  audited: boolean
  /** Files actually written (empty on dry-run or on clash). */
  written: string[]
  /** Wired into src/app.ts. */
  registered: boolean
  /** Why a step didn't complete (e.g. a file clash). */
  note?: string
}

export type ReviewStatus = 'pass' | 'warn' | 'fail'

export interface ReviewItem {
  label: string
  status: ReviewStatus
  detail: string
}

export interface ReviewResult {
  items: ReviewItem[]
  /** True when no item failed. */
  ok: boolean
}

export interface MakeResult {
  request: string
  dryRun: boolean
  resources: ResourceBuild[]
  /** Manual follow-ups the scaffold can't do yet (migration, permissions, audit). */
  followUps: string[]
  review: ReviewResult
}
