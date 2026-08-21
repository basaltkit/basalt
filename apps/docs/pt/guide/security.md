# Segurança

O Basalt é **seguro por omissão** na borda HTTP e fail-closed nos segredos.
Tudo aqui é zero-dependências e ligado através do ciclo de vida dos plugins.

## Proteção de borda — `securityPlugin`

Um só plugin cobre rate limiting, CORS e cabeçalhos de resposta seguros. **Os
cabeçalhos seguros estão ligados por omissão**; o rate limiting e o CORS são
opt-in — ativa-os explicitamente para produção. As apps novas já trazem
`securityPlugin()` no scaffold, por isso os cabeçalhos ficam protegidos desde o
primeiro deploy.

```ts
import { securityPlugin } from '@basaltkit/fastify'

securityPlugin({
  rateLimit: { limit: 100, windowMs: 60_000 },      // 100 req / minuto / IP
  cors: { origin: ['https://app.example.com'], credentials: true },
  headers: true,                                     // defaults seguros
})
```

### Rate limiting

Um limitador de janela fixa chaveado pelo IP do cliente (substitui com `key`).
Pedidos bloqueados recebem `429 RATE_LIMITED` com `Retry-After`, e cada resposta
carrega `X-RateLimit-Limit` / `-Remaining` / `-Reset`.

```ts
securityPlugin({
  rateLimit: {
    limit: 20,
    windowMs: 10_000,
    key: (req) => req.headers['x-api-key'] as string ?? req.ip,
    skip: (req) => req.url.startsWith('/livez'),
  },
})
```

O store por omissão é em memória (`MemoryRateLimitStore`). Para múltiplas
instâncias, implementa a interface `RateLimitStore` sobre Redis — o mesmo padrão
de driver usado por `@basaltkit/cache`.

### CORS

`origin` aceita `true` (refletir), uma string, um array de allow-list, ou um
predicado. Os pedidos de preflight `OPTIONS` são respondidos automaticamente.

::: warning Credenciais exigem uma allow-list explícita
Refletir uma `Origin` arbitrária **com** `credentials: true` entregaria respostas
autenticadas (com cookies) a qualquer site. Quando `credentials` está ligado, o
Basalt recusa refletir — tens de passar uma `origin` explícita (string, array ou
predicado). Um wildcard `*` só é emitido para pedidos sem credenciais.
:::

### Cabeçalhos seguros

`headers: true` define HSTS, `X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` e
`Cross-Origin-Opener-Policy: same-origin`. Passa um objeto para personalizar (p.
ex. uma `contentSecurityPolicy` para superfícies HTML) ou `false` para desativar.

## Segredos fail-closed — `secret()`

O incidente de produção mais comum é enviar uma chave de assinatura placeholder.
`secret()` torna isso impossível:

```ts
import { defineEnv, secret } from '@basaltkit/env'

export const env = defineEnv({
  APP_SECRET: secret({ devDefault: 'dev-only-insecure-secret-value' }),
})
```

- **Desenvolvimento**: usa `devDefault` quando não definido — a app simplesmente corre.
- **Produção** (`NODE_ENV=production`): a variável é **obrigatória**, tem de
  cumprir um comprimento mínimo, e é **rejeitada se parecer um placeholder**
  (`change-me`, `secret`, `password`, …). Caso contrário a app recusa arrancar.

## Bloqueio por força bruta

`@basaltkit/auth` limita logins falhados por email logo à partida — sem qualquer
ligação necessária. Após demasiadas falhas dentro de uma janela deslizante,
`login()` lança `AccountLockedError` (HTTP 429) mesmo com a password correta; um
sucesso limpa o contador.

```ts
import { authPlugin, LoginThrottle } from '@basaltkit/auth'

authPlugin({
  users,
  secret: env.APP_SECRET,
  // por omissão 5 tentativas / 15 min; personaliza ou desativa:
  loginThrottle: new LoginThrottle({ maxAttempts: 10, windowMs: 5 * 60_000 }),
  // loginThrottle: false, // para desligar
})
```

## Mutações idempotentes — `idempotencyPlugin`

Retries seguros para `POST`: um cliente que envia uma `Idempotency-Key` recebe a
**mesma** resposta replicada num retry, por isso uma ligação caída nunca cobra um
cartão duas vezes.

```ts
import { idempotencyPlugin } from '@basaltkit/fastify'

idempotencyPlugin() // protege POST por omissão
```

- Repetir com a mesma chave → a resposta em cache, com `Idempotent-Replayed: true`.
- Uma repetição enquanto a primeira ainda está em curso → `409 IDEMPOTENCY_CONFLICT`.
- Respostas `5xx` **não** são colocadas em cache, por isso falhas genuínas
  continuam repetíveis.
- As chaves têm escopo por **caller + método + rota**: uma impressão digital do
  caller é misturada na chave armazenada, por isso a resposta em cache de um
  utilizador nunca pode ser replicada a outro (sem fuga entre utilizadores/
  tenants), e a mesma chave em dois endpoints não pode colidir.

## Responsabilidade partilhada — reforçar a tua integração

O Basalt fecha as vulnerabilidades que *consegue* fechar sozinho. Três coisas,
porém, dependem de como a **tua app** liga as peças — a framework não as pode
decidir por ti. Acerta nestas em cada deployment.

### 1. Autorização é explícita — declara um guard, não só a intenção

O `meta.can` (ou `meta.teamRole`) de uma rota documenta *o que* a rota precisa,
mas o **guard que o aplica tem de estar de facto registado**. Uma rota
declarada-mas-sem-guard está **aberta**: não há um default-deny implícito que
bloqueie um pedido só porque uma permissão foi nomeada.

```ts
// ❌ o meta diz "admin", mas nada o aplica → a rota é pública
route({ method: 'POST', url: '/admin/purge', meta: { can: 'admin' }, handler })

// ✅ regista o guard que lê o meta e rejeita callers não autorizados
app.use(authorizationPlugin())        // aplica meta.can em cada rota
app.use(teamsPlugin())                // aplica meta.teamRole
```

Trata "uma rota com permissão no `meta` mas sem guard correspondente no pipeline"
como um bug. Um bom padrão é um check de CI que falha quando alguma rota declara
`meta.can`/`meta.teamRole` e o plugin que o aplica está ausente.

### 2. Nunca confies num tenant vindo do cliente — verifica a membership

Resolver o tenant ativo a partir de um header do pedido (ou subdomínio, ou path)
é conveniente, mas o header é **controlado pelo atacante**. Ler
`X-Tenant-Id: acme` e limitar a `acme` sem verificar que o *utilizador
autenticado pertence de facto a `acme`* deixa qualquer utilizador com sessão ler
os dados de outro tenant.

```ts
// ❌ tenant vindo diretamente de um header do cliente — acesso entre tenants
const tenantId = req.headers['x-tenant-id']

// ✅ resolve, depois confirma que o utilizador é membro antes de confiar
const tenantId = req.headers['x-tenant-id']
if (!(await teams.can(tenantId, ctx().user.id, 'member'))) {
  throw new ForbiddenError()
}
```

Liga a seleção de tenant a uma **membership user↔tenant verificada** (via
`@basaltkit/teams`, o `tenantId` de uma API-key, ou uma claim de sessão) — nunca
apenas ao pedido em bruto.

**Faz isto para todas as rotas de uma vez com `tenantMembershipPlugin`.** Em vez
de repetir a verificação, regista o guard do `@basaltkit/teams`: em cada pedido
autenticado e com tenant resolvido, garante que o utilizador é membro do tenant
e devolve `403` caso contrário. As rotas centrais que legitimamente atuam fora
de um só tenant (login, criação de tenant, admin da plataforma, aceitar convite)
optam por sair com `meta: { central: true }`.

```ts
import { teamsPlugin, tenantMembershipPlugin } from '@basaltkit/teams'

createApp({
  plugins: [
    authPlugin(/* … */),
    tenancyPlugin(/* … */),
    teamsPlugin(/* … */),
    tenantMembershipPlugin(), // seguro por omissão: membership imposta em todo o lado
  ],
})

// uma rota de que o utilizador não é membro → 403; rota central sai:
route({ method: 'POST', url: '/tenants', meta: { central: true }, /* … */ })
```

### 3. O scoping automático de tenant cobre o ORM — não SQL bruto nem writes aninhados

A extensão de tenancy do Prisma limita as operações de modelo padrão e **falha
fechado** sem contexto de tenant. Dois caminhos ficam *fora* dessa rede:

- **Queries brutas** — `$queryRaw` / `$executeRaw` contornam o scoping de modelo.
  O Basalt agora **recusa-as por omissão quando há um tenant em contexto**
  (`PRISMA_RAW_IN_TENANT`), para uma query bruta não poder ler entre tenants em
  silêncio. Corre-as em código central (sem tenant em contexto), ou adiciona tu o
  predicado `tenant_id = $1` e define `onRawInTenant: 'allow'`.
- **Writes aninhados** — um `connect` / `create` aninhado que alcança outro
  modelo não é re-limitado. Verifica primeiro que o registo relacionado pertence
  ao tenant atual.

```ts
// ❌ query bruta dentro de um contexto de tenant agora lança PRISMA_RAW_IN_TENANT
await db.$queryRaw`SELECT * FROM invoices WHERE status = ${status}`

// ✅ limita explicitamente, parametrizado, e opta por permitir
const tenantId = ctx().tenant.id
await db.$queryRaw`
  SELECT * FROM invoices WHERE status = ${status} AND tenant_id = ${tenantId}`
// com tenancyExtension({ onRawInTenant: 'allow' })
```

**Defesa em profundidade — ativa RLS no Postgres.** O scoping aplicacional é uma
camada; junta uma imposta pela base de dados, para que nem um predicado esquecido
vaze. O `rlsPolicySql` gera a migração, e o `set_config` nomeia o tenant ativo
por transação — a base de dados filtra cada linha por si:

```ts
import { rlsPolicySql, setTenantConfigSql, tenantConfigParams } from '@basaltkit/prisma'

// migração (uma vez): ativa RLS + política de isolamento por tenant em cada tabela
await db.$executeRawUnsafe(rlsPolicySql({ tables: ['invoices', 'projects'] }))

// por pedido: define o tenant ativo, local à transação (nunca vaza num pool)
await db.$transaction(async (tx) => {
  await tx.$executeRawUnsafe(setTenantConfigSql(), ...tenantConfigParams(ctx().tenant.id))
  // cada query aqui é filtrada ao tenant pela base de dados
})
```

Na dúvida, prefere operações de modelo (limitadas automaticamente) a SQL bruto,
e revê cada `connect` contra o tenant atual.

### 4. CSRF — seguro por omissão com auth por header; cookies são responsabilidade tua

O Basalt autentica cada pedido a partir de um **header** — `Authorization: Bearer <jwt>` ou `x-session-id: <id>` (ver o enricher de auth). Isto é **CSRF-safe por
design**: um cross-site request forgery só funciona com credenciais que o browser
anexa *automaticamente* (cookies, HTTP Basic). Um header custom nunca é enviado
cross-origin num pedido forjado, por isso a página do atacante não pode aproveitar
a sessão da vítima. **Mantém a auth num header e não há nada a fazer.**

Assumes o risco de CSRF no momento em que moves essa credencial para um **cookie**
— p. ex. guardar o session id ou o JWT num cookie para o browser o enviar
automaticamente. Se o fizeres, protege-o tu:

- Define o cookie `SameSite=Lax` (ou `Strict`), `HttpOnly` e `Secure`.
  Só o `SameSite=Lax` já trava o `POST` cross-site comum.
- Acrescenta uma segunda verificação para pedidos que alteram estado: um **token
  CSRF double-submit** (um valor aleatório espelhado num cookie e num header/campo
  do body, comparados no servidor), ou uma **allow-list de Origin/Referer**.
- Nunca contes com o CORS para isto — o CORS governa a *leitura* de uma resposta,
  não se um pedido forjado é *enviado*. Um `POST` de formulário dispara à mesma.

```ts
// ✅ preferido — sem cookie, sem superfície de CSRF
fetch('/api/pay', { method: 'POST', headers: { authorization: `Bearer ${jwt}` } })

// ⚠️ se tiveres mesmo de usar sessão em cookie, junta SameSite + verificação de token CSRF
setCookie('sid', session.id, { httpOnly: true, secure: true, sameSite: 'lax' })
```

## Cadeia de fornecimento

O CI corre `pnpm audit` (severidade alta), **CodeQL** SAST, e o **Dependabot**
mantém dependências e Actions atualizadas. Os releases publicam no npm com
**provenance** (`NPM_CONFIG_PROVENANCE`) via changesets — sem tokens manuais ou
OTP no pipeline.
