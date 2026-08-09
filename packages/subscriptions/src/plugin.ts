import { createToken, ctx, definePlugin, ensureMetadata, type Container } from '@basaltkit/core'
import { route, type BasaltRoute, type RouteGuard } from '@basaltkit/fastify'
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

declare module '@basaltkit/core' {
  interface BasaltHooks {
    'billing:subscribed': { subscription: SubscriptionRecord }
    'billing:swapped': { subscription: SubscriptionRecord; from: string }
    'billing:canceled': { subscription: SubscriptionRecord }
    'billing:trial_expired': { subscription: SubscriptionRecord }
    'billing:webhook': { event: WebhookEvent }
    'billing:checkout_started': { billableId: string; plan: string; url: string }
  }
}

export const SUBSCRIPTIONS = createToken<Subscriptions>('subscriptions')

export type SubscriptionsPluginOptions = Omit<SubscriptionsOptions, 'hooks'>

export function subscriptionsPlugin(options: SubscriptionsPluginOptions) {
  return definePlugin({
    name: 'basalt:subscriptions',
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

const billable = (): string => {
  const id = (ctx() as { tenant?: { id: string } }).tenant?.id
  if (!id) throw new NotSubscribedError()
  return id
}
const subscriptions = (): Subscriptions => (ctx().container as Container).get(SUBSCRIPTIONS)

export interface BillingRoutesOptions {
  /** Where Stripe returns the customer after Checkout. */
  successUrl: string
  cancelUrl: string
  /** Where the Customer Portal returns the customer. Default: successUrl. */
  portalReturnUrl?: string
}

/**
 * Hosted billing routes for the current tenant: `POST /billing/checkout`
 * (subscribe via the gateway's hosted page) and `POST /billing/portal`
 * (self-service management). Both return `{ url }` to redirect to. The
 * success/cancel/return URLs are configured here; the request body may
 * override them per call.
 */
export function billingRoutes(options: BillingRoutesOptions): BasaltRoute[] {
  const portalReturn = options.portalReturnUrl ?? options.successUrl
  return [
    route({
      method: 'POST',
      url: '/billing/checkout',
      body: z.object({
        plan: z.string(),
        period: z.enum(['monthly', 'yearly']).optional(),
        successUrl: z.string().url().optional(),
        cancelUrl: z.string().url().optional(),
      }),
      async handler({ body }) {
        return subscriptions().checkout(billable(), body.plan, {
          successUrl: body.successUrl ?? options.successUrl,
          cancelUrl: body.cancelUrl ?? options.cancelUrl,
          ...(body.period !== undefined ? { period: body.period } : {}),
        })
      },
    }),

    route({
      method: 'POST',
      url: '/billing/portal',
      body: z.object({ returnUrl: z.string().url().optional() }).optional(),
      async handler({ body }) {
        return subscriptions().portal(billable(), { returnUrl: body?.returnUrl ?? portalReturn })
      },
    }),
  ]
}

/**
 * Webhook endpoint: POST /billing/webhook — signature verified by the
 * gateway driver, processing idempotent by event id. Returns 200 with
 * { received, duplicate } so gateways stop retrying.
 */
export function billingWebhookRoute(gateway: BillingGateway): BasaltRoute {
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
