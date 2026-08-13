import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProjectContext } from '../context/project.js'
import type { LineWriter } from '../render.js'

export interface FileEdit {
  /** Path relative to the project root. */
  path: string
  before: string
  after: string
}

/** Returns the edits a fix would make, `[]` if there's nothing to change, or `null` if it can't apply. */
export type FixApplier = (read: (rel: string) => string | null, ctx: ProjectContext) => FileEdit[] | null

/**
 * Auto-fixers for doctor rules — only the ones with a safe, precise edit. Rules
 * that need a judgement call (tenant scoping, choosing a durable store) have no
 * entry and report "no auto-fix — apply manually".
 */
export const FIXES: Record<string, FixApplier> = {
  'fastify-logger-off': (read, ctx) => {
    if (!ctx.app) return null
    const content = read(ctx.app.path)
    if (content === null) return null
    if (/fastify\s*:\s*\{[^}]*\blogger\b/.test(content)) return [] // already configured
    const after = content.replace(
      /fastifyPlugin\(\s*\{/,
      (m) => `${m} fastify: { logger: process.env.NODE_ENV !== 'production' },`,
    )
    return after === content ? [] : [{ path: ctx.app.path, before: content, after }]
  },

  'insecure-app-secret': (read, ctx) => {
    if (!ctx.env) return null
    const value = ctx.env.appSecretDefault
    if (!value || !/change|me|example|secret|placeholder|xxx/i.test(value)) return []
    const content = read(ctx.env.path)
    if (content === null) return null
    const after = content.replace(/^(\s*)APP_SECRET:\s*z\.string\(\)[^\n]*$/m, '$1APP_SECRET: z.string().min(32),')
    return after === content ? [] : [{ path: ctx.env.path, before: content, after }]
  },
}

export type FixStatus = 'ready' | 'noop' | 'unfixable'

export interface FixOutcome {
  id: string
  status: FixStatus
  edits: FileEdit[]
  message: string
}

/** IDs of rules that have an auto-fixer. */
export function fixableIds(): string[] {
  return Object.keys(FIXES)
}

/** Compute (but don't write) the edits for a rule's fix. */
export function planFix(id: string, ctx: ProjectContext, read: (rel: string) => string | null): FixOutcome {
  const applier = FIXES[id]
  if (!applier) {
    return { id, status: 'unfixable', edits: [], message: 'no auto-fix — apply manually (see `basalt ai:doctor`)' }
  }
  const edits = applier(read, ctx)
  if (edits === null) return { id, status: 'unfixable', edits: [], message: 'target file not found' }
  const changed = edits.filter((e) => e.before !== e.after)
  if (changed.length === 0) return { id, status: 'noop', edits: [], message: 'nothing to change (already fixed?)' }
  return { id, status: 'ready', edits: changed, message: `edits ${changed.map((e) => e.path).join(', ')}` }
}

/** Write a fix's edits to disk. */
export async function applyFixEdits(edits: FileEdit[], baseDir: string): Promise<void> {
  for (const edit of edits) await writeFile(join(baseDir, edit.path), edit.after)
}

/** Render fix outcomes with a line-level diff. */
export function renderFixes(outcomes: FixOutcome[], io: LineWriter): void {
  const mark: Record<FixStatus, string> = { ready: '✓', noop: '•', unfixable: '⚠' }
  for (const outcome of outcomes) {
    io.log(`${mark[outcome.status]} ${outcome.id} — ${outcome.message}`)
    for (const edit of outcome.edits) {
      io.log(`  ${edit.path}:`)
      for (const [removed, added] of lineDiff(edit.before, edit.after)) {
        if (removed !== undefined) io.log(`    - ${removed.trim()}`)
        if (added !== undefined) io.log(`    + ${added.trim()}`)
      }
    }
  }
}

/** Positional line diff — the auto-fixes edit lines in place, keeping the line count. */
function lineDiff(before: string, after: string): Array<[string | undefined, string | undefined]> {
  const b = before.split('\n')
  const a = after.split('\n')
  const out: Array<[string | undefined, string | undefined]> = []
  for (let i = 0; i < Math.max(b.length, a.length); i++) {
    if (b[i] !== a[i]) out.push([b[i], a[i]])
  }
  return out
}
