import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  createMailPreviewServer,
  defineMail,
  definePreview,
  Mailer,
  MemoryMailDriver,
  renderPreviewResponse,
  type MailPreview,
} from '../src/index.js'

const Welcome = defineMail({
  name: 'welcome',
  schema: z.object({ name: z.string() }),
  subject: ({ name }) => `Welcome, ${name}!`,
  text: ({ name }) => `Hi ${name}`,
  html: ({ name }) => `<h1>Hi ${name}</h1>`,
})

const Ping = defineMail({ name: 'ping', subject: () => 'Ping', text: () => 'pong' })

const previews: MailPreview[] = [
  definePreview({ mail: Welcome, data: { name: 'Ada' }, label: 'Welcome email' }),
  definePreview({ mail: Ping }),
]

const mailer = () =>
  new Mailer(new MemoryMailDriver(), {
    from: 'preview@basalt.test',
    layout: (html, { mail }) => `<main data-mail="${mail}">${html}</main>`,
  })

const q = (s: string) => new URLSearchParams(s)

describe('renderPreviewResponse', () => {
  it('serves an index shell listing every preview', () => {
    const r = renderPreviewResponse(previews, mailer(), '/')
    expect(r.status).toBe(200)
    expect(r.contentType).toContain('text/html')
    expect(r.body).toContain('Welcome email')
    expect(r.body).toContain('mail preview')
    // first preview selected by default → its subject rendered
    expect(r.body).toContain('Welcome, Ada!')
  })

  it('renders the layout-wrapped HTML body for the iframe', () => {
    const r = renderPreviewResponse(previews, mailer(), '/raw/welcome/html')
    expect(r.contentType).toContain('text/html')
    expect(r.body).toBe('<main data-mail="welcome"><h1>Hi Ada</h1></main>')
  })

  it('serves the plaintext body as text/plain', () => {
    const r = renderPreviewResponse(previews, mailer(), '/raw/welcome/text')
    expect(r.contentType).toContain('text/plain')
    expect(r.body).toBe('Hi Ada')
  })

  it('falls back to a <pre> when a mail has no HTML body', () => {
    const r = renderPreviewResponse(previews, mailer(), '/raw/ping/html')
    expect(r.body).toContain('<pre>pong</pre>')
  })

  it('renders a meta table', () => {
    const r = renderPreviewResponse(previews, mailer(), '/', q('mail=welcome&view=meta'))
    expect(r.body).toContain('Subject')
    expect(r.body).toContain('preview@basalt.test')
  })

  it('404s an unknown mail', () => {
    expect(renderPreviewResponse(previews, mailer(), '/raw/nope/html').status).toBe(404)
  })

  it('renders an error card instead of crashing on invalid sample data', () => {
    const bad: MailPreview[] = [{ mail: Welcome, data: { name: 123 } as never }]
    const r = renderPreviewResponse(bad, mailer(), '/raw/welcome/html')
    expect(r.status).toBe(200)
    expect(r.body).toContain('Could not render')
  })
})

describe('createMailPreviewServer', () => {
  it('listens and serves the index over HTTP, then closes', async () => {
    const server = createMailPreviewServer(previews, { from: 'x@y.z' })
    const { url, port } = await server.listen(0)
    expect(port).toBeGreaterThan(0)
    const res = await fetch(`${url}/`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Welcome email')
    const raw = await fetch(`${url}/raw/welcome/html`)
    expect(await raw.text()).toContain('<h1>Hi Ada</h1>')
    await server.close()
  })
})
