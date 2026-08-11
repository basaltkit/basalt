import { defineConfig } from 'vitepress'

const github = 'https://github.com/Zebedeu/basalt'

export default defineConfig({
  title: 'Basalt',
  description: 'The complete toolkit for building SaaS on Node.js.',
  lang: 'en-US',
  // Served at the domain root (Cloudflare Pages / Netlify / Vercel), so base is '/'.
  cleanUrls: true,
  lastUpdated: true,

  // English is the root locale (served at `/`); Portuguese lives under `/pt/`.
  // The root inherits the shared `themeConfig` below; `pt` overrides nav/sidebar.
  locales: {
    root: { label: 'English', lang: 'en-US' },
    pt: {
      label: 'Português',
      lang: 'pt-PT',
      link: '/pt/',
      description: 'O toolkit completo para construir SaaS em Node.js.',
      themeConfig: {
        nav: [
          { text: 'Guia', link: '/pt/guide/getting-started' },
          { text: 'Referência', link: '/reference/packages' },
          { text: '1.0.4', link: `${github}/releases` },
        ],
        sidebar: {
          '/pt/': [
            {
              text: 'Começar',
              items: [
                { text: 'Introdução', link: '/pt/guide/getting-started' },
                { text: 'Instalação', link: '/pt/guide/installation' },
                { text: 'Conceitos centrais', link: '/pt/guide/concepts' },
                { text: 'Adaptadores HTTP', link: '/pt/guide/adapters' },
              ],
            },
            {
              text: 'Blocos de SaaS',
              items: [
                { text: 'Multi-tenancy', link: '/pt/guide/tenancy' },
                { text: 'Autenticação', link: '/pt/guide/auth' },
                { text: 'Equipas', link: '/pt/guide/teams' },
                { text: 'Subscrições', link: '/pt/guide/billing' },
                { text: 'Pagamentos por referência', link: '/pt/guide/reference-payments' },
                { text: 'Feature Flags', link: '/pt/guide/feature-flags' },
                { text: 'Webhooks', link: '/pt/guide/webhooks' },
              ],
            },
            {
              text: 'Capacidades',
              items: [{ text: 'Pesquisa', link: '/pt/guide/search' }],
            },
          ],
        },
        editLink: {
          pattern: `${github}/edit/main/apps/docs/:path`,
          text: 'Editar esta página no GitHub',
        },
        footer: {
          message: 'Publicado sob a licença MIT.',
          copyright: 'Copyright © 2026 Basalt Contributors',
        },
        docFooter: { prev: 'Página anterior', next: 'Próxima página' },
        outline: { label: 'Nesta página' },
        returnToTopLabel: 'Voltar ao topo',
        langMenuLabel: 'Mudar idioma',
      },
    },
  },

  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'Cookbook', link: '/cookbook/notes-saas' },
      { text: 'Reference', link: '/reference/packages' },
      { text: '1.0.4', link: `${github}/releases` },
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
            { text: 'Reference & mobile-money payments', link: '/guide/reference-payments' },
            { text: 'Feature Flags', link: '/guide/feature-flags' },
            { text: 'Webhooks', link: '/guide/webhooks' },
          ],
        },
        {
          text: 'Frontend',
          items: [
            { text: 'Web UI & components', link: '/guide/web-ui' },
            { text: 'Self-contained UIs', link: '/guide/admin-pages' },
          ],
        },
        {
          text: 'Data & infrastructure',
          items: [
            { text: 'Queues & Jobs', link: '/guide/queues' },
            { text: 'Storage', link: '/guide/storage' },
            { text: 'Caching', link: '/guide/caching' },
            { text: 'Database-per-tenant', link: '/guide/database-per-tenant' },
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
          ],
        },
        {
          text: 'Production',
          items: [
            { text: 'Persistence & durable stores', link: '/guide/persistence' },
            { text: 'Versioning & compatibility', link: '/guide/versioning' },
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
      copyright: 'Copyright © 2026 Basalt Contributors',
    },

    search: { provider: 'local' },
  },
})
