export interface TeamsPageOptions {
  /** Base path where the team JSON routes are mounted. Default '' (same origin). */
  apiBase?: string
  title?: string
  /** Roles offered in the dropdowns. Default owner/admin/member. */
  roles?: string[]
  /** Extra headers sent with every request (e.g. `{ 'x-tenant-id': '…' }` for
   *  header-based tenancy). Subdomain apps can leave this empty. */
  headers?: Record<string, string>
}

/**
 * A self-contained HTML page (no dependencies, no build) to manage a team via
 * `@machize/teams`' routes: list/invite/revoke invitations and list/change-role/
 * remove members. Serve it from a route (see `teamsUiRoutes`). Assumes the
 * browser session is authenticated (as an admin) for those routes.
 */
export function teamsPageHtml(options: TeamsPageOptions = {}): string {
  const apiBase = options.apiBase ?? ''
  const title = options.title ?? 'Team'
  const roles = options.roles ?? ['owner', 'admin', 'member']
  const headers = options.headers ?? {}
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
  :root { color-scheme: light dark; --bd: #8884; --accent: #4f46e5; --danger: #dc2626; }
  body { font: 14px/1.5 system-ui, sans-serif; margin: 0; padding: 2rem 1.5rem; max-width: 820px; margin-inline: auto; }
  h1 { font-size: 1.4rem; margin: 0 0 .5rem; }
  h2 { font-size: 1rem; margin: 1.5rem 0 .75rem; opacity: .8; }
  .card { border: 1px solid var(--bd); border-radius: 10px; padding: 1rem 1.25rem; margin-bottom: 1rem; }
  form { display: flex; gap: .5rem; flex-wrap: wrap; align-items: end; }
  label { display: flex; flex-direction: column; gap: .25rem; font-size: .8rem; opacity: .8; }
  input, select { padding: .45rem .6rem; border: 1px solid var(--bd); border-radius: 7px; background: transparent; color: inherit; }
  button { padding: .45rem .9rem; border: 1px solid var(--bd); border-radius: 7px; cursor: pointer; background: transparent; color: inherit; font: inherit; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  button.link { border: none; color: var(--danger); padding: .2rem .4rem; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: .55rem .5rem; border-bottom: 1px solid var(--bd); }
  th { font-size: .75rem; text-transform: uppercase; letter-spacing: .04em; opacity: .6; }
  .muted { opacity: .55; }
  .empty { padding: 1rem; text-align: center; }
</style>
</head>
<body>
<h1>${title}</h1>

<h2>Invite a member</h2>
<div class="card">
  <form id="invite">
    <label>Email<input name="email" type="email" placeholder="teammate@acme.test" required /></label>
    <label>Role<select name="role">${roles.map((r) => `<option>${r}</option>`).join('')}</select></label>
    <button class="primary" type="submit">Send invite</button>
  </form>
</div>

<h2>Pending invitations</h2>
<table><thead><tr><th>Email</th><th>Role</th><th>Expires</th><th></th></tr></thead><tbody id="invites"></tbody></table>

<h2>Members</h2>
<table><thead><tr><th>User</th><th>Role</th><th></th></tr></thead><tbody id="members"></tbody></table>

<script>
const API = ${JSON.stringify(apiBase)};
const ROLES = ${JSON.stringify(roles)};
const HEADERS = ${JSON.stringify(headers)};
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const opts = (extra) => ({ credentials: 'same-origin', headers: { 'content-type': 'application/json', ...HEADERS }, ...extra });
const roleSelect = (id, current) => '<select data-user="' + esc(id) + '">' +
  ROLES.map((r) => '<option' + (r === current ? ' selected' : '') + '>' + esc(r) + '</option>').join('') + '</select>';

async function loadInvites() {
  const invites = await fetch(API + '/team/invites', opts()).then((r) => r.ok ? r.json() : []);
  const tb = document.getElementById('invites');
  tb.innerHTML = (invites.length ? invites : []).map((i) =>
    '<tr><td>' + esc(i.email) + '</td><td>' + esc(i.role) + '</td>' +
    '<td class="muted">' + (i.expiresAt ? new Date(i.expiresAt).toLocaleDateString() : '') + '</td>' +
    '<td><button class="link" data-revoke="' + esc(i.id) + '">Revoke</button></td></tr>').join('') ||
    '<tr><td colspan="4" class="empty muted">No pending invitations.</td></tr>';
  for (const b of tb.querySelectorAll('[data-revoke]')) b.addEventListener('click', async () => {
    await fetch(API + '/team/invites/' + b.dataset.revoke, opts({ method: 'DELETE' })); loadInvites();
  });
}

async function loadMembers() {
  const members = await fetch(API + '/team/members', opts()).then((r) => r.ok ? r.json() : []);
  const tb = document.getElementById('members');
  tb.innerHTML = (members.length ? members : []).map((m) =>
    '<tr><td><code>' + esc(m.userId) + '</code></td><td>' + roleSelect(m.userId, m.role) + '</td>' +
    '<td><button class="link" data-remove="' + esc(m.userId) + '">Remove</button></td></tr>').join('') ||
    '<tr><td colspan="3" class="empty muted">No members yet.</td></tr>';
  for (const s of tb.querySelectorAll('select[data-user]')) s.addEventListener('change', async () => {
    await fetch(API + '/team/members/' + s.dataset.user, opts({ method: 'PATCH', body: JSON.stringify({ role: s.value }) }));
  });
  for (const b of tb.querySelectorAll('[data-remove]')) b.addEventListener('click', async () => {
    if (!confirm('Remove this member?')) return;
    await fetch(API + '/team/members/' + b.dataset.remove, opts({ method: 'DELETE' })); loadMembers();
  });
}

document.getElementById('invite').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  await fetch(API + '/team/invites', opts({ method: 'POST', body: JSON.stringify({ email: f.get('email'), role: f.get('role') }) }));
  e.target.reset(); loadInvites();
});

loadInvites(); loadMembers();
</script>
</body>
</html>`
}
