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

const HtmlOnly = defineMail({ name: 'htmlonly', subject: () => 'Html', html: () => '<b>hi</b>' })
const TextOnly = defineMail({ name: 'textonly', subject: () => 'Text', text: () => 'plain body' })
const Bare = defineMail({ name: 'bare', subject: () => 'Bare' }) // no html, no text
const Boom = defineMail({
  name: 'boom',
  // Throws a non-Error value → renderOne must wrap it in a real Error.
  subject: () => {
    throw 'kaboom'
  },
})
const Welcome = defineMail({
  name: 'welcome',
  schema: z.object({ name: z.string() }),
  subject: ({ name }) => `Hi ${name}`,
  html: ({ name }) => `<h1>${name}</h1>`,
})

const previews: MailPreview[] = [
  definePreview({ mail: HtmlOnly }),
  definePreview({ mail: TextOnly }),
  definePreview({ mail: Bare }),
  definePreview({ mail: Boom }),
  // Invalid sample data → resolve throws a MailValidationError (a real Error).
  { mail: Welcome, data: { name: 123 } as never },
]

const mailer = () => new Mailer(new MemoryMailDriver(), { from: 'preview@basalt.test' })
const q = (s: string) => new URLSearchParams(s)

describe('renderPreviewResponse — raw bodies', () => {
  it('falls back to "(no text body)" for a mail without a text body', () => {
    const r = renderPreviewResponse(previews, mailer(), '/raw/htmlonly/text')
    expect(r.body).toBe('(no text body)')
  })

  it('falls back to "(no html body)" when neither html nor text exist', () => {
    const r = renderPreviewResponse(previews, mailer(), '/raw/bare/html')
    expect(r.body).toContain('<pre>(no html body)</pre>')
  })

  it('wraps a text-only mail in a <pre> for the html view', () => {
    const r = renderPreviewResponse(previews, mailer(), '/raw/textonly/html')
    expect(r.body).toContain('<pre>plain body</pre>')
  })

  it('wraps a thrown non-Error in an error card', () => {
    const r = renderPreviewResponse(previews, mailer(), '/raw/boom/html')
    expect(r.status).toBe(200)
    expect(r.body).toContain('Could not render')
    expect(r.body).toContain('kaboom')
  })
})

describe('renderPreviewResponse — shell routing', () => {
  it('treats an empty pathname like "/"', () => {
    const r = renderPreviewResponse(previews, mailer(), '')
    expect(r.status).toBe(200)
    expect(r.contentType).toContain('text/html')
  })

  it('404s an unknown non-raw path', () => {
    const r = renderPreviewResponse(previews, mailer(), '/nonsense')
    expect(r.status).toBe(404)
    expect(r.body).toBe('Not found')
  })

  it('renders empty states when there are no previews', () => {
    const r = renderPreviewResponse([], mailer(), '/')
    expect(r.body).toContain('No mails.') // sidebar
    expect(r.body).toContain('No mails registered.') // pane
  })

  it('shows "⚠ render error" in the pane when the selected mail cannot render', () => {
    const r = renderPreviewResponse(previews, mailer(), '/', q('mail=welcome'))
    expect(r.body).toContain('⚠ render error')
  })

  it('renders the text view with a text iframe', () => {
    const r = renderPreviewResponse(previews, mailer(), '/', q('mail=htmlonly&view=text'))
    expect(r.body).toContain('/raw/htmlonly/text')
  })

  it('renders an error card in the meta view when render fails', () => {
    const r = renderPreviewResponse(previews, mailer(), '/', q('mail=welcome&view=meta'))
    expect(r.body).toContain('Could not render')
  })

  it('reports "Has text: no" in meta for an html-only mail', () => {
    const r = renderPreviewResponse(previews, mailer(), '/', q('mail=htmlonly&view=meta'))
    expect(r.body).toContain('Has text')
    expect(r.body).toContain('Has HTML')
  })

  it('reports "Has HTML: no" in meta for a text-only mail', () => {
    const r = renderPreviewResponse(previews, mailer(), '/', q('mail=textonly&view=meta'))
    expect(r.body).toContain('Has HTML')
  })
})

describe('createMailPreviewServer', () => {
  it('uses the default from address and no layout', async () => {
    const server = createMailPreviewServer(previews)
    const { url, port } = await server.listen(0)
    expect(port).toBeGreaterThan(0)
    const res = await fetch(`${url}/`)
    expect(res.status).toBe(200)
    await server.close()
  })

  it('applies a configured layout to raw html', async () => {
    const server = createMailPreviewServer(previews, { layout: (html) => `<x>${html}</x>` })
    const { url } = await server.listen(0)
    const res = await fetch(`${url}/raw/htmlonly/html`)
    expect(await res.text()).toBe('<x><b>hi</b></x>')
    await server.close()
  })

  it('rejects close() when the server was never listening', async () => {
    const server = createMailPreviewServer(previews)
    await expect(server.close()).rejects.toBeInstanceOf(Error)
  })

  it('handles a request whose url is undefined (defaults to "/")', () => {
    const server = createMailPreviewServer(previews)
    const listener = server.server.listeners('request')[0] as (req: unknown, res: unknown) => void
    let status = 0
    let body = ''
    const res = {
      writeHead(code: number) {
        status = code
      },
      end(chunk: string) {
        body = chunk
      },
    }
    listener({ url: undefined }, res)
    expect(status).toBe(200)
    expect(body).toContain('mail preview')
  })
})
