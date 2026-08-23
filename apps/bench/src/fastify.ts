import Fastify from 'fastify'
export async function startFastify(port: number) {
  const app = Fastify({ logger: false })
  app.get('/health', async () => ({ ok: true }))
  app.post('/echo', {
    schema: { body: { type: 'object', required: ['name', 'n'], properties: { name: { type: 'string' }, n: { type: 'number' } } } },
    handler: async (req) => { const b = req.body as { name: string; n: number }; return { hello: b.name, doubled: b.n * 2 } },
  })
  await app.listen({ port, host: '127.0.0.1' })
  return { close: () => app.close() }
}
