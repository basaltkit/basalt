import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * `save()` always writes every column of `subscriptionData` — including
 * `pendingPlan`/`pendingPeriod`, which the escalation guard clears by writing
 * null. A reference schema missing any of them makes every save fail with an
 * unknown-argument error on a database built by copying it.
 *
 * The schema is a hand-maintained copy of what the mapper writes, so nothing
 * but a test keeps the two in sync. This locks them together.
 */

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

/** Field names declared inside `model <name> { … }`. */
function fieldsOf(schema: string, model: string): string[] {
  const block = new RegExp(`model\\s+${model}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(schema)
  if (!block) throw new Error(`model ${model} not found in the reference schema`)
  return block[1]!
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('@@') && !line.startsWith('//'))
    .map((line) => line.split(/\s+/)[0]!)
}

/** Columns `PrismaSubscriptionStore.save()` writes on every call. */
const WRITTEN_SUBSCRIPTION_COLUMNS = [
  'billableId',
  'plan',
  'period',
  'status',
  'trialEndsAt',
  'cancelAtPeriodEnd',
  'canceledAt',
  'gatewayRef',
  'pendingPlan',
  'pendingPeriod',
]

describe('the reference prisma schema covers everything the stores write', () => {
  const schema = read('../prisma/schema.prisma')

  it('Subscription declares every column save() writes', () => {
    const declared = fieldsOf(schema, 'Subscription')
    for (const column of WRITTEN_SUBSCRIPTION_COLUMNS) {
      expect(declared, `reference schema is missing Subscription.${column}`).toContain(column)
    }
  })

  it('the README copy — the one users actually paste — matches the schema file', () => {
    const readme = read('../README.md')
    for (const column of WRITTEN_SUBSCRIPTION_COLUMNS) {
      expect(fieldsOf(readme, 'Subscription'), `README is missing ${column}`).toContain(column)
    }
  })
})
