import { memoryReader } from '@basaltkit/ai/analysis'
import { buildAiMcpServer, type AiMcpOptions } from '../src/index.js'

/**
 * An in-memory Basalt project that fires diagnostics and both auto-fixable rules
 * (`fastify-logger-off`, `insecure-app-secret`) — no disk, no network.
 */
export const PROJECT_FILES: Record<string, string> = {
  'package.json': JSON.stringify({ dependencies: { '@basaltkit/fastify': '^1', '@basaltkit/prisma': '^1' } }),
  'src/app.ts': 'createApp({ plugins: [ prismaPlugin({}), fastifyPlugin({ routes: [...appRoutes] }) ] })',
  'src/env.ts': "export const env = defineEnv({\n  APP_SECRET: z.string().default('change-me-in-production--'),\n})",
  'prisma/schema.prisma':
    'datasource db { provider = "postgresql" url = env("X") }\nmodel Tenant { id String @id }',
}

/** Build the server against the in-memory fixture at a synthetic root. */
export function fixtureServer(extra: Partial<AiMcpOptions> = {}) {
  return buildAiMcpServer({ cwd: '/proj', createReader: () => memoryReader(PROJECT_FILES), ...extra })
}
