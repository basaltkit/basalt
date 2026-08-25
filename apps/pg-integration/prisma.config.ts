import { defineConfig, env } from 'prisma/config'

// Prisma 7 moved the connection URL out of schema.prisma. The CLI (db push /
// migrate) reads it from here; the runtime client gets a driver adapter instead.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: env('TEST_DATABASE_URL'),
  },
})
