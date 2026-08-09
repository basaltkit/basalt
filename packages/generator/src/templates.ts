import type { Names } from './names.js'

/** A file the generator produces, path relative to the project root. */
export interface GeneratedFile {
  path: string
  content: string
}

export interface GeneratorOptions {
  /** Generate a Prisma-backed repository (and a schema.prisma model) instead of in-memory. */
  prisma?: boolean
}

const dir = (n: Names) => `src/modules/${n.kebab}`

export function schemaFile(n: Names): GeneratedFile {
  return {
    path: `${dir(n)}/${n.kebab}.schema.ts`,
    content: `import { z } from 'zod'

export const ${n.pascal}Schema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
})
export type ${n.pascal} = z.infer<typeof ${n.pascal}Schema>

export const Create${n.pascal}Schema = z.object({
  name: z.string().min(1),
})
export type Create${n.pascal}Input = z.infer<typeof Create${n.pascal}Schema>

export const Update${n.pascal}Schema = Create${n.pascal}Schema.partial()
export type Update${n.pascal}Input = z.infer<typeof Update${n.pascal}Schema>
`,
  }
}

const repositoryInterface = (n: Names): string => `export interface ${n.pascal}Repository {
  list(): Promise<${n.pascal}[]>
  find(id: string): Promise<${n.pascal} | null>
  create(input: Create${n.pascal}Input): Promise<${n.pascal}>
  update(id: string, input: Update${n.pascal}Input): Promise<${n.pascal} | null>
  delete(id: string): Promise<boolean>
}`

function prismaRepository(n: Names): string {
  return `import { createToken } from '@basaltkit/core'
import { db } from '@basaltkit/prisma'
import type { PrismaClient } from '@prisma/client'
import type { ${n.pascal}, Create${n.pascal}Input, Update${n.pascal}Input } from './${n.kebab}.schema.js'

${repositoryInterface(n)}

/** Prisma-backed. Requires prismaPlugin configured and a \`${n.pascal}\` model in schema.prisma. */
export class Prisma${n.pascal}Repository implements ${n.pascal}Repository {
  private get records() {
    return db<PrismaClient>().${n.camel}
  }

  list() {
    return this.records.findMany()
  }

  find(id: string) {
    return this.records.findUnique({ where: { id } })
  }

  create(input: Create${n.pascal}Input) {
    return this.records.create({ data: input })
  }

  update(id: string, input: Update${n.pascal}Input) {
    return this.records.update({ where: { id }, data: input }).catch(() => null)
  }

  delete(id: string) {
    return this.records
      .delete({ where: { id } })
      .then(() => true)
      .catch(() => false)
  }
}

export const ${n.constant}_REPOSITORY = createToken<${n.pascal}Repository>('${n.kebab}.repository')
`
}

function memoryRepository(n: Names): string {
  return `import { randomUUID } from 'node:crypto'
import { createToken } from '@basaltkit/core'
import type { ${n.pascal}, Create${n.pascal}Input, Update${n.pascal}Input } from './${n.kebab}.schema.js'

${repositoryInterface(n)}

/** In-memory implementation — pass --prisma to generate a Prisma-backed one. */
export class InMemory${n.pascal}Repository implements ${n.pascal}Repository {
  private readonly items = new Map<string, ${n.pascal}>()

  async list(): Promise<${n.pascal}[]> {
    return [...this.items.values()]
  }

  async find(id: string): Promise<${n.pascal} | null> {
    return this.items.get(id) ?? null
  }

  async create(input: Create${n.pascal}Input): Promise<${n.pascal}> {
    const item: ${n.pascal} = { id: randomUUID(), ...input, createdAt: new Date().toISOString() }
    this.items.set(item.id, item)
    return item
  }

  async update(id: string, input: Update${n.pascal}Input): Promise<${n.pascal} | null> {
    const existing = this.items.get(id)
    if (!existing) return null
    const updated: ${n.pascal} = { ...existing, ...input }
    this.items.set(id, updated)
    return updated
  }

  async delete(id: string): Promise<boolean> {
    return this.items.delete(id)
  }
}

export const ${n.constant}_REPOSITORY = createToken<${n.pascal}Repository>('${n.kebab}.repository')
`
}

export function repositoryFile(n: Names, options: GeneratorOptions = {}): GeneratedFile {
  return {
    path: `${dir(n)}/${n.kebab}.repository.ts`,
    content: options.prisma ? prismaRepository(n) : memoryRepository(n),
  }
}

export function serviceFile(n: Names): GeneratedFile {
  return {
    path: `${dir(n)}/${n.kebab}.service.ts`,
    content: `import { createToken } from '@basaltkit/core'
import type { ${n.pascal}Repository } from './${n.kebab}.repository.js'
import type { Create${n.pascal}Input, Update${n.pascal}Input } from './${n.kebab}.schema.js'

export class ${n.pascal}Service {
  constructor(private readonly repository: ${n.pascal}Repository) {}

  list() {
    return this.repository.list()
  }

  get(id: string) {
    return this.repository.find(id)
  }

  create(input: Create${n.pascal}Input) {
    return this.repository.create(input)
  }

  update(id: string, input: Update${n.pascal}Input) {
    return this.repository.update(id, input)
  }

  remove(id: string) {
    return this.repository.delete(id)
  }
}

export const ${n.constant}_SERVICE = createToken<${n.pascal}Service>('${n.kebab}.service')
`,
  }
}

export function pluginFile(n: Names, options: GeneratorOptions = {}): GeneratedFile {
  const repoClass = options.prisma ? `Prisma${n.pascal}Repository` : `InMemory${n.pascal}Repository`
  return {
    path: `${dir(n)}/${n.kebab}.plugin.ts`,
    content: `import { definePlugin } from '@basaltkit/core'
import { ${n.constant}_REPOSITORY, ${repoClass} } from './${n.kebab}.repository.js'
import { ${n.constant}_SERVICE, ${n.pascal}Service } from './${n.kebab}.service.js'

export const ${n.camel}Plugin = definePlugin({
  name: 'app:${n.kebab}',
  register({ container }) {
    container.singleton(${n.constant}_REPOSITORY, () => new ${repoClass}())
    container.singleton(
      ${n.constant}_SERVICE,
      (c) => new ${n.pascal}Service(c.get(${n.constant}_REPOSITORY)),
    )
  },
})
`,
  }
}

/** Prisma model block to paste into schema.prisma (emitted with --prisma). */
export function prismaModelFile(n: Names): GeneratedFile {
  return {
    path: `${dir(n)}/${n.kebab}.prisma`,
    content: `// Add this model to your schema.prisma, then run \`prisma migrate dev\`.
model ${n.pascal} {
  id        String   @id @default(cuid())
  name      String
  createdAt DateTime @default(now())
}
`,
  }
}

export function routesFile(n: Names): GeneratedFile {
  return {
    path: `${dir(n)}/${n.kebab}.routes.ts`,
    content: `import { ctx, type Container } from '@basaltkit/core'
import { HttpError, route } from '@basaltkit/fastify'
import { z } from 'zod'
import { ${n.constant}_SERVICE } from './${n.kebab}.service.js'
import { Create${n.pascal}Schema, Update${n.pascal}Schema, ${n.pascal}Schema } from './${n.kebab}.schema.js'

const service = () => (ctx().container as Container).get(${n.constant}_SERVICE)
const notFound = () => new HttpError(404, '${n.constant}_NOT_FOUND', '${n.pascal} not found')

export const ${n.camel}Routes = [
  route({
    method: 'GET',
    url: '/${n.pluralKebab}',
    response: { 200: z.array(${n.pascal}Schema) },
    async handler() {
      return service().list()
    },
  }),

  route({
    method: 'GET',
    url: '/${n.pluralKebab}/:id',
    params: z.object({ id: z.string() }),
    async handler({ params }) {
      const item = await service().get(params.id)
      if (!item) throw notFound()
      return item
    },
  }),

  route({
    method: 'POST',
    url: '/${n.pluralKebab}',
    body: Create${n.pascal}Schema,
    response: { 201: ${n.pascal}Schema },
    async handler({ body, reply }) {
      return reply.code(201).send(await service().create(body))
    },
  }),

  route({
    method: 'PATCH',
    url: '/${n.pluralKebab}/:id',
    params: z.object({ id: z.string() }),
    body: Update${n.pascal}Schema,
    async handler({ params, body }) {
      const item = await service().update(params.id, body)
      if (!item) throw notFound()
      return item
    },
  }),

  route({
    method: 'DELETE',
    url: '/${n.pluralKebab}/:id',
    params: z.object({ id: z.string() }),
    async handler({ params, reply }) {
      const removed = await service().remove(params.id)
      if (!removed) throw notFound()
      return reply.code(204).send()
    },
  }),
]
`,
  }
}

export function testFile(n: Names): GeneratedFile {
  return {
    path: `tests/${n.kebab}.test.ts`,
    content: `import { describe, expect, it } from 'vitest'
import { fastifyPlugin } from '@basaltkit/fastify'
import { createTestApp } from '@basaltkit/testing'
import { ${n.camel}Plugin } from '../src/modules/${n.kebab}/${n.kebab}.plugin.js'
import { ${n.camel}Routes } from '../src/modules/${n.kebab}/${n.kebab}.routes.js'

describe('${n.kebab} resource', () => {
  it('creates, lists, fetches, updates and deletes', async () => {
    const app = await createTestApp({
      plugins: [${n.camel}Plugin, fastifyPlugin({ routes: ${n.camel}Routes })],
    })

    const created = await app.post('/${n.pluralKebab}', { name: 'First' })
    expect(created.statusCode).toBe(201)
    const id = created.json().id

    expect((await app.get('/${n.pluralKebab}')).json()).toHaveLength(1)
    expect((await app.get(\`/${n.pluralKebab}/\${id}\`)).json().name).toBe('First')

    const updated = await app.patch(\`/${n.pluralKebab}/\${id}\`, { name: 'Renamed' })
    expect(updated.json().name).toBe('Renamed')

    expect((await app.delete(\`/${n.pluralKebab}/\${id}\`)).statusCode).toBe(204)
    expect((await app.get('/${n.pluralKebab}')).json()).toHaveLength(0)

    await app.shutdown()
  })
})
`,
  }
}
