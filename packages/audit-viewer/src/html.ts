export interface AuditViewerHtmlOptions {
  /** Base path where the audit JSON API is mounted. Default '' (same origin). */
  apiBase?: string
  title?: string
}

/**
 * A self-contained HTML page (no dependencies, no build) that browses the audit
 * trail by calling `GET {apiBase}/audit` and `/audit/stats`. Serve it from a
 * route (see `auditViewerRoutes`).
 */
export function auditViewerHtml(options: AuditViewerHtmlOptions = {}): string {
  const apiBase = options.apiBase ?? ''
  const title = options.title ?? 'Audit trail'
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
  :root { color-scheme: light dark; --bd: #8883; }
  body { font: 14px/1.5 system-ui, sans-serif; margin: 0; padding: 1.5rem; max-width: 1100px; margin-inline: auto; }
  h1 { font-size: 1.3rem; margin: 0 0 1rem; }
  form { display: flex; gap: .5rem; flex-wrap: wrap; margin-bottom: 1rem; }
  input, select { padding: .35rem .5rem; border: 1px solid var(--bd); border-radius: 6px; background: transparent; color: inherit; }
  button { padding: .35rem .8rem; border: 1px solid var(--bd); border-radius: 6px; cursor: pointer; background: transparent; color: inherit; }
  #stats { display: flex; gap: 1.5rem; flex-wrap: wrap; margin-bottom: 1rem; opacity: .85; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid var(--bd); vertical-align: top; }
  th { position: sticky; top: 0; }
  code { font-family: ui-monospace, monospace; }
  .muted { opacity: .6; }
  .nav { display: flex; gap: .5rem; align-items: center; margin-top: 1rem; }
</style>
</head>
<body>
<h1>${title}</h1>
<form id="filters">
  <input name="event" placeholder="event (auth:**)" />
  <input name="actorId" placeholder="actor id" />
  <select name="source"><option value="">any source</option><option>hook</option><option>event</option><option>manual</option></select>
  <button type="submit">Filter</button>
</form>
<div id="stats"></div>
<table><thead><tr><th>When</th><th>Event</th><th>Source</th><th>Actor</th></tr></thead><tbody id="rows"></tbody></table>
<div class="nav"><button id="prev">Prev</button><span id="page" class="muted"></span><button id="next">Next</button></div>
<script>
const API = ${JSON.stringify(apiBase)};
let offset = 0; const LIMIT = 50;
const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
function params() {
  const f = new FormData(document.getElementById('filters'));
  const q = new URLSearchParams();
  for (const [k, v] of f) if (v) q.set(k, v);
  q.set('limit', LIMIT); q.set('offset', offset);
  return q.toString();
}
async function load() {
  const [page, stats] = await Promise.all([
    fetch(API + '/audit?' + params()).then((r) => r.json()),
    fetch(API + '/audit/stats?' + params()).then((r) => r.json()),
  ]);
  document.getElementById('rows').innerHTML = (page.entries || []).map((e) =>
    '<tr><td class="muted">' + new Date(e.at).toLocaleString() + '</td><td><code>' + esc(e.event) +
    '</code></td><td>' + esc(e.source) + '</td><td>' + esc(e.actorId || '') + '</td></tr>').join('');
  const top = (stats.byEvent || []).slice(0, 3).map((x) => esc(x.event) + ' (' + x.count + ')').join(', ');
  document.getElementById('stats').innerHTML = '<span><b>' + (stats.total || 0) + '</b> entries</span>' + (top ? '<span>Top: ' + top + '</span>' : '');
  document.getElementById('page').textContent = 'showing ' + offset + '–' + (offset + (page.entries || []).length) + ' of ' + (page.total || 0);
}
document.getElementById('filters').addEventListener('submit', (e) => { e.preventDefault(); offset = 0; load(); });
document.getElementById('next').addEventListener('click', () => { offset += LIMIT; load(); });
document.getElementById('prev').addEventListener('click', () => { offset = Math.max(0, offset - LIMIT); load(); });
load();
</script>
</body>
</html>`
}
