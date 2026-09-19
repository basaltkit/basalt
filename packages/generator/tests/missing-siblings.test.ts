import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, normalize, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { memoryIo } from '@basaltkit/cli'
import {
  GENERATORS,
  expectedSiblings,
  generate,
  generateResource,
  generatorCommands,
  missingSiblings,
  names,
  type GeneratorKind,
} from '../src/index.js'

/**
 * Every generated artifact but the schema imports a sibling it does not create:
 * the plugin needs the repository and the service, the routes need the service
 * and the schema, the test needs the plugin and the routes. Run alone, each one
 * failed the first `tsc` with TS2307 and said nothing about it. The generator
 * still writes the file — the sibling may be about to be written by hand — but
 * it now names what is missing, at generation time.
 */

const here = dirname(fileURLToPath(import.meta.url))
const packageDir = join(here, '..')
const CORE_TYPES = join(packageDir, '..', 'core', 'dist', 'index.d.ts')
const ZOD_TYPES = join(packageDir, '..', 'http', 'node_modules', 'zod', 'index.d.ts')

const run = async (command: string, args: string[], flags: Record<string, unknown>) => {
  const io = memoryIo()
  const code = await (generatorCommands().find((c) => c.name === command) as never as {
    handle: (input: unknown) => Promise<number>
  }).handle({ args, flags, io, app: undefined, container: undefined })
  return { code, out: io.lines.join('\n'), errors: io.errors.join('\n') }
}

const write = async (root: string, files: { path: string; content: string }[]) => {
  for (const file of files) {
    await mkdir(join(root, dirname(file.path)), { recursive: true })
    await writeFile(join(root, file.path), file.content)
  }
}

const KINDS = Object.keys(GENERATORS) as GeneratorKind[]

/** What each kind imports from the resource module but does not generate itself. */
const EXPECTED: Record<GeneratorKind, string[]> = {
  schema: [],
  repository: ['src/modules/probe/probe.schema.ts'],
  service: ['src/modules/probe/probe.repository.ts', 'src/modules/probe/probe.schema.ts'],
  plugin: ['src/modules/probe/probe.repository.ts', 'src/modules/probe/probe.service.ts'],
  routes: ['src/modules/probe/probe.service.ts', 'src/modules/probe/probe.schema.ts'],
  test: ['src/modules/probe/probe.plugin.ts', 'src/modules/probe/probe.routes.ts'],
}

describe('expectedSiblings', () => {
  it('lists, per kind, the files the artifact imports but does not create', () => {
    for (const kind of KINDS) {
      expect([...expectedSiblings(kind, names('Probe'))].sort()).toEqual([...(EXPECTED[kind] ?? [])].sort())
    }
  })

  it('stays in step with what the templates actually import', () => {
    // Drift net: derive the relative imports from the generated text itself, so
    // a template that starts importing something new fails here instead of in
    // a user's first typecheck.
    for (const kind of KINDS) {
      const file = generate(kind, 'Probe')
      const imports = [...file.content.matchAll(/from '(\.[^']+)'/g)].map((m) => m[1] as string)
      const resolved = imports.map((specifier) =>
        posix.normalize(posix.join(posix.dirname(file.path), specifier.replace(/\.js$/, '.ts'))),
      )
      expect([...new Set(resolved)].sort()).toEqual([...expectedSiblings(kind, names('Probe'))].sort())
    }
  })

  it('a minimal service imports nothing, so it expects nothing', () => {
    expect(expectedSiblings('service', names('Probe'), { crud: false })).toEqual([])
    expect(generate('service', 'Probe', { crud: false }).content).not.toContain("from '.")
  })
})

describe('the make:* commands warn about siblings that are not there', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'basalt-gen-siblings-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it.each([
    ['make:plugin', EXPECTED.plugin],
    ['make:routes', EXPECTED.routes],
    ['make:test', EXPECTED.test],
    ['make:repository', EXPECTED.repository],
  ] as const)('%s alone names exactly the missing files', async (command, missing) => {
    const { code, out } = await run(command, ['Probe'], { dir: root })
    expect(code).toBe(0)
    expect(out).toContain('Warning:')
    const warning = out.slice(out.indexOf('Warning:'))
    // exactly the missing siblings, no more: the header names the file that was
    // written (not a sibling of itself), the listed lines are the missing ones
    const listed = warning
      .split('\n')
      .slice(1)
      .filter((line) => /^ {2}(src|tests)\//.test(line))
      .map((line) => line.trim())
    expect(listed).toEqual([...missing])
    expect(warning.split('\n')[0]).toContain(generate(command.replace('make:', '') as GeneratorKind, 'Probe').path)
    expect(warning).toContain('basalt make:resource Probe')
  })

  it('writes the file anyway — the sibling may be coming', async () => {
    const { code, out } = await run('make:plugin', ['Probe'], { dir: root })
    expect(code).toBe(0)
    expect(existsSync(join(root, 'src/modules/probe/probe.plugin.ts'))).toBe(true)
    expect(out).toContain('src/modules/probe/probe.plugin.ts')
  })

  it('says nothing when the siblings are already on disk', async () => {
    await write(
      root,
      generateResource('Probe').filter((f) => !f.path.endsWith('.plugin.ts')),
    )
    const { out } = await run('make:plugin', ['Probe'], { dir: root, force: true })
    expect(out).not.toContain('Warning:')
  })

  it('make:schema never warns — it imports nothing of its own', async () => {
    const { out } = await run('make:schema', ['Probe'], { dir: root })
    expect(out).not.toContain('Warning:')
  })

  it('make:resource stays silent — it generates the whole vertical', async () => {
    const { out } = await run('make:resource', ['Probe'], { dir: root, 'no-register': true })
    expect(out).not.toContain('Warning:')
  })

  it('make:service keeps its own note and never warns', async () => {
    const { out: minimal } = await run('make:service', ['Probe'], { dir: root })
    expect(minimal).not.toContain('Warning:')
    expect(minimal).toContain('Minimal service')

    await write(
      root,
      generateResource('Probe').filter(
        (f) => f.path.endsWith('.repository.ts') || f.path.endsWith('.schema.ts'),
      ),
    )
    const { out: crud } = await run('make:service', ['Probe'], { dir: root, force: true })
    expect(crud).not.toContain('Warning:')
  })
})

describe('missingSiblings', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'basalt-gen-missing-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('is what is expected minus what is on disk', async () => {
    expect(await missingSiblings('plugin', 'Probe', {}, { baseDir: root })).toEqual(EXPECTED.plugin)

    await write(
      root,
      generateResource('Probe').filter((f) => f.path.endsWith('.repository.ts')),
    )
    expect(await missingSiblings('plugin', 'Probe', {}, { baseDir: root })).toEqual([
      'src/modules/probe/probe.service.ts',
    ])

    await write(
      root,
      generateResource('Probe').filter((f) => f.path.endsWith('.service.ts')),
    )
    expect(await missingSiblings('plugin', 'Probe', {}, { baseDir: root })).toEqual([])
  })
})

/**
 * The warning's claim, proved once with the real tsc: a repository generated
 * without its schema does not compile, and compiles as soon as the schema it
 * named is there. `@basaltkit/core` and `zod` are mapped to the workspace
 * (the generator depends on neither).
 */
describe('a generated artifact does not compile without its siblings', () => {
  it.skipIf(!existsSync(CORE_TYPES) || !existsSync(ZOD_TYPES))(
    'repository alone fails with TS2307, and passes once the schema is written',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'basalt-gen-tsc-siblings-'))
      try {
        await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'probe-app', type: 'module' }))
        await writeFile(
          join(root, 'tsconfig.json'),
          JSON.stringify({
            compilerOptions: {
              target: 'ES2022',
              module: 'NodeNext',
              moduleResolution: 'NodeNext',
              lib: ['ES2023'],
              strict: true,
              noEmit: true,
              skipLibCheck: true,
              verbatimModuleSyntax: true,
              types: ['node'],
              typeRoots: [join(packageDir, 'node_modules', '@types')],
              paths: { '@basaltkit/core': [CORE_TYPES], zod: [ZOD_TYPES] },
            },
            include: ['src'],
          }),
        )
        const typecheck = (): string => {
          try {
            execFileSync(join(packageDir, 'node_modules/.bin/tsc'), ['-p', root], {
              encoding: 'utf8',
              stdio: 'pipe',
            })
            return ''
          } catch (error) {
            const e = error as { stdout?: string; stderr?: string }
            return `${e.stdout ?? ''}${e.stderr ?? ''}`
          }
        }

        const repository = generate('repository', 'Probe')
        await write(root, [repository])
        const missing = await missingSiblings('repository', 'Probe', {}, { baseDir: root })
        expect(missing).toEqual(['src/modules/probe/probe.schema.ts'])

        const broken = typecheck()
        expect(broken).toContain('error TS2307')
        expect(broken).toContain(normalize('probe.schema.js'))

        await write(root, [generate('schema', 'Probe')])
        expect(await missingSiblings('repository', 'Probe', {}, { baseDir: root })).toEqual([])
        expect(typecheck()).toBe('')
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    60_000,
  )
})
