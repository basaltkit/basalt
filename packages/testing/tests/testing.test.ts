import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ctx } from '@basaltkit/core'
import { fastifyPlugin, route } from '@basaltkit/fastify'
import { defineMail, MAILER } from '@basaltkit/mailer'
import { defineJob } from '@basaltkit/queue'
import { createTestApp, fakeMailer, fakeQueue, time } from '../src/index.js'

const WelcomeEmail = defineMail({
  name: 'welcome',
  schema: z.object({ name: z.string() }),
  subject: ({ name }) => `Welcome, ${name}!`,
  text: ({ name }) => `Hello ${name}`,
})

describe('createTestApp', () => {
  it('fluent HTTP with user/tenant impersonation', async () => {
    const whoami = route({
      method: 'GET',
      url: '/whoami',
      async handler() {
        const { user, tenant } = ctx()
        return { user: user ?? null, tenant: tenant ?? null }
      },
    })
    const app = await createTestApp({ plugins: [fastifyPlugin({ routes: [whoami] })] })

    const anonymous = await app.get('/whoami')
    expect(anonymous.json()).toEqual({ user: null, tenant: null })

    app.actingAs({ id: 'u1', email: 'ada@example.com' }).asTenant('acme')
    const impersonated = await app.get('/whoami')
    expect(impersonated.json()).toEqual({
      user: { id: 'u1', email: 'ada@example.com' },
      tenant: { id: 'acme' },
    })

    // per-request override wins over the defaults
    const overridden = await app.get('/whoami', { tenant: 'globex' })
    expect(overridden.json().tenant).toEqual({ id: 'globex' })
    await app.shutdown()
  })
})

describe('fakeMailer', () => {
  it('records and asserts sent mail', async () => {
    const mail = fakeMailer()
    const app = await createTestApp({ plugins: [mail.plugin] })

    mail.assertNothingSent()
    const mailer = app.container.get(MAILER)
    await mailer.send(WelcomeEmail, { name: 'Ada' }, { to: 'ada@example.com' })

    const sent = mail.assertSent(WelcomeEmail, (message) => message.to.includes('ada@example.com'))
    expect(sent.subject).toBe('Welcome, Ada!')
    expect(() => mail.assertSent('other.mail')).toThrowError(/Expected mail "other.mail"/)
    expect(() => mail.assertNothingSent()).toThrowError(/1 message/)
    await app.shutdown()
  })
})

describe('fakeQueue', () => {
  it('captures dispatches without executing; drain runs the handlers', async () => {
    const seen: string[] = []
    const SendWelcome = defineJob({
      name: 'email.welcome',
      schema: z.object({ userId: z.string() }),
      handle: ({ userId }) => void seen.push(userId),
    })
    const queue = fakeQueue({ jobs: [SendWelcome] })
    const app = await createTestApp({ plugins: [queue.plugin] })

    queue.assertNothingDispatched()
    await SendWelcome.dispatch({ userId: 'u-1' })

    const captured = queue.assertDispatched(SendWelcome, (job) =>
      (job.payload as { userId: string }).userId === 'u-1',
    )
    expect(captured.queue).toBe('default')
    expect(seen).toEqual([]) // captured, not executed

    expect(await queue.drain()).toBe(1)
    expect(seen).toEqual(['u-1'])
    expect(() => queue.assertDispatched('ghost.job')).toThrowError(/Expected job "ghost.job"/)
    await app.shutdown()
  })
})

describe('time travel', () => {
  afterEach(() => time.restore())

  it('shifts Date.now and new Date() forward, restore undoes it', () => {
    const before = Date.now()
    time.travel('15d')
    const after = Date.now()
    expect(after - before).toBeGreaterThanOrEqual(15 * 86_400_000)
    expect(new Date().getTime() - before).toBeGreaterThanOrEqual(15 * 86_400_000)

    // explicit dates are untouched
    expect(new Date('2026-01-01T00:00:00Z').toISOString()).toBe('2026-01-01T00:00:00.000Z')

    time.restore()
    expect(Date.now() - before).toBeLessThan(15 * 86_400_000)
  })

  it('travelTo pins the clock to a date', () => {
    time.travelTo(new Date('2030-06-01T00:00:00Z'))
    expect(new Date().toISOString().slice(0, 10)).toBe('2030-06-01')
  })
})
