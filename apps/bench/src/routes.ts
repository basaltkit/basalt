import { route, type BasaltRoute } from '@basaltkit/http'
import { z } from 'zod'

/** One trivial route + one Zod-validated route — the same on every adapter. */
export const routes: BasaltRoute[] = [
  route({ method: 'GET', url: '/health', async handler() { return { ok: true } } }),
  route({
    method: 'POST', url: '/echo',
    body: z.object({ name: z.string(), n: z.number() }),
    async handler({ body }) { return { hello: body.name, doubled: body.n * 2 } },
  }),
]
