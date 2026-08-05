import { createToken, ctx, definePlugin, ensureMetadata, type Container } from '@machize/core'
import { route, type MachizeRoute, type RouteGuard } from '@machize/fastify'
import { z } from 'zod'
import type { BillingGateway } from './gateway.js'
import type { SubscriptionRecord } from './stores.js'
import type { WebhookEvent } from './gateway.js'
import {
  FeatureUnavailableError,
  NotSubscribedError,
  Subscriptions,
  type SubscriptionsOptions,
} from './subscriptions.js'

declare module '@machize/core' {
  interface MachizeHooks {
    'billing:subscribed': { subscription: SubscriptionRecord }
    'billing:swapped': { subscription: SubscriptionRecord; from: string }
    'billing:canceled': { subscription: SubscriptionRecord }
    'billing:trial_expired': { subscription: SubscriptionRecord }
    'billing:webhook': { event: WebhookEvent }
  }
}

export const SUBSCRIPTIONS = createToken<Subscriptions>('subscriptions')

export type SubscriptionsPluginOptions = Omit<SubscriptionsOptions, 'hooks'>

export function subscriptionsPlugin(options: SubscriptionsPluginOptions) {
  return definePlugin({
    name: 'machize:subscriptions',
    register({ container, hooks }) {
      container.singleton(SUBSCRIPTIONS, () => new Subscriptions({ ...options, hooks }))

      // Route guards: meta.subscribed (true or a plan name) and meta.feature.
      // The billable is the current tenant.
      const guard: RouteGuard = async ({ route: definition, context, container: c }) => {
        const requiredSubscription = definition.meta?.['subscribed']
        const requiredFeature = definition.meta?.['feature']
        if (requiredSubscription === undefined && requiredFeature === undefined) return

        const subscriptions = c.get(SUBSCRIPTIONS)
        const billableId = (context.tenant as { id?: string } | undefined)?.id

        if (requiredSubscription !== undefined) {
          if (!billableId) throw new NotSubscribedError()
          const plan =
            typeof requiredSubscription === 'string' ? requiredSubscription : undefined
          if (!(await subscriptions.subscribed(billableId, plan))) {
            throw new NotSubscribedError()
          }
        }
        if (typeof requiredFeature === 'string') {
          if (!billableId || !(await subscriptions.features(billableId).can(requiredFeature))) {
            throw new FeatureUnavailableError(requiredFeature)
          }
        }
      }
      ensureMetadata(container).add('http:guards', guard)
    },
  })
}

/**
 * Webhook endpoint: POST /billing/webhook — signature verified by the
 * gateway driver, processing idempotent by event id. Returns 200 with
 * { received, duplicate } so gateways stop retrying.
 */
export function billingWebhookRoute(gateway: BillingGateway): MachizeRoute {
  return route({
    method: 'POST',
    url: '/billing/webhook',
    body: z.unknown(),
    async handler({ request, reply }) {
      // Real gateways (Stripe) verify the signature against the UNTOUCHED raw
      // body — re-serializing a parsed object changes bytes and breaks the
      // HMAC. Configure a raw-body parser for this route so `request.body`
      // arrives as a string; we fall back to stringify for the fake/dev path.
      const rawBody = typeof request.body === 'string' ? request.body : JSON.stringify(request.body)
      const header = request.headers['stripe-signature'] ?? request.headers['x-billing-signature']
      const event = gateway.verifyWebhook(
        rawBody,
        Array.isArray(header) ? header[0] : header,
      )
      const subscriptions = (ctx().container as Container).get(SUBSCRIPTIONS)
      if (!event) return reply.code(200).send({ received: true, ignored: true })
      const applied = await subscriptions.handleWebhook(event)
      return reply.code(200).send({ received: true, duplicate: !applied })
    },
  })
}
