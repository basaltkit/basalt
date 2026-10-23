import { definePrismaConfig } from '@prisma/cli-engine'
import { defineConfig as ormConfig } from '@prisma/orm-postgres/config'

// The harness's own database, derived from TEST_DATABASE_URL by tests/support/db.ts.
export default definePrismaConfig({
  orm: ormConfig({
    contract: './prisma/contract.prisma',
    db: { connection: process.env['PRISMA8_DATABASE_URL'] ?? 'postgresql://localhost:5432/basalt_prisma8' },
  }),
})
