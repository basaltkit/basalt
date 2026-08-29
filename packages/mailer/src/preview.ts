import { escapeHtml } from './html.js'
import { createServer, type Server } from 'node:http'
import { Mailer, type MailerOptions } from './index.js'
import { MemoryMailDriver } from './drivers/memory.js'
import type { MailDefinition, ResolvedMail } from './message.js'

/**
 * A previewable mail: a definition plus the sample data used to render it.
 * `data` is omitted for zero-argument mails.
 */
export interface MailPreview<T = unknown> {
  mail: MailDefinition<T>
  /** Sample data fed to the mail when rendering the preview. */
  data?: T
  /** Optional human label for the sidebar (defaults to the mail name). */
  label?: string
}

/** Identity helper that keeps `data` type-checked against the mail's schema. */
export function definePreview<T>(preview: MailPreview<T>): MailPreview<T> {
  return preview
}

export interface MailPreviewOptions {
  /** From address stamped on every preview. Default: `preview@basalt.test`. */
  from?: string
  /** Shared HTML layout, exactly as configured on the real mailer. */
  layout?: MailerOptions['layout']
}

/** What the pure router returns — trivially assertable without a socket. */
export interface PreviewResponse {
  status: number
  contentType: string
  body: string
}


const nameOf = (p: MailPreview): string => p.mail.name

/** Renders one preview to a resolved message, or an Error if its data is invalid. */
function renderOne(mailer: Mailer, preview: MailPreview): ResolvedMail | Error {
  try {
    return mailer.resolve(preview.mail as MailDefinition<unknown>, preview.data, {
      to: 'preview@localhost',
    })
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
}

/**
 * Pure request router for the preview UI. `createMailPreviewServer` is a thin
 * `node:http` wrapper over this — keep the logic here so it stays testable.
 *
 * - `/`                     → the app shell (sidebar + preview pane)
 * - `/raw/<name>/html`      → the layout-wrapped HTML body (for the `iframe`)
 * - `/raw/<name>/text`      → the plaintext body
 */
export function renderPreviewResponse(
  previews: MailPreview[],
  mailer: Mailer,
  pathname: string,
  query: URLSearchParams = new URLSearchParams(),
): PreviewResponse {
  const raw = pathname.match(/^\/raw\/([^/]+)\/(html|text)$/)
  if (raw) {
    const preview = previews.find((p) => nameOf(p) === decodeURIComponent(raw[1]!))
    if (!preview) return { status: 404, contentType: 'text/plain', body: 'Unknown mail' }
    const resolved = renderOne(mailer, preview)
    if (resolved instanceof Error) {
      return { status: 200, contentType: 'text/html; charset=utf-8', body: errorCard(resolved) }
    }
    if (raw[2] === 'text') {
      return { status: 200, contentType: 'text/plain; charset=utf-8', body: resolved.text ?? '(no text body)' }
    }
    return {
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: resolved.html ?? `<pre>${escapeHtml(resolved.text ?? '(no html body)')}</pre>`,
    }
  }

  if (pathname === '/' || pathname === '') {
    return {
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: renderShell(previews, mailer, query.get('mail'), query.get('view') ?? 'html'),
    }
  }

  return { status: 404, contentType: 'text/plain', body: 'Not found' }
}

function errorCard(error: Error): string {
  return `<div style="font-family:system-ui;padding:24px;color:#b91c1c">
    <strong>Could not render this mail</strong>
    <pre style="white-space:pre-wrap;margin-top:8px">${escapeHtml(error.message)}</pre>
  </div>`
}

function renderShell(
  previews: MailPreview[],
  mailer: Mailer,
  selectedName: string | null,
  view: string,
): string {
  const selected = previews.find((p) => nameOf(p) === selectedName) ?? previews[0]
  const items = previews
    .map((p) => {
      const name = nameOf(p)
      const active = selected && name === nameOf(selected)
      return `<a class="item${active ? ' active' : ''}" href="/?mail=${encodeURIComponent(name)}&view=${escapeHtml(view)}">
        <span class="dot"></span>${escapeHtml(p.label ?? name)}
      </a>`
    })
    .join('')

  const pane = selected ? renderPane(mailer, selected, view) : '<p class="empty">No mails registered.</p>'

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Basalt · Mail preview</title>
<style>
  :root { color-scheme: light dark; --bg:#fafaf9; --panel:#fff; --line:#e7e5e4; --ink:#1c1917; --muted:#78716c; --accent:#c2410c; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0c0a09; --panel:#1c1917; --line:#292524; --ink:#f5f5f4; --muted:#a8a29e; --accent:#fb923c; } }
  * { box-sizing: border-box; }
  body { margin:0; font-family: ui-sans-serif, system-ui, sans-serif; background:var(--bg); color:var(--ink); display:grid; grid-template-columns: 260px 1fr; height:100vh; }
  aside { border-right:1px solid var(--line); padding:16px 12px; overflow-y:auto; background:var(--panel); }
  .brand { font-weight:700; letter-spacing:-.02em; padding:4px 8px 14px; display:flex; align-items:center; gap:8px; }
  .brand small { color:var(--muted); font-weight:500; }
  .item { display:flex; align-items:center; gap:8px; padding:8px 10px; border-radius:8px; text-decoration:none; color:var(--ink); font-size:14px; }
  .item:hover { background:var(--bg); }
  .item.active { background:color-mix(in srgb, var(--accent) 14%, transparent); color:var(--accent); font-weight:600; }
  .dot { width:6px; height:6px; border-radius:50%; background:currentColor; opacity:.5; }
  main { display:flex; flex-direction:column; min-width:0; }
  header { padding:16px 24px; border-bottom:1px solid var(--line); display:flex; align-items:baseline; gap:16px; }
  header h1 { font-size:16px; margin:0; }
  header .subject { color:var(--muted); font-size:14px; }
  nav { display:flex; gap:4px; padding:10px 24px 0; }
  nav a { padding:6px 12px; border-radius:8px 8px 0 0; text-decoration:none; color:var(--muted); font-size:13px; border:1px solid transparent; border-bottom:none; }
  nav a.on { color:var(--ink); background:var(--panel); border-color:var(--line); }
  .view { flex:1; margin:0 24px 24px; border:1px solid var(--line); border-radius:0 8px 8px 8px; background:var(--panel); overflow:hidden; min-height:0; }
  iframe { width:100%; height:100%; border:0; background:#fff; }
  pre.text { margin:0; padding:20px; white-space:pre-wrap; font:13px/1.5 ui-monospace, monospace; overflow:auto; height:100%; }
  table.meta { width:100%; border-collapse:collapse; font-size:14px; }
  table.meta td { padding:10px 20px; border-bottom:1px solid var(--line); vertical-align:top; }
  table.meta td:first-child { color:var(--muted); width:120px; }
  .empty { padding:40px; color:var(--muted); }
</style></head><body>
<aside>
  <div class="brand">Basalt <small>mail preview</small></div>
  ${items || '<p class="empty">No mails.</p>'}
</aside>
<main>${pane}</main>
</body></html>`
}

function renderPane(mailer: Mailer, preview: MailPreview, view: string): string {
  const name = nameOf(preview)
  const resolved = renderOne(mailer, preview)
  const subject = resolved instanceof Error ? '⚠ render error' : resolved.subject
  const tab = (id: string, label: string) =>
    `<a class="${view === id ? 'on' : ''}" href="/?mail=${encodeURIComponent(name)}&view=${id}">${label}</a>`

  let body: string
  if (view === 'text') {
    body = `<iframe src="/raw/${encodeURIComponent(name)}/text"></iframe>`
  } else if (view === 'meta') {
    body =
      resolved instanceof Error
        ? errorCard(resolved)
        : `<table class="meta">
            <tr><td>Mail</td><td>${escapeHtml(resolved.mail)}</td></tr>
            <tr><td>Subject</td><td>${escapeHtml(resolved.subject)}</td></tr>
            <tr><td>From</td><td>${escapeHtml(resolved.from)}</td></tr>
            <tr><td>To</td><td>${escapeHtml(resolved.to.join(', '))}</td></tr>
            <tr><td>Has HTML</td><td>${resolved.html ? 'yes' : 'no'}</td></tr>
            <tr><td>Has text</td><td>${resolved.text ? 'yes' : 'no'}</td></tr>
          </table>`
  } else {
    body = `<iframe src="/raw/${encodeURIComponent(name)}/html"></iframe>`
  }

  return `<header><h1>${escapeHtml(preview.label ?? name)}</h1><span class="subject">${escapeHtml(subject)}</span></header>
    <nav>${tab('html', 'HTML')}${tab('text', 'Text')}${tab('meta', 'Meta')}</nav>
    <div class="view">${body}</div>`
}

export interface MailPreviewServer {
  /** Starts listening. Resolves with the bound URL and port. */
  listen(port?: number, host?: string): Promise<{ url: string; port: number }>
  /** Stops the server. */
  close(): Promise<void>
  /** The underlying node http.Server (for advanced wiring/tests). */
  readonly server: Server
}

/**
 * A zero-dependency dev server that renders registered mails in the browser —
 * the runtime behind `basalt mail preview`. Reuses the mailer's own `resolve`
 * (schema + layout), so what you see is what a driver would send.
 */
export function createMailPreviewServer(
  previews: MailPreview[],
  options: MailPreviewOptions = {},
): MailPreviewServer {
  const mailer = new Mailer(new MemoryMailDriver(), {
    from: options.from ?? 'preview@basalt.test',
    ...(options.layout ? { layout: options.layout } : {}),
  })

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const { status, contentType, body } = renderPreviewResponse(
      previews,
      mailer,
      url.pathname,
      url.searchParams,
    )
    res.writeHead(status, { 'content-type': contentType })
    res.end(body)
  })

  return {
    server,
    listen(port = 3737, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => {
          const address = server.address()
          const bound = typeof address === 'object' && address ? address.port : port
          resolve({ url: `http://${host}:${bound}`, port: bound })
        })
      })
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      })
    },
  }
}
