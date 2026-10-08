# Persistence e stores duráveis

A maioria dos building blocks da Basalt mantém o seu estado por trás de um pequeno
**contrato de store** (uma interface), e traz uma **implementação em memória** como
predefinição. Isso é deliberado: podes construir e testar uma app inteira sem base de
dados a correr. Mas um store em memória perde tudo quando o processo termina — bom
para dev e CI, não para produção.

Ir para produção significa trocar os stores em memória por duráveis. O contrato
mantém-se idêntico, por isso é uma mudança de uma linha por store — sem reescrita.

[[toc]]

## O padrão

Toma a autenticação. `authPlugin` aceita um `UserSource`, um `SessionStore`, um
`RefreshTokenStore`, e mais. Não lhe dês nada e usa as predefinições em memória; dá-lhe
implementações duráveis e os teus utilizadores permanecem autenticados através de um
redeploy:

```ts
authPlugin({ secret })                       // dev — em memória, esquece no restart
authPlugin({ secret, users, sessions, ... }) // prod — stores duráveis
```

Cada store é apenas uma interface. Podes implementar uma contra qualquer base de dados
que já corras, ou recorrer a um pacote pronto a usar.

## Auth em SQLite — `@basaltkit/auth-sqlite`

O "backend real" de referência para auth é
[`@basaltkit/auth-sqlite`](/pt/reference/packages): implementações duráveis de **todos os
sete** stores de auth — utilizadores, sessões, refresh tokens, tokens de uso único
(verify/reset), API keys, inscrição MFA e versões de token — sobre o `node:sqlite`
embutido do Node. Sem ORM, sem ferramenta de migração, sem serviço separado, zero
dependências externas.

```ts
import { authPlugin, apiKeysPlugin } from '@basaltkit/auth'
import { sqliteAuthStores } from '@basaltkit/auth-sqlite'

const s = sqliteAuthStores('./data/auth.db')   // ':memory:' por predefinição

createApp({
  plugins: [
    authPlugin({
      secret: process.env.AUTH_SECRET!,
      users: s.users,
      sessions: s.sessions,
      refreshTokens: s.refreshTokens,
      tokens: s.tokens,   // verificação de email + reset de password
      mfa: s.mfa,
      // tokenVersions: s.tokenVersions, // opcional: revogação imediata de access tokens
    }),
    apiKeysPlugin({ store: s.apiKeys, users: s.users }),
  ],
})
```

`sqliteAuthStores()` abre (ou cria) o ficheiro, aplica um schema idempotente, e devolve
todos os stores nomeados para encaixarem diretamente nos plugins — mais o handle `db`
em bruto. O resto do teu código de auth fica intacto: estas classes implementam os
mesmos contratos que os stores em memória. Cada store também é exportado por si só
(`SqliteUserSource`, …) para que possas misturar backends. O `tokenVersions` **não tem
predefinição em memória** — o auth só verifica versões de token quando lhe passas um
store, ao custo de uma leitura por pedido verificado.

::: tip Versão do Node
`node:sqlite` é estável e sem flags no **Node 24**; no Node 22.x corre com
`--experimental-sqlite`. Requer Node 22.5+.
:::

O SQLite é uma predefinição genuinamente de nível de produção para apps de nó único.
Corres múltiplas instâncias que têm de partilhar estado de sessão? Aponta
sessões/refresh tokens para o Redis e mantém os utilizadores na tua base de dados
primária — os contratos tornam isso uma escolha por store.

## Auth em Postgres/MySQL — `@basaltkit/auth-prisma`

Quando a tua app já corre numa base de dados real,
[`@basaltkit/auth-prisma`](/pt/reference/packages) dá-te os mesmos sete stores de auth
suportados por **Prisma**. Trazes um `PrismaClient` gerado cujo schema inclua os
modelos `Auth*` (o pacote traz um `schema.prisma` de referência); os stores só tocam
nesses delegates, por isso assentam sobre o teu cliente existente sem tomarem posse do
teu schema ou conexão.

```ts
import { authPlugin, apiKeysPlugin } from '@basaltkit/auth'
import { prismaAuthStores } from '@basaltkit/auth-prisma'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const s = prismaAuthStores(prisma)   // passa o teu cliente diretamente, sem cast

createApp({
  plugins: [
    authPlugin({ secret, users: s.users, sessions: s.sessions,
                 refreshTokens: s.refreshTokens, tokens: s.tokens, mfa: s.mfa }),
    apiKeysPlugin({ store: s.apiKeys, users: s.users }),
  ],
})
```

Não copies os modelos à mão — corre **`basalt prisma:sync`**. Descobre todos os pacotes
`@basaltkit/*-prisma` instalados e funde os modelos de que precisam no teu
`prisma/schema.prisma` (interativo por predefinição; `--yes` adiciona-os todos,
`--only=auth,teams` restringe, `--push` aplica imediatamente):

```bash
pnpm basalt prisma:sync --push        # adiciona modelos em falta + cria as tabelas
```

É idempotente e nunca toca nos teus próprios modelos. Quando o teu `datasource` é
`mysql`, copia em vez disso a variante `schema.mysql.prisma` de cada pacote — vê
[MySQL](#mysql). E se ligares um store `*-prisma`
antes de os seus modelos existirem, o store agora falha rápido com uma mensagem clara
nomeando o modelo em falta e apontando-te para aqui — acabaram-se os crípticos
`reading 'create' of undefined`.

Caso contrário, copia os modelos de referência para o teu `schema.prisma`,
`prisma migrate`, e avança. Para **database-per-tenant** — cada domínio isolado na sua
própria base de dados ou schema sem filtragem de tenant por store — combina-o com
`@basaltkit/prisma` e encaminha os stores através do cliente do tenant ativo. Esse
setup ponta a ponta tem o seu próprio guia:
[Database-per-tenant](/pt/guide/database-per-tenant).

::: tip Qual deles?
`@basaltkit/auth-sqlite` para um nó único com zero dependências;
`@basaltkit/auth-prisma` quando já corres Postgres/MySQL ou precisas que múltiplas
instâncias partilhem uma base de dados. Ambos implementam os contratos de store
idênticos, por isso trocar é uma mudança de uma linha.
:::

### Prisma com pnpm: o cliente gerado

O Prisma 7 precisa de um `output` explícito no generator, e para onde ele aponta
decide se a app corre em `node` puro depois do build. O que o create-basalt gera
(e o que copiar para uma app mais antiga):

```prisma
generator client {
  provider = "prisma-client-js"
  output   = "../generated/prisma"   // fora do src/: o tsc nunca copia estes ficheiros .js
}
```

```json
{
  "imports": { "#db/*": "./generated/prisma/*" },
  "dependencies": {
    "@prisma/client": "^7.10.0",
    "@prisma/client-runtime-utils": "^7.10.0"
  }
}
```

```ts
// src/db.ts — o mesmo especificador resolve a partir do src/ (tsx, vitest) e do dist/src/ (node)
import { PrismaClient } from '#db/client.js'
```

- **Fora do `src/`.** Um cliente gerado em `src/generated` passa no typecheck e
  corre com tsx, mas o `tsc` só emite o que compila — os ficheiros `.js` gerados
  nunca chegam ao `dist/`, e o `node dist/src/server.js` falha com
  `ERR_MODULE_NOT_FOUND`. O alias `imports` evita tanto um script de cópia como um
  caminho relativo que difere entre `src/` e `dist/src/`.
- **`@prisma/client-runtime-utils` como dependência direta.** O
  `runtime/client.js` gerado pede-o pelo nome. Com pnpm é só uma dependência
  transitiva do `@prisma/client`, guardada no armazém virtual onde um ficheiro do
  teu projeto não chega — por isso declara-o, com a mesma versão do
  `@prisma/client`. Não é preciso `publicHoistPattern` nem `node-linker=hoisted`.
- **Aprova os scripts de build da CLI.** O pnpm 11 falha a instalação enquanto o
  build de uma dependência estiver por aprovar; o `pnpm-workspace.yaml` do
  scaffold lista `prisma` e `@prisma/engines` em `allowBuilds`.

O `create-basalt doctor` assinala um cliente gerado dentro do `src/` e um
`@prisma/client-runtime-utils` em falta; o `create-basalt update` acrescenta a
dependência e imprime a mudança a fazer. A imagem em si está em
[Ir para produção](/pt/guide/production#build-e-envio).

## Teams — `@basaltkit/teams-sqlite` / `@basaltkit/teams-prisma`

`@basaltkit/teams` mantém memberships e convites por trás do mesmo tipo de contrato de
store, e traz os mesmos dois backends duráveis — para que as rosters de equipa e os
convites pendentes também sobrevivam a um restart:

```ts
import { teamsPlugin } from '@basaltkit/teams'
import { sqliteTeamsStores } from '@basaltkit/teams-sqlite'   // nó único, zero-dep
// import { prismaTeamsStores } from '@basaltkit/teams-prisma' // Postgres/MySQL

const t = sqliteTeamsStores('./data/teams.db')
teamsPlugin({ memberships: t.memberships, invitations: t.invitations })
```

`prismaTeamsStores(prisma)` é o equivalente Prisma drop-in (traz um cliente com os
modelos `Team*` do schema de referência incluído). O mesmo trade-off "qual deles?" que
o auth: SQLite para um nó único, Prisma quando já corres uma base de dados ou precisas
de a partilhar entre instâncias. Podem partilhar um handle com os stores de auth.

## Subscriptions — `@basaltkit/subscriptions-sqlite` / `@basaltkit/subscriptions-prisma`

O billing tem três stores — o registo de **subscription**, os contadores de **usage**,
e a idempotência de **webhook** — e ambos os backends duráveis implementam os três:

```ts
import { subscriptionsPlugin } from '@basaltkit/subscriptions'
import { sqliteSubscriptionsStores } from '@basaltkit/subscriptions-sqlite'   // nó único
// import { prismaSubscriptionsStores } from '@basaltkit/subscriptions-prisma' // Postgres/MySQL

const s = sqliteSubscriptionsStores('./data/billing.db')
subscriptionsPlugin({ plans, store: s.store, usage: s.usage, webhooks: s.webhooks })
```

O `consume()` medido é **atómico** em ambos: o SQLite corre-o numa transação
`BEGIN IMMEDIATE` com uma guarda `RETURNING`; o Prisma usa um `updateMany` condicional
que o row lock da base de dados serializa. Por isso uma quota de plano nunca é
ultrapassada sob concorrência — a mesma garantia que o store Lua do Redis dá, agora sem
precisar de Redis. A idempotência de webhook sobrevive a restarts e a múltiplas
instâncias (uma reivindicação de id único), pelo que um evento reentregue é processado
uma vez.

::: tip Já em Redis?
`@basaltkit/subscriptions` ainda traz `RedisUsageStore` e `RedisWebhookStore` — usa-os
se o Redis já é o teu store partilhado. Os backends SQLite/Prisma adicionam o **registo
de subscription** durável (que não tinha backend não-memória) e permitem-te persistir
os três na tua base de dados primária.
:::

## Comments, audit, activity e notifications

Os stores de conteúdo e observabilidade seguem o mesmo padrão de dois backends — um
store cada, SQLite para um nó único e Prisma para uma base de dados partilhada:

| Domínio | Store | SQLite | Prisma |
| --- | --- | --- | --- |
| Comments | `CommentStore` | `sqliteCommentsStore()` | `prismaCommentsStore(prisma)` |
| Audit trail | `AuditStore` (append-only) | `sqliteAuditStore()` | `prismaAuditStore(prisma)` |
| Activity feed | `ActivityStore` | `sqliteActivityStore()` | `prismaActivityStore(prisma)` |
| Notificações in-app | `InAppStore` | `sqliteInAppStore()` | `prismaInAppStore(prisma)` |
| Permissions | `AccessStore`, `TemporaryGrantStore`, `DelegationStore` | `sqliteAccessStore()` | `prismaAccessStore(prisma)` |

```ts
import { auditPlugin } from '@basaltkit/audit'
import { sqliteAuditStore } from '@basaltkit/audit-sqlite'          // nó único
// import { prismaAuditStore } from '@basaltkit/audit-prisma'       // Postgres/MySQL

auditPlugin({ store: sqliteAuditStore('./data/audit.db').store })
```

Cada um retorna `{ store }` (o SQLite também expõe o `db` partilhado) nomeado para o
seu plugin: `commentsPlugin({ store })`, `auditPlugin({ store })`,
`activityPlugin({ store })`, `notificationsPlugin({ inApp: store })`. As queries mantêm
as semânticas em memória — mais recente primeiro, scope por tenant/destinatário, o
wildcard de evento do audit, filtragem de não lidos — agora duráveis. Payloads JSON
(`payload` do audit, `properties` da activity, `data` da notificação) são guardados
como texto e fazem a ida e volta sem alterações.

`@basaltkit/permissions` segue a mesma forma: `permissionsPlugin({ store })` recebe o
`AccessStore` durável (atribuições de papel e grants, com scope), pelo que o estado RBAC
também sobrevive a um restart. As mesmas factories devolvem também os stores duráveis
`temporaryGrants` e `delegations` — passa-os para que as concessões temporárias
(`grantTemporarily()`) e as delegações (`delegate()`) sobrevivam a restarts e sejam
partilhadas entre instâncias: `permissionsPlugin({ store: p.store, temporaryGrants:
p.temporaryGrants, delegations: p.delegations })`. Em Prisma precisam dos modelos
`PermTemporaryGrant` e `PermDelegation` (`basalt prisma:sync`), procurados no primeiro
uso — uma app que não os ligue não precisa de nenhum. As linhas expiradas ficam inertes;
apaga-as com `pruneExpired()` a partir de um job agendado. `@basaltkit/flags` não precisa de backend — as feature
flags são declaradas em código e avaliadas deterministicamente, sem nada para
persistir.

### Que hooks são auditados {#which-hooks-are-audited}

O `auditPlugin` regista os hooks de ciclo de vida que correspondem a `auth:**`,
`billing:**`, `tenancy:created` e `permission:**`, **exceto**
`auth:apikey_rejected`: dispara em cada pedido que apresenta uma API key morta,
antes de alguém estar autenticado, por isso registá-lo deixava qualquer cliente
anónimo acrescentar entradas ao trilho (serializado e encadeado por hash) de um
tenant tão depressa quanto conseguisse enviar pedidos.

`hooks` aceita uma lista (o conjunto de inclusão) ou `{ include, exclude }`. Um
hook é registado quando corresponde a um padrão de `include` e a nenhum de
`exclude`; sem `exclude`, aplicam-se as exclusões padrão
(`DEFAULT_AUDIT_HOOK_EXCLUDES`). Um hook nomeado **exatamente** em `include` é
sempre registado — é assim que voltas a incluir um:

```ts
auditPlugin({ hooks: ['auth:**', 'auth:apikey_rejected'] })               // regista também as recusas
auditPlugin({ hooks: { include: ['auth:**', 'billing:**'], exclude: ['auth:login'] } })
auditPlugin({ hooks: { include: ['auth:**'], exclude: [] } })             // sem exclusões padrão
```

Se registares `auth:apikey_rejected`, limita-o tu (o payload traz o `prefix` de
apresentação da chave e o `ip` do cliente para isso).

### Trilho de auditoria verificável

Ambos os stores de audit suportam um trilho **à prova de adulteração** (tamper-evident) e o contexto do pedido:

```ts
auditPlugin({
  store: prismaAuditStore(prisma).store,
  integrity: 'hash-chain',   // ou { mode: 'hash-chain', key: process.env.AUDIT_CHAIN_KEY! } (HMAC)
  requestContext: true,      // regista ip + user-agent — dados pessoais, ver abaixo
})
```

Cada entrada fica ligada à anterior da cadeia do seu tenant (`seq`, `prevHash`,
`hash` = SHA-256, ou HMAC-SHA256 sob uma chave, sobre uma serialização canónica),
com uma cadeia por tenant mais uma cadeia de sistema. O hash nomeia o seu algoritmo
e o id da chave (`v2:hmac-sha256:<keyId>:<hex>`), por isso uma chave pode ser
rodada sem partir o histórico: assina com a nova `key`/`keyId` e mantém a antiga
em `verifyKeys` — o `verify` escolhe a chave de cada entrada pelo seu id. Hashes
legados (64 hex simples) escritos por versões anteriores continuam a verificar sob qualquer chave
configurada. A coluna do hash precisa de até 144 caracteres (cabe no
`VARCHAR(191)` do preset MySQL).
`audit.verify({ tenantId, from?, to? })` — ou `basalt
audit:verify [--tenant=<id> | --all]` — deteta linhas editadas, apagadas,
reordenadas e forjadas. Ambos os stores têm uma **restrição única em `(chain, seq)`**,
pelo que réplicas a escrever ao mesmo tempo repetem a tentativa em vez de bifurcar
a cadeia. Linhas escritas antes de ativar `integrity` são reportadas como
*unchained* (fora da cadeia), não como corrompidas; qualquer outra linha fora da
cadeia (escrita depois de ela começar, ou com `seq` sob um nome de cadeia ausente
ou alheio) falha a verificação e aparece em `unverified` — usa
`trail({ chainedOnly: true })` para uma leitura com valor de prova. Apagar a cauda
não deixa lacuna: passa uma head registada noutro sítio como
`verify({ expectedHead })` (ou `--expected-head=<seq>:<hash>`) para detetar truncatura.
O `--all` também verifica tenants que têm linhas mas nenhuma cadeia (as linhas
escritas depois de a integridade começar falham como `unchained-entry`); o
`--all=true` é lido como `--all`, e um valor não reconhecido é um erro. Uma
entrada assinada por um id de chave que o verificador não tem falha como
`unknown-key`, e uma segunda linha no mesmo `seq` falha como `sequence-duplicate`
onde quer que caia — incluindo a fronteira de página, para um store próprio sem a
restrição única.

`requestContext: true` adiciona um enricher HTTP (igual em fastify, express e hono)
e guarda o `ip` e o `userAgent` do cliente. O IP é dado pessoal: com
`createPiiMinimizingRedactor({ key })` é guardado como pseudónimo.

O SQLite migra as novas colunas automaticamente; no Prisma, adiciona-as ao modelo
e migra primeiro (o [README do `@basaltkit/audit-prisma`](https://github.com/basaltkit/basalt/tree/main/packages/audit-prisma#upgrading-from-11)
tem o SQL). Depois, faz a base de dados impor também o append-only:

```sql
REVOKE UPDATE, DELETE, TRUNCATE ON "audit_entries" FROM app_role;
```

Mantém isto mesmo que apagues dados pessoais: o apagamento passa por um papel
de apagamento dedicado, nunca pelo papel da aplicação (ver [abaixo](#erasing-personal-data-audit-redact)).

#### Dados pessoais por evento (`fieldPolicies`)

O trilho é append-only e a cadeia de hashes cobre cada payload, por isso um
valor que lá chegue só pode ser apagado depois através de um
[`audit.redact()`](#erasing-personal-data-audit-redact) atestado, e um hash
antigo pode ainda confirmar um palpite sobre ele. Mantém os dados pessoais de
fora no momento da escrita. Os redactors trabalham sobre nomes
de chaves e formatos de valores (`password`, uma string com cara de email); não
sabem que as `notes` de um evento são dados de saúde. Declara isso por evento:

```ts
auditPlugin({
  integrity: 'hash-chain',
  fieldPolicies: {
    'customer.created': { omit: ['notes', 'address.street'], pseudonymize: ['email', 'fullName'] },
    'order.placed': { pseudonymize: ['items[].buyer.phone'] },
  },
  fieldPolicyKey: process.env.AUDIT_PII_KEY!, // >= 128 bits
})
```

- As chaves são nomes exatos de eventos ou hooks (sem wildcards). Os caminhos usam
  pontos; os arrays são percorridos de forma transparente, e `items[].x` torna-o
  explícito.
- `omit` remove o campo. `pseudonymize` substitui cada escalar sob ele por um
  pseudónimo HMAC com chave (`pii_<hex>`), para as entradas continuarem
  correlacionáveis. Um caminho presente em ambos é omitido.
- A política corre em `record()`, nos hooks e eventos capturados, **antes** do
  redactor e antes do hash, sobre uma cópia (o teu objeto nunca é alterado).
- Usa a mesma chave que `createPiiMinimizingRedactor({ key })` para obter os
  mesmos pseudónimos. Sem `fieldPolicyKey` é usada uma chave aleatória por
  processo e é registado um aviso uma vez.
- As políticas são validadas na configuração: uma opção desconhecida, um segmento
  vazio ou de protótipo (`__proto__`, `constructor`), ou um caminho com mais de 8
  segmentos lança um `TypeError`.

#### Apagar dados pessoais (`audit.redact`) {#erasing-personal-data-audit-redact}

Para um valor que já está guardado (um pedido de "direito ao apagamento" do
titular, ou um campo que nunca devia ter sido registado), `audit.redact()` apaga
os campos escolhidos de uma entrada **no próprio registo** e mantém o `verify` a
passar:

```ts
const { changed, residual } = await audit.redact(entryId, {
  payload: ['customer.email', 'items[].note'], // caminhos de fieldPolicies, ou 'all'
  ip: true,                                     // e/ou userAgent: true
  reasonRef: 'DSR-2026-114',                    // referência opaca, não pessoal
})
```

- Cada valor que um caminho alcança passa a `'[erased]'`; `ip`/`userAgent` são
  removidos. Caminhos ausentes são ignorados, e um pedido que não muda nada não
  escreve nada (`changed: false`). Apagar de novo junta-se ao marcador
  `redaction` da entrada.
- A entrada mantém o `hash` original, por isso as ligações da cadeia mantêm-se.
  Na mesma transação é acrescentada à cadeia da própria entrada uma
  **atestação `audit:redacted`**. Esta liga o `id`, o `seq` e o `hash` da entrada,
  os campos apagados, um digest do novo estado e o `reasonRef`, e nunca os dados
  apagados. O `verify` verifica a entrada apagada através dela, e qualquer
  discrepância falha como `redaction-mismatch`. Também verifica cada atestação
  no sentido inverso: a sua entrada tem de continuar apagada nesse estado ou num
  posterior. Repor uma linha apagada a partir de um backup, ou voltar a uma
  redação mais antiga, também falha. O resultado conta as entradas
  apagadas em `redacted`.
- O **âmbito** segue o `trail()`. Dentro de um contexto de tenant só as entradas
  desse tenant são alcançáveis, e qualquer outro id dá `AuditEntryNotFoundError`
  (404). Fora de um, passa `tenantId`. Uma app multi-tenant que precise de
  alcançar qualquer tenant chama `audit.systemRedact()`, que é só para
  ferramentas de confiança. Nunca lhe passes input do cliente.
- **Recusado** (`AuditRedactionRefusedError`, nada é escrito): `'unverified'`
  quando a entrada não verifica tal como está (para nunca abençoar conteúdo
  adulterado), `'residual'` (ver abaixo), e `'unsupported-store'` quando o store
  não tem `get()`/`redact()`. Os dois stores incluídos têm-nos.
- `record('audit:redacted', …)` lança um erro. O prefixo de eventos `audit:` está
  reservado a eventos do framework, por isso não o uses nos teus.

**Resíduo.** Depois do apagamento, o hash antigo da entrada pode ainda confirmar
um palpite sobre o valor apagado:

| Hash da entrada | `residual` | Quem pode confirmar um palpite |
|---|---|---|
| nenhum (fora da cadeia), v3 | `'none'` | ninguém |
| v2 HMAC (cadeia com chave) | `'keyed'` | quem tem a chave de integridade |
| v2 SHA-256 (cadeia sem chave) | `'public'` | qualquer pessoa que leia a linha |

`request.residual` é o máximo que aceitas, e o valor por omissão é `'keyed'`.
Apagar de uma cadeia sem chave tem de ser assumido com `residual: 'public'`. Para
as entradas escritas daqui em diante, define `integrity: { mode: 'hash-chain',
key, erasable: true }`. Escreve hashes v3 com um nonce aleatório por entrada que
o apagamento destrói, por isso o resíduo delas é `'none'`. Precisa da coluna
`nonce` (o SQLite migra-a; no Prisma, acrescenta-a ao modelo) e está desligado
por omissão.

**O papel de apagamento.** O papel da aplicação mantém o `REVOKE UPDATE` (acima).
O apagamento passa por um segundo papel da base de dados que só pode atualizar as
colunas apagáveis, com um segundo store e um segundo `Audit` com as mesmas
opções, entregue apenas ao job de apagamento. O [README do `@basaltkit/audit-prisma`](https://github.com/basaltkit/basalt/tree/main/packages/audit-prisma#the-eraser-role)
tem o `GRANT` e um trigger de guarda opcional. Um pedido do titular passa então a
ser lógica da app, autorizada por ti:

```ts
import { AUDIT_REDACTED_EVENT } from '@basaltkit/audit'

// eraserAudit = new Audit(eraserStore, …mesmas opções que o Audit da app)
for (const entry of await eraserAudit.systemTrail({ actorId: subjectId, limit: 1000 })) {
  if (entry.event === AUDIT_REDACTED_EVENT) continue
  await eraserAudit.systemRedact(entry.id, { payload: 'all', ip: true, userAgent: true, reasonRef: dsrId })
}
```

**O que não é apagado.** Os ids opacos (`actorId`, `tenantId`, `requestId`), o
nome do evento e a hora ficam. Depois de apagares o utilizador no teu store de
auth, o `actorId` já não identifica ninguém. As cópias noutros sítios são tuas
para apagar: o outbox de eventos, os feeds de atividade, os índices de pesquisa,
os logs e os **backups**. Guarda o registo de pedidos fora da base de dados e
volta a aplicá-lo depois de um restauro. Num deploy gradual, atualiza todas as
réplicas que correm o `verify` antes do primeiro apagamento ou antes de ligar o
`erasable`. Um `@basaltkit/audit` mais antigo reporta essas entradas como
`hash-mismatch`. Não há rota HTTP, comando de CLI nem ferramenta MCP para
apagar. Quem pode apagar é decisão da app.

#### Registar fora de um pedido (jobs, scripts)

Uma entrada recebe o `actorId` e o `tenantId` do contexto ativo. Fora de um
pedido não há contexto, por isso o `audit.record()` cai na **cadeia de sistema**
sem ator — a não ser que lhe dês um:

- **Jobs da fila** não precisam de nada: o `@basaltkit/queue` captura o tenant e
  o utilizador de quem despachou o job e restaura-os à volta do handler, por isso
  um `record()` dentro do job fica atribuído como no pedido que o despachou.
- **Scripts e comandos CLI** envolvem o trabalho no contexto em nome do qual agem:

  ```ts
  import { runWithContext } from '@basaltkit/core'

  await runWithContext({ tenant: { id: 'acme' }, user: { id: 'ops:backfill' } }, () =>
    audit.record('invoice.backfilled', { count }),
  )
  ```

- **Uma única entrada** pode passar um scope explícito como terceiro argumento:

  ```ts
  await audit.record('report.generated', { rows }, { tenantId: 'acme', actorId: 'job:nightly' })
  ```

  A entrada entra na cadeia desse tenant (`t:acme`), por isso o
  `verify({ tenantId: 'acme' })` cobre-a. O scope só pode **restringir**: dentro
  de um contexto com tenant (ou utilizador), um `scope.tenantId` (ou
  `scope.actorId`) diferente lança um `TypeError` em vez de escrever na cadeia de
  outro tenant. Ambos os valores têm de ser strings imprimíveis não vazias com no
  máximo 256 caracteres. Nunca reencaminhes input do cliente para ele.

## Tenancy — `@basaltkit/tenancy-sqlite` / `@basaltkit/tenancy-prisma`

O registo de tenants é a fundação de uma app multi-tenant, mas `@basaltkit/tenancy`
traz apenas `MemoryTenantSource` por predefinição — cada tenant é esquecido no restart.
Ambos os backends duráveis implementam o mesmo contrato `TenantSource`, pelo que o
registo (e os domínios personalizados de cada tenant) passa a ser persistente:

```ts
import { tenancyPlugin, subdomainResolver } from '@basaltkit/tenancy'
import { sqliteTenantSource } from '@basaltkit/tenancy-sqlite'   // nó único, zero-dep
// import { prismaTenantSource } from '@basaltkit/tenancy-prisma' // Postgres/MySQL

const tenants = sqliteTenantSource('./data/tenants.db')
await tenants.save({ id: 'acme', name: 'Acme', domains: ['app.acme.com'] })
tenancyPlugin({ source: tenants, resolvers: [subdomainResolver({ base: 'localhost' })] })
```

Um tenant é um **registo aberto** (`{ id, ...anything }`), guardado como JSON para que
qualquer campo por tenant faça a ida e volta sem alterações; os domínios personalizados
são normalizados numa tabela indexada para que `findByDomain` (o domain resolver) seja
uma lookup por chave. Ambos adicionam métodos de escrita — `save` (upsert + sincroniza o
conjunto de domínios), `remove` — e impõem **domínios globalmente únicos**: reivindicar
um já detido por outro tenant é rejeitado, pelo que o encaminhamento permanece
inequívoco. `prismaTenantSource` traz um `schema.prisma` de referência apanhado pelo
`basalt prisma:sync`; o mesmo trade-off "qual deles?" que o auth — SQLite para um nó
único, Prisma quando já corres uma base de dados.


Cada pacote traz também o `DomainStore` durável para domínios personalizados
verificados (`CustomDomains`), na mesma tabela: `prismaDomainStore(prisma)` /
`sqliteDomainStore(tenants.db)`. Os domínios reivindicados através dele sobrevivem
a todos os `save()`, e o `findByDomain` só os resolve depois de verificados — vê
[um domain store durável](/pt/guide/tenancy#um-domain-store-duravel).

## Outbox de eventos — `@basaltkit/events-sqlite` / `@basaltkit/events-prisma`

O outbox transacional escreve cada domain event num store durável, depois um relay
entrega-o ao mundo exterior (webhooks, Kafka…) e marca-o como publicado — a entrega é
**pelo menos uma vez e sobrevive a um crash**. Essa garantia só se mantém se o store for
durável, mas `@basaltkit/events` usa por predefinição `MemoryOutboxStore`, que perde
cada evento não relayado no restart. Ambos os backends implementam o mesmo contrato
`OutboxStore`:

```ts
import { outboxPlugin } from '@basaltkit/events'
import { sqliteOutboxStore } from '@basaltkit/events-sqlite'   // nó único, zero-dep
// import { prismaOutboxStore } from '@basaltkit/events-prisma' // Postgres/MySQL

const outbox = sqliteOutboxStore('./data/outbox.db')
outboxPlugin({
  store: outbox.store,
  captureEvents: ['order.*', 'invoice.*'], // registados duravelmente à medida que disparam
  dispatch: async (entry) => sendToWebhook(entry),
  intervalMs: 1000,
})
```

### Escrever o evento na tua transação

A garantia — o evento existe **se e só se** a alteração de estado fez commit —
exige que a entrada seja escrita *dentro* da transação de negócio. Passa o handle
da transação como `tx` ao `enqueue`; o store escreve através dele, por isso um
rollback remove ambos:

```ts
const outbox = app.container.get(OUTBOX)

// Prisma: o cliente da transação interativa
await prisma.$transaction(async (tx) => {
  await tx.order.update({ where: { id }, data: { status: 'paid' } })
  await outbox.enqueue('order.paid', { id }, { tenantId, tx })
})

// SQLite: o DatabaseSync que corre o BEGIN … COMMIT (mesmo ficheiro do outbox)
db.exec('BEGIN')
db.prepare(`UPDATE orders SET status = 'paid' WHERE id = ?`).run(id)
await outbox.enqueue('order.paid', { id }, { tx: db })
db.exec('COMMIT')
```

O `captureEvents` é conveniente mas **não** é transacional: regista o evento
quando o `emit()` corre, fora da tua transação. Usa um `enqueue(…, { tx })`
explícito para eventos que nunca podem divergir dos dados.

### Vários relays (réplicas)

Com um relay por réplica, dois relays leriam as mesmas linhas pendentes. Um store
que implementa `claim` impede o dispatch duplicado: depois de selecionar um lote,
o relay **reclama-o** com um único update condicional (`lockedUntil`/`lockedBy`,
um lease de `claimLeaseMs`, predefinição 5 min) e só despacha as linhas que
ganhou; o `pending()` esconde as linhas que outro relay detém. O
`@basaltkit/events-sqlite` reclama sempre (o seu `migrate()` acrescenta as
colunas); o `@basaltkit/events-prisma` reclama com
`prismaOutboxStore(prisma, { claim: true })` — acrescenta primeiro as colunas
`lockedUntil` / `lockedBy` (`basalt prisma:sync`, depois migrate). Usa queries de
modelo simples, não `FOR UPDATE SKIP LOCKED`: portável entre providers, permitido
pelo guard de raw queries da extensão de tenancy, e um relay que morre a meio de
um dispatch só retém as suas linhas até o lease expirar. A entrega continua
at-least-once.

### Semântica do relay

O relay é a parte que decide se o "pelo menos uma vez" é real. Quatro
comportamentos, todos verificáveis em `@basaltkit/events`:

- **A captura é aguardada.** Um padrão em `captureEvents` subscreve no bus do
  `@basaltkit/events`, e o listener faz `await` da escrita no outbox. Se essa
  escrita falhar, o `emit()` falha (o bus agrega as falhas dos listeners num
  `AggregateError`) em vez de o evento ser descartado silenciosamente enquanto o
  outbox promete at-least-once. O tenant é lido do contexto ambiente
  (`ctx().tenant.id`), por isso uma entrada registada dentro de um pedido fica
  automaticamente delimitada por tenant.
- **Ticks sobrepostos coalescem.** O `flush()` devolve o flush em curso em vez de
  voltar a selecionar o batch, por isso um dispatch mais lento que `intervalMs`
  não consegue entregar em duplicado as suas próprias entradas.
- **As falhas recuam.** Uma entrada falhada é ignorada por este processo até o seu
  atraso decorrer: `delayMs · 2^(tentativas-1)`, limitado a `maxDelayMs`
  (`type: 'fixed'` mantém-no constante, `backoff: false` faz retry em cada tick).
  O calendário é **local ao processo** — um restart esquece-o, pelo que o pior
  caso é um retry antecipado — a menos que o store reclame: aí a hora do retry é
  também escrita na linha, e todas as réplicas a respeitam. Continua at-least-once.
  As entradas em backoff nunca enchem o lote — o relay pede mais entradas para as
  saltar — por isso um destino em falha (ex. o endpoint de um tenant) não
  consegue deixar as entradas mais recentes à espera.
- **Um dispatch lento não serializa o lote.** Até `concurrency` entradas
  (default 8) são despachadas em paralelo; define `concurrency: 1` para entrega
  estritamente sequencial.
- **Os tenants são servidos de forma justa.** Quando o backlog de um tenant enche
  uma página inteira, o relay volta a consultar excluindo os tenants já vistos (o
  `pending(limit, maxAttempts, filter)` do store) e intercala o lote em
  round-robin por tenant — cada tenant mantém-se FIFO. Um tenant nunca tem mais
  de `tenantConcurrency` dispatches em curso, e um flush espera no máximo
  `dispatchTimeoutMs` por entrada: um dispatch mais lento continua *destacado*
  (não é cancelado nem reenviado) e o resultado é registado quando termina. Um
  tenant com um destino pendurado não consegue deixar os outros à espera, por
  muito que emita.
- **As entradas mortas são ruidosas.** Uma entrada que atinge `maxAttempts` é
  excluída dos futuros scans de `pending()` e reportada uma vez através de
  `onDead(entry, error)`; fica no store com o seu `lastError` para inspeção. Nada
  a apaga por ti.

::: warning Dois callbacks de erro diferentes
O `onDead(entry, error)` dispara para **uma entrada** que esgotou as suas tentativas.
O `onFlushError(error)` dispara quando o **próprio flush** falhou ao nível do store —
o `pending()` lançou, a base de dados está inacessível — pelo que nenhuma entrada
chegou sequer a ser selecionada. As falhas de dispatch por entrada nunca chegam ao
`onFlushError`; são registadas na entrada via `markFailed`. Ambos usam por
predefinição `console.error`
(`[basalt:outbox] entry "…" is dead after N attempts:` e
`[basalt:outbox] flush failed:`) e nenhum pode lançar. Tanto o caminho do
temporizador como a drenagem no encerramento passam pelo `onFlushError`, que é o que
impede uma falha da base de dados de se tornar uma rejeição não tratada que mata o
processo.
:::

```ts
outboxPlugin({
  store: outbox.store,
  dispatch: (entry) => sendToWebhook(entry),
  captureEvents: ['order.*', 'invoice.*'],
  intervalMs: 1000,
  batchSize: 50,
  maxAttempts: 10,
  backoff: { type: 'exponential', delayMs: 1000, maxDelayMs: 60_000 },
  onDead: (entry, error) => alerts.page('outbox entry dead', { id: entry.id, event: entry.event, error }),
  onFlushError: (error) => logger.error({ err: error }, 'outbox flush failed'),
})
```

`outboxPlugin(options)`:

| Opção | Tipo | Predefinição | Para que serve |
| --- | --- | --- | --- |
| `dispatch` | `(entry: OutboxEntry) => void \| Promise<void>` | — (**obrigatório**) | Entrega uma entrada confirmada ao mundo exterior; lançar marca a entrada como falhada e agenda um retry |
| `store` | `OutboxStore` | `new MemoryOutboxStore()` | Onde vivem as entradas — toda a garantia depende de este ser durável. O store em memória guarda as últimas 1000 entradas publicadas (`new MemoryOutboxStore({ retainPublished })`) |
| `captureEvents` | `string[]` | `[]` | Padrões de evento registados automaticamente (`'order.*'`); uma lista não vazia faz o plugin depender de `basalt:events` |
| `intervalMs` | `number` | — (manual) | Intervalo de polling do relay. Omite para fazeres flush tu via o token `OUTBOX`; o temporizador tem `unref()` por isso nunca mantém o processo vivo |
| `batchSize` | `number` | `50` | Entradas selecionadas por flush — sobe para throughput, desce para limitar o trabalho de um tick |
| `maxAttempts` | `number` | `10` | Tentativas antes de uma entrada ficar morta e ser reportada ao `onDead` |
| `backoff` | `OutboxBackoff \| false` | `{ type: 'exponential', delayMs: 1000, maxDelayMs: 60_000 }` | Ritmo de retry para entradas falhadas; `false` faz retry em cada tick |
| `concurrency` | `number` | `8` | Entradas de um flush despachadas em paralelo, para que um destino pendurado ocupe um lugar e não o lote. `1` = sequencial |
| `tenantConcurrency` | `number` | `ceil(concurrency / 2)` | Máximo de dispatches em curso de um tenant (ou de todas as entradas sem tenant juntas), entre flushes |
| `dispatchTimeoutMs` | `number \| false` | `10_000` | Espera máxima por entrada antes de o flush avançar; o dispatch continua destacado e o resultado é registado na mesma. `false` espera indefinidamente |
| `onDead` | `(entry, error) => void` | `console.error` | Uma entrada esgotou `maxAttempts` — chama alguém, isto é uma entrega externa perdida |
| `onFlushError` | `(error) => void` | `console.error` | O flush falhou ao nível do store (tick do temporizador ou drenagem no encerramento). Nunca pode lançar |
| `claimLeaseMs` | `number` | `300_000` | Stores que reclamam (vários relays): quanto tempo dura o claim de um relay sobre uma entrada. Passado esse tempo, um relay que morreu a meio do dispatch perde a entrada para outro relay. Tem de exceder o teu dispatch mais lento |
| `now` | `() => number` | `Date.now` | Relógio injetável (testes) |

`backoff` (`OutboxBackoff`):

| Opção | Tipo | Predefinição | Para que serve |
| --- | --- | --- | --- |
| `delayMs` | `number` | `1000` | Atraso base antes de repetir uma entrada falhada |
| `type` | `'fixed' \| 'exponential'` | `'exponential'` | Espaçamento dos retries: a duplicar ou constante |
| `maxDelayMs` | `number` | `60_000` | Teto para o atraso exponencial |

O backend SQLite mantém um índice parcial sobre as linhas não publicadas para que o
scan "o que está pendente?" do relay se mantenha barato. O backend Prisma coloca o
outbox na tua base de dados primária — o objetivo do padrão: enfileira o evento **na
mesma transação** que a mudança de estado, e os dois nunca podem discordar. `pending`,
os limites de tentativas e `markPublished`/`markFailed` mantêm as semânticas em
memória, agora duráveis.

::: tip A tabela do outbox é infraestrutura do framework
Dá ao store do outbox o cliente **normal** e nenhuma política de row-level
security, tal como às tabelas `auth_*` e `perm_*`. O relay lê-a sem tenant no
contexto — com RLS em schema partilhado não veria nada (ou o
`tenancyExtension` lançaria `PRISMA_TENANT_MISSING`), e com schema por tenant
vive no schema central. Cada entrada continua a guardar o seu `tenantId`, e o
relay de webhooks entra nesse tenant para a pesquisa de endpoints (ver
[Webhooks → Schema por tenant](/pt/guide/webhooks#schema-por-tenant)).
:::

## Webhooks de saída — `@basaltkit/webhooks-sqlite` / `@basaltkit/webhooks-prisma`

`@basaltkit/webhooks` mantém as suas subscrições de endpoint por trás de um
`WebhookStore`, e usa por predefinição `MemoryWebhookStore` — pelo que um redeploy
esquece cada endpoint registado e os eventos deixam silenciosamente de ser entregues.
Ambos os backends duráveis persistem as subscrições:

```ts
import { webhooksPlugin } from '@basaltkit/webhooks'
import { sqliteWebhookStore } from '@basaltkit/webhooks-sqlite'   // nó único, zero-dep
// import { prismaWebhookStore } from '@basaltkit/webhooks-prisma' // Postgres/MySQL

const webhooks = sqliteWebhookStore('./data/webhooks.db')
webhooksPlugin({ store: webhooks.store, secret: process.env.WEBHOOK_SECRET })
```

Cada endpoint (URL, padrões de evento, tenant opcional, secret por endpoint e flag
`active`) sobrevive a um restart. A correspondência de padrão de evento (`*`,
`prefix.*`, exato) reutiliza `matchesEvent`, pelo que `forEvent` se comporta de forma
idêntica ao store de memória — a lógica de entrega/retry é inalterada, apenas a lista de
subscrições é agora durável.

## MySQL

Os schemas de referência dos `*-prisma` estão escritos para PostgreSQL, e aí —
tal como em SQLite — um `String` simples é `TEXT`. **Em MySQL o Prisma
mapeia-o para `VARCHAR(191)`**, e um servidor MySQL fora do modo strict trunca
um valor mais longo com apenas um aviso: a escrita tem sucesso e o valor lido
de volta não é o que foi escrito. Um URL de webhook passa a entregar noutro
sítio, o `path` de um ficheiro deixa de nomear o objeto guardado, um payload
JSON deixa de fazer parse, e um payload ou hash de auditoria truncado **parte a
cadeia de hashes** para sempre.

Três coisas fecham o problema:

1. **Usa a variante MySQL do schema.** Cada pacote traz
   `schema.mysql.prisma` ao lado do `schema.prisma`: os mesmos modelos, com as
   colunas de texto livre alargadas (`@db.Text`, `@db.MediumText` para payloads
   JSON, `@db.VarChar(255)` para um nome DNS ou um content type) e as chaves
   deixadas em `VARCHAR(191)` para continuarem indexáveis. O `basalt prisma:sync`
   escolhe-a automaticamente quando o teu `datasource` diz `provider = "mysql"`,
   e avisa quando um pacote não tem nenhuma. O MySQL não tem `String[]`, por
   isso as variantes do `@basaltkit/comments-prisma` (`mentions`) e do
   `@basaltkit/auth-prisma` (`scopes`, `recoveryCodes`) guardam essas listas
   como `Json`.
2. **Liga a guarda.** Passa `{ columnLimits: 'mysql' }` à factory e o store
   mede cada string contra a sua coluna antes de escrever — em caracteres para
   `VARCHAR(n)`, em bytes UTF-8 para a família `TEXT` — e lança
   `ColumnLengthError` (`COLUMN_LENGTH_EXCEEDED`, status 422) em vez de deixar a
   base de dados cortá-la. Nada é escrito; no trilho de auditoria a cadeia
   continua verificável.
3. **Corre o MySQL em modo strict** (`sql_mode` com `STRICT_TRANS_TABLES`, a
   predefinição desde a 5.7), para o próprio servidor recusar o que nenhuma
   guarda cobre — um modelo teu, uma query raw.

```ts
const audit = prismaAuditStore(prisma, { columnLimits: 'mysql' })
const webhooks = prismaWebhookStore(prisma, { columnLimits: 'mysql' })
const files = prismaFilesStore(prisma, { columnLimits: 'mysql' })
```

`'mysql'` é o preset que corresponde ao `schema.mysql.prisma` distribuído; cada
pacote exporta-o (`auditMysqlColumnLimits`, `webhooksMysqlColumnLimits`, …). Se
alargares tu uma coluna, espalha o preset e sobe esse limite — um número é um
limite em caracteres, `{ bytes: n }` em bytes:

```ts
import { auditMysqlColumnLimits, prismaAuditStore } from '@basaltkit/audit-prisma'

prismaAuditStore(prisma, {
  columnLimits: { AuditEntry: { ...auditMysqlColumnLimits.AuditEntry, event: 500 } }, // event @db.VarChar(500)
})
```

Deixa `columnLimits` por definir em PostgreSQL e SQLite: nada é verificado e
nada muda. A opção existe no `activity-`, `audit-`, `auth-` (todos os stores),
`comments-`, `events-`, `files-` (os dois stores), `notifications-`,
`permissions-`, `subscriptions-` (as duas factories), `teams-` (os dois
stores), `tenancy-` e `webhooks-prisma` — todos os pacotes `*-prisma` trazem
agora variante MySQL. No `teams-prisma` ela alarga o `email` do convite para
`VARCHAR(254)`, o endereço válido mais longo; as chaves de permissões e de
equipas ficam em `VARCHAR(191)`. No `auth-prisma` o `email` do utilizador é
`VARCHAR(254)`; o hash da password, o segredo TOTP selado, o subject OIDC e o
material de chave das passkeys são `TEXT`; e `scopes`/`recoveryCodes` são
`Json` (o MySQL não tem listas escalares). Uma coluna é encurtada em vez de
recusada: o `lastError` do outbox, que é diagnóstico — recusá-lo impediria o
`markFailed` de contar a tentativa — é cortado para caber e marcado
`…[truncated]`.

## Stores suportados por Redis

Vários pacotes já trazem implementações Redis para o estado que mais beneficia de ser
partilhado entre instâncias:

| Preocupação | Em memória (predefinição) | Durável / partilhado |
| --- | --- | --- |
| Cache | `MemoryCacheDriver` | `redisCache()` (`@basaltkit/cache-redis`), tiered (`@basaltkit/cache-tiered`) |
| Usage metering | `MemoryUsageStore` | `RedisUsageStore` — `consume()` atómico via Lua |
| Idempotência de webhook | `MemoryWebhookStore` | `RedisWebhookStore` — `SET NX EX` entre restarts |
| Rate limiting | `MemoryRateLimitStore` | `RedisRateLimitStore` (`@basaltkit/http`) — um contador atómico partilhado entre instâncias |
| Idempotência de request | `MemoryIdempotencyStore` | `RedisIdempotencyStore` (`@basaltkit/http`, qualquer adapter) — reproduz uma resposta em cache entre instâncias |
| Queues | driver em memória | pacotes de driver RabbitMQ / Kafka / SQS |
| Search | `MemorySearchDriver` | `MeilisearchDriver` (incluído), `@basaltkit/search-postgres`, `@basaltkit/search-elasticsearch` |
| Storage | disco local | pacotes de driver S3 / GCS / Azure |

## Escrever o teu próprio store

Um store é um punhado de métodos async. Para suportar utilizadores de auth com a tua
base de dados existente, implementa `UserSource`:

```ts
import type { UserSource, AuthUser, UserPatch, NewUser } from '@basaltkit/auth'

class PrismaUserSource implements UserSource {
  async findByEmail(email: string): Promise<AuthUser | null> { /* … */ }
  async findById(id: string): Promise<AuthUser | null> { /* … */ }
  async create(data: NewUser): Promise<AuthUser> { /* … persiste data.emailVerified ?? false */ }
  async update(id: string, patch: UserPatch): Promise<AuthUser | null> { /* … */ }
}
```

`@basaltkit/auth-sqlite` e `@basaltkit/auth-prisma` são referências compactas e
totalmente testadas para os sete stores de auth — lê qualquer uma quando construíres uma
para outra base de dados ou ORM. A mesma abordagem aplica-se a todos os outros contratos
de store na stack.

## Referência de opções

Cada backend durável é uma **factory**, não um plugin — chama-la uma vez no
arranque e passas o resultado ao plugin dono do domínio. As duas famílias têm uma
assinatura cada:

| Família | Assinatura | Devolve |
| --- | --- | --- |
| `sqlite*` | `(dbOrLocation: DatabaseSync \| string = ':memory:')` | `{ db, …stores }` — o handle `node:sqlite` em bruto mais um store por contrato |
| `prisma*` | `(client: PrismaClient, options?)` | `{ …stores }` — sem handle; o cliente já é teu. `options.columnLimits` protege as larguras de coluna em MySQL ([MySQL](#mysql)) |

Passar um **caminho** abre (ou cria) o ficheiro e aplica o schema; passar um
`DatabaseSync` existente migra esse handle, que é como vários domínios partilham
um só ficheiro. `':memory:'` é a predefinição, e é por isso que uma factory sem
configuração continua segura em testes.

| Domínio | Factory SQLite | Factory Prisma | Alimenta |
| --- | --- | --- | --- |
| Auth | `sqliteAuthStores()` | `prismaAuthStores(client)` | `authPlugin({ users, sessions, refreshTokens, tokens, mfa, tokenVersions })`, `apiKeysPlugin({ store, users })` |
| Teams | `sqliteTeamsStores()` | `prismaTeamsStores(client)` | `teamsPlugin({ memberships, invitations })` |
| Subscriptions | `sqliteSubscriptionsStores()` | `prismaSubscriptionsStores(client)` | `subscriptionsPlugin({ store, usage, webhooks })` |
| Pagamentos | `sqlitePaymentStores()` | `prismaPaymentStores(client)` | os stores do ledger de pagamentos + recorrências |
| Comments | `sqliteCommentsStore()` | `prismaCommentsStore(client)` | `commentsPlugin({ store })` |
| Audit | `sqliteAuditStore()` | `prismaAuditStore(client)` | `auditPlugin({ store })` |
| Activity | `sqliteActivityStore()` | `prismaActivityStore(client)` | `activityPlugin({ store })` |
| Notifications | `sqliteInAppStore()` | `prismaInAppStore(client)` | `notificationsPlugin({ inApp: store })` |
| Permissions | `sqliteAccessStore()` | `prismaAccessStore(client)` | `permissionsPlugin({ store, temporaryGrants, delegations })` |
| Tenancy | `sqliteTenantSource()` | `prismaTenantSource(client)` | `tenancyPlugin({ source })` — devolve a própria source, não `{ store }` |
| Domínios personalizados | `sqliteDomainStore(db)` | `prismaDomainStore(client)` | `new CustomDomains({ store })` — devolve o próprio store |
| Outbox de eventos | `sqliteOutboxStore()` | `prismaOutboxStore(client, { claim? })` | `outboxPlugin({ store })` |
| Webhooks | `sqliteWebhookStore()` | `prismaWebhookStore(client)` | `webhooksPlugin({ store })` |

Cada pacote também exporta `openXDatabase(location)` e `migrate(db)` se quiseres
controlar tu a abertura e a migração, e cada classe de store individual
(`SqliteUserSource`, `PrismaAuditStore`, …) recebe um `DatabaseSync` /
`PrismaClient` no construtor — por isso podes misturar backends por store.

Os únicos backends com opções de comportamento próprias são os do outbox: as
tabelas do relay estão em **Semântica do relay**, acima, e o `prismaOutboxStore`
aceita `{ claim: true }` (vê **Vários relays**) — mais a guarda `columnLimits`
para MySQL que todas as factories `prisma*` aceitam ([MySQL](#mysql)). Todo o
resto é configurado no
plugin que o consome — vê [Auth](/pt/guide/auth), [Teams](/pt/guide/teams),
[Billing](/pt/guide/billing), [Tenancy](/pt/guide/tenancy) e
[Webhooks](/pt/guide/webhooks).

## Modos de falha e resolução de problemas

| Erro | Código | Quando |
| --- | --- | --- |
| `Error: @basaltkit/<pkg>-prisma: the Prisma client has no <model> model.` | — | Uma factory `prisma*` correu contra um cliente cujo schema não tem os modelos. Corre `basalt prisma:sync --push` e depois `prisma generate`. Clientes lazy/proxy (base de dados por tenant) saltam a verificação e falham na primeira utilização |
| `Error: @basaltkit/tenancy-prisma: domain "…" is already owned by tenant "…".` | — | O `save()` tentou reivindicar um domínio personalizado que pertence a outro tenant. Os domínios são globalmente únicos para o encaminhamento ser inequívoco; o save inteiro é rejeitado antes de qualquer escrita. A source SQLite impõe a mesma regra com uma constraint PRIMARY KEY, dentro de uma transação que faz rollback |
| `ColumnLengthError: @basaltkit/<pkg>-prisma: <Model>.<column> is N characters, over its column limit of M.` | `COLUMN_LENGTH_EXCEEDED` | Um store configurado com `columnLimits` recusou um valor que a sua coluna MySQL não comporta. Nada foi escrito. Alarga a coluna e sobe o limite, ou encurta o valor — vê [MySQL](#mysql) |
| `AggregateError` vindo de `bus.emit(...)` | — | Uma escrita de captura do outbox falhou. A captura é aguardada de propósito — o emissor tem de ver a falha em vez de acreditar que um evento perdido foi registado |
| `EventValidationError` | `EVENT_INVALID` | O schema do evento rejeitou o payload antes de qualquer listener (incluindo a captura do outbox) correr |
| `UnknownTokenError` | `DI_UNKNOWN_TOKEN` | O `OUTBOX` (ou qualquer token de store) foi resolvido sem o plugin que o regista |
| `ERR_UNKNOWN_BUILTIN_MODULE` no `import 'node:sqlite'` | — | Um pacote `*-sqlite` em Node 22.x sem `--experimental-sqlite`. Usa Node 24, ou acrescenta a flag; os pacotes declaram `engines.node >= 22.5.0` |
| `TenantPoolExhaustedError` (503, o corpo diz só "Service unavailable.") | `PRISMA_POOL_EXHAUSTED` | Base de dados por tenant: todos os `max` clientes do pool ficaram em uso durante `acquireTimeoutMs`. As contagens `leased`/`recentlyUsed` ficam no log do servidor, nunca na resposta. Sobe `max` para os tenants distintos activos em poucos segundos — vê [Base de dados por tenant](/pt/guide/database-per-tenant) |

- **"Funcionava em dev e esqueceu tudo depois do deploy"** — um store continua na
  sua predefinição em memória. As predefinições são silenciosas por design; procura
  no teu `createApp` os plugins a que nunca passaste um store, e percorre a
  checklist abaixo.
- **As entradas do outbox acumulam-se por publicar** — ou não há relay a correr
  (`intervalMs` por definir e nada chama `OUTBOX.flush()`), ou todas as entradas
  estão mortas. As entradas mortas são excluídas do `pending()`, por isso a tabela
  cresce enquanto o relay diz não ter nada a fazer: verifica o `lastError` e se o
  `onDead` disparou.
- **Os eventos são registados mas nunca entregues depois de um redeploy** — o
  store do outbox é durável mas as **subscrições de webhook** não são. O
  `MemoryWebhookStore` esquece cada endpoint registado, e a entrega para em
  silêncio.
- **`SQLITE_BUSY` / contenção de locks sob carga** — um ficheiro SQLite é um só
  escritor. É esse o trade-off das zero dependências; move o domínio quente para
  Prisma (ou Redis, no caso de cache/usage/idempotência) quando um único escritor
  deixar de chegar.
- **Um store durável continua a não devolver nada para um tenant** — o store é
  durável, não encaminhado por tenant. Para base de dados por tenant tens de o
  encaminhar através do cliente do tenant ativo; vê
  [Base de dados por tenant](/pt/guide/database-per-tenant).
- **Base de dados por tenant: uma query falha, ou as ligações acumulam-se,
  depois de a resposta ter sido enviada** — trabalho que sobrevive ao pedido
  continua a usar `ctx().db`, cujo lease terminou com a resposta. Faz `await`
  antes de responder, ou corre-o em `tenancy.run()` / `DB_POOL.use()`.
- **Base de dados por tenant: todos os pedidos estão lentos e a base de dados
  vê um fluxo de ligações novas** — mais tenants distintos do que `max`
  revezam-se, por isso o pool fecha e abre um cliente por pedido (já não
  responde 503). Sobe `max` e vê com que frequência a tua factory `forTenant`
  corre.

## O que fazer antes de ir para produção

- Substitui os stores de **auth** em memória por `@basaltkit/auth-sqlite` (ou a tua
  própria DB).
- Move **cache**, **usage metering** e **idempotência de webhook** para Redis se
  correres mais do que uma instância.
- Aponta **queues**, **search** e **storage** para os seus drivers de produção.
- Para um **trilho de auditoria** com valor de conformidade, ativa `integrity: 'hash-chain'`,
  revoga `UPDATE`/`DELETE` em `audit_entries` e agenda `basalt audit:verify --all`
  ([acima](#trilho-de-auditoria-verificavel)).
- Em **MySQL**, copia as variantes `schema.mysql.prisma`, passa
  `{ columnLimits: 'mysql' }` a todas as factories `prisma*` e mantém o servidor
  em modo strict ([acima](#mysql)) — caso contrário valores longos são
  truncados em silêncio.

Vê [Going to Production](/pt/guide/production) para a checklist completa.
