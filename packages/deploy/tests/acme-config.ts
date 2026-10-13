/** The config `main` loads from a real directory; the rest of the server is a FakeHost. */
export const ACME_CONFIG = `export default {
  app: 'acme', domain: 'acme.example.com', tenants: 'subdomain', branch: 'master',
  env: {
    schema: 'src/env.ts',
    fixed: { NODE_ENV: 'production', HOST: '127.0.0.1' },
    generate: { APP_SECRET: { kind: 'secret', bytes: 32 } },
    ask: {
      MAILER_URL: { kind: 'question', prompt: 'SMTP URL', secret: true, optional: true },
      PAYCO_SECRET_TOKEN: { kind: 'question', prompt: 'PayCo token', secret: true, optional: false },
      SUPPORT_EMAIL: { kind: 'question', prompt: 'Support address', secret: false, optional: true, default: 'help@example.com' },
    },
    derive: ({ domain }) => ({ PAYCO_CALLBACK_URL: 'https://' + domain + '/api/webhooks/payco' }),
    forbid: ['PAYCO_FAKE'],
  },
  infra: { kind: 'external' },
  build: { prisma: ['prisma.config.ts'], web: 'web' },
  migrate: { central: true, tenants: true },
  runtime: { kind: 'pm2', script: 'start', port: 'auto', avoid: [3000, 3001] },
  proxy: { kind: 'apache', webRoot: 'web/dist', apiPrefix: '/api' },
  health: { path: '/health', timeoutSeconds: 10 },
  backup: { beforeMigrate: false },
}
`
