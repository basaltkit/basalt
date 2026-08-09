export interface ApiKeysPageOptions {
  /** Base path where the API-key JSON routes are mounted. Default '' (same origin). */
  apiBase?: string
  title?: string
}

/**
 * A self-contained HTML page (no dependencies, no build) to manage API keys by
 * calling `@basaltkit/auth`'s routes: `GET/POST /apikeys` and `DELETE /apikeys/:id`.
 * Serve it from a route (see `apiKeysUiRoutes`). The page assumes the browser is
 * already authenticated (session cookie) for those routes.
 */
export function apiKeysPageHtml(options: ApiKeysPageOptions = {}): string {
  const apiBase = options.apiBase ?? ''
  const title = options.title ?? 'API keys'
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
  :root { color-scheme: light dark; --bd: #8884; --accent: #4f46e5; --danger: #dc2626; --ok: #16a34a; }
  body { font: 14px/1.5 system-ui, sans-serif; margin: 0; padding: 2rem 1.5rem; max-width: 820px; margin-inline: auto; }
  h1 { font-size: 1.4rem; margin: 0 0 1.25rem; }
  .card { border: 1px solid var(--bd); border-radius: 10px; padding: 1rem 1.25rem; margin-bottom: 1.25rem; }
  form { display: flex; gap: .5rem; flex-wrap: wrap; align-items: end; }
  label { display: flex; flex-direction: column; gap: .25rem; font-size: .8rem; opacity: .8; }
  input { padding: .45rem .6rem; border: 1px solid var(--bd); border-radius: 7px; background: transparent; color: inherit; min-width: 12rem; }
  button { padding: .45rem .9rem; border: 1px solid var(--bd); border-radius: 7px; cursor: pointer; background: transparent; color: inherit; font: inherit; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  button.link { border: none; color: var(--danger); padding: .2rem .4rem; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: .55rem .5rem; border-bottom: 1px solid var(--bd); }
  th { font-size: .75rem; text-transform: uppercase; letter-spacing: .04em; opacity: .6; }
  code { font-family: ui-monospace, monospace; }
  .muted { opacity: .55; }
  .reveal { border: 1px solid var(--ok); background: #16a34a18; border-radius: 8px; padding: .75rem 1rem; margin-top: .75rem; display: none; }
  .reveal code { word-break: break-all; }
  .empty { padding: 1rem; text-align: center; }
</style>
</head>
<body>
<h1>${title}</h1>

<div class="card">
  <form id="create">
    <label>Name<input name="name" placeholder="CI pipeline" required /></label>
    <label>Scopes (comma-separated)<input name="scopes" placeholder="read, write" /></label>
    <button class="primary" type="submit">Create key</button>
  </form>
  <div class="reveal" id="reveal">
    <div>Copy your new key now — it won't be shown again:</div>
    <div style="margin-top:.4rem;display:flex;gap:.5rem;align-items:center">
      <code id="newkey"></code><button id="copy" type="button">Copy</button>
    </div>
  </div>
</div>

<table>
  <thead><tr><th>Prefix</th><th>Scopes</th><th>Last used</th><th></th></tr></thead>
  <tbody id="rows"></tbody>
</table>

<script>
const API = ${JSON.stringify(apiBase)};
const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const opts = { credentials: 'same-origin', headers: { 'content-type': 'application/json' } };

async function list() {
  const keys = await fetch(API + '/apikeys', opts).then((r) => r.json());
  const rows = document.getElementById('rows');
  if (!Array.isArray(keys) || keys.length === 0) {
    rows.innerHTML = '<tr><td colspan="4" class="empty muted">No API keys yet.</td></tr>';
    return;
  }
  rows.innerHTML = keys.map((k) =>
    '<tr><td><code>' + esc(k.prefix) + '…</code></td>' +
    '<td>' + esc((k.scopes || []).join(', ')) + '</td>' +
    '<td class="muted">' + (k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : 'never') + '</td>' +
    '<td><button class="link" data-id="' + esc(k.id) + '">Revoke</button></td></tr>').join('');
  for (const b of rows.querySelectorAll('button[data-id]')) {
    b.addEventListener('click', async () => {
      if (!confirm('Revoke this key? Any client using it will stop working.')) return;
      await fetch(API + '/apikeys/' + b.dataset.id, { ...opts, method: 'DELETE' });
      list();
    });
  }
}

document.getElementById('create').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const scopes = String(f.get('scopes') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const body = JSON.stringify({ name: f.get('name'), ...(scopes.length ? { scopes } : {}) });
  const created = await fetch(API + '/apikeys', { ...opts, method: 'POST', body }).then((r) => r.json());
  if (created && created.key) {
    document.getElementById('newkey').textContent = created.key;
    document.getElementById('reveal').style.display = 'block';
  }
  e.target.reset();
  list();
});

document.getElementById('copy').addEventListener('click', () => {
  navigator.clipboard && navigator.clipboard.writeText(document.getElementById('newkey').textContent);
});

list();
</script>
</body>
</html>`
}
