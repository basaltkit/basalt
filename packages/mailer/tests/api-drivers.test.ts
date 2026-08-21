import { describe, expect, it } from 'vitest'
import {
  MailDeliveryError,
  MailgunMailDriver,
  ResendMailDriver,
  SesMailDriver,
  type ResolvedMail,
} from '../src/index.js'

const mail: ResolvedMail = {
  mail: 'welcome',
  to: ['ada@example.com'],
  from: 'no-reply@app.dev',
  cc: [],
  bcc: [],
  subject: 'Hi',
  text: 'hello',
  html: '<b>hello</b>',
}

/** A fetch double that records calls and returns a scripted response. */
function fakeFetch(response: { ok: boolean; status: number; text?: string }) {
  const calls: { url: string; init: RequestInit }[] = []
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return { ok: response.ok, status: response.status, text: async () => response.text ?? '' }
  }) as unknown as typeof fetch
  return { fn, calls }
}

describe('ResendMailDriver', () => {
  it('POSTs to /emails with a Bearer key and the mapped body', async () => {
    const { fn, calls } = fakeFetch({ ok: true, status: 200 })
    await new ResendMailDriver({ apiKey: 're_test', fetch: fn }).send(mail)

    expect(calls[0]!.url).toBe('https://api.resend.com/emails')
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer re_test')
    expect(JSON.parse(calls[0]!.init.body as string)).toMatchObject({
      from: 'no-reply@app.dev',
      to: ['ada@example.com'],
      subject: 'Hi',
      text: 'hello',
      html: '<b>hello</b>',
    })
  })

  it('maps replyTo → reply_to and includes cc/bcc only when present', async () => {
    const { fn, calls } = fakeFetch({ ok: true, status: 200 })
    await new ResendMailDriver({ apiKey: 'k', fetch: fn }).send({
      ...mail,
      cc: ['c@x.com'],
      replyTo: 'reply@app.dev',
    })
    const body = JSON.parse(calls[0]!.init.body as string)
    expect(body.reply_to).toBe('reply@app.dev')
    expect(body.cc).toEqual(['c@x.com'])
    expect(body.bcc).toBeUndefined()
  })

  it('throws MailDeliveryError on a non-2xx response', async () => {
    const { fn } = fakeFetch({ ok: false, status: 422, text: 'invalid from' })
    await expect(new ResendMailDriver({ apiKey: 'k', fetch: fn }).send(mail)).rejects.toBeInstanceOf(
      MailDeliveryError,
    )
  })
})

describe('SesMailDriver (SES v2 + SigV4)', () => {
  const base = {
    region: 'eu-west-1',
    accessKeyId: 'AKIAEXAMPLE',
    secretAccessKey: 'secret-key',
    now: () => new Date('2026-08-21T20:24:06.123Z'),
  }

  it('POSTs to the SES v2 endpoint with a valid SigV4 authorization header', async () => {
    const { fn, calls } = fakeFetch({ ok: true, status: 200 })
    await new SesMailDriver({ ...base, fetch: fn }).send(mail)

    expect(calls[0]!.url).toBe('https://email.eu-west-1.amazonaws.com/v2/email/outbound-emails')
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers['x-amz-date']).toBe('20260821T202406Z')
    expect(headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\/20260821\/eu-west-1\/ses\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    )
    // The signature is deterministic for a fixed clock + input.
    const first = headers.authorization
    const second = fakeFetch({ ok: true, status: 200 })
    await new SesMailDriver({ ...base, fetch: second.fn }).send(mail)
    expect((second.calls[0]!.init.headers as Record<string, string>).authorization).toBe(first)
  })

  it('builds the SES v2 Simple content body (subject + text/html + destinations)', async () => {
    const { fn, calls } = fakeFetch({ ok: true, status: 200 })
    await new SesMailDriver({ ...base, fetch: fn }).send({ ...mail, cc: ['c@x.com'], replyTo: 'r@app.dev' })
    const body = JSON.parse(calls[0]!.init.body as string)
    expect(body.FromEmailAddress).toBe('no-reply@app.dev')
    expect(body.Destination.ToAddresses).toEqual(['ada@example.com'])
    expect(body.Destination.CcAddresses).toEqual(['c@x.com'])
    expect(body.ReplyToAddresses).toEqual(['r@app.dev'])
    expect(body.Content.Simple.Subject.Data).toBe('Hi')
    expect(body.Content.Simple.Body.Text.Data).toBe('hello')
    expect(body.Content.Simple.Body.Html.Data).toBe('<b>hello</b>')
  })

  it('adds x-amz-security-token when a sessionToken is set', async () => {
    const { fn, calls } = fakeFetch({ ok: true, status: 200 })
    await new SesMailDriver({ ...base, sessionToken: 'tok', fetch: fn }).send(mail)
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers['x-amz-security-token']).toBe('tok')
    expect(headers.authorization).toContain('x-amz-security-token')
  })

  it('throws MailDeliveryError on a non-2xx response', async () => {
    const { fn } = fakeFetch({ ok: false, status: 400, text: 'MessageRejected' })
    await expect(new SesMailDriver({ ...base, fetch: fn }).send(mail)).rejects.toBeInstanceOf(
      MailDeliveryError,
    )
  })
})

describe('MailgunMailDriver', () => {
  it('POSTs form-encoded with Basic auth to the domain messages endpoint', async () => {
    const { fn, calls } = fakeFetch({ ok: true, status: 200 })
    await new MailgunMailDriver({ apiKey: 'key-123', domain: 'mg.example.com', fetch: fn }).send({
      ...mail,
      cc: ['c@x.com'],
      replyTo: 'r@app.dev',
    })
    expect(calls[0]!.url).toBe('https://api.mailgun.net/v3/mg.example.com/messages')
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers.authorization).toBe(`Basic ${Buffer.from('api:key-123').toString('base64')}`)
    const body = new URLSearchParams(calls[0]!.init.body as string)
    expect(body.get('from')).toBe('no-reply@app.dev')
    expect(body.get('to')).toBe('ada@example.com')
    expect(body.get('cc')).toBe('c@x.com')
    expect(body.get('h:Reply-To')).toBe('r@app.dev')
    expect(body.get('subject')).toBe('Hi')
  })

  it('targets the EU base when region is eu', async () => {
    const { fn, calls } = fakeFetch({ ok: true, status: 200 })
    await new MailgunMailDriver({ apiKey: 'k', domain: 'd', region: 'eu', fetch: fn }).send(mail)
    expect(calls[0]!.url).toBe('https://api.eu.mailgun.net/v3/d/messages')
  })

  it('throws MailDeliveryError on a non-2xx response', async () => {
    const { fn } = fakeFetch({ ok: false, status: 401, text: 'Unauthorized' })
    await expect(new MailgunMailDriver({ apiKey: 'k', domain: 'd', fetch: fn }).send(mail)).rejects.toBeInstanceOf(
      MailDeliveryError,
    )
  })
})
