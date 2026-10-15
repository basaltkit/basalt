---
'@basaltkit/deploy': patch
---

Security review fixes:

- `bootstrap` no longer hands root's terminal to the app user's steps (`pnpm install`, `env` without a terminal): their output comes through a pipe, line by line, sanitized, so a process a postinstall leaves behind cannot read root's keystrokes. The install-plan error is sanitized too, and root's probes run from `/`, not `/tmp`.
- The Apache vhost sets `-FollowSymLinks +SymLinksIfOwnerMatch` on every directory above the checkout (a parent the app user can write could hold a link swapped in for the checkout). Installed vhosts show a one-time diff. `install` refuses a checkout reached through a link, and warns under Caddy when a parent is writable by another user.
- `install` never replaces a site file that is another app's (written by install for it, or serving other names), and Caddy `extra` site blocks are checked against co-hosted sites' names.
- The plan's `dir` is a closed set of characters (letters, digits, `. _ @ + -`); Caddy `extra` refuses zero-width characters.
- Redaction knows more secret names (`*_KEY_*`, `PASSWD`, `*_PWD`, `APIKEY`, `PRIVATE`, `SALT`) and catches multi-line values whole, escaped and line by line.
