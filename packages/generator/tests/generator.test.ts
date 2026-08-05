import { mkdtemp, readFile, rm } from 'node:fs/promises'
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
  writeGenerated,
} from '../src/index.js'

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
