import { defineConfig } from 'vitepress'

const github = 'https://github.com/Zebedeu/machize'

export default defineConfig({
  title: 'Machize',
  description: 'The Laravel-grade toolkit for building SaaS on Node.js.',
  lang: 'en-US',
  cleanUrls: true,
  lastUpdated: true,

  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'Cookbook', link: '/cookbook/multi-tenant-saas' },
      { text: 'Reference', link: '/reference/packages' },
      { text: '0.1.0', link: `${github}/releases` },
    ],

    sidebar: {
      '/guide/': [
        {
          text: 'Getting Started',
          items: [
            { text: 'Introduction', link: '/guide/getting-started' },
            { text: 'Installation', link: '/guide/installation' },
            { text: 'Core Concepts', link: '/guide/concepts' },
          ],
        },
        {
          text: 'SaaS Building Blocks',
          items: [
            { text: 'Multi-tenancy', link: '/guide/tenancy' },
            { text: 'Authentication', link: '/guide/auth' },
            { text: 'Subscriptions', link: '/guide/billing' },
          ],
        },
      ],
      '/cookbook/': [
        {
          text: 'Cookbook',
          items: [{ text: 'A multi-tenant SaaS', link: '/cookbook/multi-tenant-saas' }],
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
