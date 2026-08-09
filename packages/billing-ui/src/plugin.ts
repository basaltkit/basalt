import { ctx, type Container } from '@basaltkit/core'
import { route, type BasaltRoute } from '@basaltkit/fastify'
import { SUBSCRIPTIONS, type Plans } from '@basaltkit/subscriptions'
import { billingPageHtml, type BillingPageOptions } from './html.js'

export interface BillingUiOptions extends BillingPageOptions {
  /** The plans to show. Pass the same `Plans` you gave `subscriptionsPlugin`. */
  plans: Plans
  /** Where to mount the page. Default `/billing/ui`. */
  path?: string
}

interface PlanSummary {
  name: string
  price: Plans[string]['price']
  trial: string | null
  features: string[]
}

const summarize = (plans: Plans): PlanSummary[] =>
  Object.entries(plans).map(([name, def]) => ({
    name,
    price: def.price,
    trial: def.trial !== undefined ? String(def.trial) : null,
    features: Object.keys(def.features),
  }))

const tenantId = (): string | undefined => (ctx() as { tenant?: { id: string } }).tenant?.id

/**
 * Serves the billing page at `GET /billing/ui` and its data at
 * `GET /billing/info` ({ subscription, plans }). Pair with
 * `@basaltkit/subscriptions`' `billingRoutes()` (which provides
 * `POST /billing/checkout` and `/billing/portal` that the page calls).
 */
export function billingUiRoutes(options: BillingUiOptions): BasaltRoute[] {
  const html = billingPageHtml(options)
  const plans = summarize(options.plans)

  return [
    route({
      method: 'GET',
      url: '/billing/info',
      meta: { auth: true },
      async handler() {
        const id = tenantId()
        const subscription = id ? await (ctx().container as Container).get(SUBSCRIPTIONS).get(id) : null
        return { subscription, plans }
      },
    }),
    route({
      method: 'GET',
      url: options.path ?? '/billing/ui',
      meta: { auth: true },
      async handler({ reply }) {
        return reply.header('content-type', 'text/html; charset=utf-8').send(html)
      },
    }),
  ]
}
