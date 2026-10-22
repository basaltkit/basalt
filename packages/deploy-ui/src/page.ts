/**
 * The page and its stylesheet, as strings (the way the `*-ui` packages ship
 * markup): no inline script, no inline style — the CSP allows neither. The
 * one module script is `/client/main.js`, compiled by tsc from `src/client`.
 */

export const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light dark">
<title>Basalt deploy</title>
<link rel="stylesheet" href="/app.css">
<script type="module" src="/client/main.js"></script>
</head>
<body>
<div class="shell">
<aside class="sidebar">
  <h1 class="brand">
    <svg class="brand-mark" viewBox="40 40 120 120" width="28" height="28" aria-hidden="true" focusable="false">
      <g stroke="#0B0E13" stroke-width="3" stroke-linejoin="round">
        <polygon points="52.37,72.5 100,45 147.63,72.5 100,100" fill="#8B9AA7"/>
        <polygon points="52.37,72.5 100,100 100,155 52.37,127.5" fill="#2C3843"/>
        <polygon points="100,100 147.63,72.5 147.63,127.5 100,155" fill="#FF5A1F"/>
      </g>
      <line x1="100" y1="100" x2="100" y2="155" stroke="#FFB347" stroke-width="4" stroke-linecap="round"/>
    </svg>
    <span class="brand-text"><span class="brand-name">Basalt</span> <span class="brand-sub">Deploy</span></span>
  </h1>
  <nav id="nav" class="nav" aria-label="Screens"></nav>
  <div class="sidebar-foot">
    <p class="local-note" title="Local only: this page talks to 127.0.0.1, which talks to your servers over your own ssh.">
      <svg class="icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4"/></svg>
      <span><span class="local-label">Local only</span> <span aria-hidden="true">·</span> <span class="mono">127.0.0.1</span></span>
    </p>
    <div id="session" class="session"></div>
  </div>
</aside>
<div class="main-col">
  <div id="target-bar" class="target-bar" aria-live="polite"></div>
  <main id="app" class="app">
    <p class="muted">Starting…</p>
    <noscript><p>This UI needs JavaScript (its own module only; nothing is loaded from elsewhere).</p></noscript>
  </main>
</div>
</div>
</body>
</html>
`

export const APP_CSS = `/* Basalt deploy: an operations console. Graphite neutrals, one molten accent used sparingly. */
:root {
  color-scheme: light dark;
  --font-sans: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  --fs-xs: 11px; --fs-sm: 12px; --fs-md: 13px; --fs-base: 14px; --fs-lg: 16px; --fs-xl: 20px;
  --sp-1: 4px; --sp-2: 8px; --sp-3: 12px; --sp-4: 16px; --sp-5: 24px; --sp-6: 32px; --sp-7: 48px;
  --radius: 8px; --radius-sm: 6px; --radius-xs: 4px;
  --control-h: 32px;
  --sidebar-w: 240px;

  --bg: #f5f6f8;
  --surface: #ffffff;
  --surface-2: #f9fafb;
  --surface-3: #f0f2f5;
  --border: #e2e6eb;
  --border-strong: #cdd3da;
  --text: #0f141a;
  --text-2: #2c3843;
  --muted: #5b6672;
  --faint: #8a949f;

  --molten: #ff5a1f;
  --accent-text: #b93a0a;
  --accent-soft: #fff1ea;
  --primary-bg: #c93f0b;
  --primary-bg-hover: #b23708;
  --primary-fg: #ffffff;

  --ok: #157f3b; --ok-soft: #e8f5ec; --ok-line: #b7dfc4;
  --warn: #9a6200; --warn-soft: #fdf4e1; --warn-line: #f0d39a;
  --err: #c4271d; --err-soft: #fdecea; --err-line: #f3bdb8;
  --info: #44546a; --info-soft: #eef1f5; --info-line: #cfd7e1;
  --protected-bg: #b42318; --protected-fg: #ffffff;

  --term-bg: #0d1117; --term-border: #0d1117; --term-fg: #c9d1d9; --term-muted: #8b949e; --term-ts: #7d8590;
  --term-warn: #e3b341; --term-err: #ff7b72; --term-ok: #56d364; --term-warn-bg: rgb(227 179 65 / 0.08); --term-err-bg: rgb(255 123 114 / 0.10);

  --shadow-sm: 0 1px 2px rgb(15 20 26 / 0.05);
  --shadow-md: 0 1px 2px rgb(15 20 26 / 0.06), 0 4px 12px rgb(15 20 26 / 0.06);
  --shadow-lg: 0 2px 6px rgb(15 20 26 / 0.08), 0 24px 48px rgb(15 20 26 / 0.18);
  --focus: 0 0 0 2px var(--surface), 0 0 0 4px var(--molten);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0b0e13;
    --surface: #121820;
    --surface-2: #0f141b;
    --surface-3: #18202a;
    --border: #232c36;
    --border-strong: #2f3a46;
    --text: #e6eaef;
    --text-2: #c3cad3;
    --muted: #95a1ae;
    --faint: #6b7784;

    --accent-text: #ff8a5c;
    --accent-soft: rgb(255 90 31 / 0.12);
    --primary-bg: #ff5a1f;
    --primary-bg-hover: #ff7340;
    --primary-fg: #0b0e13;

    --ok: #3fcf79; --ok-soft: rgb(63 207 121 / 0.10); --ok-line: rgb(63 207 121 / 0.32);
    --warn: #f2b13d; --warn-soft: rgb(242 177 61 / 0.10); --warn-line: rgb(242 177 61 / 0.32);
    --err: #ff6b5e; --err-soft: rgb(255 107 94 / 0.10); --err-line: rgb(255 107 94 / 0.34);
    --info: #9aa8b8; --info-soft: rgb(154 168 184 / 0.10); --info-line: rgb(154 168 184 / 0.28);
    --protected-bg: #b42318; --protected-fg: #ffffff;

    --term-bg: #07090c; --term-border: #232c36;

    --shadow-sm: 0 1px 2px rgb(0 0 0 / 0.4);
    --shadow-md: 0 1px 2px rgb(0 0 0 / 0.4), 0 4px 12px rgb(0 0 0 / 0.3);
    --shadow-lg: 0 2px 6px rgb(0 0 0 / 0.5), 0 24px 48px rgb(0 0 0 / 0.55);
  }
}

/* Base */
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--text); }
body { font: var(--fs-base)/20px var(--font-sans); -webkit-font-smoothing: antialiased; font-feature-settings: "cv11", "ss01"; text-rendering: optimizeLegibility; }
h1, h2, h3, h4 { margin: 0; font-weight: 600; letter-spacing: -0.01em; color: var(--text); }
h2 { font-size: var(--fs-xl); line-height: 28px; letter-spacing: -0.015em; }
h3 { font-size: var(--fs-base); line-height: 20px; }
p { margin: 0; }
p + p { margin-top: var(--sp-2); }
a { color: var(--accent-text); }
.muted { color: var(--muted); }
.mono, code, kbd, pre { font-family: var(--font-mono); font-size: 12.5px; }
code { background: var(--surface-3); border: 1px solid var(--border); padding: 0 5px; border-radius: var(--radius-xs); overflow-wrap: anywhere; color: var(--text-2); line-height: 18px; -webkit-box-decoration-break: clone; box-decoration-break: clone; }
.num, time { font-variant-numeric: tabular-nums; }
.section-label { display: block; font-size: var(--fs-xs); line-height: 16px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); }
.hidden { display: none !important; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
::selection { background: rgb(255 90 31 / 0.22); }

/* Shell */
.shell { display: grid; grid-template-columns: var(--sidebar-w) minmax(0, 1fr); min-height: 100vh; background: linear-gradient(to right, var(--surface) calc(var(--sidebar-w) - 1px), var(--border) calc(var(--sidebar-w) - 1px) var(--sidebar-w), transparent var(--sidebar-w)); }
.sidebar { position: sticky; top: 0; height: 100vh; display: flex; flex-direction: column; gap: var(--sp-5); padding: var(--sp-4) var(--sp-3); background: var(--surface); border-right: 1px solid var(--border); overflow-y: auto; }
.brand { display: flex; align-items: center; gap: 10px; padding: var(--sp-1) var(--sp-2); font-size: var(--fs-base); }
.brand-mark { flex: none; }
.brand-text { display: flex; flex-direction: column; line-height: 1.15; }
.brand-name { font-size: 15px; font-weight: 650; letter-spacing: -0.02em; }
.brand-sub { font-size: var(--fs-xs); font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
.nav { display: flex; flex-direction: column; gap: var(--sp-5); }
.nav-target { display: grid; gap: 6px; padding: 0 var(--sp-2); }
.nav-target .section-label { padding: 0; }
.nav-list { display: flex; flex-direction: column; gap: 2px; }
.nav .nav-item { display: flex; align-items: center; gap: 10px; width: 100%; height: 34px; padding: 0 10px; border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--muted); font-weight: 500; text-align: left; justify-content: flex-start; position: relative; box-shadow: none; }
.nav .nav-item .icon { color: var(--faint); }
.nav .nav-item:hover { background: var(--surface-3); color: var(--text); border-color: transparent; }
.nav .nav-item:hover .icon { color: var(--text-2); }
.nav .nav-item[aria-current="page"] { background: var(--surface-3); color: var(--text); font-weight: 600; }
.nav .nav-item[aria-current="page"] .icon { color: var(--molten); }
.nav .nav-item[aria-current="page"]::before { content: ""; position: absolute; left: -12px; top: 8px; bottom: 8px; width: 3px; border-radius: 0 3px 3px 0; background: var(--molten); }
.sidebar-foot { margin-top: auto; display: grid; gap: var(--sp-3); padding: var(--sp-3) var(--sp-2) 0; border-top: 1px solid var(--border); }
.local-note { display: flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-sm); color: var(--muted); }
.local-note .mono { font-size: var(--fs-sm); }
.session:empty { display: none; }
.session { display: grid; gap: var(--sp-2); }
.session button { width: 100%; justify-content: flex-start; }
.locale { position: relative; display: flex; align-items: center; }
.locale .icon { position: absolute; left: 10px; color: var(--muted); pointer-events: none; }
.locale select { height: 30px; padding-left: 32px; font-size: var(--fs-md); max-width: none; background-position: calc(100% - 15px) 12px, calc(100% - 10px) 12px; }

.main-col { min-width: 0; display: flex; flex-direction: column; }
.app { width: 100%; max-width: 1200px; padding: var(--sp-5) var(--sp-6) var(--sp-7); }
.app > section > * + * { margin-top: var(--sp-4); }

/* Context strip: which target every screen acts on */
.target-bar { position: sticky; top: 0; z-index: 5; display: flex; flex-wrap: wrap; align-items: center; gap: 6px var(--sp-3); min-height: 52px; padding: 10px var(--sp-6); background: color-mix(in srgb, var(--surface) 92%, transparent); backdrop-filter: saturate(1.4) blur(8px); border-bottom: 1px solid var(--border); font-size: var(--fs-md); }
.target-bar:empty { display: none; }
.target-bar.is-protected { box-shadow: inset 0 3px 0 var(--protected-bg); }
.ctx-target { display: inline-flex; align-items: center; gap: var(--sp-2); }
.ctx-name { font-size: var(--fs-base); font-weight: 600; letter-spacing: -0.01em; }
.ctx-sep { display: inline-block; width: 1px; height: 16px; background: var(--border-strong); font-size: 0; line-height: 0; overflow: hidden; color: transparent; }
.ctx-item { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); min-width: 0; }
.ctx-item .icon { color: var(--faint); flex: none; }
.ctx-label { font-size: var(--fs-xs); font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); }
.ctx-val { font-family: var(--font-mono); font-size: 12.5px; color: var(--text); overflow-wrap: anywhere; }
.badge { display: inline-flex; align-items: center; gap: 4px; height: 20px; padding: 0 7px; border-radius: 999px; font-size: var(--fs-xs); font-weight: 650; letter-spacing: 0.05em; line-height: 1; white-space: nowrap; }
.badge .icon { width: 12px; height: 12px; }
.badge-protected { background: var(--protected-bg); color: var(--protected-fg); box-shadow: 0 0 0 3px rgb(180 35 24 / 0.16); }
.badge-neutral { background: var(--surface-3); color: var(--muted); border: 1px solid var(--border); }

/* Page header */
.page-head { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: var(--sp-3) var(--sp-4); padding-bottom: var(--sp-4); margin-bottom: var(--sp-5); border-bottom: 1px solid var(--border); }
.app > section > .page-head + * { margin-top: 0; }
.page-title { min-width: 0; display: grid; gap: var(--sp-1); }
.page-title h2 { overflow-wrap: anywhere; }
.page-title h2.mono-title { font-family: var(--font-mono); font-size: 18px; letter-spacing: -0.01em; font-weight: 600; }
.page-sub { color: var(--muted); max-width: 72ch; }
.page-actions { display: flex; flex-wrap: wrap; gap: var(--sp-2); align-items: center; }

/* Buttons */
button, .button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: var(--control-h); padding: 0 12px; font: 500 var(--fs-base)/1 var(--font-sans); white-space: nowrap; border-radius: var(--radius-sm); border: 1px solid var(--border-strong); background: var(--surface); color: var(--text); cursor: pointer; box-shadow: var(--shadow-sm); transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease, box-shadow 120ms ease; }
button:hover { background: var(--surface-3); border-color: var(--border-strong); }
button:active { transform: translateY(0.5px); }
button:focus-visible, input:focus-visible, select:focus-visible, summary:focus-visible { outline: none; box-shadow: var(--focus); }
button .icon { flex: none; }
button.primary { background: var(--primary-bg); border-color: var(--primary-bg); color: var(--primary-fg); font-weight: 600; box-shadow: var(--shadow-sm), inset 0 1px 0 rgb(255 255 255 / 0.12); }
button.primary:hover { background: var(--primary-bg-hover); border-color: var(--primary-bg-hover); }
button.danger { color: var(--err); border-color: var(--err-line); background: var(--surface); }
button.danger:hover { background: var(--err-soft); border-color: var(--err); }
dialog.is-danger button.danger, button.danger.solid { background: var(--err); border-color: var(--err); color: #ffffff; font-weight: 600; }
dialog.is-danger button.danger:hover, button.danger.solid:hover { filter: brightness(0.94); }
@media (prefers-color-scheme: dark) { dialog.is-danger button.danger, button.danger.solid { background: #d92d20; border-color: #d92d20; } }
button.ghost { background: transparent; border-color: transparent; box-shadow: none; color: var(--muted); }
button.ghost:hover { background: var(--surface-3); color: var(--text); }
button.ghost.danger { color: var(--err); }
button.ghost.danger:hover { background: var(--err-soft); }
button.sm { height: 28px; padding: 0 10px; font-size: var(--fs-md); }
button:disabled, button:disabled:hover { opacity: 0.5; cursor: not-allowed; filter: none; transform: none; }
.row { display: flex; flex-wrap: wrap; gap: var(--sp-2); align-items: center; }
.actions-end { justify-content: flex-end; }

/* Cards */
.card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow-sm); min-width: 0; }
.card-head { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); min-height: 48px; padding: var(--sp-2) var(--sp-4); border-bottom: 1px solid var(--border); }
.card-head h3 { font-size: var(--fs-base); }
.card-actions { display: flex; gap: var(--sp-2); align-items: center; flex-wrap: wrap; }
.card-body { padding: var(--sp-4); min-width: 0; }
.card-body > * + * { margin-top: var(--sp-3); }
.card-body.flush { padding: 0; }
.card-foot { display: flex; flex-wrap: wrap; gap: var(--sp-2); justify-content: flex-end; align-items: center; padding: var(--sp-3) var(--sp-4); border-top: 1px solid var(--border); background: var(--surface-2); border-radius: 0 0 var(--radius) var(--radius); }
.card.accent { border-color: var(--accent-line, var(--border)); box-shadow: var(--shadow-sm), inset 3px 0 0 var(--molten); }
.grid-2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--sp-4); }
.lead { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); }
.lead .mono { font-size: 13px; color: var(--text); }

/* Key/value */
.kv { display: grid; gap: 0; }
dl { margin: 0; }
.kv-row { display: grid; grid-template-columns: 128px minmax(0, 1fr); gap: var(--sp-3); padding: 7px 0; border-top: 1px solid var(--border); align-items: baseline; }
.kv-row:first-child { border-top: 0; padding-top: 0; }
.kv-row:last-child { padding-bottom: 0; }
.kv dt { color: var(--muted); font-size: var(--fs-md); }
.kv dd { margin: 0; min-width: 0; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }

/* Pills and badges */
.pill { display: inline-flex; align-items: center; gap: 6px; height: 22px; padding: 0 8px; border-radius: 999px; font-size: var(--fs-sm); font-weight: 600; line-height: 1; white-space: nowrap; border: 1px solid; vertical-align: middle; }
.pill .dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex: none; }
.pill-ok { color: var(--ok); background: var(--ok-soft); border-color: var(--ok-line); }
.pill-warn { color: var(--warn); background: var(--warn-soft); border-color: var(--warn-line); }
.pill-err { color: var(--err); background: var(--err-soft); border-color: var(--err-line); }
.pill-info { color: var(--info); background: var(--info-soft); border-color: var(--info-line); }
.pill-skip { color: var(--muted); background: var(--surface-3); border-color: var(--border); }
.pill-run { color: var(--accent-text); background: var(--accent-soft); border-color: rgb(255 90 31 / 0.35); }
.pill-run .dot { animation: pulse 1.4s ease-in-out infinite; }
.status-ok { color: var(--ok); }
.status-warn { color: var(--warn); }
.status-err { color: var(--err); }

/* Tables */
.table-wrap { overflow-x: auto; max-width: 100%; }
.card > .table-wrap { border-radius: 0 0 var(--radius) var(--radius); }
table { border-collapse: separate; border-spacing: 0; width: 100%; font-size: var(--fs-base); }
th, td { text-align: left; padding: 10px var(--sp-4); border-bottom: 1px solid var(--border); vertical-align: middle; }
thead th { position: sticky; top: 0; z-index: 1; background: var(--surface-2); font-size: var(--fs-xs); font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); padding-top: 8px; padding-bottom: 8px; white-space: nowrap; }
tbody tr:last-child > * { border-bottom: 0; }
tbody tr:hover > * { background: var(--surface-2); }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
td.nowrap, th.nowrap { white-space: nowrap; }
td.wrap { overflow-wrap: anywhere; min-width: 20ch; }
td.mono { color: var(--text-2); }
td .row { flex-wrap: nowrap; justify-content: flex-end; }
.plan-lines th { width: 1%; white-space: nowrap; font-weight: 500; }
.plan-lines tbody th { background: transparent; }
.step-chip { display: inline-block; padding: 1px 7px; border-radius: var(--radius-xs); background: var(--surface-3); border: 1px solid var(--border); font-family: var(--font-mono); font-size: var(--fs-sm); color: var(--text-2); }
.plan-lines td { font-family: var(--font-mono); font-size: 12.5px; color: var(--text-2); overflow-wrap: anywhere; }

/* Commits (plan, history, rollback): a timeline per side, author text as plain text */
.visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.commits { display: grid; gap: var(--sp-4); }
.commits-note { display: flex; align-items: flex-start; gap: var(--sp-2); padding: 10px var(--sp-3); border: 1px dashed var(--border-strong); border-radius: var(--radius-sm); background: var(--surface-2); color: var(--muted); font-size: var(--fs-md); }
.commits-note .icon { flex: none; margin-top: 2px; color: var(--faint); }
.commits-note strong { color: var(--text-2); font-weight: 600; }
.commits-note.is-ok { border-style: solid; border-color: var(--ok-line); background: var(--ok-soft); color: var(--text-2); }
.commits-note.is-ok .icon { color: var(--ok); }
.commit-group { --tone: var(--ok); --tone-soft: var(--ok-soft); --tone-line: var(--ok-line); min-width: 0; }
.commit-group-removed { --tone: var(--err); --tone-soft: var(--err-soft); --tone-line: var(--err-line); }
.commit-group-head { display: flex; align-items: center; gap: var(--sp-2); margin-bottom: var(--sp-2); }
.commit-group-title { font-size: var(--fs-xs); font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); }
.commit-sign { display: inline-grid; place-items: center; width: 18px; height: 18px; border-radius: var(--radius-xs); background: var(--tone-soft); border: 1px solid var(--tone-line); color: var(--tone); font: 600 13px/1 var(--font-mono); flex: none; }
.commit-count { display: inline-flex; align-items: center; height: 18px; padding: 0 6px; border-radius: 999px; background: var(--surface-3); border: 1px solid var(--border); color: var(--text-2); font-size: var(--fs-xs); font-weight: 600; font-variant-numeric: tabular-nums; }
.commit-list { list-style: none; margin: 0; padding: 0; position: relative; }
.commit-list::before { content: ""; position: absolute; left: 8px; top: 14px; bottom: 14px; width: 2px; border-radius: 2px; background: var(--tone-line); }
.commit { position: relative; display: grid; grid-template-columns: 18px auto minmax(0, 1fr) auto; align-items: center; gap: var(--sp-3); padding: 6px var(--sp-2) 6px 0; border-radius: var(--radius-sm); }
.commit:hover { background: var(--surface-2); }
.commit-dot { justify-self: center; width: 10px; height: 10px; border-radius: 50%; background: var(--tone); box-shadow: 0 0 0 3px var(--surface); position: relative; z-index: 1; }
.commit.is-merge .commit-dot { background: var(--surface); border: 2px solid var(--tone); }
.commit-sha { padding: 1px 6px; border-radius: var(--radius-xs); background: var(--surface-3); border: 1px solid var(--border); color: var(--text-2); font-size: var(--fs-sm); }
.commit-subject { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); }
.commit.is-merge .commit-subject { color: var(--muted); }
.commit-merge { width: 14px; height: 14px; margin-right: 6px; vertical-align: -2px; color: var(--faint); }
.commit-meta { display: flex; gap: var(--sp-2); align-items: baseline; justify-content: flex-end; color: var(--muted); font-size: var(--fs-sm); white-space: nowrap; font-variant-numeric: tabular-nums; }
.commit-author { max-width: 18ch; overflow: hidden; text-overflow: ellipsis; color: var(--text-2); }
.commit-more { margin: var(--sp-1) 0 0 30px; color: var(--muted); font-size: var(--fs-sm); }
.commit-span { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); }
.commit-span code { color: var(--text-2); }
.commit-span .icon { width: 14px; height: 14px; }
.card-actions .muted { font-size: var(--fs-md); }
@media (max-width: 720px) {
  .commit { grid-template-columns: 18px auto minmax(0, 1fr); row-gap: 2px; align-items: start; }
  .commit-dot { margin-top: 5px; }
  .commit-subject { white-space: normal; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .commit-meta { grid-column: 3; justify-content: flex-start; }
  .release-changes > td { padding-left: var(--sp-4); }
  .release-changes-cell > * { max-width: calc(100vw - 64px); }
}
/* History: a chevron opens a release's commits under its row */
.releases td.disclosure, .releases th.disclosure { width: 1%; padding-right: 0; }
.disclosure-button { width: 26px; height: 26px; padding: 0; border-color: transparent; background: transparent; box-shadow: none; color: var(--muted); }
.disclosure-button:hover { background: var(--surface-3); color: var(--text); }
.disclosure-button .icon { transition: transform 150ms ease; }
.disclosure-button[aria-expanded="true"] .icon { transform: rotate(90deg); color: var(--molten); }
.releases td.release-commit { min-width: 28ch; max-width: 40ch; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.release-commit code { margin-right: var(--sp-2); }
.release-subject { color: var(--text); }
.release-row.is-open > * { background: var(--surface-2); border-bottom-color: transparent; }
.release-changes > td { padding: var(--sp-2) var(--sp-4) var(--sp-4) 52px; background: var(--surface-2); }
.release-changes:hover > * { background: var(--surface-2); }
/* The cell spans a table wider than the card: the list stays within what is on screen. */
.release-changes-cell > * { max-width: min(52rem, calc(100vw - var(--sidebar-w) - 160px)); }
.rollback-preview:empty { display: none; }
/* The confirmation dialog's compact list */
.commit-summary { display: grid; gap: 4px; padding: var(--sp-2) var(--sp-3); border: 1px solid var(--tone-line); border-left: 3px solid var(--tone); border-radius: var(--radius-sm); background: var(--tone-soft); --tone: var(--ok); --tone-soft: var(--ok-soft); --tone-line: var(--ok-line); }
.commit-summary.commit-group-removed { --tone: var(--err); --tone-soft: var(--err-soft); --tone-line: var(--err-line); }
.commit-summary-head { display: flex; align-items: center; gap: var(--sp-2); font-weight: 600; color: var(--text); margin-bottom: 2px; }
.commit-summary-row { display: flex; gap: var(--sp-2); min-width: 0; font-size: var(--fs-md); }
.commit-summary-row .commit-subject { color: var(--text-2); }
.commit-summary .commit-sha { background: var(--surface); }
.commit-summary .commit-more { margin: 0; }

/* Forms */
.field { display: grid; gap: 6px; }
.field + .field { margin-top: var(--sp-4); }
.field > label { font-size: var(--fs-md); font-weight: 600; color: var(--text); }
.field-key { font-family: var(--font-mono); font-size: var(--fs-sm); font-weight: 400; color: var(--muted); }
.field-help, .field > .muted { font-size: var(--fs-sm); color: var(--muted); }
.field-error { color: var(--err); font-size: var(--fs-sm); }
.field-error:empty { display: none; }
.required { color: var(--err); }
input[type="text"], input[type="password"], input[type="number"], select { font: var(--fs-base)/1 var(--font-sans); height: var(--control-h); padding: 0 10px; border: 1px solid var(--border-strong); border-radius: var(--radius-sm); background: var(--surface); color: var(--text); width: 100%; max-width: 32rem; box-shadow: var(--shadow-sm); transition: border-color 120ms ease, box-shadow 120ms ease; }
input[type="password"], input#confirm-name, .field input[spellcheck="false"][type="text"] { font-family: var(--font-mono); font-size: 13px; }
input:hover, select:hover { border-color: var(--faint); }
input:focus-visible, select:focus-visible { border-color: var(--molten); }
input[aria-invalid="true"] { border-color: var(--err); }
select { appearance: none; padding-right: 30px; background-image: linear-gradient(45deg, transparent 50%, var(--muted) 50%), linear-gradient(135deg, var(--muted) 50%, transparent 50%); background-position: calc(100% - 15px) 14px, calc(100% - 10px) 14px; background-size: 5px 5px, 5px 5px; background-repeat: no-repeat; }
input[type="checkbox"] { width: 16px; height: 16px; margin: 0; accent-color: var(--primary-bg); flex: none; }
.check > label, label.check { display: flex; align-items: flex-start; gap: var(--sp-2); font-weight: 500; font-size: var(--fs-base); line-height: 20px; cursor: pointer; }
.check input[type="checkbox"] { margin-top: 2px; }
.form-section + .form-section { margin-top: var(--sp-5); padding-top: var(--sp-5); border-top: 1px solid var(--border); }
.form-note { font-size: var(--fs-md); color: var(--muted); display: flex; gap: var(--sp-2); align-items: flex-start; }
.form-note .icon { margin-top: 2px; color: var(--faint); flex: none; }

.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--sp-4) var(--sp-5); }
.form-grid > .field + .field { margin-top: 0; }
.form-grid input[type="text"], .form-grid input[type="number"] { max-width: none; }
.span-2 { grid-column: 1 / -1; }
.target-name { font-weight: 600; }
.card-body > [aria-live]:empty { display: none; }

/* Disclosures */
details > summary { cursor: pointer; color: var(--muted); font-size: var(--fs-md); font-weight: 500; width: fit-content; border-radius: var(--radius-xs); list-style-position: inside; }
details > summary:hover { color: var(--text); }
details[open] > summary { margin-bottom: var(--sp-2); }
.advanced { margin-top: var(--sp-3); }
.form-section > .advanced:first-child { margin-top: 0; }
.form-section + .form-section:has(> .advanced:first-child) { padding-top: var(--sp-4); margin-top: var(--sp-4); }
.advanced[open] { padding: var(--sp-3); border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-2); }
.diagnostics { white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--font-mono); font-size: var(--fs-sm); line-height: 18px; margin: 0; padding: 10px var(--sp-3); background: var(--surface-3); border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--text-2); max-height: 40vh; overflow-y: auto; }

/* Banners */
.banner { display: flex; gap: var(--sp-3); align-items: flex-start; padding: var(--sp-3) var(--sp-4); border: 1px solid var(--info-line); border-left-width: 3px; border-radius: var(--radius); background: var(--info-soft); color: var(--text); }
.banner-icon { width: 18px; height: 18px; flex: none; margin-top: 1px; color: var(--info); }
.banner-body { min-width: 0; flex: 1; overflow-wrap: anywhere; }
.banner-body > p { margin-top: 4px; color: var(--text-2); }
.banner-body > details { margin-top: var(--sp-2); }
.banner-title { font-weight: 600; }
.banner-code { font-family: var(--font-mono); font-size: var(--fs-sm); color: var(--muted); }
.banner.ok { border-color: var(--ok-line); border-left-color: var(--ok); background: var(--ok-soft); }
.banner.ok .banner-icon { color: var(--ok); }
.banner.warn { border-color: var(--warn-line); border-left-color: var(--warn); background: var(--warn-soft); }
.banner.warn .banner-icon { color: var(--warn); }
.banner.err { border-color: var(--err-line); border-left-color: var(--err); background: var(--err-soft); }
.banner.err .banner-icon { color: var(--err); }
.banner + .banner { margin-top: var(--sp-2); }

/* Findings */
.findings { list-style: none; margin: 0; padding: 0; }
.finding { display: grid; grid-template-columns: auto minmax(0, 1fr); column-gap: var(--sp-3); row-gap: var(--sp-2); padding: var(--sp-3) var(--sp-4); border-top: 1px solid var(--border); align-items: baseline; }
.finding:first-child { border-top: 0; }
.finding-msg { min-width: 0; overflow-wrap: anywhere; }
.finding-id { font-family: var(--font-mono); font-size: var(--fs-sm); color: var(--muted); margin-right: 6px; }
.sev { display: inline-flex; align-items: center; justify-content: center; min-width: 84px; height: 20px; padding: 0 7px; border-radius: var(--radius-xs); font-size: var(--fs-xs); font-weight: 650; letter-spacing: 0.05em; text-transform: uppercase; border: 1px solid; }
.sev-error { color: var(--err); background: var(--err-soft); border-color: var(--err-line); }
.sev-warning { color: var(--warn); background: var(--warn-soft); border-color: var(--warn-line); }
.fix { grid-column: 2; display: flex; align-items: baseline; gap: var(--sp-2); padding: 6px 10px; background: var(--surface-3); border: 1px solid var(--border); border-left: 2px solid var(--faint); border-radius: var(--radius-xs); min-width: 0; }
.fix-label { font-size: var(--fs-xs); font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); flex: none; }
.fix code { background: none; border: 0; padding: 0; user-select: all; }

/* Empty states */
.empty { display: grid; justify-items: center; text-align: center; gap: 6px; padding: var(--sp-7) var(--sp-4); border: 1px dashed var(--border-strong); border-radius: var(--radius); background: var(--surface); }
.empty-icon { display: grid; place-items: center; width: 40px; height: 40px; border-radius: 10px; background: var(--surface-3); border: 1px solid var(--border); color: var(--muted); margin-bottom: var(--sp-2); }
.empty-icon .icon { width: 20px; height: 20px; }
.empty-title { font-weight: 600; font-size: var(--fs-lg); line-height: 24px; }
.empty-text { color: var(--muted); max-width: 52ch; }
.empty .row { margin-top: var(--sp-3); justify-content: center; }
.stopped { max-width: 560px; margin: var(--sp-7) 0 0; }
.stopped .banner { margin-top: var(--sp-4); text-align: left; }

/* Dialogs */
dialog { padding: 0; border: 1px solid var(--border); border-radius: 12px; background: var(--surface); color: var(--text); width: min(32rem, calc(100vw - 32px)); max-width: none; box-shadow: var(--shadow-lg); }
dialog::backdrop { background: rgb(11 14 19 / 0.55); backdrop-filter: blur(2px); }
dialog[open] { animation: rise 160ms ease-out; }
.dialog-head { display: flex; gap: var(--sp-3); align-items: flex-start; padding: 20px 20px 0; }
.dialog-head h2 { font-size: var(--fs-lg); line-height: 24px; overflow-wrap: anywhere; }
.dialog-icon { display: grid; place-items: center; width: 32px; height: 32px; border-radius: 50%; flex: none; background: var(--accent-soft); color: var(--accent-text); }
.dialog-icon .icon { width: 18px; height: 18px; }
dialog.is-danger { border-top: 3px solid var(--err); }
dialog.is-danger .dialog-icon { background: var(--err-soft); color: var(--err); }
.dialog-body { padding: var(--sp-3) 20px 20px 64px; color: var(--text-2); overflow-wrap: anywhere; }
.dialog-body > p + p { margin-top: var(--sp-2); }
.dialog-context { font-family: var(--font-mono); font-size: 12.5px; color: var(--text); background: var(--surface-3); border: 1px solid var(--border); border-radius: var(--radius-xs); padding: 6px 10px; }
.dialog-protected { display: flex; align-items: center; gap: var(--sp-2); color: var(--err); font-weight: 500; }
.dialog-body .field { margin-top: var(--sp-4); }
.dialog-body .field > label { font-weight: 500; color: var(--text-2); }
.dialog-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--sp-2); padding: var(--sp-3) 20px; border-top: 1px solid var(--border); background: var(--surface-2); border-radius: 0 0 12px 12px; }

/* Run: the step timeline */
.run-state { display: flex; align-items: center; gap: var(--sp-2); width: fit-content; max-width: 100%; padding: 6px 12px; border: 1px solid var(--border); border-radius: 999px; background: var(--surface); color: var(--text-2); font-size: var(--fs-md); box-shadow: var(--shadow-sm); overflow-wrap: anywhere; }
.run-state::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--faint); flex: none; }
.run-state.is-live::before { background: var(--molten); animation: pulse 1.4s ease-in-out infinite; }
.run-state.is-ok::before { background: var(--ok); }
.run-state.is-err::before { background: var(--err); }
.run-state:empty { display: none; }
.run-grid { display: grid; grid-template-columns: minmax(240px, 300px) minmax(0, 1fr); gap: var(--sp-4); align-items: start; }
.run-outcome:empty, .run-findings:empty { display: none; }
.steps { list-style: none; padding: 0; margin: 0; }
.steps:empty::before { content: "Waiting for the first step…"; display: block; color: var(--muted); font-size: var(--fs-md); }
.step { position: relative; display: grid; grid-template-columns: 20px minmax(0, 1fr) auto; column-gap: 10px; align-items: center; min-height: 32px; padding: 6px 0; }
.step:not(:last-child)::after { content: ""; position: absolute; left: 9.5px; top: 28px; bottom: -6px; width: 1px; background: var(--border-strong); }
.step.is-ok:not(:last-child)::after { background: var(--ok); opacity: 0.45; }
.step-icon { position: relative; z-index: 1; display: grid; place-items: center; width: 20px; height: 20px; border-radius: 50%; font-size: 11px; font-weight: 700; line-height: 1; border: 1.5px solid var(--border-strong); background: var(--surface); color: var(--muted); }
.step.is-ok .step-icon { background: var(--ok); border-color: var(--ok); color: var(--surface); }
.step.is-failed .step-icon { background: var(--err); border-color: var(--err); color: var(--surface); }
.step.is-skipped .step-icon { background: var(--surface-3); border-color: var(--border-strong); color: var(--muted); }
.step.is-running .step-icon { color: transparent; border-color: var(--molten); border-right-color: transparent; animation: spin 0.9s linear infinite; }
.step.is-aborted .step-icon { color: transparent; border-style: dashed; border-color: var(--warn); }
.step.is-aborted .step-icon::after { content: ""; position: absolute; inset: 5px; border-radius: 2px; background: var(--warn); }
.step-title { font-weight: 500; min-width: 0; overflow-wrap: anywhere; }
.step.is-running .step-title { font-weight: 600; }
.step.is-skipped .step-title { color: var(--muted); }
.step-meta { display: inline-flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-sm); color: var(--muted); white-space: nowrap; }
.step-status { text-transform: lowercase; }
.step.is-failed .step-status { color: var(--err); font-weight: 600; }
.step.is-running .step-status { color: var(--accent-text); font-weight: 600; }
.step.is-aborted .step-status { color: var(--warn); font-weight: 600; }
.step-dur { font-family: var(--font-mono); font-variant-numeric: tabular-nums; min-width: 6ch; text-align: right; color: var(--text-2); }

/* Run: the log console (a terminal in both themes) */
.console { background: var(--term-bg); border: 1px solid var(--term-border); border-radius: var(--radius); overflow: hidden; box-shadow: var(--shadow-sm); min-width: 0; }
.console-head { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); height: 40px; padding: 0 var(--sp-4); border-bottom: 1px solid rgb(255 255 255 / 0.08); color: var(--term-muted); }
.console-head h3 { color: #e6edf3; font-size: var(--fs-md); display: flex; align-items: center; gap: var(--sp-2); }
.console-head .icon { color: var(--term-muted); }
.console-meta { font-family: var(--font-mono); font-size: var(--fs-sm); color: var(--term-muted); }
.log { list-style: none; margin: 0; padding: 10px 0; max-height: 60vh; min-height: 120px; overflow-y: auto; color: var(--term-fg); font-family: var(--font-mono); font-size: 12.5px; line-height: 20px; white-space: pre-wrap; overflow-wrap: anywhere; scrollbar-color: #30363d transparent; }
.log li { position: relative; padding: 0 var(--sp-4) 0 calc(var(--sp-4) + 10ch); }
.log li::before { content: attr(data-ts); position: absolute; left: var(--sp-4); width: 9ch; color: var(--term-ts); font-variant-numeric: tabular-nums; }
.log li:hover { background: rgb(255 255 255 / 0.03); }
.log .src { color: var(--term-muted); }
.log li.src { font-style: italic; }
.log li.warn { color: var(--term-warn); background: var(--term-warn-bg); box-shadow: inset 2px 0 0 var(--term-warn); }
.log li.error { color: var(--term-err); background: var(--term-err-bg); box-shadow: inset 2px 0 0 var(--term-err); }
.log li.ok { color: var(--term-ok); }
.log:empty::after { content: "No output yet."; display: block; padding: 0 var(--sp-4); color: var(--term-muted); }

@keyframes spin { to { transform: rotate(360deg); } }
@keyframes pulse { 50% { opacity: 0.35; } }
@keyframes rise { from { opacity: 0; transform: translateY(6px) scale(0.99); } }

/* Responsive: below 900px the sidebar becomes a top bar */
@media (max-width: 900px) {
  .shell { grid-template-columns: minmax(0, 1fr); background: none; }
  .sidebar { position: static; height: auto; flex-direction: row; flex-wrap: wrap; align-items: center; gap: var(--sp-3); padding: var(--sp-3) var(--sp-4); border-right: 0; border-bottom: 1px solid var(--border); overflow: visible; }
  .brand { padding: 0; order: 1; }
  .sidebar-foot { order: 2; margin: 0 0 0 auto; padding: 0; border: 0; display: flex; align-items: center; gap: var(--sp-3); }
  .session button { width: auto; }
  .session { display: flex; align-items: center; }
  .locale select { width: 8.5rem; }
  .nav { order: 3; width: 100%; flex-direction: row; align-items: center; gap: var(--sp-3); min-width: 0; }
  .nav-target { padding: 0; display: flex; align-items: center; gap: var(--sp-2); flex: none; }
  .nav-target select { width: 10.5rem; }
  .nav-list { flex-direction: row; gap: 2px; overflow-x: auto; min-width: 0; scrollbar-width: none; }
  .nav .nav-item { width: auto; flex: none; }
  .nav .nav-item[aria-current="page"]::before { left: 10px; right: 10px; top: auto; bottom: -12px; width: auto; height: 2px; border-radius: 2px 2px 0 0; }
  .target-bar { position: static; padding: 10px var(--sp-4); }
  .app { padding: var(--sp-5) var(--sp-4) var(--sp-7); }
  .run-grid { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 640px) {
  .form-grid { grid-template-columns: minmax(0, 1fr); }
  .local-note > span { display: none; }
  .nav { flex-wrap: wrap; }
  .nav-target { width: 100%; }
  .nav-target select { width: 100%; max-width: none; }
  .nav-list { width: 100%; margin: 0 -4px; }
  .nav .nav-item[aria-current="page"]::before { display: none; }
  .nav-list { gap: 0; justify-content: space-between; }
  .nav .nav-item { padding: 0 8px; font-size: var(--fs-md); height: 32px; }
  .nav .nav-item .icon { display: none; }
  .grid-2 { grid-template-columns: minmax(0, 1fr); }
  .kv-row { grid-template-columns: 96px minmax(0, 1fr); }
  .page-head { margin-bottom: var(--sp-4); }
  h2 { font-size: 18px; line-height: 24px; }
  th, td { padding: 8px var(--sp-3); }
  .card-head, .card-body { padding-left: var(--sp-3); padding-right: var(--sp-3); }
  .finding { grid-template-columns: minmax(0, 1fr); padding: var(--sp-3); }
  .fix { grid-column: 1; }
  .dialog-body { padding-left: 20px; }
  .log li { padding-left: var(--sp-3); }
  .log li::before { display: none; }
  .target-bar .ctx-sep { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; transition: none !important; animation: none !important; }
  .step.is-running .step-icon { border-right-color: var(--molten); border-style: dotted; }
}
`
