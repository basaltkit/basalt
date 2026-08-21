# Basalt vs outras frameworks

Uma pergunta justa quando chegas: *porquê o Basalt e não o NestJS, o AdonisJS ou
o Fastify simples?* Aqui fica um posicionamento honesto — incluindo onde as
outras são mais fortes.

## Onde o Basalt se encaixa

O Basalt vai buscar o **mecanismo** ao NestJS / AdonisJS (container de DI, ciclo
de vida de plugins, contexto de pedido) e a **amplitude de baterias** ao
ecossistema Laravel — orientado a **SaaS multi-tenant** e agnóstico ao servidor
HTTP por baixo.

O ADN Laravel é intencional: o `@basaltkit/subscriptions` ecoa o **Cashier**, o
`@basaltkit/permissions` e o `@basaltkit/activity` seguem a **Spatie**, e o
modelo de faturação inspira-se no **Soulbscription** — mas reconstruído para
TypeScript.

## Num relance

| | **Basalt** | **NestJS** | **AdonisJS** | **Laravel** (PHP) | **Fastify / Hono** |
| --- | --- | --- | --- | --- | --- |
| Tipo | Framework backend | Framework backend | Framework full-stack | Framework full-stack | Micro-framework HTTP |
| Linguagem | TypeScript (Zod-first) | TypeScript | TypeScript | PHP | JS/TS |
| IoC / DI | Container por tokens, **sem decorators** | Container, **decorators + reflection** | Container | Container | — |
| Servidor HTTP | **Agnóstico** (Fastify/Express/Hono) | Express/Fastify | Próprio | Próprio | *é* o servidor |
| Multi-tenancy | **De raiz** (resolvers, scoping, fail-closed) | Constróis tu | Constróis tu | Pacotes | Constróis tu |
| Auth · Teams · Billing · Permissões · Filas · Pesquisa · Realtime · Webhooks · … | **Incluídos** (78 pacotes) | Core mínimo + ecossistema | Vários incluídos | Ecossistema enorme | — |
| Frontend | SDK + admin headless (backend-focado) | — | Edge / Inertia | Blade / Livewire | — |
| Maturidade | Novo (1.x) | Testado em batalha | Estabelecido | Muito maduro | Muito maduro |

## O que distingue o Basalt

- **Multi-tenancy de primeira classe.** Resolvers plugáveis (subdomínio,
  domínio, header, rota), uma extensão do Prisma que limita cada query ao tenant
  ativo e **falha fechado** sem um, e contexto de tenant por pedido. Na maioria
  das frameworks isto constróis tu.
- **Baterias de SaaS que encaixam.** Auth, teams + convites, subscrições +
  gateways de pagamento, permissões, filas, pesquisa, realtime, webhooks,
  notificações, activity/audit, storage, mailer, i18n, flags, exports — a
  amplitude do ecossistema Laravel, integrada e tipada.
- **Agnóstico ao adaptador.** As mesmas rotas tipadas, enrichers e guards correm
  em Fastify, Express ou Hono. Trocar a camada HTTP não mexe na tua app.
- **Zod-first, sem decorators.** Os schemas geram os tipos, o documento OpenAPI e
  o SDK type-safe — sem metadados de reflection, sem `@Decorators`.

## Onde as outras são mais fortes (com honestidade)

- **Maturidade e comunidade.** NestJS e Laravel têm anos de produção, milhares de
  pacotes de terceiros, tutoriais e mercado de contratação. O Basalt é novo.
- **Full-stack.** Laravel e AdonisJS trazem views e ferramentas de frontend; o
  Basalt é backend + um SDK / admin headless — trazes o teu frontend.
- **Estilo com decorators.** Se gostas dos `@Injectable()` / `@Get()` do NestJS,
  a abordagem explícita do Basalt (funções e tokens) é um gosto diferente —
  melhor ou pior conforme tu.

## Quando o Basalt encaixa bem

- Estás a construir um **SaaS multi-tenant** e não queres reinventar tenancy,
  auth, teams, faturação e permissões.
- Queres **TypeScript de ponta a ponta**, com tipos a partir dos schemas, OpenAPI
  e um cliente gerado.
- Valorizas **pacotes pequenos e compostáveis** e escolher só o que precisas —
  funciona igualmente bem para uma API simples (vê [Para além do SaaS](./beyond-saas)).

## Quando procurar outra coisa

- Precisas de um **ecossistema enorme e maduro** e muita cobertura de
  tutoriais/contratação hoje → NestJS ou Laravel.
- Queres uma experiência **full-stack integrada** com views renderizadas no
  servidor → Laravel ou AdonisJS.
- Só precisas de um **serviço HTTP minúsculo** sem framework nenhuma → Fastify ou
  Hono sozinhos.

## Numa frase

> **O Laravel do TypeScript, feito para SaaS multi-tenant** — a amplitude de
> baterias do Laravel, um núcleo de plugins/DI ao estilo Nest, agnóstico ao
> adaptador HTTP, e multi-tenancy de raiz.
