import { defineConfig } from 'vitepress'

const github = 'https://github.com/Zebedeu/machize'

export default defineConfig({
  title: 'Machize',
  description: 'The Laravel-grade toolkit for building SaaS on Node.js.',
  lang: 'en-US',
  // Served at the domain root (Cloudflare Pages / Netlify / Vercel), so base is '/'.
  cleanUrls: true,
  lastUpdated: true,

  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'Cookbook', link: '/cookbook/notes-saas' },
      { text: 'Reference', link: '/reference/packages' },
      { text: '0.23.0', link: `${github}/releases` },
    ],

    sidebar: {
      '/guide/': [
        {
          text: 'Getting Started',
          items: [
            { text: 'Introduction', link: '/guide/getting-started' },
            { text: 'Installation', link: '/guide/installation' },
            { text: 'Core Concepts', link: '/guide/concepts' },
            { text: 'HTTP Adapters', link: '/guide/adapters' },
          ],
        },
        {
          text: 'SaaS Building Blocks',
          items: [
            { text: 'Multi-tenancy', link: '/guide/tenancy' },
            { text: 'Authentication', link: '/guide/auth' },
            { text: 'Teams', link: '/guide/teams' },
            { text: 'Subscriptions', link: '/guide/billing' },
            { text: 'Feature Flags', link: '/guide/feature-flags' },
            { text: 'Webhooks', link: '/guide/webhooks' },
          ],
        },
        {
          text: 'Data & infrastructure',
          items: [
            { text: 'Queues & Jobs', link: '/guide/queues' },
            { text: 'Storage', link: '/guide/storage' },
            { text: 'Caching', link: '/guide/caching' },
          ],
        },
        {
          text: 'Capabilities',
          items: [
            { text: 'Realtime', link: '/guide/realtime' },
            { text: 'Search', link: '/guide/search' },
            { text: 'File uploads', link: '/guide/files' },
            { text: 'Comments', link: '/guide/comments' },
            { text: 'Internationalization', link: '/guide/i18n' },
            { text: 'Data exports', link: '/guide/exports' },
            { text: 'Self-contained UIs', link: '/guide/admin-pages' },
          ],
        },
        {
          text: 'Production',
          items: [
            { text: 'Going to Production', link: '/guide/production' },
            { text: 'Security', link: '/guide/security' },
            { text: 'Observability', link: '/guide/observability' },
            { text: 'OpenAPI', link: '/guide/openapi' },
          ],
        },
      ],
      '/cookbook/': [
        {
          text: 'Cookbook',
          items: [
            { text: 'Build a notes SaaS (end to end)', link: '/cookbook/notes-saas' },
            { text: 'A multi-tenant SaaS', link: '/cookbook/multi-tenant-saas' },
            { text: 'Harden accounts & billing', link: '/cookbook/account-lifecycle' },
          ],
        },
      ],
      '/reference/': [
        {
          text: 'Reference',
          items: [{ text: 'Packages', link: '/reference/packages' }],
        },
      ],
    },

    socialLinks: [{ icon: 'github', link: github }],

    editLink: {
      pattern: `${github}/edit/main/apps/docs/:path`,
      text: 'Edit this page on GitHub',
    },

    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2026 Machize Contributors',
    },

    search: { provider: 'local' },
  },
})
