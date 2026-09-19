import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { memoryIo } from '@basaltkit/cli'
import { generate, generateResource, generatorCommands, serviceSiblingsExist } from '../src/index.js'

/**
 * `basalt make:service <Name>` used to always emit the CRUD service, importing
 * a sibling repository and schema it did not generate — run alone, the file did
 * not compile (TS2307). A service generated on its own now gets the minimal
 * shape unless the siblings are actually there (or `--crud` says otherwise).
 */

const here = dirname(fileURLToPath(import.meta.url))
const packageDir = join(here, '..')
const CORE_TYPES = join(packageDir, '..', 'core', 'dist', 'index.d.ts')

const run = async (command: string, args: string[], flags: Record<string, unknown>) => {
  const io = memoryIo()
  const code = await (generatorCommands().find((c) => c.name === command) as never as {
    handle: (input: unknown) => Promise<number>
  }).handle({ args, flags, io, app: undefined, container: undefined })
  return { code, out: io.lines.join('\n') }
}

/** Writes the sibling files a CRUD service imports, as `make:resource` would. */
const writeSiblings = async (root: string, kebab: string) => {
  const files = generateResource(kebab).filter(
    (f) => f.path.endsWith('.repository.ts') || f.path.endsWith('.schema.ts'),
  )
  for (const file of files) {
    await mkdir(join(root, dirname(file.path)), { recursive: true })
    await writeFile(join(root, file.path), file.content)
  }
}

const readService = (root: string, kebab: string) =>
  readFile(join(root, `src/modules/${kebab}/${kebab}.service.ts`), 'utf8')

describe('make:service without its siblings', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'basalt-gen-service-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('generates a minimal service that imports no file it did not create', async () => {
    const { code } = await run('make:service', ['Probe'], { dir: root })
    expect(code).toBe(0)

    const service = await readService(root, 'probe')
    // the bug: these imports pointed at files nobody generated
    expect(service).not.toContain('./probe.repository.js')
    expect(service).not.toContain('./probe.schema.js')
    expect(service).toContain("import { createToken } from '@basaltkit/core'")
    expect(service).toContain('export class ProbeService')
    expect(service).toContain('constructor()')
    expect(service).toContain("createToken<ProbeService>('probe.service')")
    // points the developer at the command that generates the whole vertical
    expect(service).toContain('make:resource')
  })

  it('tells the developer which shape it generated', async () => {
    const { out } = await run('make:service', ['Probe'], { dir: root })
    expect(out).toContain('Minimal service')
    expect(out).toContain('--crud')
  })

  it('keeps the CRUD shape when the repository and schema are already there', async () => {
    await writeSiblings(root, 'probe')
    const { code } = await run('make:service', ['Probe'], { dir: root })
    expect(code).toBe(0)

    const service = await readService(root, 'probe')
    expect(service).toContain("import type { ProbeRepository } from './probe.repository.js'")
    expect(service).toContain("} from './probe.schema.js'")
    expect(service).toContain('return this.repository.list()')
  })

  it('needs BOTH siblings — a lone repository is not enough', async () => {
    const repository = generateResource('probe').find((f) => f.path.endsWith('.repository.ts'))!
    await mkdir(join(root, dirname(repository.path)), { recursive: true })
    await writeFile(join(root, repository.path), repository.content)

    expect(await serviceSiblingsExist('Probe', { baseDir: root })).toBe(false)
    await run('make:service', ['Probe'], { dir: root })
    expect(await readService(root, 'probe')).not.toContain('./probe.schema.js')
  })

  it('--crud forces the CRUD shape and --no-crud forces the minimal one', async () => {
    const forced = await mkdtemp(join(tmpdir(), 'basalt-gen-service-crud-'))
    const minimal = await mkdtemp(join(tmpdir(), 'basalt-gen-service-min-'))
    try {
      await run('make:service', ['Probe'], { dir: forced, crud: true })
      expect(await readService(forced, 'probe')).toContain('./probe.repository.js')

      await writeSiblings(minimal, 'probe')
      await run('make:service', ['Probe'], { dir: minimal, crud: false })
      expect(await readService(minimal, 'probe')).not.toContain('./probe.repository.js')
    } finally {
      await rm(forced, { recursive: true, force: true })
      await rm(minimal, { recursive: true, force: true })
    }
  })

  it('leaves make:resource untouched — the vertical still gets the CRUD service', async () => {
    const service = generateResource('Probe').find((f) => f.path.endsWith('.service.ts'))!
    expect(service.content).toContain("import type { ProbeRepository } from './probe.repository.js'")
    expect(service.content).toContain('remove(id: string)')

    await run('make:resource', ['Probe'], { dir: root, 'no-register': true })
    expect(await readService(root, 'probe')).toContain('./probe.repository.js')
  })

  it('the programmatic API keeps the CRUD default; crud: false opts out', () => {
    expect(generate('service', 'Probe').content).toContain('./probe.repository.js')
    expect(generate('service', 'Probe', { crud: false }).content).not.toContain('./probe.repository.js')
  })
})

/**
 * The framework's own rule: generated code compiles. Compiled with the real
 * tsc, `@basaltkit/core` mapped to the workspace build (the generator does not
 * depend on core, so there is nothing to resolve from node_modules).
 */
describe('the minimal service typechecks on its own', () => {
  it.skipIf(!existsSync(CORE_TYPES))('compiles with no sibling files present', async () => {
    const root = await mkdtemp(join(tmpdir(), 'basalt-gen-tsc-'))
    try {
      const file = generate('service', 'Probe', { crud: false })
      await mkdir(join(root, dirname(file.path)), { recursive: true })
      await writeFile(join(root, file.path), file.content)
      await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'probe-app', type: 'module' }))
      await writeFile(
        join(root, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            target: 'ES2022',
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            lib: ['ES2023'],
            types: [],
            strict: true,
            noEmit: true,
            skipLibCheck: true,
            verbatimModuleSyntax: true,
            paths: { '@basaltkit/core': [CORE_TYPES] },
          },
          include: ['src'],
        }),
      )

      let output = ''
      try {
        execFileSync(join(packageDir, 'node_modules/.bin/tsc'), ['-p', root], { encoding: 'utf8', stdio: 'pipe' })
      } catch (error) {
        const e = error as { stdout?: string; stderr?: string }
        output = `${e.stdout ?? ''}${e.stderr ?? ''}`
      }
      expect(output).toBe('')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)
})
