import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { names, type Names } from './names.js'
import {
  pluginFile,
  repositoryFile,
  routesFile,
  schemaFile,
  serviceFile,
  testFile,
  type GeneratedFile,
} from './templates.js'

/** The kinds of artifact the generator can emit individually. */
export const GENERATORS = {
  schema: schemaFile,
  repository: repositoryFile,
  service: serviceFile,
  plugin: pluginFile,
  routes: routesFile,
  test: testFile,
} as const

export type GeneratorKind = keyof typeof GENERATORS

/** Generates a single artifact for a resource name. */
export function generate(kind: GeneratorKind, name: string): GeneratedFile {
  return GENERATORS[kind](names(name))
}

/** Generates the full resource vertical (schema → repository → service → plugin → routes → test). */
export function generateResource(name: string): GeneratedFile[] {
  const n: Names = names(name)
  return [
    schemaFile(n),
    repositoryFile(n),
    serviceFile(n),
    pluginFile(n),
    routesFile(n),
    testFile(n),
  ]
}

export class FileExistsError extends Error {
  constructor(readonly paths: string[]) {
    super(
      `Refusing to overwrite existing files (use force to replace):\n${paths
        .map((path) => `  ${path}`)
        .join('\n')}`,
    )
    this.name = 'FileExistsError'
  }
}

export interface WriteOptions {
  /** Project root the paths are resolved against. Default: process.cwd(). */
  baseDir?: string
  /** Overwrite existing files instead of refusing. Default: false. */
  force?: boolean
}

/** Writes generated files to disk. Refuses to clobber unless `force`. */
export async function writeGenerated(
  files: GeneratedFile[],
  options: WriteOptions = {},
): Promise<string[]> {
  const baseDir = resolve(options.baseDir ?? process.cwd())

  if (!options.force) {
    const clashes: string[] = []
    for (const file of files) {
      const exists = await readFile(join(baseDir, file.path)).then(
        () => true,
        () => false,
      )
      if (exists) clashes.push(file.path)
    }
    if (clashes.length > 0) throw new FileExistsError(clashes)
  }

  const written: string[] = []
  for (const file of files) {
    const target = join(baseDir, file.path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, file.content)
    written.push(file.path)
  }
  return written.sort()
}
