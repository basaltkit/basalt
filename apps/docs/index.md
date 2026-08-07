---
layout: home

hero:
  name: Machize
  text: The complete toolkit for building SaaS on Node.js
  tagline: Tenancy, auth, billing, permissions, queues and audit — integrated end to end, self-hosted, no vendor lock-in.
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: View on GitHub
      link: https://github.com/Zebedeu/machize

features:
  - title: Multi-tenancy, first class
    details: Subdomain, domain, header and route resolvers. Cache, storage, queue, logger and audit isolate per tenant automatically through the request context.
  - title: Batteries included
    details: Authentication with refresh rotation, wildcard role-based permissions, subscription billing with feature limits — in your database, not a third-party service.
  - title: TypeScript end to end
    details: Zod schemas flow from route to handler to a fully-inferred SDK client. No decorators, no reflect-metadata — works on any bundler and runtime.
  - title: Fastify-first, not Fastify-locked
    details: A framework-agnostic core with an official Fastify adapter. The domain never imports the HTTP layer, so it outlives any single server.
---
