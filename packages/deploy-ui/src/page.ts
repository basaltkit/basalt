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
<title>Basalt deploy</title>
<link rel="stylesheet" href="/app.css">
<script type="module" src="/client/main.js"></script>
</head>
<body>
<header class="top">
  <h1 class="brand">Basalt deploy</h1>
  <nav id="nav" aria-label="Screens"></nav>
  <div id="session" class="session"></div>
</header>
<div id="target-bar" class="target-bar" aria-live="polite"></div>
<main id="app" class="app">
  <p class="muted">Starting…</p>
  <noscript><p>This UI needs JavaScript (its own module only; nothing is loaded from elsewhere).</p></noscript>
</main>
<footer class="foot"><p class="muted">Local only: this page talks to 127.0.0.1, which talks to your servers over your own ssh.</p></footer>
</body>
</html>
`

export const APP_CSS = `:root {
  --bg: #f7f7f5; --fg: #1d1d1b; --muted: #5f5f5a; --panel: #ffffff; --line: #d9d9d4;
  --accent: #8a3b12; --accent-fg: #ffffff; --ok: #1f6b3a; --warn: #8a5a00; --err: #a3231b; --code: #efefea;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #161615; --fg: #ecece8; --muted: #a5a59e; --panel: #1f1f1d; --line: #3a3a36;
    --accent: #e0864d; --accent-fg: #161615; --ok: #6fcf8f; --warn: #e6b450; --err: #ff7b72; --code: #262623;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--fg); }
body { font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
.top { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 24px; padding: 12px 16px; border-bottom: 1px solid var(--line); background: var(--panel); }
.brand { font-size: 1.1rem; margin: 0; }
nav { display: flex; flex-wrap: wrap; gap: 4px; }
.session { margin-left: auto; display: flex; gap: 8px; align-items: center; }
.target-bar { padding: 8px 16px; border-bottom: 1px solid var(--line); font-family: ui-monospace, monospace; font-size: 0.9rem; overflow-wrap: anywhere; }
.target-bar:empty { display: none; }
.app { max-width: 1100px; margin: 0 auto; padding: 16px; }
.foot { max-width: 1100px; margin: 0 auto; padding: 0 16px 24px; }
h2 { font-size: 1.2rem; margin: 1.2em 0 0.5em; }
h3 { font-size: 1rem; margin: 1em 0 0.4em; }
.muted { color: var(--muted); }
button, .button { font: inherit; padding: 6px 12px; border-radius: 6px; border: 1px solid var(--line); background: var(--panel); color: var(--fg); cursor: pointer; }
button:hover { border-color: var(--accent); }
button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
button.primary { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); }
button.danger { border-color: var(--err); color: var(--err); }
button[aria-current="page"] { border-color: var(--accent); font-weight: 600; }
button:disabled { opacity: 0.5; cursor: not-allowed; }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 12px 16px; margin: 12px 0; }
.row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; overflow-wrap: anywhere; }
.table-wrap { overflow-x: auto; }
code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9em; }
code { background: var(--code); padding: 1px 4px; border-radius: 4px; overflow-wrap: anywhere; }
.field { display: grid; gap: 4px; margin: 10px 0; }
.field input[type="text"], .field input[type="password"], .field input[type="number"], .field select { font: inherit; padding: 6px 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--fg); width: 100%; max-width: 32rem; }
.field-error { color: var(--err); font-size: 0.9rem; }
.required { color: var(--err); }
.status-ok { color: var(--ok); }
.status-warn { color: var(--warn); }
.status-err { color: var(--err); }
.banner { border-left: 4px solid var(--line); padding: 8px 12px; margin: 12px 0; background: var(--panel); }
.banner.ok { border-color: var(--ok); }
.banner.warn { border-color: var(--warn); }
.banner.err { border-color: var(--err); }
.steps { list-style: none; padding: 0; margin: 0; }
.steps li { padding: 2px 0; }
.log { list-style: none; margin: 0; padding: 8px; max-height: 60vh; overflow-y: auto; background: var(--code); border-radius: 6px; font-family: ui-monospace, monospace; font-size: 0.85rem; white-space: pre-wrap; overflow-wrap: anywhere; }
.log li { padding: 0 0 1px; }
.log .warn { color: var(--warn); }
.log .error { color: var(--err); }
.log .src { color: var(--muted); }
.diagnostics { white-space: pre-wrap; overflow-wrap: anywhere; font-family: ui-monospace, monospace; font-size: 0.85rem; }
dialog { border: 1px solid var(--line); border-radius: 8px; background: var(--panel); color: var(--fg); max-width: min(36rem, calc(100vw - 32px)); }
dialog::backdrop { background: rgb(0 0 0 / 0.45); }
.hidden { display: none; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
@media (max-width: 640px) {
  .top { padding: 10px 16px; }
  .session { margin-left: 0; }
  th, td { padding: 4px; }
}
@media (prefers-reduced-motion: reduce) {
  * { scroll-behavior: auto !important; transition: none !important; animation: none !important; }
}
`
