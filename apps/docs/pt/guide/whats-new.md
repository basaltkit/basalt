# Novidades no Basalt 1.10

> *"Basalt 1.10" é o rótulo umbrella desta vaga de trabalho; os pacotes
> `@basaltkit/*` são publicados de forma independente (ver
> [Versionamento](/pt/guide/versioning)). Abaixo está o que aterrou e a versão do
> pacote que o traz.*

::: warning Dois contratos mudaram
O `@basaltkit/files` revê o contrato do seu store, e o `app.server` do
`@basaltkit/testing` passa a ser esperado com `await`. As duas edições são
mecânicas — ver [Atualização](#atualizacao).
:::

O Basalt 1.10 é a versão das **metades que faltavam**. A aplicação que escreveu o
1.9 continuou, e o que encontrou desta vez não foram duas peças que não
encaixavam uma na outra — foram capacidades sem o outro lado. Um tenant podia ser
criado e nunca destruído. Um índice podia ser mantido atualizado e nunca
reconstruído. Uma permissão dizia o que quem chama pode fazer e nunca quem essa
pessoa é.

Uma metade que falta não se anuncia. Não há stack trace para uma pergunta a que o
framework não tem resposta: cada aplicação inventa a sua, as invenções divergem,
e a que está errada é exatamente igual à que está certa — até alguém ver um
registo que não era seu.

## Destaques

### Capacidades que só funcionavam num sentido
- **Um tenant pode ser removido.** O `TenantSource` tinha `find`, `findByDomain`,
  `list`, `create` e `save`; o `Tenancy` não tinha `destroy` — não havia saída,
  nem sequer opcional. Nos testes isso significava `DROP SCHEMA` com um
  identificador interpolado em string, e a razão de ser preciso é pior do que o
  padrão: sem a limpeza, um schema que fica torna o provisionamento seguinte um
  no-op e todas as asserções abaixo dele passam a verde contra os dados da
  corrida anterior. A ordem das operações é o desenho — marcar `deleting`
  primeiro, para o resolver deixar de encaminhar antes de se desmontar seja o que
  for; correr o `onDeprovision` dentro do contexto do tenant; apagar o registo
  por último, porque o registo é a única coisa que dá nome àquele storage.
  *(`@basaltkit/tenancy`)*
- **O `search.reindex()` reconstrói um índice a partir das regras que o
  alimentam.** Uma regra alimentada por eventos só sabe do que foi criado depois
  de a regra existir, por isso uma aplicação que acrescentava pesquisa a dados
  que já tinha ficava com uma caixa que não devolvia nada para tudo o que era
  antigo — e um resultado vazio é indistinguível de "não há". O `backfill` de uma
  regra produz **payloads de hook**, não linhas, por isso uma só função
  `document` serve os dois sentidos e um segundo mapeamento escrito à mão não
  pode divergir dela. *(`@basaltkit/search`)*
- **O domínio de ficheiros tem um store durável.** Onze domínios publicam um
  backend `-prisma` e um `-sqlite` sem uma única exceção; o `files` não publicava
  nenhum — o único domínio com contrato de store e sem implementação durável
  dele. A chave no disco é `files/<uuid>` e o uuid vivia no processo, por isso um
  restart deixava todos os uploads no bucket, sem referência e impossíveis de
  ligar ao documento que eram, enquanto a aplicação comunicava uma lista vazia e
  nada dava erro. *(`@basaltkit/files-prisma`)*
- **Os documentos têm revisões.** O `Files.upload` cunha um id novo e um caminho
  novo em cada chamada, por isso carregar o mesmo contrato duas vezes produzia
  dois registos sem relação e sem nada a ligá-los, e todas as aplicações que
  precisavam de "que rascunho estou a ler?" escreviam a mesma contabilidade à
  mão. Não é um campo `version` no `FileRecord`: um registo de ficheiro descreve
  bytes, uma revisão descreve um ato editorial, e cada revisão aponta para um
  ficheiro inteiro cujos bytes nunca são sobrescritos. É o store que atribui o
  número e chaveia em `[tenantId, groupId, version]`, por isso a base de dados
  recusa o duplicado que uma corrida de ler-o-último-e-somar-um produziria.
  *(`@basaltkit/files-versions`)*

### Declarações em vez de contabilidade
- **`activityRule`** — o `search` tem `syncRule`, o `realtime` tem `bridgeRule`,
  e o `activity`, provavelmente o mais comum dos três, tinha apenas o builder
  fluente, que serve para escrever uma linha à mão dentro de um serviço. O custo
  da assimetria não são as treze chamadas a `hooks.on()` que uma aplicação
  escreve em vez disso; é a resposta natural a "regista isto" passar a ser
  "chama o activity a partir do `MatterService`", acoplando o domínio ao pacote
  que os outros dois te ensinam a manter à distância. Uma regra nunca relança o
  erro, e é aí que difere de propósito do `syncRule`: uma linha de histórico que
  não consegue ser escrita não pode fazer falhar o encerramento do processo que a
  produziu. *(`@basaltkit/activity`)*
- **`canonicalDomain`** dá um endereço a um tenant novo. Toda a source durável lê
  os domínios de uma única chave, e uma aplicação que nunca a passa cria tenants
  sem nenhum — em silêncio, porque o `subdomainResolver` responde a partir do
  `Host` sem consultar a tabela. O tenant serve tráfego; o que falta é o registo
  de que o endereço lhe pertence, e por isso não se lhe consegue anexar um
  domínio custom e nada impede um segundo tenant de reclamar o mesmo. Aplicado
  pelo `tenancy.create()`, para todos os caminhos de criação o receberem em vez
  de cada um ter de se lembrar. *(`@basaltkit/tenancy`)*
- **O `authorize` decide quem pode ver um resultado.** Um driver filtra pelos
  campos declarados `filterable` e por mais nada, o que deixava a pesquisa como a
  única superfície sem resposta para visibilidade linha a linha. O hook corre
  *depois* do driver, e é isso que permite ao pacote continuar a pedir até a
  página estar cheia — o que quem chama não consegue fazer de fora sem adivinhar
  um fator de over-fetch. Copiar a ACL para o índice é a alternativa rápida e a
  errada: um índice desatualizado dá um resultado velho, uma ACL desatualizada dá
  um resultado não autorizado. *(`@basaltkit/search`)*

### Respostas que estavam erradas em silêncio
- **Uma permissão é uma capacidade, não uma superfície.** O `matter:read` não
  distingue "ler o meu próprio processo no portal do cliente" de "ler o processo
  onde está a estratégia de litigância", por isso um papel a quem se concedeu o
  primeiro passava também a guarda do segundo — e um cliente de portal
  autenticado recebia `200` numa listagem interna com a estratégia do próprio
  processo no corpo. O `meta.audience` descreve para quem é uma rota, e a
  predefinição é o desenho todo: uma rota que não declara audiência é
  inalcançável por um papel confinado. Marcar a pequena superfície a que um papel
  restrito pode chegar é uma lista que alguém mantém; marcar todas as rotas a que
  não pode é uma lista que alguém esquece. *(`@basaltkit/permissions`)*
- **As versões de ficheiros leem o tenant ambiente, como o `Files` sempre fez.**
  Resolviam a chave do store como `tenantId ?? SINGLE_TENANT_SCOPE`, saltando o
  contexto do pedido, por isso uma app multi-tenant que não passasse um id
  explícito — o caso normal — escrevia as versões sob `acme` e lia-as de volta
  sob `default`: o `history()` devolvia `[]`, o `latest()` devolvia `null` e o
  `download()` rebentava para um ficheiro que estava no disco. A regra passa a
  viver num sítio só, exportada pelo `files` e usada pelos dois.
  *(`@basaltkit/files-versions`)*
- **O feed de atividade é escopado como `required` sob tenancy.** A predefinição
  antiga queria dizer "escopa ao tenant do contexto, corre sem escopo quando não
  há nenhum", por isso uma consulta ao feed fora de um tenant devolvia os
  registos de todos — e uma linha de feed nomeia um cliente em prosa. A mesma
  regra que a `cache` já aplicava. *(`@basaltkit/activity`)*
- **Todos os adaptadores HTTP do `testing` são peers opcionais.** O `express` e o
  `hono` já eram; o `fastify` era uma dependência normal por ser o adaptador
  predefinido, e essa assimetria custou meia hora a alguém. Quando o pacote moveu
  o seu intervalo de `fastify` para `^2` com uma app ainda em `1.x`, o pnpm
  instalou os dois, e o `createTestApp` resolveu um token `FASTIFY` de uma cópia
  diferente daquela que o `fastifyPlugin` da app registou: duas chamadas a
  `createToken('fastify')`, duas identidades, um contentor que não as consegue
  emparelhar. O erro dizia "No provider registered for token fastify" e não
  nomeava nem o pacote nem a diferença de versões. Um peer não pode duplicar.
  *(`@basaltkit/testing`)*

## Atualização

Os pacotes são independentes — sobe só o que usas. Dois contratos mudaram, e as
duas edições são mecânicas.

### O `app.server` passa a ser esperado

```ts
const server = await app.server()   // era: app.server
```

O `@basaltkit/testing` importa o adaptador a pedido, como já fazia para o
`express` e o `hono`, por isso uma app arrancada sem nenhum plugin HTTP continua
a funcionar e o pacote nunca vai buscar algo que a aplicação pode não ter
instalado. Um token resolvido através de um import dinâmico não pode ser síncrono.

Se o `pnpm install` começar a avisar de um peer `fastify` por satisfazer, o aviso
é o objetivo: é a diferença de versões que antes aparecia em runtime como um
token que não existe.

### O contrato do store de ficheiros tem três revisões

O `@basaltkit/files` publica um major. Um `FileStore` próprio precisa de três
edições:

| Era | É | Porquê |
| --- | --- | --- |
| `scanned?: boolean` | `scannedAt?: number` | A data deriva o booleano e o booleano não deriva a data. "Analisado", sem saber quando, deixa de ser resposta no momento em que as regras do scanner mudam — a única coisa que as regras de antivírus fazem de forma fiável. O hook `file:scanned` mantém o nome: o evento não é o campo |
| `metadata?: Record<string, unknown>` | `metadata?: FileMetadata` | `Record<string, JsonValue>` — de outra forma cada store durável faz um cast para passar pelo tipo JSON do seu driver, um cast que cada implementação repete e tem de acertar |
| `FilePatch = Partial<Pick<…>>` | escrito por extenso | Para poder dizer que uma chave presente com `undefined` **limpa** a coluna enquanto uma chave ausente a deixa em paz — o que o `Partial` de um campo opcional não consegue exprimir sob `exactOptionalPropertyTypes`, e que é como quem chama descarta um resultado de análise velho |

O `prisma:sync` aprende o domínio dos ficheiros, por isso os seus modelos juntam-se
como os de todos os outros.

### Dois pacotes estreiam em 0.1.0

O `files-prisma` e o `files-versions` publicam `0.1.0`, e não `1.0.0`. Nenhum foi
ainda corrido contra uma base de dados a sério por ninguém, e juntá-los ao
compromisso de semver do ecossistema logo no primeiro dia seria prometer uma
coisa que ninguém verificou. O número de versão diz isso mais barato do que um
changelog que ninguém lê, e deixa o `1.0.0` para quando for merecido.

---

## Anteriormente — Basalt 1.9

> *A versão **escrita por uma aplicação e não pelo framework**: construiu-se um
> SaaS jurídico a sério sobre o Basalt e fecharam-se quinze sítios onde o
> framework obrigou quem o usava a escrever código que o framework devia ter
> escrito.*

::: warning A partir do 1.9 é preciso Zod 4
Doze pacotes estreitam o peer do `zod` de `^3.24.0 || ^4.0.0` para `^4.0.0` —
ver [Atualizar para 1.9](#atualizar-para-1-9).
:::

### Duas peças oficiais que não encaixavam
- **A pesquisa full-text não corria de todo através do cliente Prisma.** A língua
  ia como parâmetro ligado, e o PostgreSQL não aceita isso onde quer um
  `regconfig`. Todas as queries falhavam com erro de tipo — não um resultado
  degradado, resultado nenhum. Agora com cast no sítio da chamada.
  *(`@basaltkit/search-postgres`)*
- **O plugin de auditoria abortava o provisionamento de tenants.** Os padrões por
  omissão incluíam `tenancy:switched`, que dispara fora de qualquer contexto de
  tenant; a captura lançava, e o erro propagava-se pelo `provision()`, marcando o
  tenant como falhado. Uma aplicação a seguir os defaults dos dois pacotes não
  conseguia criar um único tenant. O padrão saiu e as duas pontes passaram a
  isolar as suas falhas. *(`@basaltkit/audit`)*
- **O pacote de admin não fazia bundle para o browser a que se destina.**
  Importava `node:crypto` para gerar um id, e o barrel reexportava-o, portanto
  importar o `defineResource` arrastava um builtin do Node para o bundle. Todas as
  aplicações tinham de o substituir por um shim. *(`@basaltkit/admin`)*

### O framework passa a escrever o que todas as aplicações escreviam
- **`gate.actor()`** hidrata os papéis de quem chama a partir do âmbito do
  pedido, em vez de cada serviço o reimplementar — e levar com um 403 sem
  explicação quando se esquecia. *(`@basaltkit/permissions`)*
- **`accessRoutes()` e um subpath `permissions/match` sem dependências**, para o
  browser avaliar wildcards da mesma maneira que o servidor. Divergir aí não dá
  um erro que se veja; dá um ecrã com um botão que ninguém consegue carregar.
  *(`@basaltkit/permissions`)*
- **`inAppRoutes()`** serve os quatro endpoints que todas as aplicações
  escreviam à mão. A forma das rotas era opinativa que chegasse para ficar de
  fora; a regra de segurança não era, e é a mesma em todo o lado — **o
  destinatário é a sessão, nunca um parâmetro**. *(`@basaltkit/notifications`)*
- **`tenantClient()`** para stores construídos antes de existir um pedido, em vez
  de cada aplicação escrever o mesmo proxy. *(`@basaltkit/prisma`)*
- **`authRoutes({ password })`**, aplicado ao registo *e* ao reset — uma política
  imposta só num dos dois não é uma política. *(`@basaltkit/auth`)*

### Declarações que passam a ser verificadas
- **O `meta.subscribed` é validado no arranque.** Um nome de plano com uma gralha
  produzia uma rota que recusava toda a gente em silêncio. Todas as rotas
  ofensoras são reportadas de uma vez, porque arrancar, corrigir uma e arrancar
  outra vez é uma forma lenta de encontrar três. *(`@basaltkit/subscriptions`)*
- **O `RouteMeta` aceita assinatura de índice**, para um pacote poder estender os
  metadados de rota sem cada aplicação fazer cast. *(`@basaltkit/http`)*
- **O `prisma:sync` distingue o schema central do de um tenant.** A flag mais
  óbvia punha, em silêncio, tabelas centrais dentro do schema de cada tenant.
  *(`@basaltkit/prisma`)*

### Código gerado que combina com o projeto onde é gerado
- **O `defineResource` aceita rótulos de campo e opções de enum traduzidas.** Os
  rótulos vinham do nome do campo — `taxId` saía *Tax Id* — e as opções de enum
  saíam como os valores guardados. Numa aplicação escrita noutra língua, o
  formulário gerado ficava metade em inglês e metade em valores de base de dados,
  o que chegava para escrevê-lo à mão ser mais fácil. *(`@basaltkit/admin`)*
- **O gerador aceita um cliente Prisma configurável**, e opções do projeto. Uma
  aplicação com um segundo cliente — schema-por-tenant, réplica de leitura —
  tinha de editar à mão todos os repositórios gerados. *(`@basaltkit/generator`)*
- **O `authorize` recebe o contentor**, para o gate de subscrições de realtime
  alcançar um serviço sem uma variável de módulo preenchida pelo `boot` de outro
  plugin. *(`@basaltkit/realtime`)*
- **O SDK passa corpos nativos sem lhes tocar** — `FormData`, `Blob`,
  `ReadableStream` — e aceita `AbortSignal` e cabeçalhos por chamada.
  *(`@basaltkit/sdk`)*

### Atualizar para 1.9

Os pacotes são independentes — sobe só o que usas. Uma mudança é exigida a toda a
gente, e um comportamento apertou.

#### É preciso Zod 4

Doze pacotes — `admin`, `audit-viewer`, `auth`, `comments`, `env`, `fastify`,
`files`, `http`, `mcp`, `sdk`, `subscriptions`, `teams` — estreitam o peer do
`zod` de `^3.24.0 || ^4.0.0` para `^4.0.0`. Cada um publica um major por causa
disso.

```bash
pnpm add zod@^4
```

A segunda metade daquele range já não era exercitada há muito: este repositório
testa só contra o zod 4, portanto o zod 3 era uma promessa de compatibilidade que
ninguém verificava. Suportar uma major que nunca se corre é pior do que não a
suportar — trava a API e promete uma coisa que partia ao primeiro contacto.

O [guia de migração 3→4](https://zod.dev/v4/changelog) do próprio Zod cobre as
mudanças de API. As duas que mais tocam a quem usa Basalt:

- `z.string().datetime()` passa a `z.iso.datetime()`
- a personalização de erros passa de `message` / `invalid_type_error` para um só
  parâmetro `error`

O peer pede `^4.0.0` e não a 4.x mais recente — exigir a versão que este
repositório testa obrigaria todos os consumidores a mexer ao nosso ritmo sem
motivo.

#### Um nome de plano desconhecido passa a falhar o arranque

`meta.subscribed: 'pró'` contra um catálogo com `pro` arrancava bem e recusava
toda a gente em runtime. Agora é erro no arranque, com todas as rotas ofensoras
listadas de uma vez. Se um arranque começar a falhar depois da atualização, a
rota já estava morta — agora é que dá para ver.

---

## Anteriormente — Basalt 1.8

> *A versão em que **a persistência multi-tenant deixou de falhar em silêncio**:
> quatro maneiras distintas de um tenant acabar com os dados errados — ou sem
> dados nenhuns — com todas as camadas a comunicar sucesso.*

### Nunca mais se servem dados errados a um tenant em silêncio
- **Schema-por-tenant numa base que não o consegue fazer.** Assenta em um schema
  ser um namespace *dentro* de uma base de dados. Em MySQL um "schema" **é** uma
  base de dados; o SQLite não tem equivalente. Configurá-lo aí aparecia como um
  erro de sintaxe de `CREATE SCHEMA` na criação do tenant, longe da configuração
  que o causou. Agora é recusado onde a configuração é lida — no arranque, e uma
  vez antes de qualquer migração correr. *(`@basaltkit/prisma` 1.5)*
- **Migrações lidas do histórico errado.** O `migrations.path` pertence ao teu
  `prisma.config.ts`, não ao ficheiro de schema, portanto apontar o `--schema`
  para os modelos do tenant deixava o Prisma a aplicar o histórico **central**. O
  tenant nascia com a tabela `_prisma_migrations` e nenhuma das suas. Passa antes
  o `configPath`. *(`@basaltkit/prisma` 1.5)*
- **Uma migração que teve sucesso sem fazer nada.** O `prisma migrate deploy` sai
  com código 0 quando não encontra migrações, por isso uma pasta em falta ou
  vazia era indistinguível de sucesso — e o tenant era marcado como pronto. O
  `migrateTenants` passa a contar as tabelas do tenant e a comunicar `ok: false`.
  Conta *tabelas* e não migrações, porque o `db push` é uma estratégia legítima
  sem histórico nenhum. *(`@basaltkit/prisma` 1.6)*
- **Que estratégia funciona em que base de dados** passa a estar escrito na
  documentação, por estratégia e por motor, em vez de se deduzir de uma mensagem
  de erro. Ver
  [Que estratégia funciona em que base de dados](/pt/guide/database-per-tenant#que-estrategia-funciona-em-que-base-de-dados).

Isto é deliberadamente um conjunto de **proteções, não de abstrações**. Traduzir
`mode: 'schema'` para uma base separada em MySQL seria fazer
database-per-tenant com um nome que diz outra coisa — backups diferentes, limites
de ligações diferentes, custo de migração diferente. Isso pertence à tua
configuração como decisão, não ao framework como substituição silenciosa.

### Rotas centrais e de tenant na mesma app
O `required: true` rejeitava qualquer pedido que não resolvesse tenant — em
**todas** as rotas, o que nenhuma app aguenta: um health check não tem tenant
para enviar, e um load balancer nunca põe o header. Agora há duas saídas, e
compõem-se:

```ts
// Negar por omissão…
tenancyPlugin({ source, resolvers, required: true })

// …e cada rota diz o que é, ao lado do handler.
route({ method: 'GET', url: '/pricing',  meta: { tenant: false }, handler })
route({ method: 'GET', url: '/invoices', meta: { tenant: true },  handler })
```

O `meta.tenant` sobrepõe-se ao default da app nos dois sentidos, portanto a
decisão vive com a rota e sobrevive a um rename — ao contrário de uma lista de
caminhos noutro ficheiro, que deixa de coincidir em silêncio. O
`required: { except: [...] }` fica para caminhos que não são teus, como rotas
montadas por outro pacote. *(`@basaltkit/tenancy` 1.7 e 1.8)*

O `@basaltkit/http` 1.16 passa a rota servida aos **enrichers**, e não só aos
guards — é isso que torna o acima possível, e a razão de se comportar igual em
Fastify, Express e Hono em vez de por três implementações paralelas.

### Uma app, os dois mundos
O `prismaPlugin` já aceitava o `client` (para o contexto sem tenant) ao lado do
`schemaPerTenant`, mas isso era uma frase sem exemplo — na prática, indescobrível.
Com os dois definidos, o `db()` devolve o cliente central nos pedidos centrais e o
do tenant nos de tenant:

```ts
route({ method: 'GET', url: '/users', meta: { tenant: false }, handler: async () =>
  db<PrismaClient>().authUser.findMany(),  // central no domínio, tenant no subdomínio
})
```

O mesmo `/auth/login` passa a autenticar utilizadores centrais no domínio e
utilizadores do tenant num subdomínio — porque os dois procuram em schemas
diferentes, e não porque um handler verifica. As rotas montadas por outros
pacotes (`authRoutes()`, `mfaRoutes()`) resolvem-se mapeando o `meta` sobre elas.
Ver
[Servir rotas centrais e de tenant na mesma app](/pt/guide/database-per-tenant#servir-rotas-centrais-e-de-tenant-na-mesma-app),
incluindo o compromisso: com o `client` definido, uma rota de tenant mal marcada
lê a base central em vez de falhar ruidosamente, e é o `required: true` que
mantém isso seguro.

### Atualizar para 1.8

Os pacotes são independentes — sobe só o que usas. Nada no 1.8 é breaking, mas
dois comportamentos apertaram:

1. **O `migrateTenants` pode agora reprovar um tenant que antes passava.** Uma
   migração que não produziu tabelas comunica `ok: false` com
   `PRISMA_TENANT_SCHEMA_EMPTY`. Isso é quase sempre um histórico de migrações em
   falta ou mal apontado — mas se um tenant começar legitimamente vazio, passa
   `verifyTables: false`.
2. **O schema-por-tenant é recusado no arranque em MySQL e SQLite.** Nunca
   funcionou lá; apenas falhava mais tarde e de forma menos clara. Passa a
   database-per-tenant (`forTenant`, ou `{ mode: 'database', urlFor }`), que dá
   isolamento mais forte de qualquer maneira.

---

## Anteriormente — Basalt 1.7

> *A versão em que **nenhum núcleo te impõe um backend** — e em que um pedido
> falhado passou a ser visível em todos os adaptadores.*

### O núcleo define o contrato, o backend é um pacote
O `queue`, o `storage`, a `cache` e o `mailer` traziam um **atalho de string**
para um backend — `connection`, `driver: 's3'`, `driver: 'redis'`,
`driver: 'smtp'`. Uma string não pode ser resolvida preguiçosamente, portanto o
atalho *é* o que forçava a dependência: uma app em Azure Blob instalava à mesma
4,4 MB de SDK da AWS, e uma que enviava email pelo Resend instalava um cliente
SMTP que nunca abria.

| Núcleo | Era imposto a todos | Agora |
| --- | --- | --- |
| `@basaltkit/queue` **2.x** | `bullmq` | `@basaltkit/queue-bullmq` **1.0** |
| `@basaltkit/storage` **2.x** | `@aws-sdk/client-s3` — **4,4 MB** | `@basaltkit/storage-s3` **1.0** |
| `@basaltkit/cache` **2.x** | `ioredis` — **1,5 MB** | `@basaltkit/cache-redis` **1.0** |
| `@basaltkit/mailer` **2.x** | `nodemailer` — **688 KB** | `@basaltkit/mailer-smtp` **1.0** |

Uma app que use storage local, a cache em memória e o Resend deixa de instalar
**6,5 MB** de bibliotecas cliente que nunca chamou. Também acaba com uma
incoerência difícil de defender: acrescentar um quinto backend de filas era
fácil, acrescentar um segundo de *primeira classe* não era, porque o núcleo tinha
um preferido. A lista de exceções do teste de fronteira de drivers, que
registava exatamente estes quatro como dívida conhecida, está agora vazia.

### Um pedido falhado é visível em todos os adaptadores
Se um erro chegava ao teu terminal dependia do adaptador que tinhas montado —
exatamente a diferença que o pipeline neutro existe para apagar. O Express e o
Hono não registavam **nada**: um 500 não deixava rasto do lado do servidor. O
Fastify registava só 5xx, e só num dos seus dois pontos de captura. Agora todos os
4xx e 5xx são reportados nos três, em campos estruturados em vez de uma string
interpolada. *(`@basaltkit/http` 1.15)*

### A `main` está protegida
O `verify` (Node 22 e 24), a `coverage`, o `analyze` e o CodeQL passaram a ser
verificações **obrigatórias**, impostas também aos administradores, com pushes
diretos bloqueados. Antes disto o branch estava desprotegido.

### Atualizar para 1.7
Os quatro majors de capacidade são as únicas mudanças breaking, e cada uma é um
import e uma linha:

```diff
-queuePlugin({ connection: REDIS_URL, jobs, workers })
+bullmqQueuePlugin({ connection: REDIS_URL, jobs, workers })

-storagePlugin({ disks: { docs: { driver: 's3', bucket } } })
+storagePlugin({ disks: { docs: s3Disk({ bucket }) } })

-cachePlugin({ driver: 'redis', url })
+cachePlugin({ driver: redisCache(url) })

-mailerPlugin({ driver: 'smtp', smtp: { url }, from })
+mailerPlugin({ driver: smtpMailer({ url }), from })
```

**Não** és afetado se já passavas uma instância de driver, se usavas
`driver: 'local'`, a cache em memória por omissão, ou os drivers `log`/`memory` do
mailer. O TypeScript assinala todos os casos em tempo de compilação, porque as
strings removidas saíram das respetivas uniões. Detalhe completo em
[Pacotes de driver](/pt/guide/driver-packages).

---

## Anteriormente — Basalt 1.6

> *"Basalt 1.6" é o rótulo umbrella desta vaga de trabalho; os pacotes
> `@basaltkit/*` são versionados de forma independente (ver
> [Versionamento](/pt/guide/versioning)). Abaixo está o que entrou e a versão do
> pacote que o traz.*

O Basalt 1.6 é a release em que **a framework garante o que promete**. Três ciclos
de revisão de arquitetura pegaram nos princípios declarados do projeto —
neutralidade de adaptador, a fronteira dev-only da IA, «o SaaS é opcional»,
seguro-por-omissão — e transformaram cada um de convenção que era preciso lembrar
num **tripwire de CI que reprova o build**. Pelo caminho, as revisões encontraram
e corrigiram bugs reais que esses princípios deviam ter evitado.


### As promessas passaram a garantias
Cinco novas fronteiras impostas por máquina, cada uma com um teste que reprova o build:
- **Neutralidade de adaptador** — nenhum pacote de funcionalidade pode depender de
  um adaptador HTTP concreto. Dez tinham derivado para importar o contrato de rotas
  *através* do `@basaltkit/fastify`, forçando o Fastify em apps Express/Hono; todos
  repontados para `@basaltkit/http`. Uma suite de conformidade cross-adapter corre
  agora o mesmo contrato neutro nos três.
  *(o `@basaltkit/testing` ganhou `createTestApp({ adapter })`.)*
- **O SaaS é opcional** — um pacote genérico nunca pode *exigir* tenancy. Seis
  tinham começado a exigir: o `audit.trail()` rebentava em todas as chamadas numa
  app sem tenancy, empurrando-te para um método que a doc trata como escape hatch
  perigoso; o `search` chegava a exigir `tenantId` na escrita enquanto as leituras
  rebentavam. A nova `apps/beyond-saas` arranca uma app real com 18 plugins
  genéricos e **zero tenancy** para manter isto honesto.
  Ver [Para além do SaaS](/pt/guide/beyond-saas).
- **A camada de IA continua dev-only** — um teste ao grafo de imports mantém o
  `@basaltkit/ai` e o `@basaltkit/ai-mcp` fora do runtime de qualquer aplicação.
- **Segurança de lifetimes na DI** — o container falha agora ruidosamente perante
  uma *captive dependency* (um singleton que congelaria as instâncias de um scope
  de pedido para toda a app) em vez de servir objetos velhos em silêncio.
  *(`@basaltkit/core` 1.3)*
- **Guards declarados têm de ser impostos** — uma rota que declare `meta.auth`,
  `can`, `teamRole`, `scopes`, `subscribed` ou `feature` sem plugin que os imponha
  **falha no arranque**, nomeando o plugin que resolve, em vez de servir tráfego
  desprotegido. Opt-out deliberado com `allowUnguardedMeta`.

### Segurança
- **Billing**: as rotas de checkout/portal/faturas eram servidas **sem
  autenticação** (qualquer pessoa abria o portal de pagamento de um tenant), e o
  `checkout()` sobrescrevia a subscrição, pelo que um webhook genuinamente assinado
  podia **ativar um plano escalado**. Ambos corrigidos, com a escalada reproduzida
  primeiro como teste. *(`@basaltkit/subscriptions` 2.7)*
- **Reuso de refresh token**: o `markUsed` era ler-depois-escrever, por isso dois
  refreshes concorrentes devolviam **dois** pares de tokens válidos. Agora é um
  compare-and-swap em todos os stores. *(`@basaltkit/auth` 1.8)*
- XSS armazenado via URLs assinadas de ficheiros fechado (`Content-Disposition:
  attachment` por omissão), as UIs renderizadas no servidor ganharam **CSP
  route-scoped com hash**, os corpos de email são redigidos em produção, e o
  `html\`\`` torna o escape o caminho por omissão no email HTML.

### Fiabilidade sob carga
As implantações multi-réplica ganharam as garantias que lhes faltavam: o
`.onOneServer()` + `ScheduleLock` do scheduler (fim das execuções duplicadas em
cada réplica), um outbox de eventos que honra mesmo o at-least-once, confirmações
do publisher **antes do ack** no RabbitMQ (fechando uma janela de perda de jobs), e
redelivery no Kafka em vez de perda silenciosa. Cinco caminhos de crash de processo
foram eliminados — um WebSocket morto ou um soluço do Redis podiam antes derrubar
uma escrita de domínio.

### As docs são agora a referência oficial
Com a geração de API abandonada, os guias *são* a referência: 27 guias (EN + PT)
reescritos num único arco didático — o que é → modelo mental → quickstart
executável → receitas → tabela completa de opções → modos de falha com os códigos
de erro reais — e os [Conceitos centrais](/pt/guide/concepts) documentam a API
interna (lifetimes do container, fases dos plugins, o pipeline de rotas, os
metadata buckets, escrever o teu próprio guard/enricher) ao ponto de se construir
um pacote de terceiros só com as docs. Escrevê-las destapou mais quatro bugs reais.

### Atualizar para 1.6

Os pacotes são independentes — sobe só o que usas. Duas coisas a saber:

1. **A verificação no arranque é nova.** Se a tua app declara `meta.auth` (ou
   `can`, `teamRole`, `scopes`, `subscribed`, `feature`) numa rota mas nunca
   regista o plugin que os impõe, ela **falha agora no arranque**, com o plugin
   nomeado. Essa rota estava a ser servida desprotegida; regista o plugin, ou faz
   opt-out com `allowUnguardedMeta` se a tua edge trata disso.
2. **Alguns defaults apertaram** (documentados pacote a pacote): as URLs de
   ficheiros são `attachment` por omissão, os corpos de email são redigidos em
   produção, o scoping da cache fecha *quando a tenancy está ativa*, e o `meta.can`
   rejeita valores não-string em vez de saltar a verificação em silêncio.

---

## Anteriormente — Basalt 1.5

> A experiência de desenvolvimento IA **no teu editor e em qualquer cliente MCP** —
> Claude Desktop, Claude Code, ou o teu — mais a migração para TypeScript 7 em todo
> o repositório.

### Desenvolvimento IA sobre MCP
- **`@basaltkit/ai-mcp`** — uma ponte MCP **dev-only** que expõe os workflows de IA
  do Basalt como ferramentas MCP: `basalt_analyze`, `basalt_doctor`, `basalt_plan`,
  `basalt_review`, e um `basalt_make` confinado ao workspace. Aponta um cliente MCP à
  tua app (`npx @basaltkit/ai-mcp --cwd=<app>`) e conduz todo o ciclo
  analyze → plan → make → review a partir do Claude Desktop/Code. Traz ainda
  **resources de projeto** (`basalt://project/*`, `basalt://knowledge/architecture`)
  e **prompts de workflow** (`plan-feature`, `scaffold-resource`, `harden-tenancy`,
  `add-rbac`), sobre **stdio** (default) ou um transporte **HTTP** opcional. Como o
  resto da superfície de IA, nunca é uma dependência de runtime da tua app.
  *(`@basaltkit/ai-mcp` 0.1)* → ver [IA no teu editor (ponte MCP)](/pt/guide/ai-mcp).
- **`@basaltkit/mcp-core`** — um núcleo MCP **sem dependências** extraído do runtime
  `@basaltkit/mcp`: o protocolo JSON-RPC, um servidor genérico de tools/resources/
  prompts, transportes stdio + HTTP, e progress/cancelamento. Constrói o teu próprio
  servidor MCP sobre ele sem arrastar o runtime da framework para o grafo; o runtime
  `@basaltkit/mcp` assenta agora nele, com a API pública inalterada.
  *(`@basaltkit/mcp-core` 0.3)* → ver [Construir um servidor MCP](/pt/guide/mcp-core).
- **Seguro por design.** O `basalt_make` faz preview por defeito (deteção de colisões
  + diffs unificados, sem escritas); aplicar é explícito (`mode:"apply"`), sobrescrever
  exige `force`, migrações têm dupla-confirmação, e toda a escrita é confinada ao
  workspace-alvo.

### TypeScript 7 em todo o lado
- **O root passa também a TypeScript 7**, aposentando o último pin em `5.9` que
  existia só para o lint — todo o repositório, pacotes e root, no compilador nativo do
  TS 7. O ESLint está **temporariamente pausado** (um no-op documentado, reativável
  com uma mudança de uma linha) até o `typescript-eslint` suportar oficialmente o
  TS 7; o `typecheck` mantém-se totalmente ativo, por isso erros de tipo reais nunca
  são escondidos.

### Endurecimento de segurança
- **O transporte HTTP opcional valida `Origin` e `Host`.** O servidor HTTP do
  `@basaltkit/mcp-core` já fazia bind a loopback; agora rejeita também pedidos
  cross-site (`Origin`) e de DNS-rebinding (`Host`), para que uma página de browser
  não consiga conduzir a ponte de desenvolvimento local. Loopback-only por defeito,
  com uma válvula de escape (allow-list) para uso remoto/CI deliberado.
  *(`@basaltkit/mcp-core` 0.3, minor)*

### Documentação
- **Guias exaustivos e bilingues (EN + PT)** para a stack de dev-tooling AI/MCP:
  [IA no teu editor (ponte MCP)](/pt/guide/ai-mcp) e
  [Construir um servidor MCP](/pt/guide/mcp-core) — de um quickstart para iniciantes
  a uma referência avançada de cada tool, resource, prompt, transporte e do modelo de
  safe-make.

### Atualização (1.5)

Os pacotes são independentes — sobe só o que usas. Esta vaga é aditiva: o novo
`@basaltkit/ai-mcp` e o `@basaltkit/mcp-core` são tooling **dev-only** totalmente
novo, a API pública de runtime do `@basaltkit/mcp` está inalterada, e a mudança do
root para TypeScript 7 é interna. Apps Basalt novas podem optar pela ponte com
`create-basalt --mcp`.

---

## Anteriormente — Basalt 1.4

> Fundações e endurecimento: modernizou a toolchain, devolveu dentes reais aos gates
> de qualidade e segurança, e graduou a superfície de IA para um 1.0 estável.

### Toolchain TypeScript 7
- **Todo o monorepo compila, faz type-check e testa no compilador nativo do
  TypeScript 7.** O build de cada pacote passou de `tsup` para `tsc` puro —
  abandonando o `rollup-plugin-dts`, incompatível com o compilador do TS 7 — sem
  alterar os contratos `exports`/`types` publicados.

### IA & MCP → 1.0
- **`@basaltkit/ai` 1.0** — a experiência de desenvolvimento IA (dev-only): um motor
  agnóstico de provider mais o CLI `basalt ai` (`analyze`, `doctor`, `plan`, `make`,
  `review`), com API pública estável. *(`@basaltkit/ai` 1.0)*
- **`@basaltkit/mcp` 1.0** — a superfície de runtime do Model Context Protocol:
  expõe rotas opt-in como ferramentas sobre **HTTP (qualquer adaptador)** ou
  **stdio**, e consome servidores MCP externos como cliente — tudo pela pipeline
  neutra de rotas, sem SDK externo. *(`@basaltkit/mcp` 1.0)*

### Gate de qualidade
- **O gate de cobertura volta a ser imposto.** Tinha ficado informativo; agora
  bloqueia regressões, focado em código de runtime testável por unidade. Agregado real
  no re-baseline: statements 93% · branches 85% · funções 91% · linhas 95%.

### Endurecimento de segurança
- **Todos os achados de ReDoS alcançáveis em runtime foram eliminados.** As remoções
  quadráticas de caracteres finais foram reescritas como trims lineares sem regex em
  `audit`, `tenancy`, `mailer`, `auth`, `sdk` e `search-elasticsearch`, e o redator de
  PII limita o comprimento do input antes da regex. O backlog de code-scanning está em
  **zero alertas abertos**.
