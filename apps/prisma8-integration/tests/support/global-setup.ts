import pg from 'pg'
import { DATABASE, prisma, serverUrl } from './db.js'

/**
 * Recreates `basalt_prisma8` on the TEST_DATABASE_URL server and initialises its
 * central plane with `prisma db init`. Its own database, so the Prisma 7 harness's
 * tables in `basalt_test` are never touched. Skips when TEST_DATABASE_URL is unset.
 */
export default async function setup() {
  if (!serverUrl) return
  const admin = new pg.Client({ connectionString: serverUrl })
  await admin.connect()
  await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`)
  await admin.query(`CREATE DATABASE ${DATABASE}`)
  await admin.end()

  const emitted = await prisma(['contract', 'emit'])
  if (!emitted.ok) throw new Error(`prisma contract emit failed: ${JSON.stringify(emitted)}`)
  const init = await prisma(['db', 'init', '--yes'])
  if (!init.ok) throw new Error(`prisma db init failed: ${JSON.stringify(init)}`)
}
