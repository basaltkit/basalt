import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ensureMetadata } from '@basaltkit/core'
import { HttpServerCollector, openapiPlugin } from '../src/index.js'
import { bootWith } from './support.js'

const io = () => {
  const logs: string[] = []
  const errors: string[] = []
  return { logs, errors, log: (m: string) => logs.push(m), error: (m: string) => errors.push(m) }
}

const routes = [
  { method: 'GET', url: '/users', meta: { summary: 'List users', tags: ['Users'] } },
  {
    method: 'POST',
    url: '/users',
    body: z.object({ name: z.string() }),
    response: { 201: z.object({ id: z.string() }) },
    meta: { tags: ['Users'], auth: true },
  },
]

async function bootDocs() {
  const app = await bootWith(new HttpServerCollector(), [
    openapiPlugin({ info: { title: 'My API', version: '2.0.0' }, routes }),
  ])
  const cmds = ensureMetadata(app.container).get<{
    name: string
    handle: (ctx: unknown) => Promise<void>
  }>('commands')
  return cmds.find((c) => c.name === 'generate:docs')!
}

describe('generate:docs command', () => {
  it('prints a valid OpenAPI document to stdout', async () => {
    const cmd = await bootDocs()
    const out = io()
    await cmd.handle({ io: out, flags: { stdout: true } })
    const doc = JSON.parse(out.logs.join('\n'))
    expect(doc.openapi).toBe('3.0.3')
    expect(doc.info).toMatchObject({ title: 'My API', version: '2.0.0' })
    expect(Object.keys(doc.paths)).toContain('/users')
    expect(doc.paths['/users'].post.security).toEqual([{ bearerAuth: [] }])
    expect(doc.components.securitySchemes.bearerAuth.scheme).toBe('bearer')
  })

  it('writes to a file and reports the path count', async () => {
    const cmd = await bootDocs()
    const { mkdtemp, readFile, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = await mkdtemp(join(tmpdir(), 'basalt-docs-'))
    const file = join(dir, 'openapi.json')
    const out = io()
    try {
      await cmd.handle({ io: out, flags: { out: file } })
      expect(out.logs[0]).toContain('path(s) to')
      const doc = JSON.parse(await readFile(file, 'utf8'))
      expect(Object.keys(doc.paths)).toEqual(['/users'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
