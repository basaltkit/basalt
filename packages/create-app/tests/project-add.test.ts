import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { basaltBin } from '../src/bin-template.js'
import { createProject } from '../src/index.js'
import {
  addWorkspaceMember,
  ensureGitignore,
  patchAppForCli,
  patchAppForMcp,
} from '../src/project/add.js'
import { MANIFEST_PATH } from '../src/project/manifest.js'
import { runProjectCommand } from '../src/project/run.js'
import { appTs, routesTs, type ProjectOptions } from '../src/templates.js'
import { fakeRegistry, harness, read, write } from './helpers/project.js'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'basalt-add-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function scaffold(name: string, options: Partial<Omit<Parameters<typeof createProject>[0], 'name' | 'dir'>> = {}) {
  const dir = join(root, name)
  await createProject({ name, dir, ...options })
  await write(dir, 'pnpm-lock.yaml', 'lockfileVersion: 9.0\n')
  return dir
}

/** Every file under `dir` (relative), excluding the fake lockfile. */
async function tree(dir: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) await walk(path)
      else out.push(relative(dir, path))
    }
  }
  await walk(dir)
  return out.filter((path) => path !== 'pnpm-lock.yaml').sort()
}

const add = (dir: string, ...args: string[]) => {
  const h = harness(dir)
  return runProjectCommand(['add', ...args, '--offline'], h.deps).then((code) => ({ code, h }))
}

describe('add ui', () => {
  it('turns a project created without --ui into exactly what --ui generates', async () => {
    const without = await scaffold('twin', {})
    const withUi = join(root, 'with-ui', 'twin')
    await createProject({ name: 'twin', dir: withUi, ui: true })

    const { code, h } = await add(without, 'ui', '--yes')
    expect(code).toBe(0)
    // Installs once with pnpm (the fake runner), at the project root.
    expect(h.runs).toEqual([{ command: 'pnpm', args: ['install'], cwd: without }])

    const files = await tree(without)
    expect(files).toEqual(await tree(withUi))
    for (const path of files) {
      const [a, b] = [await read(without, path), await read(withUi, path)]
      if (path === 'package.json') expect(JSON.parse(a), path).toEqual(JSON.parse(b))
      // .env carries a secret generated per scaffold: equal once it is masked.
      else if (path === '.env') expect(a.replace(/_APP_SECRET=.*/, ''), path).toBe(b.replace(/_APP_SECRET=.*/, ''))
      else expect(a, path).toBe(b)
    }
  })

  it('never overwrites an existing file (notice), merges package.json, and --force overwrites', async () => {
    const dir = await scaffold('keep-mine')
    await write(dir, 'web/index.html', '<!-- mine -->\n')
    const { code, h } = await add(dir, 'ui', '--yes', '--no-install')
    expect(code).toBe(0)
    expect(await read(dir, 'web/index.html')).toBe('<!-- mine -->\n')
    expect(h.output()).toMatch(/skip\s+web\/index\.html\s+\(exists — kept yours/)
    expect(await read(dir, 'web/src/App.tsx')).toContain('export function App')
    expect(JSON.parse(await read(dir, 'package.json')).scripts['dev:web']).toBe('pnpm --filter keep-mine-web dev')
    expect(await read(dir, 'pnpm-workspace.yaml')).toMatch(/^packages:\n {2}- web\n/)
    expect(h.runs).toEqual([])

    // web/package.json now exists → ui counts as present; --force re-adds and overwrites.
    const again = await add(dir, 'ui', '--yes', '--no-install')
    expect(again.h.output()).toContain('already part of keep-mine')
    const forced = await add(dir, 'ui', '--yes', '--no-install', '--force')
    expect(forced.code).toBe(0)
    expect(await read(dir, 'web/index.html')).toContain('<div id="root"></div>')
  })

  it('--dry shows the plan and writes nothing', async () => {
    const dir = await scaffold('dry-ui')
    const before = await tree(dir)
    const { code, h } = await add(dir, 'ui', '--dry')
    expect(code).toBe(0)
    expect(h.output()).toMatch(/\+ create\s+web\/package\.json/)
    expect(h.output()).toMatch(/~ update\s+pnpm-workspace\.yaml/)
    expect(h.output()).toContain('Dry run — nothing written.')
    expect(await tree(dir)).toEqual(before)
  })

  it('adapts to the project: no auth → the status-only UI', async () => {
    const dir = await scaffold('noauth', { auth: false })
    await add(dir, 'ui', '--yes', '--no-install')
    expect(await read(dir, 'web/src/App.tsx')).not.toContain('AuthScreen')
    expect(await read(dir, 'web/index.html')).toContain('<title>noauth</title>')
  })

  it('resolves the web dependencies from the registry like the scaffold does', async () => {
    const dir = await scaffold('latest-ui')
    const h = harness(dir, { fetch: fakeRegistry({ react: { version: '19.9.1' }, '@basaltkit/sdk': { version: '2.4.0' } }) })
    expect(await runProjectCommand(['add', 'ui', '--yes', '--no-install'], h.deps)).toBe(0)
    const web = JSON.parse(await read(dir, 'web/package.json'))
    expect(web.dependencies.react).toBe('^19.9.1')
    expect(web.dependencies['@basaltkit/sdk']).toBe('^2.4.0')
  })

  it('is refused on a non-pnpm project (web/ is a pnpm workspace member)', async () => {
    const dir = join(root, 'npm-app')
    await createProject({ name: 'npm-app', dir })
    await write(dir, 'package-lock.json', '{}')
    const { code, h } = await add(dir, 'ui', '--yes')
    expect(code).toBe(1)
    expect(h.output()).toMatch(/pnpm workspace member.*uses npm/)
  })

  it('works on an old project without a manifest (creates one)', async () => {
    const dir = await scaffold('old-ui')
    await rm(join(dir, MANIFEST_PATH))
    const { code } = await add(dir, 'ui', '--yes', '--no-install')
    expect(code).toBe(0)
    const manifest = JSON.parse(await read(dir, MANIFEST_PATH))
    expect(manifest.options.ui).toBe(true)
    expect(Object.keys(manifest.files)).toContain('web/src/App.tsx')
    // Files it did not write (README edits of a file it cannot prove pristine) are not claimed.
    expect(Object.keys(manifest.files)).not.toContain('src/app.ts')
  })
})

describe('add cli', () => {
  it('regenerates a pristine src/app.ts, writes bin/basalt.ts and swaps the basalt script', async () => {
    const dir = await scaffold('cli-pristine')
    const { code } = await add(dir, 'cli', '--yes', '--no-install')
    expect(code).toBe(0)
    const options: ProjectOptions = { name: 'cli-pristine', tenancy: true, auth: true, billing: false, ui: false, cli: true, mcp: false, prisma: false }
    expect(await read(dir, 'src/app.ts')).toBe(appTs(options))
    expect(await read(dir, 'bin/basalt.ts')).toBe(basaltBin())
    const pkg = JSON.parse(await read(dir, 'package.json'))
    expect(pkg.scripts.basalt).toBe('tsx bin/basalt.ts')
    expect(pkg.dependencies).toHaveProperty('@basaltkit/cli')
    expect(pkg.devDependencies).toHaveProperty('@basaltkit/generator')
    expect(pkg.dependencies).not.toHaveProperty('@basaltkit/generator')
  })

  it('patches an edited src/app.ts at the template anchors, keeping the edits', async () => {
    const dir = await scaffold('cli-edited')
    const app = (await read(dir, 'src/app.ts')).replace("import { appRoutes } from './routes.js'", "import { appRoutes } from './routes.js'\n// my edit")
    await write(dir, 'src/app.ts', app)
    const { code, h } = await add(dir, 'cli', '--yes', '--no-install')
    expect(code).toBe(0)
    const after = await read(dir, 'src/app.ts')
    expect(after).toContain('// my edit')
    expect(after).toContain("import { commandsPlugin, type CommandDefinition } from '@basaltkit/cli'")
    expect(after).toContain('commands?: CommandDefinition[]')
    expect(after).toContain('[commandsPlugin(options.commands)]')
    expect(h.output()).toContain('patched at the template anchors')
  })

  it('prints manual steps and leaves src/app.ts alone when it no longer matches the template', async () => {
    const dir = await scaffold('cli-custom')
    const custom = 'export const buildApp = () => null\n'
    await write(dir, 'src/app.ts', custom)
    const { code, h } = await add(dir, 'cli', '--yes', '--no-install')
    expect(code).toBe(0)
    expect(await read(dir, 'src/app.ts')).toBe(custom)
    expect(h.output()).toContain('Manual step:')
    expect(h.output()).toContain("import { commandsPlugin, type CommandDefinition } from '@basaltkit/cli'")
    // The rest of the plan still applied.
    expect(await read(dir, 'bin/basalt.ts')).toBe(basaltBin())
  })

  it('keeps a customised "basalt" script', async () => {
    const dir = await scaffold('cli-script')
    const pkg = JSON.parse(await read(dir, 'package.json'))
    pkg.scripts.basalt = 'node my-tool.js'
    await write(dir, 'package.json', JSON.stringify(pkg, null, 2))
    const { h } = await add(dir, 'cli', '--yes', '--no-install')
    expect(JSON.parse(await read(dir, 'package.json')).scripts.basalt).toBe('node my-tool.js')
    expect(h.output()).toContain('script "basalt" (kept "node my-tool.js")')
  })
})

describe('add mcp', () => {
  it('regenerates pristine app.ts/routes.ts and keeps ai-mcp dev-only', async () => {
    const dir = await scaffold('mcp-pristine')
    const { code } = await add(dir, 'mcp', '--yes', '--no-install')
    expect(code).toBe(0)
    const options: ProjectOptions = { name: 'mcp-pristine', tenancy: true, auth: true, billing: false, ui: false, cli: false, mcp: true, prisma: false }
    expect(await read(dir, 'src/app.ts')).toBe(appTs(options))
    expect(await read(dir, 'src/routes.ts')).toBe(routesTs(options))
    const pkg = JSON.parse(await read(dir, 'package.json'))
    expect(pkg.dependencies).toHaveProperty('@basaltkit/mcp')
    expect(pkg.devDependencies).toHaveProperty('@basaltkit/ai-mcp')
    expect(pkg.dependencies).not.toHaveProperty('@basaltkit/ai-mcp')
    expect(JSON.parse(await read(dir, '.mcp.json')).mcpServers['basalt-ai'].args).toContain('@basaltkit/ai-mcp')
  })

  it('on an edited project: patches app.ts, leaves routes.ts, explains how to expose routes', async () => {
    const dir = await scaffold('mcp-edited')
    await write(dir, 'src/app.ts', `${await read(dir, 'src/app.ts')}\n// edited\n`)
    await write(dir, 'src/routes.ts', `${await read(dir, 'src/routes.ts')}\n// edited\n`)
    const routesBefore = await read(dir, 'src/routes.ts')
    const { code, h } = await add(dir, 'mcp', '--yes', '--no-install')
    expect(code).toBe(0)
    const app = await read(dir, 'src/app.ts')
    expect(app).toContain("mcpPlugin({ routes: [...appRoutes, ...authRoutes(), ...mfaRoutes()], serverInfo: { name: 'mcp-edited', version: '0.1.0' } })")
    expect(app).toContain('fastifyPlugin({ routes: [...appRoutes, ...authRoutes(), ...mfaRoutes(), ...mcpRoutes()] })')
    expect(await read(dir, 'src/routes.ts')).toBe(routesBefore)
    expect(h.output()).toContain('meta: { mcp:')
  })
})

describe('add — command surface', () => {
  it('rejects an unknown feature', async () => {
    const dir = await scaffold('unknown')
    const { code, h } = await add(dir, 'billing')
    expect(code).toBe(1)
    expect(h.output()).toContain('Available: ui, cli, mcp')
  })
})

describe('safe-edit helpers (adapter-agnostic)', () => {
  const source = (adapter: string) => `import { createApp } from '@basaltkit/core'
import { ${adapter} } from '@basaltkit/${adapter.replace('Plugin', '')}'
import { appRoutes } from './routes.js'

export interface BuildAppOptions {
  logLevel?: LogLevel
}

export function buildApp(options: BuildAppOptions = {}) {
  return createApp({
    plugins: [
      ${adapter}({ routes: appRoutes }),
    ],
  })
}
`
  for (const adapter of ['fastifyPlugin', 'expressPlugin', 'honoPlugin']) {
    it(`wires cli and mcp on ${adapter}`, () => {
      const cli = patchAppForCli(source(adapter)) as string
      expect(cli).toContain(`...(options.commands && options.commands.length > 0 ? [commandsPlugin(options.commands)] : []),\n      ${adapter}(`)
      const mcp = patchAppForMcp(cli, 'x') as string
      expect(mcp).toContain(`${adapter}({ routes: [...appRoutes, ...mcpRoutes()] }),`)
      expect(mcp).toContain("mcpPlugin({ routes: appRoutes, serverInfo: { name: 'x', version: '0.1.0' } }),")
      // Idempotent.
      expect(patchAppForMcp(mcp, 'x')).toBe(mcp)
      expect(patchAppForCli(cli)).toBe(cli)
    })
  }

  it('escapes the server name as a single-quoted literal (quotes, backslashes, line breaks)', () => {
    const cli = patchAppForCli(source('fastifyPlugin')) as string
    const mcp = patchAppForMcp(cli, "o'brien\\x\nnext") as string
    expect(mcp).toContain("serverInfo: { name: 'o\\'brien\\\\x\\nnext', version: '0.1.0' }")
  })

  it('refuses ambiguous or missing anchors', () => {
    const two = source('fastifyPlugin').replace('fastifyPlugin({ routes: appRoutes }),', 'fastifyPlugin({ routes: appRoutes }),\n      honoPlugin({ routes: appRoutes }),')
    expect(patchAppForMcp(two, 'x')).toBeUndefined()
    expect(patchAppForCli(two)).toBeUndefined()
    expect(patchAppForCli('export const x = 1\n')).toBeUndefined()
  })

  it('edits pnpm-workspace.yaml packages and .gitignore without duplicates', () => {
    expect(addWorkspaceMember('allowBuilds:\n  esbuild: true\n', 'web')).toBe('packages:\n  - web\nallowBuilds:\n  esbuild: true\n')
    expect(addWorkspaceMember('packages:\n  - api\nallowBuilds: {}\n', 'web')).toBe('packages:\n  - api\n  - web\nallowBuilds: {}\n')
    expect(addWorkspaceMember("packages:\n  - 'web'\n", 'web')).toBe("packages:\n  - 'web'\n")
    expect(addWorkspaceMember('packages: [api]\n', 'web')).toBeUndefined()
    expect(ensureGitignore('/node_modules\n', ['node_modules/', 'dist/'])).toBe('/node_modules\ndist/\n')
    expect(ensureGitignore('dist', ['dist/'])).toBe('dist')
  })
})
