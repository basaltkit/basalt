# @machize/auth

Autenticação completa para aplicações Machize: registo e login de utilizadores, tokens JWT com renovação segura, sessões, verificação de email, recuperação de palavra-passe, autenticação de dois fatores (MFA/TOTP) e chaves de API — tudo com rotas HTTP prontas a usar.

Precisas deste módulo sempre que a tua aplicação tiver utilizadores que fazem login.

## O que este módulo resolve

Quando uma aplicação tem contas de utilizadores, precisa de responder a duas perguntas em cada pedido: "quem és tu?" (autenticação) e "como provas isso?". Fazer isto à mão é difícil e perigoso — guardar palavras-passe de forma segura, gerar e validar **tokens** (pequenos "bilhetes" digitais que provam a identidade sem enviar a palavra-passe em cada pedido), impedir ataques de força bruta, etc.

O `@machize/auth` trata de tudo isto por ti. As palavras-passe nunca são guardadas em texto simples — só uma versão irreversivelmente baralhada (**hash**, com o algoritmo scrypt). O login devolve um par de tokens: um **access token** (JWT de curta duração, 15 minutos por omissão, que acompanha cada pedido) e um **refresh token** (de longa duração, 30 dias, usado apenas para obter um novo access token). Se um refresh token for usado duas vezes — sinal típico de roubo — toda a "família" de tokens é revogada automaticamente.

Inclui ainda, sem instalar mais nada: bloqueio de conta após demasiadas tentativas falhadas, verificação de email e recuperação de palavra-passe por links de utilização única, MFA por aplicação autenticadora (Google Authenticator, etc.) com códigos de recuperação, e chaves de API para acesso programático (scripts, integrações).

## Instalação

```bash
pnpm add @machize/auth
```

Requisitos: `@machize/core` e `@machize/fastify` (instalados automaticamente como dependências) e `zod` (peer dependency — instala com `pnpm add zod`).

## Começar em 5 minutos

Passo a passo para teres registo e login a funcionar:

1. **Cria a aplicação** com o plugin de auth e as rotas prontas:

```ts
import { createApp } from '@machize/core'
import { fastifyPlugin } from '@machize/fastify'
import { authPlugin, authRoutes, MemoryUserSource } from '@machize/auth'

const app = await createApp({
  plugins: [
    authPlugin({
      users: new MemoryUserSource(), // em produção: a tua base de dados
      secret: process.env.AUTH_SECRET!, // segredo que assina os tokens
    }),
    fastifyPlugin({ routes: authRoutes() }),
  ],
}).boot()
```

2. **Regista um utilizador** (a rota `POST /auth/register` já existe):

```bash
curl -X POST http://localhost:3000/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"ada@exemplo.com","password":"palavrasecreta1"}'
```

3. **Faz login** e recebe os tokens:

```bash
curl -X POST http://localhost:3000/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"ada@exemplo.com","password":"palavrasecreta1"}'
# → { "user": {...}, "accessToken": "...", "refreshToken": "..." }
```

4. **Usa o access token** para aceder a rotas protegidas:

```bash
curl http://localhost:3000/auth/me \
  -H 'authorization: Bearer O_ACCESS_TOKEN_AQUI'
```

5. **Protege as tuas próprias rotas** com `meta: { auth: true }`:

```ts
import { ctx } from '@machize/core'
import { route } from '@machize/fastify'

const minhaRota = route({
  method: 'GET',
  url: '/painel',
  meta: { auth: true }, // sem login → 401 AUTH_REQUIRED
  async handler() {
    return { ola: ctx().user?.email }
  },
})
```

> **Nota:** `MemoryUserSource` guarda os utilizadores em memória — perfeito para experimentar, mas tudo desaparece quando o processo reinicia. Em produção, implementa a interface `UserSource` sobre a tua base de dados (ver abaixo).

## Guia de utilização

### Ligar à tua base de dados (UserSource)

O módulo não impõe nenhuma base de dados. Forneces um objeto que cumpre a interface `UserSource`:

```ts
import type { UserSource, AuthUser, UserPatch } from '@machize/auth'

const users: UserSource = {
  async findByEmail(email) { /* SELECT ... WHERE email = ? */ return null },
  async findById(id) { /* SELECT ... WHERE id = ? */ return null },
  async create(data) {
    // data = { email, passwordHash } — o hash já vem calculado
    return { id: 'novo-id', ...data } as AuthUser
  },
  // Opcional, mas obrigatório para verificação de email e reset de password:
  async update(id, patch: UserPatch) { /* UPDATE ... */ return null },
}
```

### Registo, login e logout (por código)

Todas as operações também estão disponíveis programaticamente através da classe `Auth`:

```ts
import { Auth, MemoryUserSource } from '@machize/auth'

const auth = new Auth({ users: new MemoryUserSource(), secret: 'um-segredo-forte' })

const user = await auth.register('ada@exemplo.com', 'palavrasecreta1')
const { tokens } = await auth.login('ada@exemplo.com', 'palavrasecreta1')
const renovados = await auth.refresh(tokens.refreshToken) // novo par de tokens
await auth.revoke(renovados.refreshToken) // logout: invalida a família de tokens
```

### Proteger rotas

O `authPlugin` regista automaticamente:

- Um **enricher** que lê o header `Authorization: Bearer <jwt>` ou `x-session-id` e coloca o utilizador em `ctx().user` (do tipo `PublicUser` — nunca inclui o hash da palavra-passe).
- Um **guard** que rejeita com 401 qualquer rota com `meta: { auth: true }` sem utilizador autenticado.

Um pedido sem credenciais fica anónimo (não dá erro); um token inválido explícito dá 401.

### Recuperar a palavra-passe

O fluxo tem dois passos. O módulo gera um **token de utilização única** (válido 1 hora por omissão) e emite um hook — a tua aplicação envia o email com o link:

```ts
// 1. Escuta o hook e envia o email (fazes isto uma vez, no arranque)
app.hooks.on('auth:password_reset_requested', async ({ user, token }) => {
  await enviarEmail(user.email, `https://app.exemplo.com/reset?token=${token}`)
})
```

As rotas prontas: `POST /auth/password/forgot` (body `{ email }` — responde sempre 200, para não revelar se o email existe) e `POST /auth/password/reset` (body `{ token, password }`). Após o reset, **todas as sessões e refresh tokens do utilizador são revogados**.

A verificação de email funciona da mesma forma: hook `auth:verify_requested`, rotas `POST /auth/verify/request` e `POST /auth/verify` (token válido 24 horas por omissão).

### MFA — autenticação de dois fatores (TOTP)

**TOTP** é o código de 6 dígitos gerado por aplicações como o Google Authenticator. Regista as rotas:

```ts
import { authRoutes, mfaRoutes } from '@machize/auth'
import { fastifyPlugin } from '@machize/fastify'

fastifyPlugin({ routes: [...authRoutes(), ...mfaRoutes()] })
```

Fluxo (todas as rotas exigem login):

1. `POST /auth/mfa/enroll` → devolve `{ secret, otpauthUri }`; mostra o `otpauthUri` como código QR.
2. `POST /auth/mfa/activate` com `{ code }` (código da app) → ativa e devolve `{ recoveryCodes }` — 10 códigos de recuperação de utilização única, **mostrados uma única vez**.
3. A partir daí, `POST /auth/login` exige o campo extra `mfaCode` (código TOTP ou um código de recuperação). Password certa sem código → erro `AUTH_MFA_REQUIRED`.
4. `GET /auth/mfa/status` e `POST /auth/mfa/disable` (com `{ code }`) completam o ciclo.

### Chaves de API

Para acesso programático (scripts, CI, integrações) sem login interativo. Uma chave tem o formato `mk_live_...`, é mostrada **uma única vez** ao ser criada e só o seu hash SHA-256 fica guardado.

```ts
import { createApp } from '@machize/core'
import { fastifyPlugin, route } from '@machize/fastify'
import {
  authPlugin, authRoutes, apiKeysPlugin, apiKeyRoutes, MemoryUserSource,
} from '@machize/auth'

const users = new MemoryUserSource()
const app = await createApp({
  plugins: [
    authPlugin({ users, secret: process.env.AUTH_SECRET! }),
    apiKeysPlugin({ users }), // autentica chaves e aplica scopes
    fastifyPlugin({
      routes: [
        ...authRoutes(),
        ...apiKeyRoutes(), // POST/GET /apikeys, DELETE /apikeys/:id
        route({
          method: 'GET',
          url: '/relatorios',
          meta: { scopes: ['reports:read'] }, // exige uma chave com este scope
          async handler() { return { ok: true } },
        }),
      ],
    }),
  ],
}).boot()
```

A chave apresenta-se no header `Authorization: Bearer mk_live_...` ou `x-api-key`. Um **scope** é uma permissão granular da chave (ex.: `reports:read`); `*` significa todos. Após autenticar, `ctx().apiKey` contém `{ id, scopes, tenantId?, userId? }`.

### Bloqueio por força bruta (LoginThrottle)

Ativo por omissão: 5 tentativas falhadas por email numa janela de 15 minutos → erro `AUTH_LOCKED` (HTTP 429). Um login bem-sucedido limpa o contador.

```ts
import { authPlugin, LoginThrottle, MemoryUserSource } from '@machize/auth'

authPlugin({
  users: new MemoryUserSource(),
  secret: process.env.AUTH_SECRET!,
  loginThrottle: new LoginThrottle({ maxAttempts: 3, windowMs: 10 * 60_000 }),
  // ou loginThrottle: false para desativar (não recomendado)
})
```

### Hooks (eventos)

A aplicação pode reagir a eventos de autenticação: `auth:registered`, `auth:login`, `auth:login_failed`, `auth:logout`, `auth:verify_requested`, `auth:email_verified`, `auth:password_reset_requested`, `auth:password_reset`, `auth:mfa_enabled`, `auth:mfa_disabled`, `auth:apikey_issued`, `auth:apikey_revoked`.

## Referência da API

### `authPlugin(options)` e classe `Auth`

Opções (`AuthOptions` / `AuthPluginOptions` — o plugin aceita as mesmas menos `hooks`):

| Nome | Tipo | Obrigatório? | Default | Descrição |
|---|---|---|---|---|
| `users` | `UserSource` | Sim | — | De onde vêm os utilizadores (a tua BD). |
| `secret` | `string` | Sim | — | Segredo que assina os JWT (HS256). |
| `hasher` | `PasswordHasher` | Não | `ScryptPasswordHasher` | Algoritmo de hash de palavras-passe. |
| `sessions` | `SessionStore` | Não | `MemorySessionStore` | Armazenamento de sessões. |
| `refreshTokens` | `RefreshTokenStore` | Não | `MemoryRefreshTokenStore` | Armazenamento de refresh tokens. |
| `accessTtl` | `DurationInput` | Não | `'15m'` | Validade do access token. |
| `refreshTtl` | `DurationInput` | Não | `'30d'` | Validade do refresh token. |
| `sessionTtl` | `DurationInput` | Não | `'30d'` | Validade das sessões. |
| `loginThrottle` | `LoginThrottle \| false` | Não | ativo (5/15min) | Bloqueio anti força bruta; `false` desativa. |
| `tokens` | `AuthTokenStore` | Não | `MemoryAuthTokenStore` | Tokens de verificação/reset. |
| `verificationTtl` | `DurationInput` | Não | `'24h'` | Validade do link de verificação de email. |
| `resetTtl` | `DurationInput` | Não | `'1h'` | Validade do link de reset de password. |
| `mfa` | `MfaStore` | Não | `MemoryMfaStore` | Estado de MFA por utilizador. |
| `mfaIssuer` | `string` | Não | `'Machize'` | Nome mostrado na app autenticadora. |
| `hooks` | `HookBus` | Não | — | Só na classe `Auth`; o plugin injeta-o. |

Métodos da classe `Auth`:

| Método | Descrição |
|---|---|
| `register(email, password)` | Cria a conta; lança `EmailTakenError` se o email já existir. |
| `login(email, password, mfaCode?)` | Devolve `{ user, tokens }`; aplica throttle e MFA. |
| `attempt(email, password)` | Verifica credenciais sem efeitos secundários; `null` se falhar. |
| `refresh(refreshToken)` | Novo par de tokens; deteta reutilização e revoga a família. |
| `revoke(refreshToken)` | Logout para clientes com tokens. |
| `verifyAccess(accessToken)` | Valida o JWT e devolve os claims. |
| `createSession(userId)` / `sessionUser(sessionId)` / `logout(sessionId)` | Sessões por cookie/header. |
| `requestEmailVerification(email)` / `verifyEmail(token)` | Verificação de email. |
| `requestPasswordReset(email)` / `resetPassword(token, novaPassword)` | Recuperação de password. |
| `enrollMfa(userId)` / `activateMfa(userId, code)` / `disableMfa(userId, code)` | Ciclo de vida do MFA. |
| `isMfaEnabled(userId)` / `mfaStatus(userId)` / `verifyMfaCode(userId, code)` | Estado e verificação de MFA. |

### Rotas prontas

- `authRoutes()`: `POST /auth/register`, `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`, `GET /auth/me`, `POST /auth/verify/request`, `POST /auth/verify`, `POST /auth/password/forgot`, `POST /auth/password/reset`. São rotas normais — podes omitir ou substituir qualquer uma.
- `apiKeyRoutes()`: `POST /apikeys`, `GET /apikeys`, `DELETE /apikeys/:id` (todas exigem login; limitadas ao tenant/utilizador atual).
- `mfaRoutes()`: `POST /auth/mfa/enroll`, `POST /auth/mfa/activate`, `GET /auth/mfa/status`, `POST /auth/mfa/disable`.

### `apiKeysPlugin(options)` e classe `ApiKeys`

Opções (`ApiKeysPluginOptions`):

| Nome | Tipo | Obrigatório? | Default | Descrição |
|---|---|---|---|---|
| `store` | `ApiKeyStore` | Não | `MemoryApiKeyStore` | Armazenamento das chaves. |
| `header` | `string` | Não | `'x-api-key'` | Header alternativo ao Bearer. |
| `users` | `UserSource` | Não | — | Se dado, uma chave com `userId` também preenche `ctx().user`. |
| `now` | `() => number` | Não | `Date.now` | Relógio injetável (testes). |

Métodos de `ApiKeys`: `issue(input)` (devolve `{ record, key }` — a chave em texto simples só aqui), `verify(presented)`, `list(filter)`, `get(id)`, `revoke(id)`. Auxiliar `scopesSatisfy(granted, required)`.

### Utilitários exportados

| Export | Descrição |
|---|---|
| `signJwt(claims, { secret, expiresIn? })` / `verifyJwt(token, secret)` | JWT HS256 sem dependências. Avançado. |
| `ScryptPasswordHasher` / `PasswordHasher` | Hash de palavras-passe (scrypt, memory-hard). Avançado. |
| `LoginThrottle` (`maxAttempts` def. 5, `windowMs` def. 15 min, `clock`) | Anti força bruta. |
| `generateTotpSecret`, `totp`, `verifyTotp`, `otpauthUri`, `base32Encode`, `base32Decode` | Primitivas TOTP (RFC 6238). Avançado. |
| `publicUser(user)` | Converte `AuthUser` → `PublicUser` (remove o hash). |
| `AUTH`, `API_KEYS` | Tokens de injeção: `container.get(AUTH)` devolve a instância `Auth`. |
| Stores em memória | `MemoryUserSource`, `MemorySessionStore`, `MemoryRefreshTokenStore`, `MemoryAuthTokenStore`, `MemoryApiKeyStore`, `MemoryMfaStore` — dev/testes. |

### Erros exportados

| Erro | Código | HTTP |
|---|---|---|
| `InvalidCredentialsError` | `AUTH_INVALID_CREDENTIALS` | 401 |
| `EmailTakenError` | `AUTH_EMAIL_TAKEN` | 409 |
| `RefreshInvalidError` / `RefreshReusedError` | `AUTH_REFRESH_INVALID` / `AUTH_REFRESH_REUSED` | 401 |
| `AuthRequiredError` | `AUTH_REQUIRED` | 401 |
| `TokenInvalidError` / `TokenExpiredError` | `AUTH_TOKEN_INVALID` / `AUTH_TOKEN_EXPIRED` | 401 |
| `AuthTokenInvalidError` (links de verificação/reset) | `AUTH_TOKEN_INVALID` | 400 |
| `UserUpdateUnsupportedError` | `AUTH_UPDATE_UNSUPPORTED` | 500 |
| `MfaRequiredError` / `MfaInvalidCodeError` / `MfaNotEnrolledError` | `AUTH_MFA_*` | 401/401/400 |
| `AccountLockedError` | `AUTH_LOCKED` | 429 |
| `ScopeRequiredError` | `AUTH_SCOPE_REQUIRED` | 403 |

## Erros comuns e soluções (FAQ)

**"Os utilizadores desaparecem quando reinicio o servidor."** Estás a usar `MemoryUserSource` (e stores em memória). Implementa `UserSource` (e os outros stores) sobre a tua base de dados.

**"401 AUTH_TOKEN_EXPIRED pouco depois do login."** O access token dura 15 minutos por desenho. O cliente deve chamar `POST /auth/refresh` com o refresh token para obter um novo par — não aumentes o `accessTtl` para valores longos.

**"401 AUTH_REFRESH_REUSED."** O mesmo refresh token foi usado duas vezes. Cada refresh devolve um token novo que substitui o anterior; guarda sempre o mais recente. Se acontecer sem bug no cliente, pode indicar roubo do token — o utilizador terá de fazer login de novo (comportamento intencional).

**"AUTH_UPDATE_UNSUPPORTED ao verificar email / reset."** O teu `UserSource` não implementa o método opcional `update()`. Ele é obrigatório para estes dois fluxos.

**"O email com o link nunca é enviado."** O módulo não envia emails — emite os hooks `auth:verify_requested` e `auth:password_reset_requested` com o token; a tua aplicação escuta-os e envia o email.

**"429 AUTH_LOCKED nos testes."** O throttle está ativo por omissão. Nos testes passa `loginThrottle: false`.

**"A minha chave de API não funciona no authPlugin."** Correto: bearers com prefixo `mk_` são ignorados pelo `authPlugin` e tratados pelo `apiKeysPlugin` — regista os dois.

## Como se liga aos outros módulos

- **@machize/core** — fornece a app, o container, o contexto de pedido (`ctx()`) e os hooks; o auth coloca `ctx().user` e `ctx().apiKey`.
- **@machize/fastify** — o adaptador HTTP que executa os enrichers/guards e serve as rotas prontas.
- **@machize/permissions** — responde a "o que podes fazer?"; o seu guard `meta.can` usa o `ctx().user` que o auth define.
- **@machize/tenancy** — define `ctx().tenant`; as chaves de API criadas dentro de um tenant ficam limitadas a esse tenant.
- **@machize/teams** — o guard `meta.teamRole` combina o `ctx().user` (auth) com o `ctx().tenant` (tenancy).

## Boas práticas de segurança

- **O `secret` é a chave do cofre.** Usa um valor longo e aleatório (ex.: `openssl rand -base64 48`), guarda-o numa variável de ambiente e nunca o metas no código nem no git. Se ele fugir, qualquer pessoa pode forjar tokens.
- **Usa HTTPS sempre.** Tokens em texto simples numa ligação sem cifra podem ser intercetados.
- **Não aumentes o `accessTtl`.** Tokens de acesso curtos limitam o estrago de um token roubado; a renovação via refresh token já dá comodidade ao utilizador.
- **Mostra a chave de API e os códigos de recuperação uma única vez** — é assim que o módulo funciona; não os guardes em texto simples do teu lado.
- **Não desativa o `loginThrottle` em produção** e mantém as respostas "sempre 200" nas rotas de forgot/verify (já vêm assim), para não revelar que emails têm conta.
- **Em cluster (várias máquinas)**, usa stores partilhados (base de dados/Redis) em vez dos `Memory*`, senão sessões e bloqueios não são partilhados entre processos.
