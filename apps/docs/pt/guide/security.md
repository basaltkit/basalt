# Segurança

O Basalt é **seguro por omissão** na borda HTTP e fail-closed nos segredos.
Tudo aqui é zero-dependências e ligado através do ciclo de vida dos plugins.

## Os defaults seguros, num relance

Cada um destes vem LIGADO por omissão — tens de optar por *sair*, nunca por
entrar. Esta tabela é o mapa; o guia de cada linha tem os detalhes e o opt-out.

| Default | O que previne | Onde |
|---|---|---|
| O boot recusa rotas cuja meta de segurança não tem guard a aplicá-la (`UnguardedRouteMetaError`) | rotas "protegidas" a servir abertas em silêncio | nesta página, abaixo |
| As rotas de billing/faturas exigem utilizador autenticado (`meta.auth`) | gestão anónima de cartões/planos via tenant forjado | [Billing](/pt/guide/billing) |
| Guard de membership em cada pedido autenticado com tenant (`tenantMembershipPlugin`) | um utilizador válido do tenant A a conduzir o tenant B (`TEAM_NOT_A_MEMBER`) | nesta página, abaixo |
| A cache falha fechada fora do contexto de tenant em apps multi-tenant (`MissingCacheScopeError`) | leituras cross-tenant através de um namespace "global" partilhado | [Caching](/pt/guide/caching) |
| `meta.can` rejeita formas não aplicáveis (`PERMISSION_META_INVALID`) | uma declaração malformada a saltar a autorização em silêncio | [Autorização](/pt/guide/authorization) |
| URLs assinados de storage servem `Content-Disposition: attachment` | stored XSS via uploads de utilizadores numa origem CDN | [Storage](/pt/guide/storage) |
| Corpos de mail construídos com `` html`…` `` com interpolações auto-escapadas; o log driver redige corpos em produção | injeção de markup no mail da app · links de reset em agregadores de logs | [Notificações](/pt/guide/notifications) |
| Páginas admin/UI transportam uma CSP route-scoped com hash | injeção de script inline — sem enfraquecer a CSP da app | [Páginas admin](/pt/guide/admin-pages) |
| As chaves de rate-limit ignoram `X-Forwarded-For`; o CORS nunca reflete origens arbitrárias com credenciais; HSTS/nosniff/frame-deny ligados | limites forjados por header · leituras cross-origin com credenciais · clickjacking | nesta página, abaixo |
| Os segredos falham fechados em produção (`secret()`, `AUTH_WEAK_SECRET`) | arrancar com uma chave de assinatura adivinhável | nesta página, abaixo |

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

**Limites por rota.** Uma rota pode apertar o orçamento de um endpoint sensível
via `meta.rateLimit` — recebe o seu próprio balde (por IP + rota) nesse limite,
enquanto as restantes usam o global:

```ts
route({
  method: 'POST',
  url: '/auth/login',
  meta: { rateLimit: { limit: 5, windowMs: 60_000 } }, // 5/min além do limite global
  // …
})
```

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
`X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`,
`Cross-Origin-Opener-Policy: same-origin` e uma `Content-Security-Policy`
restritiva por omissão — `default-src 'none'; frame-ancestors 'none'` (adequada
a uma API JSON). Passa um objeto para personalizar (p. ex. a tua própria
`contentSecurityPolicy` para uma superfície HTML/docs), `contentSecurityPolicy:
false` para omitir só a CSP, ou `headers: false` para desativar tudo.

## Limites de recursos & resistência a DoS

Para além de headers e rate limits, conexões longas e lentas podem esgotar um
servidor. O Basalt traz defaults sensatos e knobs para as arestas.

### Timeouts de request (anti-slowloris)

Um cliente lento que envia um pedido byte a byte prende uma conexão indefinidamente. O
adapter Fastify usa por omissão um **`requestTimeout` de 30 s** (o default do Fastify é
*desligado*); sobrepõe via `fastifyPlugin({ fastify: { requestTimeout } })`. O Express e
o Hono correm num servidor Node teu — aplica a mesma proteção nele:

```ts
// Express / Hono (servidor node:http)
server.requestTimeout = 30_000   // o pedido inteiro tem de chegar em 30s
server.headersTimeout = 20_000   // headers em 20s (slowloris de headers)
server.keepAliveTimeout = 5_000
```

### Streams SSE

Os Server-Sent Events são longos por natureza, por isso dá-lhes um heartbeat e um
limite de vida. O `send()` devolve também um booleano de **backpressure** — para de
produzir quando for `false`:

```ts
return sse(async (stream) => {
  for await (const update of source) {
    if (!stream.send({ data: update })) break // o cliente não acompanha → abranda
  }
}, { heartbeatMs: 15_000, maxDurationMs: 30 * 60_000 }) // ping a cada 15s, limite de 30 min
```

Os pings de heartbeat impedem os proxies de largar um stream inativo e revelam um socket
morto; o `maxDurationMs` é um backstop contra conexões que nunca desligam. Limita o
número de streams concorrentes por utilizador/tenant no teu handler para um teto rígido.

### Endpoints de cerimónia (WebAuthn, MFA)

Endpoints que emitem um challenge ou verificam um código são pré-auth e baratos de
martelar — faz-lhes throttle. Reutiliza o [bloqueio por força bruta](#bloqueio-por-forca-bruta)
e limites por-rota, e em produção suporta o `PasskeyStore` / `WebAuthnChallengeStore` do
WebAuthn (e os stores de MFA) com uma implementação **durável**, não o default em memória.

### Re-verificação de domínios custom

Um domínio custom verificado que depois expira ou repointa o DNS é um risco de takeover.
Re-verifica num agendamento com [`@basaltkit/scheduler`](/pt/guide/scheduler) — o
`verify(tenantId, domain, { force })` re-verifica o registo TXT e **revoga** o domínio se
já não corresponder:

```ts
schedule.call('reverify-domains', async () => {
  for (const { tenantId, domain } of await listVerifiedDomains()) {
    await customDomains.verify(tenantId, domain, { force: true })
  }
}).daily().at('04:00')
```

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

Um throttle por IP corre em paralelo (ligado por omissão), para apanhar também um
*spray* de uma tentativa por muitas contas — passa o IP do cliente ao
`login({ ip })` (a rota incorporada já o faz).

## A enumeração de contas está fechada por omissão

O endpoint público de registo é **enumeration-safe**: registar um email que já
existe devolve o *mesmo* `202` (e faz trabalho equivalente) que um registo novo,
por isso não pode ser usado para sondar que emails têm conta. A colisão é
sinalizada out-of-band pelo hook `auth:register_existing_email` — envia ao
endereço "já tens conta; entra ou repõe a password":

```ts
app.hooks.on('auth:register_existing_email', ({ email }) => sendAlreadyRegisteredEmail(email))

// opt-out (409 clássico no duplicado) se mesmo precisares:
authPlugin({ users, secret: env.APP_SECRET, enumerationSafeRegister: false })
```

As respostas de login, reposição de password e verificação de email são também
uniformes exista ou não a conta (timing equalizado, `{ ok: true }` genérico), por
isso nenhum endpoint de auth revela que emails estão registados.

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

## Revogar access tokens

Os access tokens (JWTs) são stateless, por isso ficam válidos até expirarem. Liga
um `TokenVersionStore` para os revogar mais cedo — uma reposição de password (e o
explícito `revokeAllTokens(userId)`) invalida então todos os tokens emitidos
antes do incremento:

```ts
import { authPlugin, MemoryTokenVersionStore } from '@basaltkit/auth'
import { PrismaTokenVersionStore } from '@basaltkit/auth-prisma' // ou SqliteTokenVersionStore

authPlugin({ users, secret: env.APP_SECRET, tokenVersions: new PrismaTokenVersionStore(prisma) })
```

Desligado por omissão (a verificação passa a custar uma leitura ao store por
pedido). O próprio segredo de assinatura é protegido: o `Auth` recusa arrancar
com segredo vazio e, em produção, rejeita um com menos de 32 chars (uma chave
HS256 curta é forjável offline) — usa `secret({ minLength: 32 })`.

## Cifrar segredos TOTP em repouso

O TOTP tem proteção anti-replay de origem (o time-step de um código é registado,
por isso um código intercetado é de uso único). Para sobreviver também a uma fuga
da base de dados, cifra os segredos guardados com uma chave da app — ficam como
envelopes AES-256-GCM e só são decifrados ao verificar um código:

```ts
authPlugin({ users, secret: env.APP_SECRET, mfaEncryptionKey: env.MFA_KEY })
```

Os registos em plaintext existentes continuam a funcionar e são cifrados na
próxima escrita.

## Responsabilidade partilhada — reforçar a tua integração

O Basalt fecha as vulnerabilidades que *consegue* fechar sozinho. Três coisas,
porém, dependem de como a **tua app** liga as peças — a framework não as pode
decidir por ti. Acerta nestas em cada deployment.

### 1. Autorização é explícita — declara um guard, não só a intenção

O `meta.auth` / `meta.can` / `meta.teamRole` de uma rota documenta *o que* a
rota precisa, mas o **guard que o aplica tem de estar de facto registado**. Uma
rota declarada-mas-sem-guard estaria **aberta** — por isso os adapters recusam
arrancá-la: no arranque verificam que cada chave de meta de segurança declarada
tem um guard registado a reclamá-la (via o bucket `http:guarded-meta`) e falham
alto, listando todas as rotas em falta.

```ts
// ❌ o meta diz "admin", mas nada o aplica → UnguardedRouteMetaError no BOOT
route({ method: 'POST', url: '/admin/purge', meta: { can: 'admin' }, handler })

// ✅ regista o plugin cujo guard aplica a chave
authPlugin(…)         // aplica meta.auth
permissionsPlugin(…)  // aplica meta.can
teamsPlugin(…)        // aplica meta.teamRole
```

Se a proteção acontecer genuinamente numa edge/gateway exterior, opta por sair
explicitamente com a opção do adapter `allowUnguardedMeta: true` (ou
`['auth', …]` para chaves específicas). Um plugin de guard próprio que aplique
uma destas chaves deve reclamá-la:
`ensureMetadata(container).add('http:guarded-meta', 'auth')`.

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

Por omissão o guard verifica a **existência** de membership — qualquer registo
de membership passa, por isso roles personalizados ausentes do `roleRank` não
são rejeitados; passa `role: 'member'` (ou superior) para impor semântica de
rank. Mais duas opções:

```ts
tenantMembershipPlugin({
  // Escape baseado em QUEM chama: admins de plataforma / suporte cruzam
  // tenants legitimamente. Prefere isto a meta.central quando a exceção é
  // sobre o chamador — central desativa o guard para toda a gente nessa rota.
  exempt: ({ user }) => (user as { platformAdmin?: boolean })?.platformAdmin === true,

  // Cache de decisão opt-in: sem ela, cada pedido autenticado com tenant custa
  // um lookup indexado de membership (normalmente ok). Decisões em cache são
  // descartadas de imediato pelos hooks team:joined/role_changed/member_removed
  // no mesmo processo; ttlMs apenas limita a staleness de alterações feitas
  // NOUTRA réplica — um membro removido noutro lado pode manter acesso até ttlMs.
  cache: { ttlMs: 30_000 },
})
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

## Apanha regressões automaticamente — `ai:doctor`

O `basalt ai:doctor` verifica estaticamente o teu projeto contra os invariantes
de segurança do framework — offline, sem chave de API. Duas verificações
codificam as garantias mais importantes deste guia:

- **`missing-tenant-membership`** (erro) — tens tenancy + auth + teams mas nenhum
  `tenantMembershipPlugin`, por isso um tenant resolvido nunca é ligado a um
  membro verificado. É a classe de acesso cross-tenant da secção 2.
- **`missing-security-plugin`** (aviso) — sem `securityPlugin()`, as respostas
  saem sem cabeçalhos seguros.

```bash
basalt ai:doctor      # corre-o em CI para falhar o build numa regressão de segurança
```

Liga-o ao teu pipeline para que uma mudança que remova o guard de membership ou
o security plugin ponha o build vermelho em vez de ir para produção.

## Cadeia de fornecimento

O CI corre `pnpm audit` (severidade alta), **CodeQL** SAST, e o **Dependabot**
mantém dependências e Actions atualizadas. Os releases publicam no npm com
**provenance** (`NPM_CONFIG_PROVENANCE`) via changesets — sem tokens manuais ou
OTP no pipeline.
