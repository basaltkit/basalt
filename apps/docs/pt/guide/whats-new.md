# Novidades no Basalt 1.3

> *"Basalt 1.3" é o rótulo umbrella desta vaga de trabalho; os pacotes
> `@basaltkit/*` são versionados de forma independente (ver
> [Versionamento](/pt/guide/versioning)). Abaixo está o que entrou e a versão do
> pacote que o traz.*

O Basalt 1.3 completa a história de escala, tempo-real e passwordless da
framework — e reforça tudo isso com uma ronda de segurança adversarial dedicada.

## Destaques

### Tempo-real & transporte
- **Server-Sent Events** — produtores `sse()` tipados, ligados de forma idêntica ao
  Fastify, Express e Hono. O `send()` devolve sinal de backpressure; `id`/`event`
  são à prova de injeção. *(`@basaltkit/http` 1.8, adapters 1.5/1.2/1.2)*

### Escalar dados
- **Read replicas** — `readReplica({ primary, replicas, extend })` encaminha
  leituras pelas réplicas e escritas para o primary; o `extend` garante que cada
  réplica leva o teu scoping de tenant. *(`@basaltkit/prisma` 1.4)*
- **Sharding horizontal** — o `ShardRouter` mapeia cada tenant para uma base fixa
  com hash determinístico; liga com `prismaPlugin({ shards })`. *(`@basaltkit/prisma` 1.4)*

### Multi-tenancy
- **Domínios custom** — regista o domínio próprio de um tenant, prova a posse com um
  registo DNS TXT, e resolve só domínios **verificados** via `findByVerifiedDomain`.
  *(`@basaltkit/tenancy` 1.3)*

### Auth
- **WebAuthn / passkeys** — a cerimónia completa de registo e autenticação
  (challenges, opções, storage de credenciais, deteção de clone) com um verifier de
  crypto plugável, para a framework não carregar dependência WebAuthn.
  *(`@basaltkit/auth` 1.6)*

### Notifications
- **Canais SMS & WhatsApp** sobre um `SmsSender` provider-agnostic — sem SDK de
  provider na framework. *(`@basaltkit/notifications` 1.2)*

### Dashboard
- **Analytics** — o bridge de movimento de MRR (new / expansion / contraction /
  churn / reactivation) mais o crescimento período-a-período. *(`@basaltkit/dashboard` 1.4)*
- **Branding white-label** — nome do produto, logo e cores por tenant renderizados
  para CSS custom properties. *(`@basaltkit/dashboard` 1.4)*

### Experiência de desenvolvimento
- **DI-graph devtools** — `container.describe()`, um grafo de dependências passivo, e
  um renderer Mermaid. *(`@basaltkit/core` 1.1)*

## Reforço de segurança

Cada componente novo acima passou por uma auditoria de segurança adversarial antes
desta release. Um problema crítico e vários altos/médios foram encontrados e
corrigidos com testes de regressão:

- **Crítico:** fechado um vetor de stored-XSS controlado pelo tenant no CSS do white-label.
- **Alto:** o registo WebAuthn é vinculado ao sujeito (sem binding de passkey
  cross-conta); as read replicas não conseguem contornar o scoping de tenant; as
  operações de domínio custom são scoped por tenant com um normalizador IDNA
  partilhado e revogação na re-verificação; `id`/`event` de SSE à prova de injeção.

## Atualizar

Os pacotes são independentes — bumpa só o que usas; os ranges são semver, por isso um
minor `1.x` é drop-in. Dois refinamentos de comportamento da ronda de segurança:

- `CustomDomains.verify` / `instructions` / `remove` passam a receber o `tenantId`
  dono como primeiro argumento.
- O `readReplica` mantém o `$queryRaw` no primary por omissão — opta por leituras raw
  na réplica com `rawReadsOnReplica: true`.
