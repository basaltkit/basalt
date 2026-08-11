# Reforçar contas e faturação

Esta receita adiciona as peças que um SaaS real precisa em torno de um utilizador
registado: **verificação de email**, **reposição de palavra-passe**,
**autenticação multifator**, **chaves de API**, **convites de equipa** e
**faturação alojada** (Stripe Checkout, Customer Portal e mudanças de plano com
proporcionalidade).

Tudo aqui vem em `@basaltkit/auth`, `@basaltkit/teams` e
`@basaltkit/subscriptions` (0.5.0+). A regra de design ao longo de tudo: **os
segredos viajam por email, nunca numa resposta HTTP**, e a enumeração é
impossível — os endpoints de "pedido" respondem sempre `200`.

[[toc]]

## A forma disto

```
Sign up ─▶ verify email ─┐
                         ├─▶ log in ─(MFA code)─▶ session
Forgot? ─▶ reset link ───┘                         │
                                                   ├─▶ issue API keys (mk_live_…)
                                                   ├─▶ invite teammates (roles)
                                                   └─▶ Checkout / Portal / swap plan
```

Os tokens de verificação, reposição e convites são de utilização única e expiram.
O serviço **emite um hook que transporta o token**; a tua app envia-o por email. A
autenticação nunca depende do teu mailer.

## 1. Plugins

```ts
import { createApp } from '@basaltkit/core'
import { fastifyPlugin } from '@basaltkit/fastify'
import { tenancyPlugin, headerResolver, MemoryTenantSource } from '@basaltkit/tenancy'
import { mailerPlugin } from '@basaltkit/mailer'
import {
  authPlugin, authRoutes, apiKeysPlugin, apiKeyRoutes, mfaRoutes,
  MemoryUserSource,
} from '@basaltkit/auth'
import { teamsPlugin, teamRoutes } from '@basaltkit/teams'
import { subscriptionsPlugin, billingRoutes, billingWebhookRoute, definePlans, StripeBillingGateway } from '@basaltkit/subscriptions'
```

Vamos montar o `app.ts` completo no fim — primeiro, cada capacidade por sua vez.

## 2. Email transacional, ligado uma vez

A verificação, a reposição e os convites fazem todos a mesma coisa: transformam um
hook + token num email. Define os emails e depois um pequeno plugin que subscreve
os hooks. `hooks.on(...)` é totalmente tipado — a forma do payload vem do pacote
que declarou o hook.

```ts
// mails.ts
import { defineMail } from '@basaltkit/mailer'
import { z } from 'zod'

const link = z.object({ url: z.string() })

export const VerifyEmail = defineMail({
  name: 'verify-email',
  schema: link,
  subject: () => 'Confirm your email',
  html: ({ url }) => `<p>Confirm your address: <a href="${url}">verify</a></p>`,
})

export const ResetEmail = defineMail({
  name: 'reset-password',
  schema: link,
  subject: () => 'Reset your password',
  html: ({ url }) => `<p>Reset your password: <a href="${url}">choose a new one</a></p>`,
})

export const InviteEmail = defineMail({
  name: 'team-invite',
  schema: link,
  subject: () => 'You have been invited to a team',
  html: ({ url }) => `<p>Join the team: <a href="${url}">accept invitation</a></p>`,
})
```

```ts
// emails-plugin.ts
import { definePlugin } from '@basaltkit/core'
import { MAILER } from '@basaltkit/mailer'
import { VerifyEmail, ResetEmail, InviteEmail } from './mails.js'

const APP_URL = process.env.APP_URL ?? 'https://app.example.com'

/** Turns auth/teams token hooks into outbound email. */
export const emailsPlugin = definePlugin({
  name: 'app:emails',
  dependsOn: ['basalt:mailer'],
  register({ container, hooks }) {
    const mailer = () => container.get(MAILER)

    hooks.on('auth:verify_requested', ({ user, token }) =>
      mailer().send(VerifyEmail, { url: `${APP_URL}/verify?token=${token}` }, { to: user.email }))

    hooks.on('auth:password_reset_requested', ({ user, token }) =>
      mailer().send(ResetEmail, { url: `${APP_URL}/reset?token=${token}` }, { to: user.email }))

    hooks.on('team:invited', ({ invitation, token }) =>
      mailer().send(InviteEmail, { url: `${APP_URL}/invite?token=${token}` }, { to: invitation.email }))
  },
})
```

::: tip Envia email fora do pedido
Envolve o mailer numa fila para que uma chamada SMTP lenta nunca bloqueie a
resposta: `mailer.useQueue((m) => SendMail.dispatch(m))`. Vê o
[cookbook do SaaS de notas](/pt/cookbook/notes-saas) para a ligação da fila.
:::

## 3. Verificação de email

`authRoutes()` já inclui os endpoints — só tens de fornecer a canalização de email
(feito acima). Um novo utilizador começa não verificado (`emailVerified: false`).

| Endpoint | Body | Resposta |
| --- | --- | --- |
| `POST /auth/verify/request` | `{ email }` | sempre `{ ok: true }` |
| `POST /auth/verify` | `{ token }` | `{ user }` (agora `emailVerified: true`) |

```bash
curl -X POST /auth/verify/request -d '{"email":"ada@acme.test"}'   # email sent
curl -X POST /auth/verify        -d '{"token":"<from the link>"}'   # verified
```

Para exigir um email verificado em rotas sensíveis, lê `ctx().user` num guard:

```ts
route({
  method: 'POST', url: '/projects', meta: { auth: true, verified: true },
  handler: () => ({ /* ... */ }),
})

// register once (a RouteGuard), rejecting unverified users with 403:
const requireVerified: RouteGuard = ({ route, context }) => {
  if (route.meta?.verified === true && context.user?.emailVerified !== true) {
    throw new AuthRequiredError()
  }
}
```

## 4. Reposição de palavra-passe

O mesmo padrão — o token chega por email, e ambas as rotas de "pedido" respondem
`200` quer a conta exista quer não, para que ninguém possa sondar a tua lista de
utilizadores.

| Endpoint | Body | Notas |
| --- | --- | --- |
| `POST /auth/password/forgot` | `{ email }` | sempre `{ ok: true }` |
| `POST /auth/password/reset` | `{ token, password }` | **revoga todos os refresh tokens** |

Uma reposição concluída faz logout do utilizador em todo o lado — todas as famílias
de refresh-token são revogadas, para que uma sessão roubada não sobreviva à
mudança da palavra-passe.

## 5. Autenticação multifator (TOTP)

Regista `mfaRoutes()` ao lado de `authRoutes()`. O registo é um handshake de dois
passos para que um código mal digitado nunca deixe o utilizador de fora.

```bash
# 1. begin — returns a secret and an otpauth:// URI to render as a QR code
curl -X POST /auth/mfa/enroll -H "authorization: Bearer $ACCESS"
# → { "secret": "JBSWY3…", "otpauthUri": "otpauth://totp/Basalt:ada@acme.test?…" }

# 2. confirm with a code from the authenticator — returns one-time recovery codes
curl -X POST /auth/mfa/activate -H "authorization: Bearer $ACCESS" -d '{"code":"123456"}'
# → { "recoveryCodes": ["1a2b3-c4d5e", … 10 total] }
```

Uma vez ativado, o login recebe um `mfaCode` opcional:

```bash
curl -X POST /auth/login -d '{"email":"ada@acme.test","password":"…"}'
# → 401 { "error": { "code": "AUTH_MFA_REQUIRED" } }   (password was correct)

curl -X POST /auth/login -d '{"email":"ada@acme.test","password":"…","mfaCode":"123456"}'
# → 200 { user, accessToken, refreshToken }
```

- Uma palavra-passe correta com um código **em falta** devolve `AUTH_MFA_REQUIRED`
  e **não** conta como tentativa falhada; um código **errado** conta, para que o
  throttle de login continue a bloquear a força bruta contra o segundo fator.
- Os códigos de recuperação são de utilização única e guardados apenas como hashes
  SHA-256. Um utilizador com um dispositivo perdido autentica-se com um em vez do
  código TOTP.
- A implementação do TOTP não tem dependências e é verificada contra os vetores de
  teste do RFC 6238.

Ativa-o para toda a app fixando o `mfaIssuer` (o rótulo que as apps de
autenticação mostram):

```ts
authPlugin({ users, secret, mfaIssuer: 'Acme' })
```

## 6. Chaves de API

`apiKeysPlugin()` autentica chaves `mk_live_…` (via `Authorization: Bearer` ou
`x-api-key`) e impõe **scopes** declarados nas rotas. As chaves têm âmbito de
tenant e são criadas por um utilizador autenticado.

```ts
apiKeysPlugin({ users })                 // `users` lets a key also populate ctx().user
// routes: [...authRoutes(), ...apiKeyRoutes(), yourScopedRoutes]
```

```ts
// a machine route requiring a scope
route({ method: 'GET', url: '/v1/export', meta: { scopes: ['read'] }, handler: () => … })
```

```bash
# create (as a logged-in user) — the key is shown exactly once
curl -X POST /apikeys -H "authorization: Bearer $ACCESS" -d '{"name":"CI","scopes":["read"]}'
# → 201 { "id": "…", "prefix": "mk_live_ab12cd", "scopes": ["read"], "key": "mk_live_ab12cd…" }

# use it
curl /v1/export -H "authorization: Bearer mk_live_ab12cd…"        # 200
curl /v1/export                                                  # 403 AUTH_SCOPE_REQUIRED
```

Apenas o hash SHA-256 e um pequeno prefixo de exibição são guardados; uma base de
dados vazada não rende chaves utilizáveis. `GET /apikeys` lista-as (sem hash, sem
texto simples); `DELETE /apikeys/:id` revoga. Um `*` nos scopes de uma chave
concede tudo.

## 7. Convites de equipa

`@basaltkit/teams` transforma um tenant numa equipa multi-utilizador com uma
hierarquia de papéis ordenada (`owner` > `admin` > `member`). Regista o plugin e as
rotas, e semeia o primeiro owner do tenant quando o crias.

```ts
teamsPlugin({ access })   // optional `access` mirrors roles into @basaltkit/permissions
// routes: [...teamRoutes()]
```

```ts
// when an operator creates a tenant, make the creator its owner:
import { TEAMS } from '@basaltkit/teams'
await app.container.get(TEAMS).addMember(tenant.id, creator.id, 'owner')
```

O guard `teamRole` protege as ações de administração; aceitar um convite só precisa
de um utilizador autenticado.

| Endpoint | Requer | |
| --- | --- | --- |
| `POST /team/invites` `{ email, role? }` | `admin` | envia por email um token via `team:invited` |
| `POST /team/invites/accept` `{ token }` | login | inscreve o utilizador no papel convidado |
| `GET /team/invites` · `DELETE /team/invites/:id` | `admin` | listar / revogar pendentes |
| `GET /team/members` | `member` | |
| `PATCH /team/members/:userId` `{ role }` · `DELETE …` | `admin` | mudar papel / remover |

```bash
# admin invites (token emailed, never returned)
curl -X POST /team/invites -H "authorization: Bearer $ADMIN" -H "x-tenant-id: acme" \
     -d '{"email":"bob@acme.test","role":"member"}'

# bob accepts with the token from his email
curl -X POST /team/invites/accept -H "authorization: Bearer $BOB" -d '{"token":"…"}'
```

Os convites expiram (por omissão 7 dias) e são de utilização única; um convite
novo para o mesmo endereço substitui o pendente. O serviço recusa-se a despromover
ou remover o **último owner** (`TEAM_LAST_OWNER`).

## 8. Faturação: Checkout, Portal, proporcionalidade

Configura o gateway do Stripe e depois `billingRoutes()` dá ao tenant atual um
fluxo de subscrição alojado e um portal self-service.

```ts
const plans = definePlans({
  free: { price: 0, features: { seats: 1 } },
  pro:  { price: 29, features: { seats: 10 }, trial: '14d' },
  team: { price: 99, features: { seats: 50 } },
})

const gateway = new StripeBillingGateway({
  secretKey: process.env.STRIPE_SECRET_KEY!,
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET!,
  priceId: (plan, period) => PRICE_IDS[`${plan}_${period}`], // your Stripe Price IDs
  customerId: (tenantId) => ensureStripeCustomer(tenantId),  // your tenant → customer map
})

subscriptionsPlugin({ plans, gateway, fallbackPlan: 'free' })
// routes: [
//   ...billingRoutes({ successUrl: `${APP_URL}/billing/ok`, cancelUrl: `${APP_URL}/billing` }),
//   billingWebhookRoute(gateway),
// ]
```

**Subscrever** — `POST /billing/checkout` devolve um URL para onde redirecionar. O
Basalt regista a subscrição como `incomplete`; o webhook do Stripe passa-a a
`active` no pagamento (e aprende o id da subscrição para gestão posterior).

```bash
curl -X POST /billing/checkout -H "authorization: Bearer $ACCESS" -H "x-tenant-id: acme" \
     -d '{"plan":"pro"}'
# → { "url": "https://checkout.stripe.com/c/pay/cs_…" }
```

**Gerir** — `POST /billing/portal` devolve o URL do Customer Portal (atualizar
cartão, cancelar, ver faturas):

```bash
curl -X POST /billing/portal -H "authorization: Bearer $ACCESS" -H "x-tenant-id: acme"
# → { "url": "https://billing.stripe.com/p/session/…" }
```

**Mudar de plano com proporcionalidade** — `swap()` envia a mudança ao Stripe e
credita/cobra a diferença a meio do ciclo:

```ts
import { SUBSCRIPTIONS } from '@basaltkit/subscriptions'
const subs = ctx().container.get(SUBSCRIPTIONS)

await subs.swap('acme', 'team')                  // create_prorations (default)
await subs.swap('acme', 'team', { prorate: false }) // switch at renewal, no settlement
```

::: warning Verifica os webhooks contra o corpo em bruto
`billingWebhookRoute` verifica a assinatura do Stripe sobre os bytes intactos.
Configura um parser de corpo em bruto para `/billing/webhook` para que a
reserialização não quebre o HMAC — vê o [guia de Subscrições](/pt/guide/billing).
:::

## 9. A app montada

```ts
const app = await createApp({
  plugins: [
    tenancyPlugin({ source: tenants, resolvers: [headerResolver()] }),
    mailerPlugin({ driver: 'smtp', smtp: { /* … */ }, from: 'no-reply@acme.test' }),
    authPlugin({ users, secret: process.env.JWT_SECRET!, mfaIssuer: 'Acme' }),
    apiKeysPlugin({ users }),
    teamsPlugin({ access }),
    subscriptionsPlugin({ plans, gateway, fallbackPlan: 'free' }),
    emailsPlugin,
    fastifyPlugin({
      routes: [
        ...authRoutes(),      // register/login/refresh/logout/me + verify + reset
        ...mfaRoutes(),       // enroll/activate/status/disable
        ...apiKeyRoutes(),    // create/list/revoke keys
        ...teamRoutes(),      // invites + members
        ...billingRoutes({ successUrl: `${APP_URL}/billing/ok`, cancelUrl: `${APP_URL}/billing` }),
        billingWebhookRoute(gateway),
      ],
    }),
  ],
}).boot()
```

## Checklist de segurança

- **Sem enumeração** — as rotas de pedido de verify/forgot/invite devolvem sempre
  `200`. Os tokens são de utilização única, expiram e são entregues apenas por
  email.
- **A reposição de palavra-passe é um logout global** — todos os refresh tokens são
  revogados.
- **Throttling de MFA** — um segundo fator errado conta para o bloqueio de login;
  um meramente em falta não conta.
- **As chaves e os códigos de recuperação são guardados em hash** (SHA-256); o
  texto simples é mostrado exatamente uma vez.
- **Menor privilégio** — as chaves de API transportam scopes; as ações de equipa
  transportam um papel exigido; o último owner não pode ser removido.
- **Integridade dos webhooks** — assinaturas verificadas contra o corpo em bruto,
  processamento idempotente por id de evento.

## Para onde ir a seguir

- [Guia de autenticação](/pt/guide/auth) — sessões, rotação de refresh, guards.
- [Guia de equipas](/pt/guide/teams) — papéis, o guard `teamRole`, permissões.
- [Guia de subscrições](/pt/guide/billing) — planos, trials, quotas, webhooks.
- [Cookbook do SaaS de notas](/pt/cookbook/notes-saas) — a mesma stack, de ponta a ponta.
