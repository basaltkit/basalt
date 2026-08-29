# UIs autónomas

Alguns trabalhos precisam de um ecrã, não só de uma API — gerir chaves de API,
convidar colegas de equipa, mudar de plano, navegar no rasto de auditoria. O Basalt
entrega-os como **páginas HTML sem dependências** que largas na tua app: sem passo
de build, sem framework de frontend, sem inchaço de npm. Cada página é servida pelas
rotas JSON que já montas e renderiza no tema claro ou escuro de quem a vê.

[[toc]]

## Como funcionam

Um pacote de UI expõe um helper `*Routes()` que regista uma rota que serve uma
página HTML estática (mais, onde necessário, um pequeno endpoint JSON). A página faz
fetch **same-origin** com a sessão do browser, portanto assume que o utilizador já
está autenticado para as rotas subjacentes — protege a página com o teu próprio
guard de administração onde apropriado. Não há nada para compilar: monta as rotas e
abre o URL.

::: warning Aviso: uma página de UI precisa do seu plugin de dados
Cada página é apenas um visualizador sobre rotas JSON — não renderiza nada sem o
plugin que serve essas rotas. Emparelha `apiKeysUiRoutes()` com
`apiKeysPlugin()`, `teamsUiRoutes()` com `teamsPlugin()`, `billingUiRoutes()`
com `subscriptionsPlugin()`, e `auditViewerRoutes()` com **ambos**
`auditPlugin()` e `auditViewerPlugin()`.
:::

Aqui está a ligação completa — cada plugin registado, depois cada rota montada:

```ts
import { createApp } from '@basaltkit/core'
import { fastifyPlugin } from '@basaltkit/fastify'
import {
  authPlugin, authRoutes, apiKeysPlugin, apiKeyRoutes, MemoryUserSource,
} from '@basaltkit/auth'
import { teamsPlugin, teamRoutes } from '@basaltkit/teams'
import {
  subscriptionsPlugin, billingRoutes, definePlans, StripeBillingGateway,
} from '@basaltkit/subscriptions'
import { auditPlugin } from '@basaltkit/audit'
import { apiKeysUiRoutes } from '@basaltkit/api-keys-ui'
import { teamsUiRoutes } from '@basaltkit/teams-ui'
import { billingUiRoutes } from '@basaltkit/billing-ui'
import { auditViewerPlugin, auditViewerRoutes } from '@basaltkit/audit-viewer'

const plans = definePlans({
  free: { price: 0, features: { projects: 3 } },
  pro: { price: 29, trial: '14d', features: { projects: 50, api: true } },
})

const app = await createApp({
  plugins: [
    // ...tenancyPlugin — o tenant por trás dos dados de cada UI
    authPlugin({ users: new MemoryUserSource(), secret: process.env.AUTH_SECRET! }),
    apiKeysPlugin(),
    teamsPlugin(),
    subscriptionsPlugin({ plans, gateway: new StripeBillingGateway({ /* … */ }), fallbackPlan: 'free' }),
    auditPlugin(),
    auditViewerPlugin(),
    fastifyPlugin({
      routes: [
        ...authRoutes(),
        ...apiKeyRoutes(), ...apiKeysUiRoutes(),   // → /apikeys/ui
        ...teamRoutes(), ...teamsUiRoutes(),        // → /team/ui
        ...billingRoutes({ successUrl: 'https://app/ok', cancelUrl: 'https://app/billing' }),
        ...billingUiRoutes({ plans }),              // → /billing/ui
        ...auditViewerRoutes(),                     // → /audit/view
      ],
    }),
  ],
}).boot()
```

Cada helper recebe a mesma forma de opções: `path?` (onde montar),
`apiBase?` (se as rotas JSON estiverem sob um prefixo), `title?`, e — para
tenancy baseada em headers — `headers?` (ex. `{ 'x-tenant-id': '…' }`; apps por
subdomínio não precisam de nada).

## Chaves de API — `@basaltkit/api-keys-ui`

```ts
import { apiKeysUiRoutes } from '@basaltkit/api-keys-ui'
// emparelha com o apiKeysPlugin() + apiKeyRoutes() de @basaltkit/auth
```

Serve **`/apikeys/ui`**: criar uma chave (o plaintext é revelado **uma única vez**, com
um botão de copiar), listar chaves com prefixo/scopes/último-uso, e revogar. Requer um
utilizador com sessão iniciada.

## Equipa — `@basaltkit/teams-ui`

```ts
import { teamsUiRoutes } from '@basaltkit/teams-ui'
// emparelha com o teamsPlugin() + teamRoutes() de @basaltkit/teams
```

Serve **`/team/ui`**: convidar um membro, listar e revogar convites pendentes, e
listar membros com um dropdown de papel e remover. As ações de nível de administração requerem o
guard `teamRole: 'admin'` nas rotas de equipa.

## Billing — `@basaltkit/billing-ui`

```ts
import { billingUiRoutes } from '@basaltkit/billing-ui'
// passa os mesmos plans que deste ao subscriptionsPlugin; emparelha com billingRoutes()
billingUiRoutes({ plans })
```

Serve **`/billing/ui`** (e `/billing/info`): mostra o plano atual, o estado
e o trial, lista os planos como cartões, e liga Subscribe/Switch ao Checkout
alojado e o Manage-billing ao Customer Portal.

## Rasto de auditoria — `@basaltkit/audit-viewer`

```ts
import { auditViewerPlugin, auditViewerRoutes } from '@basaltkit/audit-viewer'
// emparelha com o auditPlugin() de @basaltkit/audit
auditViewerPlugin()
```

Serve **`/audit/view`**: navega no rasto de auditoria do tenant com filtros (evento,
ator, fonte, intervalo de tempo), paginação e estatísticas agregadas. O JSON por trás
(`/audit`, `/audit/stats`, `/audit/:id`) também é consultável diretamente. Só-leitura —
o rasto mantém-se append-only.

## Usar o HTML diretamente

Cada pacote também exporta a sua página como string (`apiKeysPageHtml`,
`teamsPageHtml`, `billingPageHtml`, `auditViewerHtml`) se preferires servi-la
à tua maneira, embebê-la, ou alojá-la noutra framework.

## Segurança

Estas páginas são conveniência sobre as tuas rotas existentes — não impõem nada
de novo. Põe-nas atrás de autenticação (são montadas com `meta.auth`) e adiciona um
guard para ecrãs só-de-administração. As rotas de dados subjacentes já impõem os seus
próprios guards (ex. as ações de administração do `teamRoutes()` requerem `teamRole: 'admin'`), mas
a própria página também vale a pena proteger — monta a tua própria cópia com um guard de
permissões ou de papel-de-equipa para que não-administradores nunca a vejam:

```ts
import { route } from '@basaltkit/fastify'
import { teamsPageHtml } from '@basaltkit/teams-ui'

// Serve a página tu mesmo atrás de um guard de administração em vez de teamsUiRoutes()
route({
  method: 'GET',
  url: '/team/ui',
  meta: { auth: true, teamRole: 'admin' }, // ou meta.can: 'team:manage' com @basaltkit/permissions
  handler: () => teamsPageHtml({ title: 'Team' }),
})
```

Como estas páginas fazem fetch same-origin sem segredos embebidos, é seguro
servi-las a partir da origin da tua app.

### Content-Security-Policy

Cada página traz blocos `<style>`/`<script>` inline que o `DEFAULT_CSP` global
do `securityPlugin` bloquearia. NÃO precisas de desativar o CSP globalmente:
cada `*UiRoutes()`/`auditViewerRoutes()` define por defeito um CSP **por rota**
na sua própria resposta — tudo bloqueado, o script inline da página permitido
apenas pelo seu hash sha256 (exportado como `apiKeysPageCsp`, `teamsPageCsp`,
`billingPageCsp`, `auditViewerCsp`). Passa `csp: '…'` para substituir ou
`csp: false` para desativar. Se servires tu mesmo a string `…PageHtml()`,
define o header `…PageCsp()` correspondente nessa rota.

Os inputs server-side (`title`, `roles`) são escapados em HTML, e o estado
embebido (`apiBase`, `headers`, `roles`) é serializado de forma a não conseguir
terminar o bloco de script — mas os valores de `headers` continuam a aparecer no
código-fonte da página, portanto nunca ponhas segredos neles.
