import { describe, expect, it } from 'vitest'
import { coercionFindings, policyFindings } from '../src/env-check.js'
import { answerQuestions, describeEnv, planEnv, readEnv, writeEnv } from '../src/env-step.js'
import { context, DIR, FakeHost } from './fake-host.js'

const ENV = `${DIR}/.env`

describe('the .env step', () => {
  it('writes fixed, generated, derived and asked values; removes forbidden ones; prints keys only', async () => {
    const host = new FakeHost().put(ENV, 'PAYCO_FAKE=0\nNODE_ENV=development\n', 0o644)
    host.answers = ['', 'sk_live_TOKEN_123']
    const ctx = context(host)
    const plan = planEnv(ctx, await readEnv(ctx), 3002, [])
    expect(plan.questions).toEqual(['MAILER_URL', 'PAYCO_SECRET_TOKEN'])
    expect(await answerQuestions(ctx, plan)).toEqual([])
    for (const line of describeEnv(plan)) host.out.info(line)
    await writeEnv(ctx, plan)

    const written = plan.values
    expect(written.get('PORT')).toBe('3002')
    expect(written.get('NODE_ENV')).toBe('production')
    expect(written.get('APP_SECRET')).toMatch(/^[0-9a-f]{64}$/)
    expect(written.get('PAYCO_CALLBACK_URL')).toBe('https://acme.example.com/api/webhooks/payco')
    expect(written.get('PAYCO_SECRET_TOKEN')).toBe('sk_live_TOKEN_123')
    expect(written.get('MAILER_URL')).toBe('')
    expect(written.has('PAYCO_FAKE')).toBe(false)

    expect(host.mode(ENV)).toBe(0o600)
    expect(host.file(`${ENV}.bak-20261011T120000`)).toBe('PAYCO_FAKE=0\nNODE_ENV=development\n')
    expect(host.mode(`${ENV}.bak-20261011T120000`)).toBe(0o600)
    // The summary names keys; no value — generated or typed — reaches the screen.
    expect(host.transcript).toContain('add PAYCO_SECRET_TOKEN (answered)')
    expect(host.transcript).not.toContain('sk_live_TOKEN_123')
    expect(host.transcript).not.toContain(written.get('APP_SECRET'))
  })

  it('generates and asks only once: a second run changes nothing', async () => {
    const host = new FakeHost().put(ENV, '')
    host.answers = ['smtps://u:p@mail:465', 'tok']
    const ctx = context(host)
    const first = planEnv(ctx, await readEnv(ctx), 3002, [])
    await answerQuestions(ctx, first)
    await writeEnv(ctx, first)
    const again = planEnv(ctx, await readEnv(ctx), 3002, [])
    expect(again.changes).toEqual([])
    expect(again.questions).toEqual([])
  })

  it('without a terminal, takes answers from its own environment, else lists what is missing', async () => {
    const host = new FakeHost().put(ENV, '')
    host.env['PAYCO_SECRET_TOKEN'] = 'from-ci'
    const ctx = context(host)
    const plan = planEnv(ctx, await readEnv(ctx), 3002, [])
    expect(await answerQuestions(ctx, plan)).toEqual([])
    expect(plan.changes.find((c) => c.key === 'PAYCO_SECRET_TOKEN')).toMatchObject({ value: 'from-ci' })

    const bare = new FakeHost().put(ENV, '')
    const ctx2 = context(bare)
    const plan2 = planEnv(ctx2, await readEnv(ctx2), 3002, [])
    expect(await answerQuestions(ctx2, plan2)).toEqual(['PAYCO_SECRET_TOKEN'])
  })

  it('asks again for a value no quoting can carry, instead of writing a broken file', async () => {
    const host = new FakeHost().put(ENV, 'MAILER_URL=x\n')
    host.answers = ["it's $5", 'good']
    const ctx = context(host)
    const plan = planEnv(ctx, await readEnv(ctx), 3002, [])
    await answerQuestions(ctx, plan)
    expect(plan.changes.find((c) => c.key === 'PAYCO_SECRET_TOKEN')).toMatchObject({ value: 'good' })
    expect(host.prompts).toHaveLength(2)
  })

  it('keeps at most five backups', async () => {
    const host = new FakeHost().put(ENV, 'A=1\n')
    for (let i = 0; i < 7; i++) host.put(`${ENV}.bak-2026010${i}T000000`, 'old', 0o600)
    const ctx = context(host)
    const plan = planEnv(ctx, await readEnv(ctx), 3002, [])
    plan.questions = []
    await writeEnv(ctx, plan)
    expect((await host.list(DIR)).filter((n) => n.startsWith('.env.bak-'))).toHaveLength(5)
  })
})

describe('C6 — a value meant as off that the schema reads as on', () => {
  it('flags "0"/"false"/"no"/"off" parsed as true, prefixed names included', () => {
    const values = new Map([['PAYCO_FAKE', '0'], ['MY_APP_DEBUG', 'false'], ['OTHER', '1'], ['FEATURE', 'true']])
    const findings = coercionFindings(values, ['PAYCO_FAKE', 'DEBUG', 'OTHER', 'FEATURE'])
    expect(findings.map((f) => f.message.split('=')[0])).toEqual(['PAYCO_FAKE', 'MY_APP_DEBUG'])
    expect(findings[0]?.fix).toMatch(/remove PAYCO_FAKE/)
  })

  it('says nothing about a value parsed as false', () => {
    expect(coercionFindings(new Map([['FLAG', '0']]), [])).toEqual([])
  })
})

describe('C10 — forbidden and fixed keys', () => {
  it('reports both', () => {
    const ctx = context(new FakeHost())
    const findings = policyFindings(ctx, new Map([['PAYCO_FAKE', ''], ['NODE_ENV', 'production'], ['HOST', '0.0.0.0']]))
    expect(findings.map((f) => f.message)).toEqual(['PAYCO_FAKE must not exist in the production .env', 'HOST differs from deploy.config.ts'])
  })
})
