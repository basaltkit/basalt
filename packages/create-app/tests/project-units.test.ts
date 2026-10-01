import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseArgs } from '../src/args.js'
import { binStatus, LEGACY_BIN_HASHES } from '../src/bin-template.js'
import { createProject } from '../src/index.js'
import { detectProjectPackageManager } from '../src/project/context.js'
import { hashContent, MANIFEST_PATH, ownVersion } from '../src/project/manifest.js'
import { mergePackageJson, setDependencyRange } from '../src/project/package-json.js'
import { COMMAND_USAGE, isProjectCommand, PROJECT_COMMANDS, runProjectCommand } from '../src/project/run.js'
import { parseSimpleRange, satisfies, updateKind } from '../src/project/semver.js'
import { colorsEnabled, makeColors } from '../src/project/term.js'
import { harness, read, write } from './helpers/project.js'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'basalt-units-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('semver subset', () => {
  it('satisfies the ranges package.json files use', () => {
    expect(satisfies('22.5.0', '>=22.5.0')).toBe(true)
    expect(satisfies('22.4.9', '>=22.5.0')).toBe(false)
    expect(satisfies('20.11.0', '^20.11 || >=22')).toBe(true)
    expect(satisfies('21.0.0', '^20.11 || >=22')).toBe(false)
    expect(satisfies('1.9.9', '^1.2.3')).toBe(true)
    expect(satisfies('2.0.0', '^1.2.3')).toBe(false)
    expect(satisfies('0.2.9', '^0.2.1')).toBe(true)
    expect(satisfies('0.3.0', '^0.2.1')).toBe(false)
    expect(satisfies('1.2.9', '~1.2.3')).toBe(true)
    expect(satisfies('1.3.0', '~1.2.3')).toBe(false)
    expect(satisfies('22.9.0', '22.x')).toBe(true)
    expect(satisfies('1.2.3', '1.2.3')).toBe(true)
    expect(satisfies('1.2.3', '>= 1.0.0 < 2')).toBe(true)
    expect(satisfies('1.2.3', '*')).toBe(true)
    expect(satisfies('1.2.3', 'workspace:^')).toBeUndefined()
    expect(satisfies('1.2.3', '1.0.0 - 2.0.0')).toBeUndefined()
  })

  it('classifies updates (a 0.x minor counts as a major)', () => {
    expect(updateKind([1, 2, 3], [1, 2, 4])).toBe('patch')
    expect(updateKind([1, 2, 3], [1, 3, 0])).toBe('minor')
    expect(updateKind([1, 2, 3], [2, 0, 0])).toBe('major')
    expect(updateKind([0, 2, 0], [0, 3, 0])).toBe('major')
    expect(parseSimpleRange('^1.2.3')?.style).toBe('^')
    expect(parseSimpleRange('>=1.2.3')).toBeUndefined()
    expect(parseSimpleRange('latest')).toBeUndefined()
  })
})

describe('package.json edits', () => {
  it('setDependencyRange rewrites one value and nothing else (not nested keys)', () => {
    const text = '{\r\n\t"overrides": { "dependencies": { "zod": "1" } },\r\n\t"dependencies": { "zod": "^4.0.0", "x": "1" }\r\n}'
    const out = setDependencyRange(text, 'dependencies', 'zod', '^4.9.0')
    expect(out).toBe(text.replace('"zod": "^4.0.0"', '"zod": "^4.9.0"'))
    expect(setDependencyRange(text, 'devDependencies', 'zod', '^5.0.0')).toBe(text)
  })

  it('mergePackageJson adds in sorted position, keeps existing entries and the indentation', () => {
    const text = '{\n    "scripts": { "dev": "x" },\n    "dependencies": { "a": "1", "c": "1" }\n}\n'
    const merged = mergePackageJson(text, { dependencies: { b: '2', a: '9' }, scripts: { dev: 'y', web: 'z' } })
    const pkg = JSON.parse(merged.text)
    expect(Object.keys(pkg.dependencies)).toEqual(['a', 'b', 'c'])
    expect(pkg.dependencies.a).toBe('1')
    expect(pkg.scripts).toEqual({ dev: 'x', web: 'z' })
    expect(merged.text).toContain('\n    "dependencies"')
    expect(merged.kept).toEqual(['a (kept 1)', 'script "dev" (kept "x")'])
  })
})

describe('terminal output', () => {
  it('honors NO_COLOR, FORCE_COLOR and TTY detection', () => {
    expect(colorsEnabled({}, true)).toBe(true)
    expect(colorsEnabled({}, false)).toBe(false)
    expect(colorsEnabled({ NO_COLOR: '1' }, true)).toBe(false)
    expect(colorsEnabled({ FORCE_COLOR: '1' }, false)).toBe(true)
    expect(colorsEnabled({ FORCE_COLOR: '0' }, true)).toBe(false)
    expect(colorsEnabled({ TERM: 'dumb' }, true)).toBe(false)
    expect(makeColors(false).red('x')).toBe('x')
    expect(makeColors(true).red('x')).toBe('\x1b[31mx\x1b[39m')
  })

  it('--no-color strips escapes even when colors are forced', async () => {
    const dir = join(root, 'nc')
    await createProject({ name: 'nc', dir })
    const h = harness(dir, { env: { FORCE_COLOR: '1' } })
    await runProjectCommand(['doctor', '--offline', '--no-color'], h.deps)
    expect(h.output()).not.toContain('\x1b[')
    const colored = harness(dir, { env: { FORCE_COLOR: '1' } })
    await runProjectCommand(['doctor', '--offline'], colored.deps)
    expect(colored.output()).toContain('\x1b[')
  })
})

describe('scaffold manifest', () => {
  it('createProject writes .basalt/project.json with the options and a hash per generated file', async () => {
    const dir = join(root, 'manifest-app')
    const result = await createProject({ name: 'manifest-app', dir, cli: true })
    const manifest = JSON.parse(await read(dir, MANIFEST_PATH))
    expect(manifest).toMatchObject({ manifestVersion: 1, generator: 'create-basalt', createdWith: ownVersion() })
    expect(manifest.options).toEqual(result.options)
    expect(manifest.files['src/app.ts']).toBe(hashContent(await read(dir, 'src/app.ts')))
    expect(manifest.files['bin/basalt.ts']).toBe(hashContent(await read(dir, 'bin/basalt.ts')))
    // package.json changes with every install/update — never hashed; nor is the manifest itself.
    expect(manifest.files).not.toHaveProperty('package.json')
    expect(manifest.files).not.toHaveProperty(MANIFEST_PATH)
    // Every other generated file is recorded.
    expect(Object.keys(manifest.files).length).toBe(result.files.length - 2)
  })

  it('hashes are CRLF-insensitive', () => {
    expect(hashContent('a\r\nb\n')).toBe(hashContent('a\nb\n'))
  })

  it('binStatus tells current, untouched-legacy and customised bins apart', () => {
    expect(binStatus(undefined)).toBe('absent')
    expect(binStatus("if (['update', 'add', 'doctor', 'info'].includes(process.argv[2] ?? '')) {}")).toBe('current')
    expect(binStatus('// custom\n')).toBe('modified')
    expect(binStatus('// custom\n', hashContent('// custom\n'))).toBe('patchable')
    expect(LEGACY_BIN_HASHES.size).toBe(4)
  })
})

describe('subcommand vs project name', () => {
  it('reserves update/add/doctor/info as project commands', () => {
    expect(PROJECT_COMMANDS).toEqual(['update', 'add', 'doctor', 'info'])
    for (const command of PROJECT_COMMANDS) expect(isProjectCommand(command)).toBe(true)
    expect(isProjectCommand('my-saas')).toBe(false)
    expect(isProjectCommand(undefined)).toBe(false)
  })

  it('--name= creates a project named like a command', () => {
    expect(parseArgs(['--name=update', '--billing']).name).toBe('update')
    expect(parseArgs(['my-saas']).name).toBe('my-saas')
  })

  it('outside a Basalt app: a clear error that points at --name', async () => {
    const h = harness(root)
    expect(await runProjectCommand(['update'], h.deps)).toBe(1)
    expect(h.output()).toContain('No package.json in')
    expect(h.output()).toContain('npm create basalt -- --name=update')
  })

  it('a package.json without @basaltkit deps is not a Basalt app', async () => {
    await write(root, 'package.json', JSON.stringify({ name: 'other', dependencies: { express: '^5.0.0' } }))
    const h = harness(root)
    expect(await runProjectCommand(['doctor'], h.deps)).toBe(1)
    expect(h.output()).toContain('does not look like a Basalt app')
  })

  it('per-command --help, project usage, and unknown options', async () => {
    for (const command of PROJECT_COMMANDS) {
      const h = harness(root)
      expect(await runProjectCommand([command, '--help'], h.deps)).toBe(0)
      expect(h.output()).toContain(COMMAND_USAGE[command].split('\n')[0])
    }
    const bare = harness(root)
    expect(await runProjectCommand([], bare.deps)).toBe(0)
    expect(bare.output()).toContain('Project commands')
    await write(root, 'package.json', JSON.stringify({ name: 'a', dependencies: { '@basaltkit/core': '^1.0.0' } }))
    const unknown = harness(root)
    expect(await runProjectCommand(['update', '--frobnicate'], unknown.deps)).toBe(1)
    expect(unknown.output()).toContain('Unknown option --frobnicate')
    const pm = harness(root)
    expect(await runProjectCommand(['info', '--pm=pip'], pm.deps)).toBe(1)
  })

  it('--cwd points the command at another directory', async () => {
    const dir = join(root, 'elsewhere')
    await createProject({ name: 'elsewhere', dir })
    const h = harness(root)
    expect(await runProjectCommand(['info', '--cwd=elsewhere'], h.deps)).toBe(0)
    expect(h.output()).toContain('app            elsewhere')
  })

  it('detects the package manager: --pm, packageManager, lockfile, user agent, npm', () => {
    expect(detectProjectPackageManager({}, [], 'bun').pm).toBe('bun')
    expect(detectProjectPackageManager({ packageManager: 'pnpm@11.8.0' }, ['package-lock.json']).pm).toBe('pnpm')
    expect(detectProjectPackageManager({}, ['yarn.lock'], undefined, 'pnpm/11').pm).toBe('yarn')
    expect(detectProjectPackageManager({}, [], undefined, 'pnpm/11.8.0 npm/? node/v24').pm).toBe('pnpm')
    expect(detectProjectPackageManager({}, [], undefined, undefined)).toEqual({ pm: 'npm', source: 'default' })
  })
})
