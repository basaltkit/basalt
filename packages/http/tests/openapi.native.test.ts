import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { definePlugin, ensureMetadata } from '@basaltkit/core'
import { HttpServerCollector, generateOpenApi, openapiPlugin, zodToJsonSchema } from '../src/index.js'
import { FakeReply, bootWith, makeRequest } from './support.js'

// Publishes `http:routes` metadata the way a real adapter would, so the plugin
// and the docs command can source routes from metadata (options.routes omitted).
const routesProvider = (routes: { method: string; url: string; meta?: Record<string, unknown> }[]) =>
  definePlugin({
    name: 'test:http-routes',
    register({ container }) {
      const metadata = ensureMetadata(container)
      for (const r of routes) metadata.add('http:routes', r)
    },
  })

// These run against the REAL Zod 4 native converter, so they cover the
// normalisation (`clean`) branches of `zodToJsonSchema` and the assorted
// option branches of `generateOpenApi` / the plugin.

describe('zodToJsonSchema — native-converter normalisation branches', () => {
  it('strips the JS safe-integer bounds Zod stamps on integers', () => {
    const out = zodToJsonSchema(z.number().int())
    expect(out).toEqual({ type: 'integer' })
    expect(out).not.toHaveProperty('minimum')
    expect(out).not.toHaveProperty('maximum')
  })

  it('keeps genuine numeric bounds (not the safe-integer sentinels)', () => {
    expect(zodToJsonSchema(z.number().min(5).max(9))).toMatchObject({ minimum: 5, maximum: 9 })
  })

  it('strips safe-integer bounds recursively inside arrays', () => {
    const out = zodToJsonSchema(z.array(z.number().int())) as { items: Record<string, unknown> }
    expect(out.items).toEqual({ type: 'integer' })
  })

  it('drops a field with a default from `required`, deleting an emptied `required`', () => {
    const out = zodToJsonSchema(z.object({ a: z.string().default('x') }))
    expect(out).not.toHaveProperty('required')
    expect((out as { properties: Record<string, { default?: unknown }> }).properties.a!.default).toBe('x')
  })

  it('keeps the still-required fields when only some carry defaults', () => {
    const out = zodToJsonSchema(z.object({ a: z.string(), b: z.string().default('x') }))
    expect((out as { required: string[] }).required).toEqual(['a'])
  })

  it('recurses through a falsy default value (0 / false) without choking', () => {
    const out = zodToJsonSchema(z.object({ flag: z.boolean().default(false), count: z.number().default(0) }))
    const props = (out as { properties: Record<string, { default?: unknown }> }).properties
    expect(props.flag!.default).toBe(false)
    expect(props.count!.default).toBe(0)
  })
})

describe('generateOpenApi — remaining option branches', () => {
  it('filters non-string entries out of meta.tags', () => {
    const doc = generateOpenApi(
      [{ method: 'GET', url: '/x', meta: { tags: ['Real', 123, null, 'Also'] } }],
      { title: 'API', version: '1' },
    ) as { paths: Record<string, Record<string, { tags: string[] }>>; tags: { name: string }[] }
    expect(doc.paths['/x']!.get!.tags).toEqual(['Real', 'Also'])
    expect(doc.tags.map((t) => t.name)).toEqual(['Real', 'Also'])
  })

  it('falls back to "OK" for an unknown status code', () => {
    const doc = generateOpenApi(
      [{ method: 'GET', url: '/teapot', response: { 418: z.object({ ok: z.boolean() }) } }],
      { title: 'API', version: '1' },
    ) as { paths: Record<string, Record<string, { responses: Record<string, { description: string }> }>> }
    expect(doc.paths['/teapot']!.get!.responses['418']!.description).toBe('OK')
  })

  it('emits multiple per-status responses on one operation', () => {
    const doc = generateOpenApi(
      [{ method: 'POST', url: '/y', response: { 201: z.object({ id: z.string() }), 400: z.object({ error: z.string() }) } }],
      { title: 'API', version: '1' },
    ) as { paths: Record<string, Record<string, { responses: Record<string, unknown> }>> }
    const responses = doc.paths['/y']!.post!.responses
    expect(Object.keys(responses).sort()).toEqual(['201', '400'])
  })

  it('includes info.description when provided', () => {
    const doc = generateOpenApi([{ method: 'GET', url: '/x' }], { title: 'API', version: '1', description: 'The docs.' }) as {
      info: { description?: string }
    }
    expect(doc.info.description).toBe('The docs.')
  })

  it('combines path params, query and body on a single operation', () => {
    const doc = generateOpenApi(
      [
        {
          method: 'PUT',
          url: '/users/:id',
          params: z.object({ id: z.string() }),
          query: z.object({ dryRun: z.boolean().optional() }),
          body: z.object({ name: z.string() }),
        },
      ],
      { title: 'API', version: '1' },
    ) as { paths: Record<string, Record<string, { parameters: { name: string; in: string; required: boolean }[]; requestBody: unknown }>> }
    const op = doc.paths['/users/{id}']!.put!
    expect(op.requestBody).toBeDefined()
    expect(op.parameters.find((p) => p.name === 'id')).toMatchObject({ in: 'path', required: true })
    expect(op.parameters.find((p) => p.name === 'dryRun')).toMatchObject({ in: 'query', required: false })
  })

  it('tolerates non-object params/query schemas (no properties to iterate)', () => {
    const doc = generateOpenApi(
      [{ method: 'GET', url: '/x', params: z.string(), query: z.number() }],
      { title: 'API', version: '1' },
    ) as { paths: Record<string, Record<string, { parameters?: unknown }>> }
    // A non-object schema yields no `properties`, so no parameters are emitted.
    expect(doc.paths['/x']!.get!.parameters).toBeUndefined()
  })

  it('handles an empty route list (no paths, no tags, no components)', () => {
    const doc = generateOpenApi([], { title: 'Empty', version: '1' }) as Record<string, unknown>
    expect(doc.paths).toEqual({})
    expect(doc.tags).toBeUndefined()
    expect(doc.components).toBeUndefined()
  })
})

describe('openapiPlugin — boot placeholder with a description', () => {
  it('serves a document whose info carries the configured description', async () => {
    const c = new HttpServerCollector()
    await bootWith(c, [
      openapiPlugin({
        info: { title: 'Desc API', version: '3.0.0', description: 'Placeholder desc.' },
        routes: [{ method: 'GET', url: '/ping' }],
      }),
    ])
    const route = c.extraRoutes.find((r) => r.url === '/openapi.json')!
    const doc = (await route.handler({ request: makeRequest(), reply: new FakeReply() })) as { info: { description?: string } }
    expect(doc.info.description).toBe('Placeholder desc.')
  })
})

describe('openapiPlugin — sources routes from http:routes metadata when options.routes is omitted', () => {
  it('builds the document from published metadata at app:booted', async () => {
    const c = new HttpServerCollector()
    await bootWith(c, [
      routesProvider([{ method: 'GET', url: '/from-meta', meta: { summary: 'Discovered' } }]),
      openapiPlugin({ info: { title: 'Meta API', version: '1' } }),
    ])
    const route = c.extraRoutes.find((r) => r.url === '/openapi.json')!
    const doc = (await route.handler({ request: makeRequest(), reply: new FakeReply() })) as {
      paths: Record<string, Record<string, { summary?: string }>>
    }
    expect(doc.paths['/from-meta']!.get!.summary).toBe('Discovered')
  })
})

describe('generate:docs command — default output filename', () => {
  it('writes ./openapi.json when neither --out nor --stdout is given', async () => {
    // No options.routes → the command sources routes from http:routes metadata (line 312 branch).
    const app = await bootWith(new HttpServerCollector(), [
      routesProvider([{ method: 'GET', url: '/z' }]),
      openapiPlugin({ info: { title: 'API', version: '1' } }),
    ])
    const cmds = ensureMetadata(app.container).get<{ name: string; handle: (ctx: unknown) => Promise<void> }>('commands')
    const cmd = cmds.find((c) => c.name === 'generate:docs')!

    const { mkdtemp, readFile, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = await mkdtemp(join(tmpdir(), 'basalt-docs-default-'))
    const cwd = process.cwd()
    const logs: string[] = []
    try {
      process.chdir(dir)
      await cmd.handle({ io: { log: (m: string) => logs.push(m), error: () => {} }, flags: {} })
      const doc = JSON.parse(await readFile(join(dir, 'openapi.json'), 'utf8'))
      expect(Object.keys(doc.paths)).toEqual(['/z'])
      expect(logs[0]).toContain('openapi.json')
    } finally {
      process.chdir(cwd)
      await rm(dir, { recursive: true, force: true })
    }
  })
})
