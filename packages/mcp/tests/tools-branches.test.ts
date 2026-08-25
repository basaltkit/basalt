import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { createApp, type Container } from '@basaltkit/core'
import { route, type BasaltRoute } from '@basaltkit/http'
import { z } from 'zod'
import { collectTools, defaultToolName, type McpTool } from '../src/index.js'

// A rich route set that drives the uncovered corners of tools.ts: default tool
// naming, arg coercion, non-object schemas, reply capture and text encoding.
const routes: BasaltRoute[] = [
  // No name override → exercises defaultToolName with a `:param` segment.
  route({
    method: 'GET',
    url: '/projects/:id/items/:itemId',
    meta: { mcp: true },
    params: z.object({ id: z.string(), itemId: z.string() }),
    async handler({ params }) {
      return { id: params.id, itemId: params.itemId }
    },
  }),
  // Scalar coercion: number + boolean fields, plus a plain string field.
  route({
    method: 'POST',
    url: '/coerce',
    meta: { mcp: true },
    body: z.object({
      n: z.number().optional(),
      b: z.boolean().optional(),
      s: z.string().optional(),
    }),
    async handler({ body }) {
      return { n: body.n ?? null, b: body.b ?? null, s: body.s ?? null }
    },
  }),
  // Handler drives the reply object directly (code + header + send).
  route({
    method: 'POST',
    url: '/via-reply',
    meta: { mcp: true },
    async handler({ reply }) {
      reply.code(201).header('x-test', '1').send({ created: true })
    },
  }),
  // Returns a bare string → asText string branch, no structuredContent.
  route({
    method: 'GET',
    url: '/plain',
    meta: { mcp: true },
    async handler() {
      return 'just text'
    },
  }),
  // Returns null → asText empty-string branch, no structuredContent.
  route({
    method: 'GET',
    url: '/nullish',
    meta: { mcp: true },
    async handler() {
      return null
    },
  }),
  // Non-object body schema → splitArgs falls back to `route.body ? args`.
  route({
    method: 'POST',
    url: '/scalar-body',
    meta: { mcp: true },
    body: z.string(),
    async handler({ body }) {
      return { echoed: body }
    },
  }),
  // Non-object query schema → splitArgs falls back to `route.query ? args`.
  route({
    method: 'GET',
    url: '/scalar-query',
    meta: { mcp: true },
    query: z.string(),
    async handler() {
      return { ok: true }
    },
  }),
  // All-optional object → buildInputSchema hits the `required ?? []` branch.
  route({
    method: 'POST',
    url: '/all-optional',
    meta: { mcp: true },
    body: z.object({ note: z.string().optional() }),
    async handler({ body }) {
      return { note: body.note ?? null }
    },
  }),
  // Shared required key across params + body → dedup `!required.includes` branch.
  route({
    method: 'POST',
    url: '/dup/:id',
    meta: { mcp: true },
    params: z.object({ id: z.string() }),
    body: z.object({ id: z.string(), name: z.string() }),
    async handler({ params, body }) {
      return { id: params.id, name: body.name }
    },
  }),
  // Not opted in — must never surface.
  route({
    method: 'GET',
    url: '/hidden',
    async handler() {
      return { nope: true }
    },
  }),
]

let container: Container
let shutdown: () => Promise<void>
let tools: McpTool[]
const tool = (name: string) => tools.find((t) => t.name === name)!

beforeAll(async () => {
  const app = await createApp({ plugins: [] }).boot()
  container = app.container
  shutdown = () => app.shutdown()
  tools = collectTools(routes, container)
})

afterAll(async () => {
  await shutdown()
})

describe('defaultToolName', () => {
  it('renders `:param` segments as `by_<name>`', () => {
    const r = route({ method: 'GET', url: '/projects/:id/items/:itemId', async handler() {} })
    expect(defaultToolName(r)).toBe('get_projects_by_id_items_by_itemId')
  })

  it('handles a root URL with an empty path', () => {
    const r = route({ method: 'GET', url: '/', async handler() {} })
    expect(defaultToolName(r)).toBe('get')
  })
})

describe('collectTools', () => {
  it('names a param route by default and never exposes non-opted-in routes', () => {
    const names = tools.map((t) => t.name)
    expect(names).toContain('get_projects_by_id_items_by_itemId')
    expect(names).not.toContain('get_hidden')
  })

  it('honours a filter predicate, skipping unmatched routes', () => {
    const filtered = collectTools(routes, container, { filter: (r) => r.url === '/plain' })
    expect(filtered.map((t) => t.name)).toEqual(['get_plain'])
  })

  it('merges shared required keys once (no duplicate in required[])', () => {
    const schema = tool('post_dup_by_id').inputSchema as { required?: string[] }
    const idCount = (schema.required ?? []).filter((k) => k === 'id').length
    expect(idCount).toBe(1)
    expect(schema.required).toContain('name')
  })

  it('omits required[] entirely for an all-optional schema', () => {
    const schema = tool('post_all_optional').inputSchema as { required?: string[] }
    expect(schema.required).toBeUndefined()
  })
})

describe('scalar coercion through invoke', () => {
  it('coerces a numeric string to a number', async () => {
    const res = await tool('post_coerce').invoke({ n: '7' })
    expect((res.structuredContent as { n: number }).n).toBe(7)
  })

  it('leaves a non-numeric string alone (validation then fails)', async () => {
    const res = await tool('post_coerce').invoke({ n: 'abc' })
    expect(res.isError).toBe(true)
  })

  it('passes an already-numeric value straight through', async () => {
    const res = await tool('post_coerce').invoke({ n: 5 })
    expect((res.structuredContent as { n: number }).n).toBe(5)
  })

  it('coerces the boolean strings "true" and "false"', async () => {
    const t = await tool('post_coerce').invoke({ b: 'true' })
    expect((t.structuredContent as { b: boolean }).b).toBe(true)
    const f = await tool('post_coerce').invoke({ b: 'false' })
    expect((f.structuredContent as { b: boolean }).b).toBe(false)
  })

  it('leaves a non-boolean string alone (validation then fails)', async () => {
    const res = await tool('post_coerce').invoke({ b: 'maybe' })
    expect(res.isError).toBe(true)
  })
})

describe('non-object schemas', () => {
  it('routes flat args to a scalar body schema', async () => {
    // A string body schema can't take the flat object → the call errors, but the
    // `route.body ? args` fallback branch in splitArgs is exercised.
    const res = await tool('post_scalar_body').invoke({ anything: 1 })
    expect(res.isError).toBe(true)
  })

  it('routes flat args to a scalar query schema', async () => {
    const res = await tool('get_scalar_query').invoke({ q: 'x' })
    expect(res.isError).toBe(true)
  })
})

describe('reply capture and text encoding', () => {
  it('captures a handler that drives reply.code/header/send', async () => {
    const res = await tool('post_via_reply').invoke({})
    expect((res.structuredContent as { created: boolean }).created).toBe(true)
  })

  it('encodes a string return as text with no structuredContent', async () => {
    const res = await tool('get_plain').invoke({})
    expect(res.content[0]!.text).toBe('just text')
    expect('structuredContent' in res).toBe(false)
  })

  it('encodes a null return as empty text with no structuredContent', async () => {
    const res = await tool('get_nullish').invoke({})
    expect(res.content[0]!.text).toBe('')
    expect('structuredContent' in res).toBe(false)
  })

  it('defaults args to {} when invoked with none', async () => {
    const res = await tool('get_nullish').invoke(undefined as never)
    expect(res.content[0]!.text).toBe('')
  })
})
