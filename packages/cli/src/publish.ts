import { defineCommand, type CommandDefinition } from './command.js'
import { CI_WORKFLOW, DOCKERFILE, DOCKERIGNORE, EDITORCONFIG } from './stubs.js'

/** One file a publishable drops into the app. */
export interface PublishableFile {
  /** Path relative to the target dir, e.g. `Dockerfile` or `.github/workflows/ci.yml`. */
  path: string
  content: string
}

/** A named group of stub files an app can copy in and then own (à la vendor:publish). */
export interface Publishable {
  id: string
  description: string
  files(): PublishableFile[]
}

/** Filesystem surface for publishing — injected so `runPublish` is testable. */
export interface PublishFs {
  exists(path: string): Promise<boolean>
  write(path: string, content: string): Promise<void>
}

export interface PublishResult {
  written: string[]
  skipped: string[]
}

/** Stubs bundled with the CLI. Apps can register more via the metadata bucket. */
export const PUBLISHABLES: Publishable[] = [
  {
    id: 'dockerfile',
    description: 'Production multi-stage Dockerfile — build stage + plain-node runtime (+ .dockerignore keeping secrets out of the image)',
    files: () => [
      { path: 'Dockerfile', content: DOCKERFILE },
      { path: '.dockerignore', content: DOCKERIGNORE },
    ],
  },
  { id: 'ci', description: 'GitHub Actions CI workflow (install, typecheck, build, test)', files: () => [{ path: '.github/workflows/ci.yml', content: CI_WORKFLOW }] },
  { id: 'editorconfig', description: 'Shared .editorconfig', files: () => [{ path: '.editorconfig', content: EDITORCONFIG }] },
]

/**
 * Copies a publishable's files into the target, skipping any that already exist
 * unless `force` is set. Returns which files were written vs skipped.
 */
export async function runPublish(
  publishable: Publishable,
  fs: PublishFs,
  options: { force?: boolean } = {},
): Promise<PublishResult> {
  const written: string[] = []
  const skipped: string[] = []
  for (const file of publishable.files()) {
    if (!options.force && (await fs.exists(file.path))) {
      skipped.push(file.path)
      continue
    }
    await fs.write(file.path, file.content)
    written.push(file.path)
  }
  return { written, skipped }
}

/** Node-backed {@link PublishFs} rooted at `dir` (creates parent directories). */
export function nodePublishFs(dir: string): PublishFs {
  return {
    async exists(path) {
      const { access } = await import('node:fs/promises')
      const { join } = await import('node:path')
      return access(join(dir, path)).then(
        () => true,
        () => false,
      )
    },
    async write(path, content) {
      const { mkdir, writeFile } = await import('node:fs/promises')
      const { dirname, join } = await import('node:path')
      const target = join(dir, path)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, content, 'utf8')
    },
  }
}

/** `basalt publish [<id>] [--dir=<path>] [--force]` — list, or copy a stub group. */
export const publishCommand: CommandDefinition = defineCommand({
  name: 'publish',
  description: 'Copy a publishable stub group into the app (run with no id to list)',
  async handle({ io, args, flags }) {
    const id = args[0]
    if (!id) {
      io.log('Publishable groups:')
      io.table(PUBLISHABLES.map((p) => ({ id: p.id, description: p.description })))
      return 0
    }
    const publishable = PUBLISHABLES.find((p) => p.id === id)
    if (!publishable) {
      io.error(`Unknown publishable "${id}". Available: ${PUBLISHABLES.map((p) => p.id).join(', ')}.`)
      return 1
    }
    const dir = typeof flags['dir'] === 'string' ? flags['dir'] : process.cwd()
    const result = await runPublish(publishable, nodePublishFs(dir), { force: flags['force'] === true })
    for (const path of result.written) io.log(`  wrote ${path}`)
    for (const path of result.skipped) io.log(`  skipped ${path} (exists — use --force to overwrite)`)
    if (result.written.length === 0 && result.skipped.length > 0) {
      io.log('Nothing written. Re-run with --force to overwrite existing files.')
    }
    return 0
  },
})
