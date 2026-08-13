import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { names, type Names } from './names.js'
import {
  pluginFile,
  prismaModelFile,
  repositoryFile,
  routesFile,
  schemaFile,
  serviceFile,
  testFile,
  type GeneratedFile,
  type GeneratorOptions,
} from './templates.js'

export type { GeneratorOptions } from './templates.js'

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

const GENERATOR_FNS = GENERATORS as Record<GeneratorKind, (n: Names, options?: GeneratorOptions) => GeneratedFile>

/** Generates a single artifact for a resource name. */
export function generate(kind: GeneratorKind, name: string, options: GeneratorOptions = {}): GeneratedFile {
  return GENERATOR_FNS[kind](names(name), options)
}

/** Generates the full resource vertical (schema → repository → service → plugin → routes → test). */
export function generateResource(name: string, options: GeneratorOptions = {}): GeneratedFile[] {
  const n: Names = names(name)
  return [
    schemaFile(n, options),
    repositoryFile(n, options),
    ...(options.prisma ? [prismaModelFile(n, options)] : []),
    serviceFile(n, options),
    pluginFile(n, options),
    routesFile(n, options),
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

export interface AppRegistration {
  registered: boolean
  /** When not registered, why: 'src/app.ts not found', 'already registered', or 'shape'. */
  reason?: string
  appPath: string
}

/**
 * Wires a generated resource into `src/app.ts`: imports the plugin + routes,
 * adds the plugin to the `plugins` array and spreads the routes into
 * `fastifyPlugin({ routes: [...] })`.
 *
 * Best-effort and idempotent: if app.ts is missing, already wired, or does not
 * match the expected shape, it changes nothing and reports why — so the caller
 * can fall back to printing manual instructions. Never throws on shape.
 */
export async function registerResourceInApp(
  name: string,
  options: WriteOptions = {},
): Promise<AppRegistration> {
  const baseDir = resolve(options.baseDir ?? process.cwd())
  const appPath = join(baseDir, 'src', 'app.ts')

  let source: string
  try {
    source = await readFile(appPath, 'utf8')
  } catch {
    return { registered: false, reason: 'src/app.ts not found', appPath }
  }

  const n = names(name)
  const pluginId = `${n.camel}Plugin`
  const routesId = `${n.camel}Routes`
  const pluginImport = `import { ${pluginId} } from './modules/${n.kebab}/${n.kebab}.plugin.js'`
  const routesImport = `import { ${routesId} } from './modules/${n.kebab}/${n.kebab}.routes.js'`

  // Idempotent: if the plugin identifier already appears, do nothing.
  if (new RegExp(`\\b${pluginId}\\b`).test(source)) {
    return { registered: false, reason: 'already registered', appPath }
  }

  // Both anchors must be present, or we make no change (all-or-nothing).
  // Tolerate other options before `routes:` (e.g. `fastifyPlugin({ fastify: {...}, routes: [...] })`).
  const routesAnchor = /fastifyPlugin\(\s*\{[\s\S]*?\broutes:\s*\[/
  const pluginAnchor = /^([ \t]*)fastifyPlugin\(/m
  const imports = [...source.matchAll(/^import .*$/gm)]
  const lastImport = imports.at(-1)
  if (!lastImport || lastImport.index === undefined || !routesAnchor.test(source) || !pluginAnchor.test(source)) {
    return { registered: false, reason: 'app.ts does not use fastifyPlugin({ routes: [...] })', appPath }
  }

  let out = source
  // 1) imports — after the last top-level import line
  const insertAt = lastImport.index + lastImport[0].length
  out = `${out.slice(0, insertAt)}\n${pluginImport}\n${routesImport}${out.slice(insertAt)}`
  // 2) plugin — before the fastifyPlugin( line, matching its indentation
  out = out.replace(pluginAnchor, (_match, indent: string) => `${indent}${pluginId},\n${indent}fastifyPlugin(`)
  // 3) routes — spread into the front of the routes array
  out = out.replace(routesAnchor, (match) => `${match}...${routesId}, `)

  await writeFile(appPath, out)
  return { registered: true, appPath }
}
