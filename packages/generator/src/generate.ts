import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { names, type Names } from './names.js'
import {
  pluginFile,
  prismaModelFile,
  repositoryFile,
  routesFile,
  moduleFile,
  schemaFile,
  serviceFile,
  testFile,
  type GeneratedFile,
  type GeneratorOptions,
} from './templates.js'

export type { GeneratorOptions, PrismaClientRef } from './templates.js'

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
    // The vertical always gets the CRUD service: the repository and schema it
    // imports are generated right here, in the same batch. Stated explicitly so
    // it does not ride on the default.
    serviceFile(n, { ...options, crud: true }),
    pluginFile(n, options),
    routesFile(n, options),
    testFile(n, options),
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

/**
 * What each artifact imports from the resource module but does not generate
 * itself. `make:resource` writes them all in one batch; a single `make:<kind>`
 * writes one file, and the ones it refers to have to be there already or the
 * file does not compile (TS2307).
 */
const SIBLINGS: Record<GeneratorKind, (n: Names) => string[]> = {
  schema: () => [],
  repository: (n) => [moduleFile(n, 'schema')],
  service: (n) => [moduleFile(n, 'repository'), moduleFile(n, 'schema')],
  plugin: (n) => [moduleFile(n, 'repository'), moduleFile(n, 'service')],
  routes: (n) => [moduleFile(n, 'service'), moduleFile(n, 'schema')],
  test: (n) => [moduleFile(n, 'plugin'), moduleFile(n, 'routes')],
}

/**
 * The files `kind` will import but not create, as project-relative paths.
 * Pure — it says nothing about what is on disk; see {@link missingSiblings}.
 *
 * A minimal service (`crud: false`) imports nothing, so it expects nothing.
 */
export function expectedSiblings(
  kind: GeneratorKind,
  name: string | Names,
  options: GeneratorOptions = {},
): string[] {
  if (kind === 'service' && options.crud === false) return []
  return SIBLINGS[kind](typeof name === 'string' ? names(name) : name)
}

/**
 * The subset of {@link expectedSiblings} that is not under `write.baseDir`
 * (default `process.cwd()`) — the files the generated artifact will import and
 * nobody has written. Empty for every kind once `make:resource` has run.
 *
 * The CLI prints these as a warning and generates the file anyway; tooling that
 * calls the generator programmatically (the dev-only `@basaltkit/ai` `make`
 * path, an MCP client, an editor extension) should surface them the same way —
 * {@link missingSiblingsWarning} renders the exact lines the CLI prints.
 */
export async function missingSiblings(
  kind: GeneratorKind,
  name: string,
  options: GeneratorOptions = {},
  write: WriteOptions = {},
): Promise<string[]> {
  const baseDir = resolve(write.baseDir ?? process.cwd())
  const missing: string[] = []
  for (const path of expectedSiblings(kind, name, options)) {
    const exists = await access(join(baseDir, path)).then(
      () => true,
      () => false,
    )
    if (!exists) missing.push(path)
  }
  return missing
}

/**
 * The warning the CLI prints when a generated artifact refers to files that do
 * not exist yet: what is missing, and the command that creates them. Empty
 * array when nothing is missing.
 */
export function missingSiblingsWarning(name: string, generatedPath: string, missing: string[]): string[] {
  if (missing.length === 0) return []
  const n = names(name)
  return [
    `Warning: ${generatedPath} imports ${missing.length} file(s) that do not exist yet:`,
    ...missing.map((path) => `  ${path}`),
    `  Generate the whole vertical with \`basalt make:resource ${n.pascal}\`, or write them yourself — until then this file does not compile.`,
  ]
}

/**
 * Whether the sibling files a CRUD service imports — `<name>.repository.ts`
 * and `<name>.schema.ts` in the module directory — are already under
 * `baseDir`. Both, or none: a service importing a file nobody generated does
 * not compile.
 *
 * This is what `basalt make:service <Name>` consults when neither `--crud` nor
 * `--no-crud` was given, and what a programmatic caller should consult before
 * calling `generate('service', …)` on its own — `generateResource` does not
 * need it (it writes the siblings itself).
 */
export async function serviceSiblingsExist(name: string, options: WriteOptions = {}): Promise<boolean> {
  return (await missingSiblings('service', name, { crud: true }, options)).length === 0
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
