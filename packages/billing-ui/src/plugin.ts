import { ctx, type Container } from '@basaltkit/core'
import { route, type BasaltRoute } from '@basaltkit/http'
import { SUBSCRIPTIONS, type Plans } from '@basaltkit/subscriptions'
import { billingPageCsp, billingPageHtml, type BillingPageOptions } from './html.js'

export interface BillingUiOptions extends BillingPageOptions {
  /** The plans to show. Pass the same `Plans` you gave `subscriptionsPlugin`. */
  plans: Plans
  /** Where to mount the page. Default `/billing/ui`. */
  path?: string
  /**
   * Content-Security-Policy for the page. Default: the hash-locked
   * {@link billingPageCsp}. Pass a string to override, or `false` to send none.
   */
  csp?: string | false
  /**
   * Extra route metadata merged into both routes — a guard such as
   * `{ can: 'billing:manage' }`, a rate limit, OpenAPI tags. `auth: true` is
   * always applied on top and cannot be switched off.
   */
  meta?: Record<string, unknown>
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
  const csp = options.csp === false ? undefined : (options.csp ?? billingPageCsp(options))
  const plans = summarize(options.plans)
  const meta = { ...options.meta, auth: true }

  return [
    route({
      method: 'GET',
      url: '/billing/info',
      meta,
      async handler() {
        const id = tenantId()
        const subscription = id ? await (ctx().container as Container).get(SUBSCRIPTIONS).get(id) : null
        return { subscription, plans }
      },
    }),
    route({
      method: 'GET',
      url: options.path ?? '/billing/ui',
      meta,
      async handler({ reply }) {
        if (csp !== undefined) reply.header('content-security-policy', csp)
        return reply.header('content-type', 'text/html; charset=utf-8').send(html)
      },
    }),
  ]
}
