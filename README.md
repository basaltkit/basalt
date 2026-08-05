# Machize

Ecossistema open source para construir aplicações SaaS em Node.js — tenancy, auth, billing, permissões, filas e auditoria integrados, com a filosofia do Laravel e TypeScript de ponta a ponta.

- Arquitetura completa: [ARCHITECTURE.md](./ARCHITECTURE.md)
- Stack: Node.js, TypeScript, Fastify, Prisma, PostgreSQL, Redis, MinIO, BullMQ, Zod

## Desenvolvimento

```bash
pnpm install
pnpm build
pnpm test
```

## Estrutura

- `packages/*` — bibliotecas publicáveis (`@machize/*`)
- `apps/*` — docs, playground e exemplos
- `tooling/*` — configs compartilhadas (tsconfig, vitest)
