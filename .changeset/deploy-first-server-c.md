---
"@basaltkit/deploy": minor
---

The last two gaps from a first real server:

- **`install` handles a missing TLS certificate before it writes the Apache vhost.** The managed vhost names `/etc/letsencrypt/live/<certName or domain>`. Without that certificate, `apachectl configtest` failed and install put everything back and stopped. Install now checks first. If the certificate is missing, it offers to get one from Let's Encrypt, after asking: it installs certbot and the Apache plugin when needed, then runs `certbot certonly --apache`, which never edits a vhost. A "no", or no terminal, stops with the commands to run by hand. Tenants on subdomains need a wildcard, which only a DNS challenge issues, so install says how and runs nothing.
- **New `basalt-deploy vhost [--port=<n>]`.** It prints the vhost `install` would write, for this checkout's path and the app's port, on stdout. It is the starting point for `apache({ managed: false })`, replacing a vhost copied from an example with someone else's `/var/www/…` path and port. It does not speak `--json`, since its output is the file itself.
