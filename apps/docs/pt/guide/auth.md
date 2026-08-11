# Autenticação

`@basaltkit/auth` fornece autenticação completa do lado do servidor com os dados na
**tua** base de dados — sem dependência de fornecedor. Hashing de passwords, JWT com
rotação de refresh, sessões, MFA (TOTP), API keys e rotas prontas a usar.

[[toc]]

## Configuração

O arranque mais rápido usa os stores em memória — perfeitos para experimentar, mas
tudo desaparece ao reiniciar. Regista o plugin e as rotas prontas a usar:

```ts
import { createApp, ctx } from '@basaltkit/core'
import { fastifyPlugin, route } from '@basaltkit/fastify'
import { authPlugin, authRoutes, MemoryUserSource } from '@basaltkit/auth'

const app = await createApp({
  plugins: [
    authPlugin({
      users: new MemoryUserSource(), // em produção: implementa UserSource sobre a tua BD
      secret: process.env.AUTH_SECRET!, // assina os JWTs (HS256) — mantém-no secreto
      accessTtl: '15m', // access token de curta duração (padrão)
      refreshTtl: '30d', // refresh token de longa duração (padrão)
    }),
    fastifyPlugin({ routes: authRoutes() }),
  ],
}).boot()
```

::: warning Aviso
O `secret` é a chave do cofre. Usa um valor longo e aleatório (`openssl rand -base64 48`),
carrega-o a partir de uma variável de ambiente e nunca o faças commit. Se for exposto,
qualquer um pode forjar tokens. Serve sempre a autenticação sobre HTTPS.
:::

## Stores duráveis (produção)

`authPlugin` aceita um store para cada peça móvel — troca os padrões `Memory*`
por um backend durável e os utilizadores mantêm-se autenticados, as API keys continuam
a funcionar e os tokens de password-reset sobrevivem a um redeploy. Dois backends oficiais
vêm prontos a usar.

### SQLite — `@basaltkit/auth-sqlite`

Zero dependências externas, construído sobre o `node:sqlite` do Node (Node 22.5+; no 22.x
corre com `--experimental-sqlite`, estável e sem flag no Node 24):

```ts
import { authPlugin, apiKeysPlugin } from '@basaltkit/auth'
import { sqliteAuthStores } from '@basaltkit/auth-sqlite'

const s = sqliteAuthStores('./data/auth.db') // ':memory:' por padrão; abre + migra

const app = await createApp({
  plugins: [
    authPlugin({
      secret: process.env.AUTH_SECRET!,
      users: s.users,
      sessions: s.sessions,
      refreshTokens: s.refreshTokens,
      tokens: s.tokens, // verificação de email + reposição de password
      mfa: s.mfa,
    }),
    apiKeysPlugin({ store: s.apiKeys, users: s.users }),
    fastifyPlugin({ routes: authRoutes() }),
  ],
}).boot()
```

`sqliteAuthStores()` também aceita um `DatabaseSync` que já tenhas aberto, para que a
autenticação possa partilhar uma ligação com o resto da tua app. Os stores individuais
(`SqliteUserSource`, `SqliteSessionStore`, …) também são exportados se quiseres misturar
backends.

### Prisma — `@basaltkit/auth-prisma`

Para PostgreSQL/MySQL. Copia os modelos `Auth*` de
`@basaltkit/auth-prisma/schema.prisma` para o teu `schema.prisma`, corre
`prisma migrate dev && prisma generate` e depois:

```ts
import { authPlugin, apiKeysPlugin } from '@basaltkit/auth'
import { prismaAuthStores } from '@basaltkit/auth-prisma'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const s = prismaAuthStores(prisma) // passa o client diretamente, sem cast

authPlugin({
  secret: process.env.AUTH_SECRET!,
  users: s.users,
  sessions: s.sessions,
  refreshTokens: s.refreshTokens,
  tokens: s.tokens,
  mfa: s.mfa,
})
apiKeysPlugin({ store: s.apiKeys, users: s.users })
```

::: tip Dica
Traz o teu próprio UserSource. Não tens base de dados? Implementa o contrato `UserSource`
tu mesmo — quatro métodos sobre as tuas tabelas. `update` é opcional mas **obrigatório**
para verificação de email e reposição de password (`AUTH_UPDATE_UNSUPPORTED` se faltar):

```ts
import type { UserSource, AuthUser, UserPatch } from '@basaltkit/auth'

const users: UserSource = {
  async findByEmail(email) { /* SELECT … WHERE email = ? */ return null },
  async findById(id) { /* SELECT … WHERE id = ? */ return null },
  async create(data) { // data = { email, passwordHash } — hash já calculado
    return { id: crypto.randomUUID(), ...data } as AuthUser
  },
  async update(id, patch: UserPatch) { /* UPDATE … */ return null },
}
```
:::

## Rotas prontas a usar

Regista as rotas incorporadas — cada uma é uma rota simples que podes substituir ou omitir:

```ts
import { authRoutes, mfaRoutes, apiKeyRoutes } from '@basaltkit/auth'
import { fastifyPlugin } from '@basaltkit/fastify'

fastifyPlugin({ routes: [...appRoutes, ...authRoutes(), ...mfaRoutes(), ...apiKeyRoutes()] })
```

`authRoutes()` expõe:

| Endpoint | Body | Notas |
| --- | --- | --- |
| `POST /auth/register` | `{ email, password }` | → `EmailTakenError` (409) se já existir |
| `POST /auth/login` | `{ email, password, mfaCode? }` | → `{ user, accessToken, refreshToken }` |
| `POST /auth/refresh` | `{ refreshToken }` | novo par de tokens; mata a família em caso de reutilização |
| `POST /auth/logout` | `{ refreshToken }` | revoga a família de refresh |
| `GET /auth/me` | — | requer `Authorization: Bearer <jwt>` |
| `POST /auth/verify/request` · `POST /auth/verify` | `{ email }` · `{ token }` | verificação de email |
| `POST /auth/password/forgot` · `POST /auth/password/reset` | `{ email }` · `{ token, password }` | reposição de password |

As rotas `verify/request` e `password/forgot` respondem sempre `200` para que a
resposta nunca revele se uma conta existe; o token é enviado por email através dos
hooks `auth:verify_requested` / `auth:password_reset_requested`, nunca devolvido
por HTTP. Uma reposição de password concluída revoga todas as sessões e refresh tokens.

### O fluxo register → login → refresh (HTTP)

```bash
# 1. Registo
curl -X POST http://localhost:3000/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"ada@example.com","password":"secretpassword1"}'

# 2. Login → { user, accessToken, refreshToken }
curl -X POST http://localhost:3000/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"ada@example.com","password":"secretpassword1"}'

# 3. Chama uma rota protegida com o access token
curl http://localhost:3000/auth/me -H 'authorization: Bearer <accessToken>'

# 4. Quando o access token expira (15m), troca o refresh token por um novo par
curl -X POST http://localhost:3000/auth/refresh \
  -H 'content-type: application/json' -d '{"refreshToken":"<refreshToken>"}'
```

### O mesmo fluxo em código (a classe `Auth`)

Cada rota é um invólucro fino sobre o serviço `Auth` — alcança-o a partir do
container com o token `AUTH`, ou constrói um diretamente:

```ts
import { AUTH } from '@basaltkit/auth'
const auth = app.container.get(AUTH)

const user = await auth.register('ada@example.com', 'secretpassword1')
const { user: u, tokens } = await auth.login('ada@example.com', 'secretpassword1')
// tokens = { accessToken, refreshToken }
const next = await auth.refresh(tokens.refreshToken) // → novo { accessToken, refreshToken }
await auth.revoke(next.refreshToken) // logout para clientes baseados em tokens
```

## Rotação de refresh com deteção de reutilização

Cada refresh consome o token e emite um novo na mesma família. Se um
token já consumido reaparecer — um indicador de roubo — toda a família é revogada:

```ts
const { tokens } = await auth.login(email, password)
const next = await auth.refresh(tokens.refreshToken) // token antigo agora morto

// reproduzir o token antigo lança RefreshReusedError (401 AUTH_REFRESH_REUSED)
// e mata a família inteira — o utilizador tem de voltar a autenticar-se
await auth.refresh(tokens.refreshToken)
```

As passwords são hasheadas com **scrypt** (memory-hard, zero dependências); um
driver argon2id pode ser trocado através do contrato `PasswordHasher`
(`hasher: new MyArgon2Hasher()`).

## Proteger rotas e ler o utilizador

`authPlugin` regista um **enricher** (lê `Authorization: Bearer <jwt>` ou
`x-session-id` e define `ctx().user`) e um **guard**. Declara `meta.auth` numa
rota; o guard devolve `401 AUTH_REQUIRED` para pedidos anónimos. `ctx().user`
é um `PublicUser` — nunca inclui o hash da password:

```ts
import { ctx } from '@basaltkit/core'
import { route } from '@basaltkit/fastify'

route({
  method: 'GET',
  url: '/me',
  meta: { auth: true }, // anónimo → 401 AUTH_REQUIRED
  async handler() {
    const user = ctx().user // { id, email, emailVerified, … }
    return { hello: user?.email }
  },
})
```

Um pedido sem credenciais permanece anónimo (sem erro); um token explicitamente
inválido ou expirado devolve `401 AUTH_TOKEN_INVALID` / `AUTH_TOKEN_EXPIRED`.

## Autenticação multifator (TOTP)

Regista `mfaRoutes()` para enroll / activate / status / disable (todas requerem
login). **TOTP** é o código de 6 dígitos de apps como o Google Authenticator.

```ts
fastifyPlugin({ routes: [...authRoutes(), ...mfaRoutes()] })
```

O fluxo enroll → activate → recovery:

```ts
const auth = app.container.get(AUTH)

// 1. Enroll: gera um secret pendente + um URI de QR para renderizar
const { secret, otpauthUri } = await auth.enrollMfa(user.id)
//    otpauthUri → renderiza como um código QR; secret → alternativa de introdução manual

// 2. Activate com um código da app autenticadora → recovery codes (mostrados UMA vez)
const { recoveryCodes } = await auth.activateMfa(user.id, '123456')
//    recoveryCodes: 10 códigos de uso único guardados como hashes SHA-256

// 3. Status / disable
await auth.mfaStatus(user.id)          // { enabled, pending }
await auth.disableMfa(user.id, '123456') // requer um código atual ou de recovery válido
```

Por HTTP o mesmo fluxo é `POST /auth/mfa/enroll` → `POST /auth/mfa/activate`
`{ code }` → `GET /auth/mfa/status` / `POST /auth/mfa/disable` `{ code }`.

Uma vez o MFA ativo, `login` requer um código — passa-o como o terceiro argumento
opcional (ou o campo `mfaCode` no `POST /auth/login`):

```ts
await auth.login(email, password)            // → MfaRequiredError (401 AUTH_MFA_REQUIRED)
await auth.login(email, password, '123456')  // → { user, tokens }
```

Uma password correta com um código em falta **não** é uma tentativa falhada; um código
errado lança `MfaInvalidCodeError` e conta para o throttle. Tanto um código TOTP como
um código de recovery são aceites (os códigos de recovery são consumidos ao usar). A
implementação de TOTP não tem dependências e é verificada contra os vetores de teste
da RFC 6238.

## Reposição de password (ponta a ponta)

O módulo nunca envia email — emite um hook que transporta um token de uso único
(válido 1 hora por padrão) para a **tua** app enviar por email. Liga o hook uma vez no
arranque, depois expõe as duas rotas:

```ts
// 1. No arranque: transforma o hook num email
app.hooks.on('auth:password_reset_requested', async ({ user, token }) => {
  await mailer.send(user.email, `https://app.example.com/reset?token=${token}`)
})
```

```bash
# 2. O utilizador pede a reposição — responde sempre 200 (sem enumeração de contas)
curl -X POST http://localhost:3000/auth/password/forgot \
  -H 'content-type: application/json' -d '{"email":"ada@example.com"}'

# 3. O utilizador segue o link enviado por email e submete a nova password
curl -X POST http://localhost:3000/auth/password/reset \
  -H 'content-type: application/json' \
  -d '{"token":"<token-from-email>","password":"a-new-strong-password"}'
```

Em código os mesmos passos são `auth.requestPasswordReset(email)` (devolve
`{ user, token }` ou `null` quando nenhuma conta corresponde) e
`auth.resetPassword(token, newPassword)`. Concluir uma reposição **termina a sessão do
utilizador em todo o lado** — todas as sessões e refresh tokens são revogados. A
verificação de email funciona de forma idêntica: hook `auth:verify_requested`, rotas
`POST /auth/verify/request` e `POST /auth/verify` (token válido 24h).

## API keys

`apiKeysPlugin()` autentica chaves `mk_live_…` (via `Authorization: Bearer` ou
`x-api-key`) e impõe `meta.scopes` nas rotas. As chaves têm âmbito de tenant, são
criadas por um utilizador autenticado através de `apiKeyRoutes()`, e guardadas apenas
como um hash SHA-256 mais um prefixo curto de exibição — o texto simples é mostrado
exatamente uma vez.

```ts
import { authPlugin, apiKeysPlugin, apiKeyRoutes, authRoutes, MemoryUserSource } from '@basaltkit/auth'

const users = new MemoryUserSource()
const app = await createApp({
  plugins: [
    authPlugin({ users, secret: process.env.AUTH_SECRET! }),
    apiKeysPlugin({ users }), // passa `users` para que uma chave com userId também defina ctx().user
    fastifyPlugin({
      routes: [
        ...authRoutes(),
        ...apiKeyRoutes(), // POST /apikeys, GET /apikeys, DELETE /apikeys/:id (todas requerem login)
        route({
          method: 'GET',
          url: '/reports',
          meta: { scopes: ['reports:read'] }, // precisa de uma chave com este scope (ou `*`)
          async handler() {
            const key = ctx().apiKey // { id, scopes, tenantId?, userId? }
            return { ok: true, keyId: key?.id }
          },
        }),
      ],
    }),
  ],
}).boot()
```

Emite uma chave em código com o serviço `ApiKeys` (o texto simples aparece só aqui):

```ts
import { API_KEYS } from '@basaltkit/auth'
const apiKeys = app.container.get(API_KEYS)
const { record, key } = await apiKeys.issue({ name: 'CI pipeline', scopes: ['reports:read'] })
// key = 'mk_live_…' → mostra uma vez, nunca guardes; record tem prefix/scopes mas não o hash
```

::: warning Aviso
Regista ambos os plugins. Um bearer com prefixo `mk_` é ignorado pelo `authPlugin` e
tratado pelo `apiKeysPlugin`. Se as chaves "não funcionam", provavelmente falta-te o
`apiKeysPlugin()`.
:::

## Bloqueio por força bruta

Ativo por padrão: 5 tentativas falhadas por email em 15 minutos → `AccountLockedError`
(429 `AUTH_LOCKED`); um login bem-sucedido limpa o contador. Ajusta-o ou desativa-o:

```ts
import { authPlugin, LoginThrottle } from '@basaltkit/auth'

authPlugin({
  users,
  secret: process.env.AUTH_SECRET!,
  loginThrottle: new LoginThrottle({ maxAttempts: 3, windowMs: 10 * 60_000 }),
  // loginThrottle: false // desativa-o — não recomendado (usa em testes)
})
```

## Códigos de erro

| Erro | Código | HTTP |
| --- | --- | --- |
| `InvalidCredentialsError` | `AUTH_INVALID_CREDENTIALS` | 401 |
| `EmailTakenError` | `AUTH_EMAIL_TAKEN` | 409 |
| `RefreshInvalidError` / `RefreshReusedError` | `AUTH_REFRESH_INVALID` / `AUTH_REFRESH_REUSED` | 401 |
| `AuthRequiredError` | `AUTH_REQUIRED` | 401 |
| `TokenInvalidError` / `TokenExpiredError` | `AUTH_TOKEN_INVALID` / `AUTH_TOKEN_EXPIRED` | 401 |
| `AuthTokenInvalidError` (links de verify/reset) | `AUTH_TOKEN_INVALID` | 400 |
| `UserUpdateUnsupportedError` | `AUTH_UPDATE_UNSUPPORTED` | 500 |
| `MfaRequiredError` / `MfaInvalidCodeError` / `MfaNotEnrolledError` | `AUTH_MFA_*` | 401 / 401 / 400 |
| `AccountLockedError` | `AUTH_LOCKED` | 429 |
| `ScopeRequiredError` | `AUTH_SCOPE_REQUIRED` | 403 |

## Eventos

Cada passo emite um evento — `auth:login`, `auth:login_failed`, `auth:registered`,
`auth:logout`, `auth:verify_requested`, `auth:email_verified`,
`auth:password_reset_requested`, `auth:password_reset`, `auth:mfa_enabled`,
`auth:mfa_disabled`, `auth:apikey_issued`, `auth:apikey_revoked` — consumidos
gratuitamente por [audit](/pt/reference/packages) e notificações.

Para a ligação completa ponta a ponta (encanamento de email, teams e billing), vê o
[cookbook do ciclo de vida da conta](/pt/cookbook/account-lifecycle).
