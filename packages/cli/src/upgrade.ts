import { defineCommand, type CommandDefinition } from './command.js'

/**
 * Filesystem surface an upgrade migration works against. Injected so migrations
 * (and `runUpgrade`) are testable with an in-memory tree — no disk needed.
 */
export interface UpgradeFs {
  /** Recursively lists files under `dir` (relative paths). Skips node_modules/dist/.git. */
  list(dir: string): Promise<string[]>
  read(path: string): Promise<string>
  write(path: string, content: string): Promise<void>
}

/** A single edit a migration wants to make — surfaced for `--dry` before writing. */
export interface Edit {
  path: string
  before: string
  after: string
}

/** A versioned, idempotent codemod. `plan` computes edits without writing them. */
export interface Migration {
  id: string
  description: string
  plan(fs: UpgradeFs, dir: string): Promise<Edit[]>
}

export interface UpgradeReport {
  migration: string
  changed: string[]
}

/**
 * A codemod that rewrites the deprecated `@machize/*` npm scope to `@basaltkit/*`
 * across package.json and source imports. Unambiguous (scoped rename), so a plain
 * text replace is safe and idempotent.
 */
export const renameMachizeScope: Migration = {
  id: 'rename-machize-scope',
  description: 'Rewrite the deprecated @machize/* scope to @basaltkit/*',
  async plan(fs, dir) {
    const files = (await fs.list(dir)).filter((p) => /\.(t|j)sx?$|\.json$/.test(p))
    const edits: Edit[] = []
    for (const path of files) {
      const before = await fs.read(path)
      if (!before.includes('@machize/')) continue
      const after = before.split('@machize/').join('@basaltkit/')
      if (after !== before) edits.push({ path, before, after })
    }
    return edits
  },
}

/** All migrations shipped with the CLI, in application order. */
export const MIGRATIONS: Migration[] = [renameMachizeScope]

/**
 * Runs the selected migrations. With `dry`, computes and reports edits without
 * writing. Returns a per-migration report of the files it changed.
 */
export async function runUpgrade(
  migrations: Migration[],
  fs: UpgradeFs,
  options: { dir: string; dry?: boolean; only?: string },
): Promise<UpgradeReport[]> {
  const selected = options.only ? migrations.filter((m) => m.id === options.only) : migrations
  const reports: UpgradeReport[] = []
  for (const migration of selected) {
    const edits = await migration.plan(fs, options.dir)
    if (!options.dry) {
      for (const edit of edits) await fs.write(edit.path, edit.after)
    }
    reports.push({ migration: migration.id, changed: edits.map((e) => e.path) })
  }
  return reports
}

/** Node-backed {@link UpgradeFs}. Recursive, skipping build/vcs directories. */
export function nodeUpgradeFs(): UpgradeFs {
  const SKIP = new Set(['node_modules', 'dist', '.git', '.next', 'build', 'coverage'])
  return {
    async list(dir) {
      const { readdir } = await import('node:fs/promises')
      const { join, relative } = await import('node:path')
      const out: string[] = []
      const walk = async (current: string): Promise<void> => {
        const entries = await readdir(current, { withFileTypes: true })
        for (const entry of entries) {
          if (entry.isDirectory()) {
            if (!SKIP.has(entry.name)) await walk(join(current, entry.name))
          } else {
            out.push(relative(dir, join(current, entry.name)))
          }
        }
      }
      await walk(dir)
      return out
    },
    async read(path) {
      const { readFile } = await import('node:fs/promises')
      const { isAbsolute, join } = await import('node:path')
      return readFile(isAbsolute(path) ? path : join(process.cwd(), path), 'utf8')
    },
    async write(path, content) {
      const { writeFile } = await import('node:fs/promises')
      const { isAbsolute, join } = await import('node:path')
      await writeFile(isAbsolute(path) ? path : join(process.cwd(), path), content, 'utf8')
    },
  }
}

/** `basalt upgrade [--dir=<path>] [--dry] [--only=<migration-id>]` */
export const upgradeCommand: CommandDefinition = defineCommand({
  name: 'upgrade',
  description: 'Apply framework upgrade codemods (--dry to preview, --only=<id>)',
  async handle({ io, flags }) {
    const dir = typeof flags['dir'] === 'string' ? flags['dir'] : process.cwd()
    const dry = flags['dry'] === true
    const only = typeof flags['only'] === 'string' ? flags['only'] : undefined
    if (only && !MIGRATIONS.some((m) => m.id === only)) {
      io.error(`Unknown migration "${only}". Available: ${MIGRATIONS.map((m) => m.id).join(', ')}.`)
      return 1
    }
    const reports = await runUpgrade(MIGRATIONS, nodeUpgradeFs(), {
      dir,
      dry,
      ...(only ? { only } : {}),
    })
    let total = 0
    for (const report of reports) {
      if (report.changed.length === 0) continue
      total += report.changed.length
      io.log(`${dry ? '[dry] ' : ''}${report.migration}: ${report.changed.length} file(s)`)
      for (const path of report.changed) io.log(`  ${path}`)
    }
    if (total === 0) io.log('Nothing to upgrade — everything is up to date.')
    else if (dry) io.log(`\n${total} file(s) would change. Re-run without --dry to apply.`)
    else io.log(`\nApplied ${total} change(s).`)
    return 0
  },
})
