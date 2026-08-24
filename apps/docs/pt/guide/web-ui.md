# Web UI & componentes

O Basalt dá-te duas formas de pôr um ecrã à frente da tua API:

1. **[Páginas HTML autónomas](/pt/guide/admin-pages)** — páginas prontas a usar, sem build (`teamsUiRoutes`, `billingUiRoutes`, `apiKeysUiRoutes`, o visualizador de auditoria). Sem projeto de frontend, sem `npm install` no cliente. Ótimas para ecrãs internos/de administração.
2. **Um frontend React a sério** — uma app Vite + React que fala com a tua API através de um SDK type-safe, com os componentes `@basaltkit/admin` à mão para renderizar tabelas e formulários diretamente a partir dos teus esquemas Zod. É isto que o `create-basalt --ui` gera, e é o que este guia cobre.

[[toc]]

## O scaffold `--ui`

```bash
pnpm create basalt my-app --ui          # a auth está ligada por omissão → os fluxos de auth prontos vêm juntos
```

A autenticação está **ligada por omissão** no scaffold, portanto o `--ui` dá-te também os ecrãs de auth; passa `--no-auth` se quiseres o frontend sem eles. Requer **pnpm** — o frontend `web/` é um membro do workspace (o scaffolder muda automaticamente para pnpm se o invocaste com outro gestor).

Além da API, isto gera um frontend **`web/`** ligado de ponta a ponta:

```
web/
├── vite.config.ts     # o dev server faz proxy de /api → o teu backend (sem CORS)
├── tailwind.config.js # tema Tailwind + shadcn, incl. @basaltkit/admin-shadcn em `content`
├── index.html
└── src/
    ├── api.ts         # os teus endpoints descritos uma vez com @basaltkit/sdk
    ├── App.tsx        # a app — com --auth: login, registo, esqueci/repor, um dashboard + MFA
    ├── main.tsx
    └── index.css      # variáveis do tema shadcn (claro/escuro)
```

- **React + Vite** para o dev server e o build.
- **[`@basaltkit/admin-shadcn`](#paineis-de-administracao-a-partir-dos-teus-esquemas-zod)** — componentes shadcn/ui autênticos, já com tema.
- **[`@basaltkit/sdk`](#o-sdk-type-safe)** — o cliente type-safe para a tua API.
- O dev server do Vite **faz proxy de `/api`** para o backend, portanto o browser fala same-origin — sem CORS para configurar.

O `web` está registado como membro do workspace pnpm (com o nome `<your-app>-web`), portanto o `pnpm install` na raiz resolve-o. Corre o backend com `pnpm dev` (API em `:3000`), depois o frontend com `pnpm --filter my-app-web dev` — o Vite serve-o em `http://localhost:5180` e faz proxy de `/api` para o backend.

Com a auth ativada (a omissão), o `App.tsx` traz os fluxos padrão completos out of the box: iniciar sessão (com um desafio TOTP), registo, esqueci-a-password, repor-password via o link `?token` enviado por email, e um dashboard que gere o dois-fatores (enroll → secret/otpauth → activate → recovery codes → disable). Passa `--no-auth` para gerar o frontend sem eles.

## O SDK type-safe

O [`@basaltkit/sdk`](/pt/reference/packages) é um cliente HTTP sem drift: descreves cada endpoint **uma vez** com Zod, e cada chamada recebe os tipos de input/output corretos, erros estruturados e refresh automático de token. A sua única dependência é o Zod — é browser-friendly e não arrasta o `@basaltkit/core`.

```ts
// src/api.ts — a única fonte de verdade, partilhável entre cliente e testes
import { z } from 'zod'
import { endpoint } from '@basaltkit/sdk'

const Project = z.object({ id: z.string(), name: z.string() })

export const api = {
  projects: {
    list:   endpoint({ method: 'GET',  path: '/projects', result: z.array(Project) }),
    get:    endpoint({ method: 'GET',  path: '/projects/:id', params: z.object({ id: z.string() }), result: Project }),
    create: endpoint({ method: 'POST', path: '/projects', body: z.object({ name: z.string() }), result: Project }),
  },
}
```

```ts
import { createClient } from '@basaltkit/sdk'
import { api } from './api.js'

const client = createClient(api, { baseUrl: '/api' })

const created = await client.projects.create({ body: { name: 'Basalt' } }) // tipado { id, name }
const one     = await client.projects.get({ params: { id: created.id } })
const all     = await client.projects.list()
```

O cliente **espelha a forma** do teu objeto `api`, o TypeScript verifica os argumentos, e a resposta do servidor é **validada contra o esquema** em runtime — uma incompatibilidade lança `CLIENT_RESPONSE_MISMATCH` em vez de devolver dados errados em silêncio. Muda um campo no backend e o frontend deixa de compilar, em vez de falhar em produção.

::: tip Dica: auth & refresh de token
Passa um callback `getToken` (devolve o access token atual, enviado como `Authorization: Bearer`) e um callback `refresh` ao `createClient`. Num `401` o cliente chama `refresh` uma vez e repete com o novo token — transparente para quem chama; o `refresh` devolve o novo token, ou `null` para desistir. O scaffold `--ui` liga isto às rotas de auth por ti.

```ts
const client = createClient(api, {
  baseUrl: '/api',
  getToken: () => localStorage.getItem('accessToken') ?? undefined,
  refresh: async () => {
    /* chama POST /auth/refresh, guarda os novos tokens, devolve o access token ou null */
    return null
  },
})
```
:::

## Painéis de administração a partir dos teus esquemas Zod

Três pacotes empilham-se para que possas trocar o aspeto visual sem reescrever a lógica:

| Pacote | Papel |
| --- | --- |
| [`@basaltkit/admin`](/pt/reference/packages) | **Motor headless** — a partir de um esquema Zod, deriva colunas de tabela, campos de formulário e validação. Não renderiza nada. |
| [`@basaltkit/admin-react`](/pt/reference/packages) | **Camada React** — `DataTable`, `ResourceForm`, `useList`, em HTML simples sem estilo. |
| [`@basaltkit/admin-shadcn`](/pt/reference/packages) | **Os mesmos componentes, com estilo shadcn/ui** (Tailwind). Props idênticas. O que o `--ui` usa. |

### 1. Define o recurso uma vez

```ts
// resources.ts — lógica pura, sem React
import { z } from 'zod'
import { defineResource } from '@basaltkit/admin'

export const projects = defineResource({
  name: 'projects',
  schema: z.object({
    id: z.string(),
    name: z.string(),
    status: z.enum(['draft', 'published']),
    archived: z.boolean().optional(),
  }),
  createSchema: z.object({
    name: z.string().min(3),
    status: z.enum(['draft', 'published']),
  }),
  columns: ['name', 'status'], // ordem mostrada na tabela
})
```

A partir disto, o motor deriva os rótulos das colunas, os campos do formulário (com o input certo por tipo — texto, checkbox para booleanos, `<select>` para enums, número para números), quais os campos obrigatórios, e as regras de validação. Usa o `fieldsFromSchema` diretamente se quiseres os modelos de campo sem um recurso completo.

### 2. Liga uma fonte de dados

O motor lê e escreve através de uma **`AdminDataSource`** — `{ list, get, create, update, remove }`. Usa `memoryDataSource(seed)` para demos, ou apoia-a no teu cliente SDK type-safe para uma API real:

```ts
// source.ts
import type { AdminDataSource } from '@basaltkit/admin'
import { createClient } from '@basaltkit/sdk'
import { api } from './api'

const client = createClient(api, { baseUrl: '/api' })

export const projectsSource: AdminDataSource = {
  list:   ()          => client.projects.list(),
  get:    (id)        => client.projects.get({ params: { id } }),
  create: (input)     => client.projects.create({ body: input as { name: string } }),
  update: (id, input) => client.projects.update({ params: { id }, body: input }),
  remove: (id)        => client.projects.remove({ params: { id } }).then(() => true),
}
```

### 3. Renderiza-o

```tsx
// ProjectsPage.tsx
import { DataTable, ResourceForm } from '@basaltkit/admin-shadcn' // ou @basaltkit/admin-react (sem estilo)
import { useList } from '@basaltkit/admin-react'                  // o hook vive em admin-react
import { projects } from './resources'
import { projectsSource } from './source'

export function ProjectsPage() {
  const { data, loading, error, reload } = useList(projectsSource)
  if (loading) return <p>A carregar…</p>
  if (error) return <p>Algo correu mal.</p>

  return (
    <>
      <DataTable resource={projects} rows={data} />
      <ResourceForm
        resource={projects}
        onSubmit={async (values) => {
          await projectsSource.create(values)
          reload()
        }}
      />
    </>
  )
}
```

O `useList(source)` carrega a lista no mount e devolve `{ data, loading, error, reload }`. O `DataTable` formata as células (booleanos como Yes/No, datas como `2026-08-07`); o `ResourceForm` renderiza um input por campo com validação por campo e mensagens de erro guiadas pelo teu `createSchema` — só chama `onSubmit` com dados válidos. Troca o import de `DataTable`/`ResourceForm` entre `@basaltkit/admin-react` (sem estilo) e `@basaltkit/admin-shadcn` (com estilo) — **as props são idênticas**. O hook `useList` e o helper `formatCell` são exportados apenas de `@basaltkit/admin-react`, portanto importa-os de lá independentemente de que skin de componentes uses.

### As primitivas shadcn

O `@basaltkit/admin-shadcn` também exporta as próprias primitivas shadcn — `Button`, `Input`, `Label`, `Card`, `CardHeader`, `CardContent`, `CardTitle`, `Badge`, `Table` — para que construas o resto do teu painel (cabeçalhos, cartões de métricas, ações) com o mesmo aspeto, sem copiar os ficheiros do shadcn para o teu projeto.

::: warning Aviso: o Tailwind é obrigatório para o estilo
As classes do `@basaltkit/admin-shadcn` só produzem cores/espaçamento se a tua app tiver o **Tailwind CSS** configurado com as variáveis de tema do shadcn (`--primary`, `--border`, …) e incluir o pacote no `content` do Tailwind:

```js
// tailwind.config.js
content: ['./index.html', './src/**/*.{ts,tsx}', './node_modules/@basaltkit/admin-shadcn/dist/**/*.js']
```

O scaffold `--ui` faz tudo isto por ti. A integrar à mão? Segue [ui.shadcn.com/docs/installation](https://ui.shadcn.com/docs/installation) mais a linha `content` acima.
:::

## Dashboards

O [`@basaltkit/dashboard`](/reference/packages/dashboard) compõe uma visão geral a partir dos teus dados — `defineDashboard` com secções de métricas/auditoria/fila, métricas de billing (`computeBillingMetrics`, `churnRate`) e resumos de fila — renderizados pelos mesmos componentes shadcn.

### Analytics — tendências, não só snapshots

O `computeBillingMetrics` é um snapshot num instante; o `mrrMovement` transforma
**dois** snapshots no **MRR bridge** de SaaS — como a receita mudou, decomposta:

```ts
import { mrrMovement, growth } from '@basaltkit/dashboard'

const m = mrrMovement(subsMesPassado, subsEsteMes, plans)
// { new, reactivation, expansion, contraction, churned, net, previousMrr, currentMrr }
// new + reactivation + expansion − contraction − churned === net

const g = growth(metricasMesPassado, metricasEsteMes)
g.mrr // { previous, current, delta, pct }  → seta cima/baixo + "+22%" num card de KPI
```

Os snapshots fazem match por `billableId`, por isso dás-lhe dois `subscriptions.all()`
tirados em momentos diferentes (persiste um snapshot mensal, ou faz diff de um
guardado). Tudo é puro e browser-safe.

### Branding white-label

A vender o painel a outras empresas? Cada tenant traz o seu próprio nome de produto,
logo e cores sobre um brand default:

```ts
import { resolveBranding, brandingStyleSheet, defineDashboard } from '@basaltkit/dashboard'

const brand = await resolveBranding(brandingStore, tenantId) // merged sobre o teu default
const dashboard = defineDashboard({ branding: brand, sections })
dashboard.title // o nome de produto do tenant

// injeta as cores do brand como CSS custom properties no <head> do shell:
`<style>${brandingStyleSheet(brand)}</style>` // :root { --brand-primary: … }
```

O `resolveBranding` faz deep-merge, por isso um tenant que sobrescreve uma cor mantém
o resto do teu tema. Nomes e valores são validados e o input inseguro é descartado (o
CSS é injetado em `<style>`), por isso branding vindo do tenant é seguro — mesmo assim
serve o shell sob uma CSP que restrinja estilos inline como defesa em profundidade.
Emparelha com [domínios custom](/pt/guide/tenancy) por tenant: resolve o tenant do
domínio, depois o brand do tenant.

## Que abordagem de UI?

- **Páginas HTML autónomas** ([`admin-pages`](/pt/guide/admin-pages)) — sem projeto de frontend; monta uma rota e abre o URL. Melhor para ecrãs internos de administração (chaves de API, equipa, billing, auditoria).
- **O frontend React** (`--ui`) — uma SPA completa com o SDK type-safe e componentes shadcn, para a app que os teus clientes usam.

Compõem-se: uma app React ainda pode embeber ou ligar para as páginas autónomas.
