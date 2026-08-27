import type { GeneratedFile } from '@basaltkit/generator/resource'
import type { OnProgress } from '../generate.js'

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
  /** Path to the Prisma schema to merge models into. Default `prisma/schema.prisma`. */
  schemaPath?: string
  /** After merging models, run `prisma db push` (creates tables + regenerates the client). */
  migrate?: boolean
  /** Abort the operation (checked at each resource boundary). */
  signal?: AbortSignal
  /** Receive coarse progress as each resource is built. */
  onProgress?: OnProgress
}

/** How the generated models were merged into prisma/schema.prisma. */
export interface SchemaMerge {
  path: string
  /** The schema file was found on disk. */
  found: boolean
  /** Models appended. */
  merged: string[]
  /** Models already present (left as is). */
  skipped: string[]
  /** The schema file was written (false on dry-run). */
  written: boolean
}

/** Result of an opt-in `prisma db push`. */
export interface Migration {
  ok: boolean
  /** Tail of the command output. */
  output: string
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

/** One file the build would write, with the change it would make. */
export interface FilePreview {
  path: string
  /** `create` = the file does not exist; `overwrite` = it exists and would be replaced. */
  action: 'create' | 'overwrite'
  /** Unified diff of the change (empty old side for a new file). */
  diff: string
}

/** A dry-run preview: exactly what would be written, and which files clash. */
export interface MakePreview {
  perFile: FilePreview[]
  /** Paths that already exist and would be overwritten (an apply needs `force`). */
  clashes: string[]
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
  /**
   * Serialization contract version. `runMake` always sets it; optional on the
   * type so older, unversioned results still satisfy the interface.
   */
  schemaVersion?: number
  request: string
  dryRun: boolean
  resources: ResourceBuild[]
  /** How models were merged into the Prisma schema (undefined when no Prisma resource). */
  schema?: SchemaMerge
  /** Result of `--migrate` (undefined when not requested). */
  migration?: Migration
  /** Manual follow-ups the scaffold can't do yet. */
  followUps: string[]
  review: ReviewResult
  /** Dry-run only: the exact per-file plan (clash flags + diffs). Absent on apply. */
  preview?: MakePreview
}
