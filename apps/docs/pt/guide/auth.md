# Autenticação

`@basaltkit/auth` fornece autenticação completa do lado do servidor com os dados na
**tua** base de dados — sem dependência de fornecedor. Hashing de passwords, JWT com
rotação de refresh, sessões, MFA (TOTP), passkeys, login social, API keys e rotas
prontas a usar. Responde a *quem está a chamar*; deliberadamente não responde a *o
que essa pessoa pode fazer* — isso é [autorização](/pt/guide/authorization) — e é
desacoplado da framework HTTP, pelo que a mesma ligação funciona em Fastify, Express
e Hono (vê [Adaptadores](/pt/guide/adapters)).

[[toc]]

## Modelo mental

Cinco peças, e só ligas as duas primeiras à mão:

| Peça | Registada por | O que faz |
| --- | --- | --- |
| **Enricher** | `authPlugin` | Lê `Authorization: Bearer <jwt>` ou `x-session-id` e define `ctx().user`. **Sem** credenciais → o pedido fica anónimo, sem erro. Um token *explicitamente* inválido ou expirado → `401` |
| **Guard** | `authPlugin` | Uma rota que declara `meta: { auth: true }` exige `ctx().user` — anónimo → `401 AUTH_REQUIRED` |
| **Enricher + guard** | `apiKeysPlugin` | Autentica bearers com prefixo `mk_` / `x-api-key` para `ctx().apiKey`, e impõe `meta.scopes` |
| **Serviço `Auth`** | `authPlugin`, token `AUTH` | Tudo o que as rotas chamam: registo, login, refresh, sessões, verificação, reposição, MFA. Alcança-o com `app.container.get(AUTH)` |
| **Rotas** | `authRoutes()` · `mfaRoutes()` · `apiKeyRoutes()` · `oauthRoutes()` | Invólucros finos e substituíveis sobre o serviço |

Duas durações de token sustentam a sessão: um **access token** curto (JWT, 15m)
enviado em cada pedido, e um **refresh token** longo (30d) trocado por um novo par.
O refresh é rotativo com deteção de reutilização — repetir um token já consumido
revoga a família inteira.

::: tip O `meta.auth` é um pedido de proteção, e é verificado no arranque
O `authPlugin` reivindica a chave de meta `auth`. Uma rota que declara `meta.auth`
sem o `authPlugin` registado serviria desprotegida, por isso cada adaptador recusa
arrancar com `UnguardedRouteMetaError` (`HTTP_UNGUARDED_ROUTE_META`) — detalhado em
*Proteger rotas* mais abaixo.
:::

## Configuração

O arranque mais rápido usa os stores em memória — perfeitos para experimentar, mas
tudo desaparece ao reiniciar. Regista o plugin e as rotas prontas a usar:

```ts
import { createApp } from '@basaltkit/core'
import { fastifyPlugin, FASTIFY } from '@basaltkit/fastify'
import { authPlugin, authRoutes, MemoryUserSource } from '@basaltkit/auth'

const app = await createApp({
  plugins: [
    authPlugin({
      users: new MemoryUserSource(), // em produção: implementa UserSource sobre a tua BD
      secret: process.env.AUTH_SECRET!, // assina os JWTs (HS256) — mantém-no secreto
      accessTtl: '15m', // access token de curta duração (predefinição)
      refreshTtl: '30d', // refresh token de longa duração (predefinição)
    }),
    fastifyPlugin({ routes: authRoutes() }),
  ],
}).boot()

await app.container.get(FASTIFY).listen({ port: 3000 })
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
| `POST /auth/register` | `{ email, password }` | Sempre `202 { ok: true }` — à prova de enumeração (ver abaixo) |
| `POST /auth/login` | `{ email, password, mfaCode? }` | → `{ user, accessToken, refreshToken }` |
| `POST /auth/refresh` | `{ refreshToken }` | novo par de tokens; mata a família em caso de reutilização |
| `POST /auth/logout` | `{ refreshToken }` | `204`; revoga a família de refresh |
| `GET /auth/me` | — | `meta.auth` — requer `Authorization: Bearer <jwt>` |
| `POST /auth/verify/request` · `POST /auth/verify` | `{ email }` · `{ token }` | verificação de email |
| `POST /auth/password/forgot` · `POST /auth/password/reset` | `{ email }` · `{ token, password }` | reposição de password |

A `password` é validada com `min(8)` e o `email` como endereço de email em todas as
rotas que os recebem — uma password mais curta é um erro de validação `400`, não uma
conta fraca.

::: tip Nada aqui revela se uma conta existe
O `POST /auth/register` responde o mesmo `202 { ok: true }` para um registo novo e
para um email já existente, e faz *trabalho equivalente* (continua a fazer o hash da
password) para que o tempo de resposta também coincida. A colisão é sinalizada fora
de banda através do hook `auth:register_existing_email` — envia um email à morada a
dizer "já tens conta, entra ou repõe a password" em vez de deixar escapar a
existência na resposta HTTP. Define `enumerationSafeRegister: false` para voltar ao
comportamento antigo de `409 AUTH_EMAIL_TAKEN`; o `auth.register()` de nível mais
baixo lança sempre num duplicado, independentemente disso.

As rotas `verify/request` e `password/forgot` respondem `200` pela mesma razão; os
seus tokens são enviados por email através dos hooks `auth:verify_requested` /
`auth:password_reset_requested`, nunca devolvidos por HTTP. Uma reposição de password
concluída revoga todas as sessões e refresh tokens.
:::

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

O consumo é um **compare-and-swap**, não um ler-depois-escrever: o `markUsed`
marca o token como usado só se ele ainda estiver por usar e reporta se foi
*esta* chamada a fazê-lo. Dois refreshes concorrentes do mesmo token — o cliente
legítimo e um ladrão a correr com ele — resolvem-se em exatamente um vencedor e
um `RefreshReusedError`; sem o CAS ambos teriam sucesso e a deteção de reutilização
nunca dispararia. O mesmo se aplica aos tokens de uso único de verificação e
reposição.

::: tip Escrever o teu próprio store
`AuthTokenStore.markUsed` e `RefreshTokenStore.markUsed` devolvem
`Promise<boolean | void>`. Torna o update condicional (`WHERE token = ? AND
used_at IS NULL`) e devolve se alterou alguma linha. Devolver `void` mantém o
comportamento antigo de ler-depois-escrever — continua a compilar e a correr,
mas sem a proteção contra a race.
:::

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

### O `meta.auth` é verificado no arranque

Declarar `meta.auth` é um *pedido* de proteção; quem o impõe é o guard que o
`authPlugin` regista. Uma rota que pede proteção que ninguém impõe serviria
desprotegida e responderia `200` — por isso cada adaptador corre a verificação de
meta protegida ao registar as rotas e **recusa arrancar**:

```
UnguardedRouteMetaError: Refusing to boot: 1 route(s) declare security meta that
NO registered guard enforces — they would serve unprotected:
  - GET /me declares meta.auth
```

O erro carrega `code: 'HTTP_UNGUARDED_ROUTE_META'` e nomeia todos os infratores. A
correção é normalmente registar o plugin que impõe: `auth` → `authPlugin`,
`can` → `permissionsPlugin`, `teamRole` → `teamsPlugin`. Quando a proteção acontece
genuinamente numa fronteira exterior (um gateway de API que já autentica), desliga a
verificação explicitamente no adaptador:

```ts
fastifyPlugin({ routes, allowUnguardedMeta: ['auth'] }) // ou `true` para todas as chaves
```

O `meta: { auth: false }` é uma desativação explícita, não um pedido de proteção, e
nunca é assinalado. A mesma opção existe no `expressPlugin` e no `honoPlugin` — vê
[Adaptadores](/pt/guide/adapters) — e a separação guard/meta está explicada em
[Autorização](/pt/guide/authorization).

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

## Passkeys (WebAuthn)

As passkeys deixam os utilizadores entrar com Face ID, Touch ID ou uma chave de
segurança física — sem password para phishing ou fugas. O Basalt conduz toda a
cerimónia (challenges, opções do browser, storage de credenciais, challenges de uso
único, o contador de deteção de clone) e delega só a criptografia a um pequeno
verifier que implementas sobre [`@simplewebauthn/server`](https://simplewebauthn.dev),
por isso a framework não carrega dependência WebAuthn.

```ts
import { webauthnPlugin, type WebAuthnVerifier } from '@basaltkit/auth'
import { verifyRegistrationResponse, verifyAuthenticationResponse } from '@simplewebauthn/server'

const verifier: WebAuthnVerifier = {
  async verifyRegistration(i) {
    const v = await verifyRegistrationResponse({
      response: i.response as never,
      expectedChallenge: i.expectedChallenge,
      expectedOrigin: i.expectedOrigin,
      expectedRPID: i.expectedRpId,
      requireUserVerification: i.requireUserVerification,
    })
    if (!v.verified || !v.registrationInfo) return { verified: false }
    const c = v.registrationInfo.credential
    return { verified: true, credential: {
      id: c.id, publicKey: Buffer.from(c.publicKey).toString('base64url'), counter: c.counter,
    } }
  },
  async verifyAuthentication(i) {
    const v = await verifyAuthenticationResponse({
      response: i.response as never,
      expectedChallenge: i.expectedChallenge,
      expectedOrigin: i.expectedOrigin,
      expectedRPID: i.expectedRpId,
      requireUserVerification: i.requireUserVerification,
      credential: {
        id: i.credential.id,
        publicKey: Buffer.from(i.credential.publicKey, 'base64url'),
        counter: i.credential.counter,
      },
    })
    return { verified: v.verified, newCounter: v.authenticationInfo?.newCounter ?? i.credential.counter }
  },
}

app.use(webauthnPlugin({
  config: { rpId: 'example.com', rpName: 'Example', origin: 'https://example.com' },
  verifier,
}))
```

### Os quatro passos

Resolve o serviço a partir do token `WEBAUTHN` e conduz a partir das tuas rotas. O
`sessionKey` liga um challenge à sessão atual — o id do utilizador quando autenticado,
ou um id de sessão para login sem sessão iniciada.

```ts
import { WEBAUTHN } from '@basaltkit/auth'
const passkeys = container.get(WEBAUTHN)

// 1. Registo — um utilizador autenticado adiciona uma passkey
const regOptions = await passkeys.startRegistration(sessionKey, { id: user.id, name: user.email })
// → @simplewebauthn/browser startRegistration(regOptions), depois faz POST do resultado:
await passkeys.finishRegistration(sessionKey, user.id, browserResponse, 'MacBook')

// 2. Entrar — sem username: omite o userId
await passkeys.startAuthentication(sessionKey)
const { userId } = await passkeys.finishAuthentication(sessionKey, browserResponse)
// → emite a tua sessão / JWT para userId
```

O `finishAuthentication` procura a credencial pelo id, verifica-a, confirma que o
contador de assinatura **aumentou** (um clone lança `PasskeyClonedError`), e guarda o
novo contador. Usa `passkeys.list(userId)` / `passkeys.remove(id)` para um ecrã de
"gerir dispositivos".

::: warning Security
O challenge é vinculado ao utilizador que passas ao `startRegistration`; o
`finishRegistration` lança `WEBAUTHN_SUBJECT_MISMATCH` se o `userId` for diferente,
por isso uma passkey nunca pode ser vinculada à conta de outra pessoa — tira sempre o
`userId` da sessão autenticada, nunca do input do pedido. Em produção, troca os
`PasskeyStore` / `WebAuthnChallengeStore` em memória por versões duráveis.
:::

## Login social (OAuth)

Entra com Google ou GitHub via o fluxo *authorization-code* do OAuth 2.0 — sem
SDK e sem cookies: o `state` (CSRF) é assinado com HMAC e é stateless.

```ts
import {
  authPlugin, oauthPlugin, oauthRoutes, authRoutes, googleProvider, githubProvider,
} from '@basaltkit/auth'

createApp({
  plugins: [
    authPlugin({ users, secret: env.APP_SECRET }),
    oauthPlugin({
      secret: env.APP_SECRET, // assina o state
      providers: [
        googleProvider({ clientId: env.GOOGLE_ID, clientSecret: env.GOOGLE_SECRET }),
        githubProvider({ clientId: env.GITHUB_ID, clientSecret: env.GITHUB_SECRET }),
      ],
    }),
  ],
})

// regista as rotas
fastifyPlugin({ routes: [...authRoutes(), ...oauthRoutes({ callbackBaseUrl: 'https://app.example.com' })] })
```

São adicionadas duas rotas por provider:

- `GET /auth/oauth/:provider` → redireciona para o provider. Regista
  `${callbackBaseUrl}/auth/oauth/:provider/callback` como o redirect URI do provider.
- `GET /auth/oauth/:provider/callback` → verifica o state, troca o code e faz o
  login do utilizador. A resposta é JSON `{ user, accessToken, refreshToken }`;
  passa `successRedirect` para devolver o browser à tua SPA com os tokens no
  fragmento do URL.

As contas novas são criadas **sem password** (autenticam via provider até definires
uma password); um email verificado pelo provider ativa o `emailVerified`. O
`Auth.socialLogin(email)` é a primitiva subjacente se ligares um provider próprio.

::: warning As contas são associadas por email
Confia apenas em providers que devolvem um email **verificado**. O Google e o
provider GitHub incorporado fazem-no — o driver do GitHub lê o endereço primário
*verificado*.
:::

### SSO empresarial (OIDC)

Qualquer IdP OpenID Connect — Okta, Azure AD / Entra ID, Auth0, Google Workspace,
Keycloak — encaixa como provider. Passa os três endpoints, ou deixa o
`discoverOidcProvider` lê-los do `.well-known/openid-configuration` do IdP:

```ts
import { oidcProvider, discoverOidcProvider, oauthPlugin } from '@basaltkit/auth'

// endpoints explícitos…
oidcProvider({ name: 'okta', authorizeUrl, tokenUrl, userInfoUrl, clientId, clientSecret })

// …ou por descoberta (await no arranque)
const okta = await discoverOidcProvider({ name: 'okta', issuer: 'https://acme.okta.com', clientId, clientSecret })
oauthPlugin({ secret: env.APP_SECRET, providers: [okta] })
```

Para IdPs **SAML 2.0** legados (ADFS, Shibboleth, ou um IdP configurado para SAML),
usa o pacote companheiro **`@basaltkit/auth-saml`** — SSO iniciado pelo SP construído
sobre a biblioteca de XML-DSig auditada `@node-saml/node-saml`, que encaixa no mesmo
`Auth.socialLogin`:

```ts
import { samlPlugin, samlRoutes } from '@basaltkit/auth-saml'

samlPlugin({ providers: [{ name: 'okta', entryPoint, idpCert, issuer, callbackUrl }] })
// rotas: GET /auth/saml/:provider/login · POST …/acs · GET …/metadata
```

As assertions têm de ser assinadas (`wantAssertionsSigned`) **e** ligadas a um
login que esta app iniciou: o `validateInResponseTo` tem omissão `'ifPresent'`,
por isso uma resposta que traga um `InResponseTo` tem de corresponder a um
AuthnRequest pendente e ainda não consumido. Isso fecha a janela em que um
`SAMLResponse` capturado pode ser reproduzido até ao seu `NotOnOrAfter`.

| Opção | Tipo | Omissão | Propósito |
| --- | --- | --- | --- |
| `providers` | `SamlProvider[]` | — (obrigatória) | IdPs: `name`, `entryPoint`, `idpCert`, `issuer`, `callbackUrl`, `emailAttribute` opcional |
| `validateInResponseTo` | `'never' \| 'ifPresent' \| 'always'` | `'ifPresent'` | Proteção contra replay — liga a resposta a um AuthnRequest emitido por este SP |
| `cacheProvider` | `SamlCacheProvider` | cache em processo do node-saml | Onde vivem os ids de AuthnRequest pendentes — **obrigatório em deployments com várias réplicas** |
| `createClient` | `(provider) => SamlClient` | node-saml | Fábrica do cliente subjacente (testes) |
| `host` | `string` | — | Host usado ao construir o AuthnRequest |

::: warning SAML com várias réplicas precisa de um `cacheProvider` partilhado
Os ids de pedido usam por omissão uma cache **em processo**. Com várias réplicas
sem sessões pegajosas, um login iniciado numa réplica e a regressar noutra falha
com `AUTH_SAML_RESPONSE_INVALID`. Passa um `cacheProvider` partilhado (Redis, a
tua base de dados), ou opta por sair com `validateInResponseTo: 'never'` e
aceita a janela de replay.
:::

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

## Referência de opções

`authPlugin(options)` — todas as opções do serviço `Auth` exceto `hooks`, que o
plugin fornece:

| Opção | Tipo | Predefinição | Propósito |
| --- | --- | --- | --- |
| `users` | `UserSource` | — (obrigatório) | Onde vivem as contas. `MemoryUserSource` em dev; `auth-sqlite`/`auth-prisma`, ou os teus quatro métodos sobre as tuas tabelas |
| `secret` | `string` | — (obrigatório) | Chave de assinatura HS256 dos access tokens. Rejeitada vazia, e rejeitada abaixo de 32 caracteres com `NODE_ENV=production` (`AUTH_WEAK_SECRET`) |
| `hasher` | `PasswordHasher` | `new ScryptPasswordHasher()` | Hashing de passwords. Troca por uma implementação argon2id sem mexer nos pontos de chamada |
| `sessions` | `SessionStore` | em memória | Sessões por cookie/`x-session-id` — troca para durabilidade |
| `refreshTokens` | `RefreshTokenStore` | em memória | Famílias de refresh tokens; em memória significa que cada redeploy expulsa toda a gente |
| `tokens` | `AuthTokenStore` | em memória | Tokens de verificação de email e de reposição de password |
| `mfa` | `MfaStore` | em memória | Estado de inscrição TOTP e códigos de recuperação |
| `accessTtl` | `DurationInput` | `'15m'` | Duração do access token. Curta por desenho — é o refresh token que sustenta a sessão |
| `refreshTtl` | `DurationInput` | `'30d'` | Duração do refresh token — na prática, "quanto tempo até o utilizador ter de entrar outra vez" |
| `sessionTtl` | `DurationInput` | `'30d'` | Duração da sessão do lado do servidor |
| `verificationTtl` | `DurationInput` | `'24h'` | Duração do link de verificação de email |
| `resetTtl` | `DurationInput` | `'1h'` | Duração do link de reposição de password; mantém-na curta |
| `loginThrottle` | `LoginThrottle \| false` | `new LoginThrottle()` (5 por 15m, por email) | Bloqueio por força bruta por email. `false` desativa-o — só em testes |
| `ipLoginThrottle` | `LoginThrottle \| false` | `new LoginThrottle({ maxAttempts: 50, windowMs: 900_000 })` | Orçamento por IP que apanha *password spraying* (uma tentativa em muitas contas), que um contador por email não vê. Só se aplica quando quem chama passa o ip do cliente — o `authRoutes()` passa |
| `enumerationSafeRegister` | `boolean` | `true` | Impede que o `POST /auth/register` revele que um email já tem conta. `false` repõe o `409 AUTH_EMAIL_TAKEN` |
| `tokenVersions` | `TokenVersionStore` | — (desligado) | **Revogação** opcional de access tokens: os tokens levam uma claim `tv` que o `resetPassword`/`revokeAllTokens` incrementa, matando os tokens em circulação antes do TTL. Custa uma leitura ao store por pedido autenticado |
| `mfaEncryptionKey` | `string \| Buffer` | — (texto simples) | Cifra os segredos TOTP em repouso com AES-256-GCM (envelopes `v1:`), para que uma fuga da base de dados não recupere um segundo fator vivo. As linhas em texto simples existentes continuam a funcionar e são cifradas na escrita seguinte |
| `mfaIssuer` | `string` | `'Basalt'` | Nome do emissor mostrado na app autenticadora |

`new LoginThrottle(options)`:

| Opção | Tipo | Predefinição | Propósito |
| --- | --- | --- | --- |
| `maxAttempts` | `number` | `5` | Tentativas falhadas permitidas dentro da janela |
| `windowMs` | `number` | `900_000` (15m) | Janela deslizante; um login bem-sucedido limpa o contador |
| `clock` | `() => number` | `Date.now` | Relógio injetável (testes) |

`apiKeysPlugin(options)`:

| Opção | Tipo | Predefinição | Propósito |
| --- | --- | --- | --- |
| `store` | `ApiKeyStore` | em memória | Onde vivem os hashes das chaves — durável em produção, ou as chaves morrem no redeploy |
| `header` | `string` | `'x-api-key'` | Header alternativo ao `Authorization: Bearer mk_…` |
| `users` | `UserSource` | — | Quando definido, uma chave com `userId` também preenche `ctx().user`, para que as rotas protegidas por scopes leiam o utilizador que age |
| `now` | `() => number` | `Date.now` | Relógio injetável (testes) |

`webauthnPlugin(options)` e a sua `config`:

| Opção | Tipo | Predefinição | Propósito |
| --- | --- | --- | --- |
| `verifier` | `WebAuthnVerifier` | — (obrigatório) | A fronteira criptográfica que implementas sobre o `@simplewebauthn/server`, para que a framework não carregue nenhuma dependência WebAuthn |
| `credentials` | `PasskeyStore` | `new MemoryPasskeyStore()` | Passkeys registadas — troca por um store durável |
| `challenges` | `WebAuthnChallengeStore` | `new MemoryWebAuthnChallengeStore()` | Desafios de cerimónia de uso único |
| `config.rpId` | `string` | — (obrigatório) | Relying Party ID — o teu domínio registável, p. ex. `'example.com'` |
| `config.rpName` | `string` | — (obrigatório) | Nome legível mostrado no diálogo do sistema operativo |
| `config.origin` | `string \| string[]` | — (obrigatório) | Origem(ns) esperada(s), p. ex. `'https://example.com'` |
| `config.challengeTtlMs` | `number` | `300_000` (5m) | Quanto tempo um desafio se mantém utilizável |
| `config.userVerification` | `'required' \| 'preferred' \| 'discouraged'` | `'preferred'` | Se o autenticador tem de verificar o utilizador (PIN/biometria) |
| `config.timeoutMs` | `number` | `60_000` | Tempo limite da cerimónia anunciado ao browser |
| `config.pubKeyCredParams` | `PublicKeyParam[]` | ES256 + RS256 | Sobrepõe os algoritmos de assinatura aceites |

`oauthPlugin(options)` e `oauthRoutes(options)`:

| Opção | Tipo | Predefinição | Propósito |
| --- | --- | --- | --- |
| `providers` | `OAuthProvider[]` | — (obrigatório) | `googleProvider()`, `githubProvider()`, `oidcProvider()` / `discoverOidcProvider()` — uma entrada por IdP |
| `secret` | `string` | — (obrigatório) | Chave HMAC que assina o `state` de CSRF; tipicamente o mesmo `APP_SECRET` |
| `stateTtlMs` | `number` | `600_000` (10m) | Quanto tempo um `state` assinado se mantém válido — a janela para concluir o redirecionamento |
| `fetch` | `typeof fetch` | `fetch` global | Cliente HTTP injetado (testes) |
| `now` | `() => number` | `Date.now` | Relógio injetável (testes) |
| `callbackBaseUrl` (rotas) | `string` | — (obrigatório) | URL base pública da tua app; o redirect URI é `${callbackBaseUrl}/auth/oauth/:provider/callback` e tem de ser registado em cada fornecedor |
| `successRedirect` (rotas) | `string` | — (resposta JSON) | Devolve o browser para aqui com `#access_token=…&refresh_token=…` em vez de responder JSON — o fluxo para SPA |

Regista o `oauthPlugin` **depois** do `authPlugin`: o serviço resolve o `AUTH` para
autenticar os utilizadores.

## Modos de falha & resolução de problemas

| Erro | Código | HTTP | Quando |
| --- | --- | --- | --- |
| `InvalidCredentialsError` | `AUTH_INVALID_CREDENTIALS` | 401 | Email desconhecido ou password errada — deliberadamente indistinguíveis, e com custo igual |
| `EmailTakenError` | `AUTH_EMAIL_TAKEN` | 409 | `auth.register()` sobre um email existente (a *rota* mantém-se à prova de enumeração, salvo `enumerationSafeRegister: false`) |
| `AuthRequiredError` | `AUTH_REQUIRED` | 401 | Uma rota com `meta.auth` (ou uma rota de MFA) correu sem `ctx().user` |
| `TokenInvalidError` / `TokenExpiredError` | `AUTH_TOKEN_INVALID` / `AUTH_TOKEN_EXPIRED` | 401 | O **access token** apresentado está malformado/mal assinado, ou passou o TTL |
| `AuthTokenInvalidError` | `AUTH_TOKEN_INVALID` | 400 | Um token de **link** de verificação ou reposição é desconhecido, já usado ou expirado |
| `RefreshInvalidError` | `AUTH_REFRESH_INVALID` | 401 | Refresh token desconhecido, revogado ou expirado |
| `RefreshReusedError` | `AUTH_REFRESH_REUSED` | 401 | Um refresh token já **consumido** voltou — indicador de roubo; a família inteira é revogada |
| `MfaRequiredError` | `AUTH_MFA_REQUIRED` | 401 | Password correta, MFA ativo, sem `mfaCode`. Não conta como tentativa falhada |
| `MfaInvalidCodeError` | `AUTH_MFA_INVALID` | 401 | Código TOTP ou de recuperação errado — este **conta** para o throttle |
| `MfaNotEnrolledError` | `AUTH_MFA_NOT_ENROLLED` | 400 | Ativar/desativar MFA sem nenhuma inscrição em curso |
| `AccountLockedError` | `AUTH_LOCKED` | 429 | O orçamento de logins falhados por email ou por IP esgotou-se; traz `retryAfterMs` |
| `UserUpdateUnsupportedError` | `AUTH_UPDATE_UNSUPPORTED` | 500 | O teu `UserSource` não tem `update()` — obrigatório para verificação e reposição |
| `WeakJwtSecretError` | `AUTH_WEAK_SECRET` | arranque | `secret` em falta, ou com menos de 32 caracteres com `NODE_ENV=production` |
| `ScopeRequiredError` | `AUTH_SCOPE_REQUIRED` | 403 | Uma rota com `meta.scopes` foi chamada sem uma API key que tenha esse scope (ou `*`) |
| `ApiKeyForbiddenError` | `AUTH_APIKEY_NOT_FOUND` | 404 | `DELETE /apikeys/:id` para uma chave fora do âmbito tenant/utilizador de quem chama — um 404, nunca um 403, para que os ids das chaves não possam ser sondados |
| `WebAuthnChallengeError` | `WEBAUTHN_CHALLENGE_INVALID` | 400 | O desafio da passkey expirou ou já foi usado (são de uso único) |
| `WebAuthnVerificationError` | `WEBAUTHN_VERIFICATION_FAILED` | 400 | O verifier rejeitou a resposta do browser |
| `WebAuthnSubjectMismatchError` | `WEBAUTHN_SUBJECT_MISMATCH` | 403 | O `finishRegistration` recebeu um `userId` diferente daquele para quem o desafio foi emitido |
| `PasskeyNotFoundError` | `PASSKEY_NOT_FOUND` | 404 | Nenhuma credencial guardada corresponde ao id apresentado |
| `PasskeyClonedError` | `PASSKEY_CLONED` | 401 | O contador de assinaturas não aumentou — o autenticador pode estar clonado |
| `PasskeyExistsError` | `PASSKEY_EXISTS` | 409 | Essa credencial já está registada |
| `OAuthProviderUnknownError` | `AUTH_OAUTH_UNKNOWN_PROVIDER` | 404 | O `:provider` não está no array `providers` |
| `OAuthStateInvalidError` | `AUTH_OAUTH_STATE_INVALID` | 400 | O `state` de CSRF está em falta, foi adulterado, ou é mais velho que `stateTtlMs` |
| `OAuthExchangeError` | `AUTH_OAUTH_EXCHANGE_FAILED` | 502 | O fornecedor rejeitou a troca do código ou a obtenção do perfil falhou |
| `SamlResponseInvalidError` | `AUTH_SAML_RESPONSE_INVALID` | 400 | A assertion falhou a validação — assinatura errada, expirada, ou (com `validateInResponseTo`) um `InResponseTo` que esta réplica nunca emitiu |
| `UnguardedRouteMetaError` | `HTTP_UNGUARDED_ROUTE_META` | arranque | Uma rota declara `meta.auth` e o `authPlugin` não está registado |

- **Todos os pedidos ficam anónimos mesmo com um `Authorization` válido** —
  confirma que o bearer não tem o prefixo `mk_` (esses pertencem ao
  `apiKeysPlugin`), e que o `authPlugin` está registado *antes* do plugin do
  adaptador, para que o seu enricher esteja no pipeline.
- **`401 AUTH_REQUIRED` numa rota que julgavas pública** — ficou lá o `meta.auth`.
  E se a app recusa *arrancar* com `HTTP_UNGUARDED_ROUTE_META`, é o problema
  inverso: a meta está lá, o plugin não.
- **`AUTH_REFRESH_REUSED` logo a seguir a um login normal** — dois clientes (ou um
  pedido repetido) fizeram refresh com o mesmo token. A rotação é de uso único por
  token; serializa os refreshes no cliente, não os repitas às cegas.
- **Toda a gente é expulsa depois de um redeploy** — os stores `Memory*` são por
  processo. Passa `refreshTokens`/`sessions` para `auth-sqlite` ou `auth-prisma`.
- **`AUTH_UPDATE_UNSUPPORTED` na verificação ou na reposição** — o teu `UserSource`
  personalizado omite o `update()`. É opcional para o login, obrigatório para estes.
- **`AUTH_LOCKED` para um utilizador que escreveu a password certa** — o orçamento
  por *IP* pode disparar primeiro com NAT partilhado ou num teste de carga. Ajusta o
  `ipLoginThrottle`, e lembra-te de que ambos os throttles são em processo: com
  várias réplicas, o orçamento efetivo é por réplica.
- **`AUTH_WEAK_SECRET` só em produção** — o mínimo de comprimento é imposto com
  `NODE_ENV=production`; um secret de tamanho de dev arranca localmente e falha no
  deploy.

## Eventos

| Hook | Payload | Uso típico |
| --- | --- | --- |
| `auth:registered` | `{ user }` | Email de boas-vindas, provisionamento |
| `auth:register_existing_email` | `{ email }` | O email fora de banda "já tens conta" — o sinal que a resposta HTTP retém deliberadamente |
| `auth:login` · `auth:login_failed` | `{ user }` · `{ email }` | Trilho de auditoria, alertas |
| `auth:logout` | `{ user }` | Trilho de auditoria |
| `auth:verify_requested` · `auth:email_verified` | `{ user, token }` · `{ user }` | **Envia o token por email** — nunca é devolvido por HTTP |
| `auth:password_reset_requested` · `auth:password_reset` | `{ user, token }` · `{ user }` | **Envia o token por email**; o segundo confirma a alteração |
| `auth:mfa_enabled` · `auth:mfa_disabled` | `{ user }` | Notificação de segurança |
| `auth:apikey_issued` · `auth:apikey_revoked` | `{ id, tenantId?, userId? }` · `{ id }` | Trilho de auditoria |

São consumidos gratuitamente pelo audit e pelas notificações (vê
[Pacotes](/pt/reference/packages)). Para a ligação completa ponta a ponta —
encanamento de email, teams e billing — vê o
[cookbook do ciclo de vida da conta](/pt/cookbook/account-lifecycle).
