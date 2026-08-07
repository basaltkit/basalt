export interface BillingPageOptions {
  /** Base path where the billing JSON routes are mounted. Default '' (same origin). */
  apiBase?: string
  title?: string
  /** Extra headers sent with every request (e.g. `{ 'x-tenant-id': '…' }`). */
  headers?: Record<string, string>
}

/**
 * A self-contained HTML page (no dependencies, no build) showing the current
 * subscription and the available plans, with Subscribe / Switch (hosted
 * Checkout) and Manage-billing (Customer Portal) actions. It reads
 * `GET {apiBase}/billing/info` and posts to `/billing/checkout` and
 * `/billing/portal` (see `billingUiRoutes` and `@machize/subscriptions`'
 * `billingRoutes`). Assumes an authenticated browser session.
 */
export function billingPageHtml(options: BillingPageOptions = {}): string {
  const apiBase = options.apiBase ?? ''
  const title = options.title ?? 'Billing'
  const headers = options.headers ?? {}
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
  :root { color-scheme: light dark; --bd: #8884; --accent: #4f46e5; --ok: #16a34a; }
  body { font: 14px/1.5 system-ui, sans-serif; margin: 0; padding: 2rem 1.5rem; max-width: 900px; margin-inline: auto; }
  h1 { font-size: 1.4rem; margin: 0 0 1rem; }
  .status { border: 1px solid var(--bd); border-radius: 10px; padding: 1rem 1.25rem; margin-bottom: 1.5rem; display: flex; justify-content: space-between; align-items: center; gap: 1rem; flex-wrap: wrap; }
  .plans { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 1rem; }
  .plan { border: 1px solid var(--bd); border-radius: 10px; padding: 1.1rem; display: flex; flex-direction: column; gap: .5rem; }
  .plan.current { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
  .plan h3 { margin: 0; font-size: 1.05rem; text-transform: capitalize; }
  .price { font-size: 1.5rem; font-weight: 600; }
  .price small { font-size: .8rem; font-weight: 400; opacity: .6; }
  ul { margin: .25rem 0; padding-left: 1.1rem; opacity: .8; }
  button { padding: .5rem .9rem; border: 1px solid var(--bd); border-radius: 8px; cursor: pointer; background: transparent; color: inherit; font: inherit; margin-top: auto; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  .badge { font-size: .75rem; padding: .1rem .5rem; border-radius: 99px; border: 1px solid var(--bd); }
  .badge.ok { color: var(--ok); border-color: var(--ok); }
  .muted { opacity: .6; }
</style>
</head>
<body>
<h1>${title}</h1>
<div class="status" id="status"><span class="muted">Loading…</span></div>
<div class="plans" id="plans"></div>

<script>
const API = ${JSON.stringify(apiBase)};
const HEADERS = ${JSON.stringify(headers)};
const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const opts = (extra) => ({ credentials: 'same-origin', headers: { 'content-type': 'application/json', ...HEADERS }, ...extra });

function priceLabel(price) {
  if (price === 'custom') return 'Custom';
  const monthly = typeof price === 'object' ? price.monthly : price;
  if (!monthly) return 'Free';
  return '$' + monthly + '<small>/mo</small>';
}

async function redirect(path, body) {
  const res = await fetch(API + path, opts({ method: 'POST', body: JSON.stringify(body || {}) })).then((r) => r.json());
  if (res && res.url) window.location.href = res.url;
}

async function load() {
  const info = await fetch(API + '/billing/info', opts()).then((r) => r.json());
  const sub = info.subscription;
  const status = document.getElementById('status');
  if (sub) {
    status.innerHTML = '<div><b style="text-transform:capitalize">' + esc(sub.plan) + '</b> · <span class="badge ok">' +
      esc(sub.status) + '</span>' + (sub.trialEndsAt ? ' <span class="muted">trial ends ' + new Date(sub.trialEndsAt).toLocaleDateString() + '</span>' : '') +
      '</div><button id="portal">Manage billing</button>';
    document.getElementById('portal').addEventListener('click', () => redirect('/billing/portal'));
  } else {
    status.innerHTML = '<span class="muted">No active subscription — pick a plan below.</span>';
  }

  document.getElementById('plans').innerHTML = (info.plans || []).map((p) => {
    const current = sub && sub.plan === p.name;
    return '<div class="plan' + (current ? ' current' : '') + '">' +
      '<h3>' + esc(p.name) + (current ? ' <span class="badge ok">current</span>' : '') + '</h3>' +
      '<div class="price">' + priceLabel(p.price) + '</div>' +
      (p.trial ? '<div class="muted">' + esc(p.trial) + ' free trial</div>' : '') +
      '<ul>' + (p.features || []).map((f) => '<li>' + esc(f) + '</li>').join('') + '</ul>' +
      (current ? '' : '<button class="primary" data-plan="' + esc(p.name) + '">' + (sub ? 'Switch' : 'Subscribe') + '</button>') +
      '</div>';
  }).join('');

  for (const b of document.querySelectorAll('[data-plan]')) {
    b.addEventListener('click', () => redirect('/billing/checkout', { plan: b.dataset.plan }));
  }
}
load();
</script>
</body>
</html>`
}
