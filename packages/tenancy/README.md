# @machize/tenancy

Multi-tenancy para aplicações Machize: identifica automaticamente a que cliente (tenant) pertence cada pedido — por subdomínio, domínio próprio, header ou rota — e disponibiliza-o em `ctx().tenant` em toda a aplicação.

Precisas deste módulo quando a mesma aplicação serve vários clientes/organizações com dados separados (o modelo típico de um SaaS).

## O que este módulo resolve

**Multi-tenancy** significa que uma única instalação da aplicação serve vários "inquilinos" (**tenants**) — empresas, equipas ou organizações — cada um com os seus dados, como um prédio onde cada fração tem a sua chave. O desafio é: quando chega um pedido HTTP, como é que a aplicação sabe a que tenant pertence? E como garantir que o código que corre a seguir "sabe" sempre em que tenant está, sem passar esse valor de função em função?

Este módulo resolve as duas partes. Primeiro, os **resolvers**: pequenas funções que olham para o pedido e identificam o tenant — pelo subdomínio (`acme.minhaapp.com` → tenant `acme`), por um domínio próprio do cliente (`app.acme.com`), por um header (`x-tenant-id`) ou por um parâmetro de rota (`/t/acme/...`). Podes combinar vários: o primeiro que encontrar um tenant existente ganha.

Segundo, o **contexto**: uma vez resolvido, o tenant fica em `ctx().tenant` (usando AsyncLocalStorage do Node — um "fio invisível" que acompanha cada pedido), acessível em qualquer handler, serviço ou hook sem passar argumentos. Também podes correr código "como" um tenant fora de um pedido HTTP (jobs, migrações) com `tenancy.run()` e iterar todos os tenants com `tenancy.forEach()`.

## Instalação

```bash
pnpm add @machize/tenancy
```

## Começar em 5 minutos

1. **Define de onde vêm os tenants** (em produção, a tua base de dados; para experimentar, memória):

```ts
import { MemoryTenantSource } from '@machize/tenancy'

const source = new MemoryTenantSource()
  .add({ id: 'acme', name: 'Acme Inc' })
  .add({ id: 'globex', name: 'Globex' })
```

2. **Regista o plugin com um resolver:**

```ts
import { createApp, ctx } from '@machize/core'
import { fastifyPlugin, route } from '@machize/fastify'
import { tenancyPlugin, headerResolver, MemoryTenantSource } from '@machize/tenancy'

const source = new MemoryTenantSource().add({ id: 'acme', name: 'Acme Inc' })

const app = await createApp({
  plugins: [
    tenancyPlugin({
      source,
      resolvers: [headerResolver()], // lê o header x-tenant-id
    }),
    fastifyPlugin({
      routes: [
        route({
          method: 'GET',
          url: '/whoami',
          async handler() {
            return { tenant: ctx().tenant?.id ?? null }
          },
        }),
      ],
    }),
  ],
}).boot()
```

3. **Testa:**

```bash
curl http://localhost:3000/whoami -H 'x-tenant-id: acme'
# → { "tenant": "acme" }

curl http://localhost:3000/whoami
# → { "tenant": null }  (pedido sem tenant — permitido, porque required é false)
```

4. **Para exigir sempre um tenant**, passa `required: true` — pedidos não resolvidos recebem 404 `TENANCY_NOT_RESOLVED`.

## Guia de utilização

### Escolher o resolver

```ts
import {
  subdomainResolver, domainResolver, headerResolver, routeResolver,
} from '@machize/tenancy'

// acme.minhaapp.com → tenant "acme" (ignora www, o domínio base e sub-subdomínios)
subdomainResolver({ base: 'minhaapp.com' })

// Domínio próprio do cliente: app.acme.com → source.findByDomain('app.acme.com')
domainResolver()

// Header HTTP (default x-tenant-id; personalizável)
headerResolver({ header: 'x-org' })

// Parâmetro de rota: /t/:tenant/... (default 'tenant')
routeResolver({ param: 'tenant' })
```

Podes passar vários em `resolvers: [...]` — são tentados por ordem e o primeiro cuja referência corresponder a um tenant **existente** na source ganha (uma referência a um tenant desconhecido passa ao seguinte).

### Ligar à tua base de dados (TenantSource)

```ts
import type { TenantSource, Tenant } from '@machize/tenancy'

const source: TenantSource = {
  async find(id) { /* SELECT ... WHERE id = ? */ return null },
  // Opcional — obrigatório para domainResolver():
  async findByDomain(domain) { /* SELECT ... WHERE domain = ? */ return null },
  // Opcional — obrigatório para tenancy.forEach():
  async list() { return [] },
}
```

O tipo `Tenant` só exige `id: string`; acrescenta os campos que quiseres (`name`, `plan`, `domains`, …). Nota: o `findByDomain` do `MemoryTenantSource` procura no campo `domains: string[]` do tenant.

### Correr código como um tenant (jobs, scripts)

Fora de um pedido HTTP não há resolver — usa a facade `Tenancy`:

```ts
import { TENANCY } from '@machize/tenancy'
import { ctx } from '@machize/core'

const tenancy = app.container.get(TENANCY)

// Corre a função com ctx().tenant = acme (contexto exterior preservado e restaurado)
await tenancy.run('acme', async () => {
  console.log(ctx().tenant?.id) // 'acme'
})

// Manutenção em massa: visita todos os tenants, cada um no seu contexto,
// com concorrência limitada (default 5)
await tenancy.forEach(
  async (tenant) => { /* ex.: correr migrações do tenant */ },
  { concurrency: 2 },
)
```

`run()` aceita o objeto `Tenant` ou o `id` (que é carregado da source; se não existir lança `TenantNotFoundError`).

### Reagir a mudanças de tenant (hook)

Sempre que a execução entra num contexto de tenant (num pedido HTTP resolvido ou via `run`), o hook `tenancy:switched` dispara:

```ts
app.hooks.on('tenancy:switched', ({ tenant }) => {
  console.log('a trabalhar para o tenant', tenant.id)
})
```

## Referência da API

### `tenancyPlugin(options)`

| Nome | Tipo | Obrigatório? | Default | Descrição |
|---|---|---|---|---|
| `source` | `TenantSource` | Sim | — | De onde se carregam os tenants. |
| `resolvers` | `TenantResolver[]` | Sim | — | Tentados por ordem; o primeiro que carregar um tenant ganha. |
| `required` | `boolean` | Não | `false` | `true` → pedido sem tenant recebe 404 `TENANCY_NOT_RESOLVED`. |

O plugin regista a facade no container sob o token `TENANCY` e um enricher HTTP que resolve o tenant de cada pedido, o coloca em `ctx().tenant` e emite `tenancy:switched`.

### Classe `Tenancy`

Construtor: `new Tenancy(source, resolvers, hooks?)` (normalmente criada pelo plugin).

| Método | Devolve | Descrição |
|---|---|---|
| `current()` | `Tenant \| undefined` | Tenant do contexto ativo. |
| `find(id)` | `Promise<Tenant \| null>` | Procura na source. |
| `resolve(request)` | `Promise<Tenant \| null>` | Corre os resolvers sobre `{ headers?, params?, url? }`. |
| `run(tenantOrId, fn)` | `Promise<T>` | Executa `fn` com `ctx().tenant` definido; emite `tenancy:switched`. |
| `forEach(fn, { concurrency? })` | `Promise<void>` | `fn` por cada tenant (requer `source.list`); concorrência default 5. |

### Resolvers

| Função | Opções | Devolve |
|---|---|---|
| `subdomainResolver(options)` | `base: string` (obrigatório) | `{ id: subdominio }`; ignora `www`, o domínio base, subdomínios aninhados e a porta. |
| `domainResolver()` | — | `{ domain: host }`; requer `source.findByDomain`. |
| `headerResolver(options?)` | `header?: string` (default `'x-tenant-id'`) | `{ id: valorDoHeader }`. |
| `routeResolver(options?)` | `param?: string` (default `'tenant'`) | `{ id: params[param] }`. |

Um `TenantResolver` é `(request: ResolutionRequest) => TenantRef | null | Promise<...>`, onde `TenantRef` é `{ id: string }` ou `{ domain: string }`. Podes escrever o teu — é só uma função. (Avançado.)

### Tipos e erros

| Export | Descrição |
|---|---|
| `Tenant` | `{ id: string; [key: string]: unknown }`. |
| `TenantSource` | `find` (obrigatório), `findByDomain?`, `list?`. |
| `MemoryTenantSource` | Source em memória com `.add(tenant)` encadeável — dev/testes. |
| `ResolutionRequest`, `TenantRef`, `TenantResolver` | Tipos dos resolvers. Avançado. |
| `TENANCY` | Token de injeção: `container.get(TENANCY)` → `Tenancy`. |
| `TenancyNotResolvedError` | `TENANCY_NOT_RESOLVED`, HTTP 404 — pedido sem tenant com `required: true`. |
| `TenantNotFoundError` | `TENANT_NOT_FOUND` — id inexistente passado a `run()`. |

## Erros comuns e soluções (FAQ)

**"`ctx().tenant` está sempre `undefined`."** Confere: (1) o `tenancyPlugin` está registado **antes** de leres o contexto; (2) o pedido traz mesmo o que o resolver espera (header certo, subdomínio certo); (3) o tenant existe na source — um resolver que identifica um id desconhecido é ignorado.

**"404 TENANCY_NOT_RESOLVED em pedidos que deviam passar."** Tens `required: true` e nenhum resolver conseguiu carregar um tenant. Para rotas "centrais" (landing page, registo) usa `required: false` e trata a ausência de tenant no handler.

**"O subdomainResolver não apanha `a.b.minhaapp.com`."** Intencional: só aceita um único nível de subdomínio; `www` e o domínio base também são ignorados.

**"O domainResolver devolve sempre null."** A tua `TenantSource` precisa de implementar `findByDomain`. No `MemoryTenantSource`, o tenant tem de ter o campo `domains: ['app.acme.com']`.

**"tenancy.forEach() lança TenantNotFoundError."** A tua source não implementa o método opcional `list()` — ele é obrigatório para o `forEach`.

**"Os tenants desaparecem ao reiniciar."** `MemoryTenantSource` vive em memória; implementa `TenantSource` sobre a tua base de dados.

## Como se liga aos outros módulos

- **@machize/core** — fornece o contexto por pedido (`ctx()`, AsyncLocalStorage) onde o tenant é colocado, e o bus de hooks (`tenancy:switched`).
- **@machize/fastify** — executa o enricher que resolve o tenant em cada pedido HTTP.
- **@machize/auth** — independente, mas complementar: auth diz *quem* é o utilizador, tenancy diz *onde* (em que organização) o pedido decorre. As chaves de API criadas num tenant ficam limitadas a ele.
- **@machize/permissions** — usa `ctx().tenant.id` como âmbito por omissão: permissões concedidas num tenant não valem noutro.
- **@machize/teams** — as equipas são os membros de um tenant; as rotas de equipa exigem `ctx().tenant` definido por este módulo.

## Boas práticas de segurança

- **Nunca confies num header de tenant vindo do browser em produção.** O `headerResolver` é ótimo para desenvolvimento e para tráfego interno, mas um utilizador pode enviar `x-tenant-id: outro-cliente` à mão. Em produção, prefere `subdomainResolver`/`domainResolver` (o DNS é controlado por ti) e valida sempre que o utilizador autenticado **pertence** ao tenant resolvido (o guard `teamRole` do `@machize/teams` faz isso).
- **Isola os dados por tenant nas queries.** Este módulo identifica o tenant; cabe ao teu código usar `ctx().tenant.id` em todas as consultas à base de dados. Uma query sem filtro de tenant é uma fuga de dados entre clientes.
- **Usa `required: true` nas áreas de aplicação** para que um pedido mal encaminhado falhe alto (404) em vez de correr sem tenant e tocar em dados globais.
- **Cuidado com os domínios próprios:** só aceites um domínio em `findByDomain` depois de o cliente provar que o controla (ex.: registo DNS), senão alguém pode apontar um domínio para a tua aplicação e fazer-se passar por outro tenant.
