import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { memoryIo } from '@machize/cli'
import {
  FileExistsError,
  generate,
  generateResource,
  generatorCommands,
  names,
  registerResourceInApp,
  writeGenerated,
} from '../src/index.js'

const SAMPLE_APP = `import { createApp } from '@machize/core'
import { fastifyPlugin } from '@machize/fastify'
import { authRoutes } from '@machize/auth'
import { appRoutes } from './routes.js'

export function buildApp() {
  return createApp({
    plugins: [
      fastifyPlugin({ routes: [...appRoutes, ...authRoutes()] }),
    ],
  })
}
`

const writeApp = async (root: string, content = SAMPLE_APP) => {
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src/app.ts'), content)
}

describe('names', () => {
  it('derives all casings and pluralizes the last word', () => {
    expect(names('Project')).toMatchObject({
      pascal: 'Project',
      camel: 'project',
      kebab: 'project',
      pluralKebab: 'projects',
      constant: 'PROJECT',
    })
    expect(names('blog-post')).toMatchObject({
      pascal: 'BlogPost',
      camel: 'blogPost',
      kebab: 'blog-post',
      pluralKebab: 'blog-posts',
      constant: 'BLOG_POST',
    })
    expect(names('company').pluralKebab).toBe('companies')
    expect(names('box').pluralKebab).toBe('boxes')
  })
})

describe('generateResource', () => {
  it('emits the full vertical with consistent identifiers', () => {
    const files = generateResource('BlogPost')
    expect(files.map((file) => file.path)).toEqual([
      'src/modules/blog-post/blog-post.schema.ts',
      'src/modules/blog-post/blog-post.repository.ts',
      'src/modules/blog-post/blog-post.service.ts',
      'src/modules/blog-post/blog-post.plugin.ts',
      'src/modules/blog-post/blog-post.routes.ts',
      'tests/blog-post.test.ts',
    ])

    const byName = (needle: string) => files.find((file) => file.path.includes(needle))!.content
    expect(byName('schema')).toContain('export const BlogPostSchema')
    expect(byName('repository')).toContain('BLOG_POST_REPOSITORY')
    expect(byName('service')).toContain('class BlogPostService')
    expect(byName('plugin')).toContain("name: 'app:blog-post'")
    expect(byName('routes')).toContain("url: '/blog-posts'")
    expect(byName('routes')).toContain('BLOG_POST_NOT_FOUND')
    expect(byName('.test.ts')).toContain("await app.post('/blog-posts'")
  })

  it('generate() emits a single artifact', () => {
    const service = generate('service', 'Project')
    expect(service.path).toBe('src/modules/project/project.service.ts')
    expect(service.content).toContain('PROJECT_SERVICE')
  })
})

describe('writeGenerated', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'machize-gen-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('writes files and refuses to overwrite unless forced', async () => {
    const written = await writeGenerated(generateResource('Project'), { baseDir: root })
    expect(written).toContain('src/modules/project/project.routes.ts')
    const routes = await readFile(join(root, 'src/modules/project/project.routes.ts'), 'utf8')
    expect(routes).toContain("url: '/projects'")

    await expect(writeGenerated(generateResource('Project'), { baseDir: root })).rejects.toBeInstanceOf(
      FileExistsError,
    )
    await expect(
      writeGenerated(generateResource('Project'), { baseDir: root, force: true }),
    ).resolves.toBeDefined()
  })
})

describe('generatorCommands', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'machize-gen-cmd-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('exposes make:resource and per-kind commands', async () => {
    const commands = generatorCommands()
    const commandNames = commands.map((command) => command.name)
    expect(commandNames).toContain('make:resource')
    expect(commandNames).toContain('make:service')

    const resource = commands.find((command) => command.name === 'make:resource')!
    const io = memoryIo()
    const code = await resource.handle({
      args: ['Project'],
      flags: { dir: root },
      io,
      app: undefined as never,
      container: undefined as never,
    })
    expect(code).toBe(0)
    expect(io.lines.join('\n')).toContain('project.service.ts')

    // missing name → usage error
    const bad = await resource.handle({
      args: [],
      flags: {},
      io: memoryIo(),
      app: undefined as never,
      container: undefined as never,
    })
    expect(bad).toBe(1)
  })
})

describe('registerResourceInApp', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'machize-gen-reg-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('wires the plugin import, plugin registration and routes spread into app.ts', async () => {
    await writeApp(root)
    const result = await registerResourceInApp('Room', { baseDir: root })
    expect(result.registered).toBe(true)

    const app = await readFile(join(root, 'src/app.ts'), 'utf8')
    expect(app).toContain("import { roomPlugin } from './modules/room/room.plugin.js'")
    expect(app).toContain("import { roomRoutes } from './modules/room/room.routes.js'")
    expect(app).toContain('roomPlugin,')
    // plugin sits directly above fastifyPlugin, routes spread into the array
    expect(app).toMatch(/roomPlugin,\s*\n\s*fastifyPlugin\(/)
    expect(app).toContain('routes: [...roomRoutes, ...appRoutes, ...authRoutes()]')
  })

  it('is idempotent — a second call changes nothing', async () => {
    await writeApp(root)
    await registerResourceInApp('Room', { baseDir: root })
    const once = await readFile(join(root, 'src/app.ts'), 'utf8')

    const second = await registerResourceInApp('Room', { baseDir: root })
    expect(second.registered).toBe(false)
    expect(second.reason).toBe('already registered')
    const twice = await readFile(join(root, 'src/app.ts'), 'utf8')
    expect(twice).toBe(once)
    expect(twice.match(/roomPlugin,/g)).toHaveLength(1)
  })

  it('multiple resources coexist', async () => {
    await writeApp(root)
    await registerResourceInApp('Room', { baseDir: root })
    await registerResourceInApp('BlogPost', { baseDir: root })
    const app = await readFile(join(root, 'src/app.ts'), 'utf8')
    expect(app).toContain('roomPlugin,')
    expect(app).toContain('blogPostPlugin,')
    expect(app).toContain('...roomRoutes')
    expect(app).toContain('...blogPostRoutes')
  })

  it('skips gracefully when app.ts is missing or has an unexpected shape', async () => {
    const missing = await registerResourceInApp('Room', { baseDir: root })
    expect(missing).toMatchObject({ registered: false, reason: 'src/app.ts not found' })

    await writeApp(root, `export const buildApp = () => 'no fastify here'\n`)
    const odd = await registerResourceInApp('Room', { baseDir: root })
    expect(odd.registered).toBe(false)
    expect(odd.reason).toContain('fastifyPlugin')
  })

  it('make:resource auto-wires app.ts through the CLI command', async () => {
    await writeApp(root)
    const resource = generatorCommands().find((c) => c.name === 'make:resource')!
    const io = memoryIo()
    await resource.handle({
      args: ['Room'],
      flags: { dir: root },
      io,
      app: undefined as never,
      container: undefined as never,
    })
    expect(io.lines.join('\n')).toContain('Wired the plugin + routes into src/app.ts.')
    const app = await readFile(join(root, 'src/app.ts'), 'utf8')
    expect(app).toContain('roomPlugin,')
    expect(app).toContain('...roomRoutes')
  })

  it('make:resource --no-register leaves app.ts untouched', async () => {
    await writeApp(root)
    const resource = generatorCommands().find((c) => c.name === 'make:resource')!
    await resource.handle({
      args: ['Room'],
      flags: { dir: root, 'no-register': true },
      io: memoryIo(),
      app: undefined as never,
      container: undefined as never,
    })
    const app = await readFile(join(root, 'src/app.ts'), 'utf8')
    expect(app).not.toContain('roomPlugin')
  })
})
