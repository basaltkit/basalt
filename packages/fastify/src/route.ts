// The route definition is framework-neutral and lives in @machize/http; it is
// re-exported here so existing `import { route } from '@machize/fastify'` keeps
// working. A route defined this way runs unchanged on Express and Hono too.
export {
  route,
  type MachizeRoute,
  type HandlerArgs,
  type HttpMethod,
  type HttpRequest,
  type HttpReply,
} from '@machize/http'
