// The route definition is framework-neutral and lives in @basaltkit/http; it is
// re-exported here so existing `import { route } from '@basaltkit/fastify'` keeps
// working. A route defined this way runs unchanged on Express and Hono too.
export {
  route,
  type BasaltRoute,
  type HandlerArgs,
  type HttpMethod,
  type HttpRequest,
  type HttpReply,
} from '@basaltkit/http'
