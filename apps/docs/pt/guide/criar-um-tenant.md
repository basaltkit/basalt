# Criar um tenant

Novo no Basalt? Começa aqui. Esta página ensina **todas** as formas de criar um
tenant, desde a versão de uma linha que usas enquanto experimentas, até a um
fluxo de registo real que enviarias para clientes. Cada secção começa com um "quando
usar isto" simples, para poderes saltar para o nível que corresponde a onde estás.

## O que é um tenant?

Um **tenant** é um cliente da tua app — normalmente uma empresa ou organização —
cujos dados são mantidos completamente separados dos de toda a gente. Se
construíres uma ferramenta de projetos usada tanto pela "Acme Inc" como pela
"Globex", então a Acme é um tenant e a Globex é outro. A Acme nunca pode ver os
projetos da Globex, e vice-versa. Essa separação é o objetivo central da
multi-tenancy.

Algumas palavras que vais encontrar nesta página:

- **Source** (fonte) — o sítio onde os teus tenants são guardados (uma lista em
  memória, uma tabela de base de dados, o que escolheres). O Basalt lê os
  tenants *a partir de* uma source.
- **Resolver um tenant** — descobrir, para cada pedido que chega, *a qual*
  tenant pertence. O Basalt faz isto olhando para o pedido (um header, um
  subdomínio como `acme.tuaapp.com`, ou o URL) e associando-o a um tenant na tua
  source.
- **Membership** (pertença) — o facto de um utilizador específico pertencer a um
  tenant específico. A Ada é *membro* da Acme. A membership é o que impede um
  utilizador com sessão de espreitar um tenant a que não pertence.

Aqui está a ideia importante, e que surpreende os principiantes: **o Basalt não
te dá um botão nem uma rota "criar tenant" já pronta.** O trabalho do Basalt é
*resolver* o tenant ativo em cada pedido. *Criar* tenants é o trabalho da tua
app, porque só tu sabes quando um tenant deve existir (um cliente regista-se, um
admin adiciona um, semeias alguns para uma demo). Esta página mostra-te como, de
quatro formas, da mais simples à mais profissional.

## Nível 1 — Em memória (dev / experimentar)

**Quando usar isto:** estás a aprender, a correr testes, ou a construir uma demo
rápida, e não te importas que os tenants desapareçam quando a app reinicia.

A source mais simples possível é o `MemoryTenantSource`. Mantém os tenants numa
lista simples em memória. Adicionas um tenant com `.add({ id, ... })` e entregas
a source ao `tenancyPlugin`. Um tenant é apenas um objeto — precisa de um `id`, e
podes juntar-lhe quaisquer outros campos que queiras (`name`, `plan`, e assim por
diante).

Isto liga dois tenants e deixa os pedidos escolher um via um header `x-tenant-id`:

```ts
import { tenancyPlugin, MemoryTenantSource, headerResolver } from '@basaltkit/tenancy'

tenancyPlugin({
  source: new MemoryTenantSource()
    .add({ id: 'acme', name: 'Acme Inc' })
    .add({ id: 'globex', name: 'Globex' }),
  resolvers: [headerResolver()], // lê o header x-tenant-id → { id: 'acme' }
})
```

Esse é todo o passo "criar um tenant" neste nível: `.add(...)`. Um pedido que
traga `x-tenant-id: acme` corre agora como Acme.

::: warning Não guardado em lado nenhum
O `MemoryTenantSource` vive apenas em memória. Reinicia a app e cada tenant
desaparece. Isso é perfeito para testes e demos, e errado para qualquer coisa
real — para isso, continua a ler.
:::

## Nível 2 — Source Prisma nativa (código mínimo, pronta para produção)

**Quando usar isto:** queres tenants que sobrevivem a reinícios e são partilhados
por todas as instâncias da tua app, e já usas (ou estás disposto a usar) uma base
de dados SQL através do Prisma. Este é o ponto de partida recomendado para um
produto real, e escreves quase nenhum código.

O [Prisma](https://www.prisma.io/) é uma ferramenta popular para falar com uma
base de dados SQL (PostgreSQL, MySQL, …) a partir de TypeScript. O Basalt traz
uma source já pronta, `PrismaTenantSource`, que guarda os teus tenants nessa base
de dados. Não implementas nada — apontas para a tua base de dados e chamas
`save()`.

**Passo 1.** Adiciona dois modelos ao teu `schema.prisma`. Copia-os de
`@basaltkit/tenancy-prisma/schema.prisma` (ou corre `basalt prisma:sync`), depois
corre `prisma migrate dev && prisma generate`. O `Tenant` guarda o registo do
tenant como JSON; o `TenantDomain` deixa um tenant reclamar domínios próprios
como `app.acme.com`:

```prisma
model Tenant {
  id      String         @id
  data    Json           // o registo aberto do tenant ({ id, ...qualquer coisa })
  domains TenantDomain[]

  @@map("tenants")
}

model TenantDomain {
  domain   String @id
  tenantId String
  tenant   Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@index([tenantId])
  @@map("tenant_domains")
}
```

**Passo 2.** Envolve o teu cliente Prisma gerado com `prismaTenantSource(...)` e
entrega-o ao `tenancyPlugin` — exatamente como no Nível 1, apenas uma source
durável:

```ts
import { PrismaClient } from '@prisma/client'
import { prismaTenantSource } from '@basaltkit/tenancy-prisma'
import { tenancyPlugin, subdomainResolver, domainResolver } from '@basaltkit/tenancy'

const tenants = prismaTenantSource(new PrismaClient())

tenancyPlugin({
  source: tenants,
  resolvers: [subdomainResolver({ base: 'tuaapp.com' }), domainResolver()],
})
```

**Passo 3.** Cria (ou atualiza) um tenant com `save()`. É um *upsert* — insere o
tenant se for novo, ou atualiza-o se o `id` já existir. Qualquer campo extra que
passes é guardado e volta sem alterações:

```ts
await tenants.save({ id: 'acme', name: 'Acme Inc', plan: 'pro', domains: ['app.acme.com'] })
```

É tudo. O tenant está agora na tua base de dados, `acme.tuaapp.com` (ou o domínio
próprio `app.acme.com`) resolve para ele, e continua lá depois de um reinício.

::: tip Os domínios têm de ser únicos
O `save()` substitui o conjunto de domínios próprios do tenant. Se um domínio já
pertencer a um tenant *diferente*, o `save()` recusa — o encaminhamento tem de ser
inequívoco.
:::

## Nível 3 — O teu próprio repositório de tenants

**Quando usar isto:** os teus tenants já vivem numa tabela que desenhaste, com as
tuas próprias colunas, e preferes lê-los diretamente de lá em vez de os copiar
para a tabela `Tenant` do Basalt.

Uma **source** é definida por uma pequena interface chamada `TenantSource`. Podes
implementá-la tu mesmo sobre qualquer armazenamento. Só um método é obrigatório:

- `find(id)` — devolve o tenant com este id, ou `null`. **Obrigatório.**
- `findByDomain(domain)` — devolve o tenant dono de um domínio próprio, ou
  `null`. Opcional; só necessário se usares `domainResolver()`.
- `list()` — devolve todos os tenants. Opcional; só necessário para jobs em massa
  como `tenancy.forEach()`.

Aqui está uma source compacta sobre a tua própria tabela `organization`. O `find`
lê uma linha e molda-a num objeto de tenant; o `save` é o teu próprio helper para
criar um:

```ts
import type { TenantSource, Tenant } from '@basaltkit/tenancy'
import { db } from './db' // o teu próprio acesso à base de dados

export const orgSource: TenantSource = {
  async find(id): Promise<Tenant | null> {
    const org = await db.organization.findUnique({ where: { id } })
    return org ? { id: org.id, name: org.name, plan: org.plan } : null
  },
  async list(): Promise<Tenant[]> {
    const orgs = await db.organization.findMany()
    return orgs.map((o) => ({ id: o.id, name: o.name, plan: o.plan }))
  },
}

// O teu próprio "criar um tenant" — escreve na tua tabela como quiseres:
export async function createOrg(input: { id: string; name: string }) {
  await db.organization.create({ data: input })
  return input
}
```

Passa `orgSource` ao `tenancyPlugin` como as outras. A lição: uma source é um
contrato minúsculo, por isso o Basalt nunca dita o teu esquema. Recorre a isto
quando as sources nativas não encaixam nos teus dados existentes.

## Nível 4 — Fluxo de onboarding profissional

**Quando usar isto:** estás a construir um produto real. Um cliente regista-se,
um tenant é criado para ele, e *ele* torna-se o primeiro owner — tudo num só
pedido.

Esta é a versão adulta. Uma única rota `POST /onboarding` faz quatro coisas:

1. **Exige um utilizador com sessão.** Sem criação anónima de tenants. A auth põe
   o utilizador no pedido como `ctx().user`.
2. **Persiste o tenant** na tua source durável (Nível 2 ou 3).
3. **Torna o criador o owner** via `teams.addMember(tenantId, userId, 'owner')` —
   para que, desde o primeiro momento, exista uma membership real a ligar este
   utilizador a este tenant. (`@basaltkit/teams` gere quem pertence a um tenant e
   o seu papel: `owner`, `admin` ou `member`.)
4. **Deixa os pedidos seguintes encontrar o tenant.** Como o registo já existe na
   source, o resolver que já configuraste (subdomínio, domínio, …) encaminha o
   tráfego do novo tenant automaticamente — nada extra a ligar por tenant.

Aqui está a função de serviço que cria o tenant e semeia o seu owner:

```ts
import { TEAMS } from '@basaltkit/teams'
import { tenants } from './tenancy' // a tua source durável do Nível 2/3

export async function onboard(app, userId: string, input: { id: string; name: string }) {
  // 2. persiste o tenant para os resolvers poderem encaminhar para ele a partir de agora
  await tenants.save({ id: input.id, name: input.name })

  // 3. o criador torna-se o primeiro owner do tenant
  await app.container.get(TEAMS).addMember(input.id, userId, 'owner')

  return { id: input.id, name: input.name }
}
```

E aqui está a rota que exige um utilizador com sessão e a chama. O `meta.auth`
diz ao Basalt que esta rota precisa de autenticação; `ctx().user` é o utilizador
com sessão:

```ts
import { route } from '@basaltkit/fastify'
import { ctx } from '@basaltkit/core'
import { onboard } from './onboarding'

route({
  method: 'POST',
  url: '/onboarding',
  meta: { auth: true }, // 1. rejeita callers anónimos
  async handler(req) {
    const user = ctx().user           // definido por @basaltkit/auth
    const { id, name } = req.body as { id: string; name: string }
    return onboard(req.server.app, user.id, { id, name })
  },
})
```

Depois desta chamada, `acme.tuaapp.com` resolve para o novo tenant, e o
utilizador que o criou já é o seu `owner` — pronto para convidar colegas (ver
[Equipas](/pt/guide/teams)).

## Segurança: nunca confies num tenant vindo do cliente

::: warning Verifica a membership antes de confiar num id de tenant
Resolver um tenant a partir de um header ou subdomínio é conveniente, mas um
pedido é **controlado pelo atacante**. Se leres `x-tenant-id: acme` e limitares a
`acme` sem verificar que o utilizador com sessão pertence de facto a `acme`,
então *qualquer* utilizador com sessão pode ler os dados de *outro* tenant.
Confirma sempre a membership com `teams.can(...)`:

```ts
// Depois de o tenant ser resolvido, antes de confiares nele:
if (!(await teams.can(tenantId, ctx().user.id, 'member'))) {
  throw new ForbiddenError()
}
```

Liga a seleção de tenant a uma **membership user↔tenant verificada**, nunca apenas
ao pedido em bruto. Vê [Segurança](/pt/guide/security) para o quadro completo.
:::

## Qual devo usar?

| A tua situação | Usa isto | Como crias um tenant |
| --- | --- | --- |
| Aprender, testes, uma demo rápida | `MemoryTenantSource` | `.add({ id, name })` |
| Um produto real, caminho mais simples | `PrismaTenantSource` (`@basaltkit/tenancy-prisma`) | `source.save({ id, name })` |
| Tenants já na tua própria tabela | A tua própria `TenantSource` | o teu insert + `find`/`list` |
| Registo real, criador torna-se owner | Rota de onboarding + `@basaltkit/teams` | `POST /onboarding` → `save` + `addMember(..., 'owner')` |

Começa no Nível 1 para aprender, passa para o Nível 2 no momento em que precisas
que os tenants sobrevivam a um reinício, e acrescenta o Nível 4 quando tiveres
clientes reais a registarem-se sozinhos.
