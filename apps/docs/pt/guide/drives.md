# Drives externos

O `@basaltkit/drives` liga as **contas de armazenamento de ficheiros externas**
de um tenant — Google Drive, OneDrive/SharePoint, Dropbox — à tua aplicação,
para que documentos que vivem noutro sítio possam ser listados, importados e
mantidos sincronizados.

A parte específica de cada fornecedor é pequena e vive num adaptador. Tudo o que
está acima dela é genérico e vive aqui: várias ligações por tenant, credenciais
OAuth cifradas em repouso com refresh e rotação, paginação agnóstica do
fornecedor, download em stream que nunca carrega o ficheiro em memória,
sincronização incremental por cursor, deduplicação, backoff de rate limit e
verificação de notificações recebidas.

[[toc]]

## Migrar da 0.1.x

::: warning Três formas mudaram
Todo o resto da 0.1.x continua a compilar. Os membros opcionais que os
adaptadores acrescentaram (`deltaIncludesExisting`, `retryAfterFromBody`,
`accountIds`, `secrets`, `DriveRefreshInput.scopes`) são aditivos, e um
adaptador que não declare nenhum deles mantém o comportamento da 0.1.
:::

**1. Uma notificação resolve para uma lista de ligações.** Uma entrega do
Dropbox nomeia *contas*, e a mesma conta pode estar ligada várias vezes (duas
etiquetas num tenant, ou a mesma conta ligada por dois tenants). A 0.1 devolvia
uma única ligação, o que teria sincronizado uma delas e deixado as restantes
desatualizadas.

```ts
// 0.1.x
if (outcome.shouldSync && outcome.connection) await sync(outcome.connection)

// 0.2.0
if (outcome.shouldSync) for (const connection of outcome.connections) await sync(connection)
```

O `connections` está sempre presente e é `[]` quando nada corresponde. Procura
no teu código por `.connection` num outcome: um sítio migrado a meio lê um campo
que já não existe, em vez de falhar de forma visível.

**2. Uma notificação verificada que não corresponde a nada devolve em vez de
lançar.** A 0.1 lançava `DriveNotificationInvalidError`, e a rota respondia
`400`. Responder de forma diferente a uma notificação sem correspondência é um
oráculo sobre que contas é que um deployment tem, por isso passa a ser
`reason: 'unmatched'`, `shouldSync: false` e o mesmo `200` que uma
correspondência recebe.

```ts
// 0.1.x — este catch já não dispara para uma notificação sem correspondência
try {
  await handleNotification(drives, input, options)
} catch {
  return reply.status(400)
}

// 0.2.0 — uma *assinatura* inválida continua a lançar; "não corresponde a nada" é um outcome
const outcome = await handleNotification(drives, input, options)
if (outcome.reason === 'unmatched') log.info('notificação para nenhuma ligação nossa')
```

O `DriveNotificationInvalidError` não mudou e continua a ser lançado para uma
notificação em que não se pode *confiar* — assinatura inválida, segredo de canal
em falta, um corpo que não é sequer uma notificação. Só a distinção
correspondeu/não correspondeu é que mudou. Se usas o `driveRoutes()`, isto já
está tratado.

**3. O `DriveRemoval.externalId` é opcional.** Uma eliminação no Dropbox não
traz id nenhum, só o caminho, por isso uma remoção reportada pode ter `path` e
não ter `externalId` (e portanto também não ter `targetId`, que o motor resolve
no ledger pelo id).

```ts
// 0.1.x
onRemoved: async ({ externalId, targetId }) => archive(externalId, targetId)

// 0.2.0
onRemoved: async ({ externalId, path, targetId }) => {
  if (externalId !== undefined) return archive(externalId, targetId)
  // Dropbox: correlaciona com aquilo que guardaste no momento da importação.
  return archiveByPath(path!)
}
```

No Google e na Microsoft o `externalId` continua a estar sempre presente — mas
agora está *tipado* como opcional, por isso um sítio de chamada existente
precisa de uma verificação.

## Modelo mental

Três coisas que não devem ser confundidas:

| Peça | O que é | Pertence a |
| --- | --- | --- |
| Uma **ligação** | o consentimento de um tenant a uma conta num fornecedor, com a sua etiqueta, raiz, credenciais e cursor de sincronização | `@basaltkit/drives` |
| Um **item** | um ficheiro ou pasta **no fornecedor**, identificado pelo `externalId` | o fornecedor |
| A **importação** | aquilo com que a tua aplicação ficou — um registo do `@basaltkit/files`, ou uma linha tua | a tua aplicação |

Um tenant pode ter **várias ligações ao mesmo fornecedor**. "Drive Finance" e
"Drive HR" são duas linhas com `provider: 'google'`, credenciais, raízes e
cursores independentes. Nada é indexado por `(tenant, fornecedor)`, o que faz
com que isto resulte do modelo em vez de ser um caso especial.

## Configuração

```ts
import { drivesPlugin, DRIVES } from '@basaltkit/drives'

const app = createApp({
  plugins: [
    tenancyPlugin({ /* … */ }),
    // O sniffing importa aqui: o content type declarado por um fornecedor é o
    // que o cliente que fez upload afirmou, por isso nunca é de confiança.
    filesPlugin({ disk: 'documents', validate: { sniff: true } }),
    drivesPlugin({
      providers: [/* um adaptador — ver "Escrever um adaptador" */],
      keys: [{ id: '2026-09', key: env.DRIVES_ENCRYPTION_KEY }],
      secret: env.APP_SECRET,
      store: prismaDriveConnectionStore(db),
      ledger: prismaDriveImportLedger(db),
    }),
  ],
})
```

`keys` é um **conjunto de chaves**. A primeira entrada cifra as credenciais
novas; todas as outras continuam legíveis, por isso a rotação é uma mudança
progressiva — acrescenta a chave nova à frente, deixa as ligações re-cifrarem à
medida que fazem refresh, e remove a chave antiga quando nada a referenciar. Usa
o `secret()` do `@basaltkit/env` para que um valor de exemplo não chegue a
produção:

```ts
export const env = defineEnv({
  DRIVES_ENCRYPTION_KEY: secret({ minLength: 32 }),
})
```

## Rotas

O `driveRoutes()` serve o fluxo de ligação e **um** endpoint de notificações que
responde aos handshakes dos três fornecedores. É construído com o `route()` do
[`@basaltkit/http`](/pt/guide/adapters), por isso as mesmas definições correm sem
alterações em Fastify, Express e Hono.

```ts
import { driveRoutes } from '@basaltkit/drives'

fastifyPlugin({
  routes: driveRoutes({
    redirectUri: (provider) => `https://app.example.com/drives/${provider}/callback`,
    successRedirect: '/settings/drives',
    notifications: {
      connections: ({ accountIds }) => db.driveConnections.byAccount('dropbox', accountIds ?? []),
      onChange: (connections) => Promise.all(connections.map((c) => SyncDrive.dispatch(c))),
    },
  }),
})
```

| Rota | O que faz |
| --- | --- |
| `GET /drives/:provider/connect` | 302 para o consentimento, com o binding do browser num cookie `HttpOnly`, `SameSite=Lax`, `Secure` limitado ao fluxo |
| `GET /drives/:provider/callback` | valida state + binding, troca o código, guarda a ligação, limpa o cookie |
| `GET /drives/:provider/notifications` | responde ao desafio do handshake como `text/plain` com `nosniff` |
| `POST /drives/:provider/notifications` | valida e depois agenda; responde sempre `200 {received:true}` |

As rotas de ligação usam `meta: { auth: true }` por omissão — iniciar uma
autorização em nome de um tenant não é uma acção anónima. As rotas de
notificação nunca têm metadados de guarda: o fornecedor não tem sessão.

### O corpo em bruto

A rota de notificações precisa dos bytes **intactos** do pedido: uma assinatura
cobre os bytes que chegaram, por isso um corpo re-serializado é uma *mensagem
diferente*.

Ela declara `body: rawBody({ maxBytes })` de `@basaltkit/http`, por isso o
**Fastify, o Express e o Hono entregam-lhe os octetos exactos sem wiring
nenhum** — sem content-type parser, sem hook `verify`, sem middleware. Os bytes
são lidos depois de correrem os guards do pipeline, limitados a 64 KiB por
omissão (`notifications.maxBytes`), e nunca são analisados por nada.

```ts
fastifyPlugin({ routes: driveRoutes({ /* … */ notifications: { /* … */ } }) })
// …e as mesmas rotas, sem alterações, no expressPlugin() e no honoPlugin().
```

Vê [Corpos de pedido em bruto](/pt/guide/adapters#corpos-de-pedido-em-bruto-assinaturas-de-webhook)
para o que cada adaptador faz. Há uma ressalva, só no Express: se trouxeres a tua
própria aplicação com o `express.json()` já montado, o body-parser consome o
stream antes de qualquer rota correr — acrescenta
`app.use(express.json({ verify: captureRawBody }))` (de `@basaltkit/express`), ou
a convenção comum `req.rawBody = buffer`, que também é honrada.

**Os handshakes nunca precisam de corpo.** O desafio da Dropbox chega em
`GET ?challenge=`; o da Microsoft Graph chega num `POST ?validationToken=` **sem
corpo nenhum**, enviado antes de a subscrição existir. Uma só rota responde às
duas formas, e responde a um desafio vindo da query *antes* de pedir bytes
nenhuns — sem consultar qualquer ligação, sem gastar um token de replay, e
limitado e sanitizado (`text/plain`, `nosniff`, 256 caracteres, caracteres de
controlo e bidi removidos). Exigir os bytes primeiro transformaria a validação da
Graph em `subscriptionValidationFailed` no `watch()`, mandando o operador
investigar a subscrição em vez do body-parser.

Quando uma entrega que **declarou** bytes não os consegue produzir, a rota
**falha fechada** em vez de reconstruir uma mensagem: é esse o objectivo. Para um deployment que termina o
pedido num sítio que a camada neutra não vê, fornece-os tu com
`notifications.rawBody: (request) => Buffer` — nunca re-serializando um objecto
já analisado.

## Ligar uma conta

O `driveRoutes()` acima faz isto por ti. A fachada por baixo também é pública,
para uma aplicação que queira as suas próprias rotas: dois passos, com um valor
transportado entre eles num cookie.

```ts
// 1. Para onde enviar o browser.
const { url, binding } = drives.startAuthorization({
  provider: 'google',
  redirectUri: 'https://app.example.com/drives/google/callback',
})
reply.setCookie('drive_binding', binding, { httpOnly: true, sameSite: 'lax', secure: true })
reply.redirect(url)
```

```ts
// 2. No callback.
const connection = await drives.completeAuthorization({
  provider: 'google',
  code: query.code,
  state: query.state,
  binding: request.cookies['drive_binding'],
  redirectUri: 'https://app.example.com/drives/google/callback',
  label: 'Drive Finance',
})
```

::: tip Porquê o cookie
O `state` sozinho pode ser reproduzido: um atacante que inicie o seu próprio
fluxo pode abrir o URL de callback resultante no browser de uma vítima e ligar a
conta **dele** ao tenant da vítima. O `binding` impede isso, porque o state só
valida contra um valor que está no cookie da própria vítima. O state transporta
também o tenant, por isso não pode ser reproduzido noutro tenant, e é de uso
único.
:::

Listar nunca expõe credenciais:

```ts
await drives.list()                      // ligações do tenant actual
await drives.list({ provider: 'google' })
await drives.list({ status: 'invalid' }) // precisam que o utilizador volte a ligar
```

Desligar **revoga no fornecedor por omissão** — apagar a nossa linha enquanto a
autorização continua viva não é o que "desligar" significa:

```ts
await drives.disconnect(connection.id)
await drives.disconnect(connection.id, { revoke: false })  // apenas local
```

A linha e as credenciais seladas desaparecem sempre; o que varia é se o grant
sobreviveu no fornecedor — e o `drive:disconnected` di-lo em `revocation`, em
vez de te deixar inferi-lo a partir de um booleano:

| `revocation` | Significado | O que fazer |
| --- | --- | --- |
| `revoked` | o fornecedor aceitou | nada — o grant desapareceu |
| `skipped` | passaste `{ revoke: false }` | nada |
| `unsupported` | o adaptador não tem endpoint de revogação, e nunca terá (Microsoft Graph — ver abaixo) | dizer ao utilizador para retirar o consentimento no portal da conta dele |
| `failed` | perguntámos e o fornecedor não respondeu | **tentar de novo** — o grant pode continuar vivo |

O `revoked: boolean` continua lá e continua a significar
`revocation === 'revoked'`, mas não consegue separar os dois últimos — e são
esses os dois que exigem acções diferentes de quem opera.

## Ligar o Dropbox

O `@basaltkit/drives-dropbox` é o primeiro adaptador real, e a referência para
escrever um.

```bash
pnpm add @basaltkit/drives-dropbox
```

```ts
import { dropboxDrive } from '@basaltkit/drives-dropbox'

drivesPlugin({
  providers: [
    dropboxDrive({
      clientId: env.DROPBOX_APP_KEY,
      // O Dropbox não tem um segredo separado para webhooks: o segredo da
      // aplicação também assina as notificações.
      clientSecret: env.DROPBOX_APP_SECRET,
    }),
  ],
  keys: [{ id: '2026-09', key: env.DRIVES_ENCRYPTION_KEY }],
  secret: env.APP_SECRET,
})
```

Na [App Console do Dropbox](https://www.dropbox.com/developers/apps):

1. **Redirect URI** — `https://app.example.com/drives/dropbox/callback`, byte a
   byte o que o `driveRoutes({ redirectUri })` produz.
2. **Permissões** — `account_info.read`, `files.metadata.read`,
   `files.content.read`, e `files.content.write` se fizeres upload.
3. **Webhook URI** — `https://app.example.com/drives/dropbox/notifications`.
   O Dropbox valida-o com um `GET ?challenge=…` **no momento em que carregas em
   Save**, antes de qualquer tenant ter ligado o que quer que seja; a rota
   responde a isso sem consultar nenhuma ligação.

### Quatro coisas que o Dropbox faz de forma diferente

Cada uma delas mudou o contrato em vez de ser disfarçada, e os adaptadores do
Google e da Microsoft vão cair do outro lado de cada uma.

**O feed de alterações começa na pasta, não no "agora".** O `files/list_folder`
devolve a primeira página de entradas *e* o cursor, e o `/continue` continua
para as alterações — o backfill e o delta são um só contínuo. O adaptador
declara `deltaIncludesExisting: true`. O `changes.getStartPageToken` do Google
Drive é o oposto e tem de declarar `false`, momento em que o motor corre uma
listagem completa antes da primeira passagem de delta — caso contrário a
primeira sincronização não importa absolutamente nada.

**Uma eliminação não tem id.** O Dropbox reporta
`{".tag":"deleted", path_display}`, porque o id pertencia àquilo que já não
existe. Por isso uma remoção transporta `externalId` **ou** `path`:

```ts
onRemoved: ({ externalId, path, targetId }) => {
  // O `targetId` só é resolvido numa remoção por id — o ledger é indexado por
  // id. Para o Dropbox, correlaciona pelo caminho que guardaste na importação;
  // o `filesSink` grava-o em `metadata.drivePath`.
  return targetId ? archiveDocument(targetId) : archiveByPath(path!)
}
```

**Não há subscrição, nem um segredo nosso.** O URI do webhook é registado uma
vez por *aplicação* e dispara para todos os utilizadores que a autorizaram, por
isso o `watchConnection()` reporta `DRIVE_UNSUPPORTED` e uma notificação
identifica a ligação pelo **id de conta** do Dropbox que nomeia. Uma notificação
pode dizer respeito a várias ligações — a mesma conta ligada duas vezes, ou por
dois tenants — por isso o `outcome.connections` é uma lista. A procura por conta
atravessa necessariamente tenants, e é segura porque o id veio de um payload que
o segredo da aplicação assinou, nunca de quem chamou; continua a ser a **tua**
consulta, por isso a framework nunca percorre uma tabela num pedido não
autenticado.

**A pista de rate-limit vem muitas vezes no corpo.** O Dropbox responde `429`
com `{"error":{"retry_after":300}}` e frequentemente sem qualquer cabeçalho
`Retry-After`. O adaptador declara `retryAfterFromBody` e o motor aplica-o
dentro do seu próprio tecto.

### Limitações

- Uploads acima de **150 MB** precisam de `files/upload_session/*`, que não está
  implementado; ficheiros maiores são recusados à partida com
  `DRIVE_CONTENT_TOO_LARGE`.
- Os **team spaces** do Dropbox Business não são endereçados (não são enviados
  `Dropbox-API-Path-Root` nem `Dropbox-API-Select-User`).
- Os **itens só de exportação** (documentos Paper) aparecem com
  `exportOnly: true`; o `files/export` não está ligado.
- Sem `externalUrl`: os metadados do Dropbox não trazem link web, e fabricar um
  significaria criar uma partilha.

## Ligar o Google Drive

O `@basaltkit/drives-google` é o segundo adaptador, e aquele que o contrato
corria maior risco de achatar.

```bash
pnpm add @basaltkit/drives-google
```

```ts
import { googleDrive } from '@basaltkit/drives-google'

drivesPlugin({
  providers: [
    googleDrive({
      clientId: env.GOOGLE_CLIENT_ID,
      // Ao contrário do Dropbox, isto NÃO é uma chave de webhook: o Google não
      // assina nada, e uma notificação é autenticada pelo token de canal que o
      // motor escolheu.
      clientSecret: env.GOOGLE_CLIENT_SECRET,
    }),
  ],
  keys: [{ id: '2026-09', key: env.DRIVES_ENCRYPTION_KEY }],
  secret: env.APP_SECRET,
})
```

Na [consola do Google Cloud](https://console.cloud.google.com/apis/credentials):

1. **Activa a Google Drive API** no projecto.
2. **Cliente OAuth** do tipo *Web application*, com o redirect URI
   `https://app.example.com/drives/google/callback` — byte a byte o que o
   `driveRoutes({ redirectUri })` produz.
3. **Scopes** — `drive.readonly` por omissão; fazer upload precisa de
   `drive.file` ou `drive`. O `drive.readonly` e o `drive` são scopes
   *restritos*: uma aplicação pública precisa da verificação do Google e de uma
   avaliação de segurança anual, uma aplicação interna de Workspace não.
4. **Notificações push** (opcional) — o domínio do URL de notificação tem de
   estar verificado no Google Search Console e registado no projecto. O Google
   não faz nenhum handshake de desafio; simplesmente recusa criar o canal.

### Quatro coisas que o Google faz de forma diferente

**O feed de alterações começa no "agora", por isso a primeira sincronização tem
de fazer backfill.** O `changes.getStartPageToken` é o token do *futuro*: o
corpus que já existe nunca aparece no `changes.list`. O adaptador declara
`deltaIncludesExisting: false`, e o motor responde tirando primeiro o token,
correndo uma listagem completa e só depois seguindo o feed — essa ordem é o
argumento de correcção, porque tudo o que mude durante a listagem é entregue
outra vez na primeira passagem de delta e o ledger absorve a repetição. Declarar
o contrário não é um problema de desempenho: a primeira sincronização reporta
sucesso, não importa **nada**, e persiste um cursor que garante que os ficheiros
existentes nunca mais são vistos.

**Um rate limit é um `403`, não um `429`.** O Google responde
`{"error":{"errors":[{"domain":"usageLimits","reason":"userRateLimitExceeded"}]}}`
com estado 403. O adaptador lê a razão e levanta `DRIVE_RATE_LIMITED`,
guardando o `DRIVE_ACCESS_DENIED` para uma recusa de permissão genuína. A
diferença não é cosmética — o `DRIVE_ACCESS_DENIED` é terminal, por isso mapear
só pelo código de estado faz falhar permanentemente um job por causa de uma
condição que se resolve sozinha num segundo.

**O `changes.list` é ao nível da conta, não da pasta.** Há um feed por conta;
não é possível limitá-lo a uma pasta. Uma ligação confinada a um `rootId` filtra
portanto **do lado do cliente**, subindo os `parents` de cada ficheiro alterado
com uma leitura de metadados por cada pasta que ainda não viu nessa chamada. O
custo é real e está limitado por `ancestryMaxLookups`, que falha alto em vez de
adivinhar. As alterações fora do âmbito são deitadas fora antes de se tornarem
um `DriveChange`, por isso nada sobre outra pasta chega ao `onRemoved`, aos teus
hooks ou ao ledger. A mesma ausência de uma query recursiva é a razão pela qual
uma **listagem** com âmbito percorre a subárvore pasta a pasta em vez de
devolver um só nível.

Uma eliminação definitiva é o único caso que isto não consegue delimitar: o
`{fileId, removed: true}` chega sem qualquer recurso de ficheiro, por isso não
sobra nada cuja ascendência se possa testar. Numa ligação com âmbito essas são
descartadas por omissão — o `includeUnscopedRemovals: true` encaminha-as, e a
correlação passa a ser tua, contra o ledger que realmente sabe que ids
importaste. Um envio para o lixo (a eliminação normal do Drive) transporta o
recurso completo e é delimitado normalmente.

**Os documentos nativos do Google não têm bytes.** Um Doc, uma Sheet ou uns
Slides não têm `md5Checksum` nem `size`, e o `files.get?alt=media` recusa-os.
Aparecem com `exportOnly: true` e o seu mime type em `raw`, e o `download`
recusa-os em vez de exportar para um formato que nunca pediste. O `importItem`
salta-os na estratégia `copy` com `reason: 'no-content'`, para que não se tornem
jobs que falham para sempre; em `reference` o teu sink continua a vê-los e pode
chamar o `files.export` por si próprio.

### Renovar uma subscrição

O Google limita a vida de um canal. O `DriveWatch.expiresAt` transporta a
`expiration` do próprio Google — nunca o TTL que pediste — e a renovação é
trabalho **teu**, porque voltar a subscrever é tráfego para o fornecedor que a
framework não gasta em teu nome:

```ts
defineReconciler({
  name: 'drive-watch-renewal',
  every: '1h',
  find: () => connectionsWithWatchExpiringWithin('24h'),
  redispatch: (c) =>
    watchConnection(drives, c.id, {
      tenantId: c.tenantId,
      notificationUrl: 'https://app.example.com/drives/google/notifications',
    }),
}).schedule(scheduler)
```

O `watchConnection` gera um segredo novo de cada vez, por isso um canal renovado
não pode ser endereçado com o antigo.

### O redirect, e porque é que a allowlist tem um ponto

O `files.get?alt=media` responde `302` para um URL assinado em
`*.googleusercontent.com`. O adaptador coloca-o na allowlist como um **sufixo**
com ponto à cabeça, que corresponde a `doc-04-7g-docs.googleusercontent.com` e
recusa tanto o `googleusercontent.com` em si como o
`evilgoogleusercontent.com` — o sósia que um `endsWith` ingénuo deixaria passar.
O fetch protegido volta a correr a allowlist, a validação SSRF e o pinning de IP
em cada salto, e o adaptador nunca vê o URL assinado, por isso não o pode
registar em logs. Esse URL é, ele próprio, uma credencial para o ficheiro.

### Limitações

- Uploads acima de **5 MB** precisam de `uploadType=resumable`, que não está
  implementado; ficheiros maiores são recusados à partida com
  `DRIVE_CONTENT_TOO_LARGE`.
- As **shared drives** não são endereçadas como corpus: o `supportsAllDrives` é
  enviado em todo o lado, por isso ids dentro de uma resolvem, mas uma ligação
  com âmbito numa shared drive (com o seu próprio feed de alterações) não está
  ligada.
- **Sem `path`** — o Drive é um grafo e não publica nenhum, por isso as remoções
  correlacionam-se por `externalId`.
- **Service accounts / delegação a todo o domínio** não estão implementadas;
  obtém os tokens por ti e usa o `drives.connect()`.
- Um `invalid_grant` no refresh significa consentimento revogado, cliente OAuth
  apagado **ou** uma autorização não usada durante seis meses (sete dias
  enquanto a aplicação está em "testing"). O Google envia a mesma string nos
  três casos, por isso a ligação é marcada como `invalid` e pede-se ao tenant
  que volte a ligar — que é a única acção disponível em qualquer um deles.

## Ligar o OneDrive / SharePoint

O `@basaltkit/drives-microsoft` é o adaptador do Microsoft Graph, e cai do
**outro lado** de quase todas as diferenças que o Dropbox expôs.

```bash
pnpm add @basaltkit/drives-microsoft
```

```ts
import { microsoftDrive } from '@basaltkit/drives-microsoft'

drivesPlugin({
  providers: [
    microsoftDrive({
      clientId: env.MS_CLIENT_ID,
      // Um registo de aplicação web tem segredo; um cliente público usa só
      // PKCE. NÃO é uma chave de webhook: o Graph não assina notificações.
      clientSecret: env.MS_CLIENT_SECRET,
      tenant: 'common',
    }),
  ],
  keys: [{ id: '2026-09', key: env.DRIVES_ENCRYPTION_KEY }],
  secret: env.APP_SECRET,
})
```

No [registo de aplicação do Entra ID](https://entra.microsoft.com):

1. **Redirect URI** — `https://app.example.com/drives/microsoft/callback`, um
   redirect de plataforma *Web*, byte a byte o que o
   `driveRoutes({ redirectUri })` produz.
2. **Permissões de API** — permissões delegadas do Graph. O `offline_access` é
   o que faz o Entra ID devolver sequer um refresh token; o `Files.Read` lê o
   OneDrive do próprio utilizador, o `Files.Read.All` qualquer drive a que ele
   chegue, e uma biblioteca do **SharePoint** precisa de `Files.Read.All` **e**
   `Sites.Read.All`. Escrever precisa das variantes `ReadWrite`.
3. **Não há nada para registar para webhooks.** As subscrições são criadas em
   runtime e o Graph valida o URL de notificação enquanto cria cada uma.

**Single-tenant ou multi-tenant.** `tenant: 'common'` aceita qualquer conta
Microsoft; `organizations` só contas profissionais/escolares; um GUID ou domínio
verificado fixa um tenant do Entra. Se o registo de aplicação for single-tenant
tens de definir o tenant — o endpoint `common` emite um token que o registo
depois recusa, e isso aparece como `AADSTS50194` no callback, **depois** de o
utilizador ter consentido. Se for multi-tenant, conta com consentimento de
administrador por cada tenant cliente (`consent_required` até um administrador
aprovar), políticas de acesso condicional que não controlas (um refresh pode
voltar `interaction_required`, o que marca a ligação `invalid` e exige uma
pessoa), e um client secret que passa a alcançar todos os tenants clientes.

**Que drive é que uma ligação significa, dito em voz alta.** O Graph tem três
respostas plausíveis e um id isolado não as distingue, por isso o alvo vive no
`rootId`:

```ts
import { microsoftRoot } from '@basaltkit/drives-microsoft'

microsoftRoot({})                                  // '/me/drive/root'
microsoftRoot({ driveId })                         // '/drives/{id}/root'
microsoftRoot({ siteId })                          // a biblioteca por omissão de um site
microsoftRoot({ siteId, itemId })                  // uma pasta lá dentro
```

O `rootId` chega ao adaptador a partir do `?rootId=` no URL de ligação, por isso
é controlado por quem chama e passa a fazer parte de um caminho do Graph: cada
segmento é validado, e `/`, `?`, `#`, `%`, `.`, `..` e espaços são recusados com
`DRIVE_ACCESS_DENIED`. Um `folderId` pode estreitar uma chamada a uma pasta mas
nunca nomear outra drive.

### Quatro coisas que a Microsoft faz de forma diferente

**O refresh token roda, sempre.** O antigo morre no instante em que um novo é
emitido. Nada no adaptador contorna isso; o compare-and-set do motor persiste o
novo. A parte subtil é que um refresh *concorrente* produz `invalid_grant` —
byte a byte o que um grant **revogado** produz — por isso tomá-lo à letra
marcaria uma ligação saudável como `invalid`, ao acaso, sob carga. O motor
relê a linha antes de a condenar e adota o que o vencedor guardou.

**Desligar significa menos aqui.** O Graph não tem endpoint de revogação por
aplicação, por isso o adaptador omite o `revoke` e o `drives.disconnect()` emite
`revoked: false`:

```ts
hooks.on('drive:disconnected', ({ provider, revocation }) => {
  // Decide pelo `revocation`, nunca só pelo `revoked`: no OneDrive o booleano é
  // sempre false porque não há nada a chamar, e no Dropbox ou no Google é false
  // quando a chamada simplesmente não passou — o que vale a pena repetir, e é a
  // instrução oposta.
  if (revocation === 'unsupported') indicarOndeRemoverConsentimento(provider)
  if (revocation === 'failed') agendarNovaTentativaDeRevogacao(provider)
})
```

O `revocation` é `'revoked' | 'skipped' | 'unsupported' | 'failed'`; ver
[Ligar uma conta](#ligar-uma-conta). As credenciais locais são apagadas em todos
os casos — a distinção é só sobre o destino do grant no fornecedor, que é
exactamente o que um registo de eliminação tem de conseguir declarar.

**A paginação é um URL, não um token.** O `@odata.nextLink` e o
`@odata.deltaLink` são URLs completos. São embrulhados num cursor opaco para que
o estado de paginação do Graph nunca aterre na tua base de dados como algo que
se possa ir buscar, e só são desembrulhados depois de se confirmar que ainda
apontam para o Graph — antes de o fetch guardado os revalidar a sério. Um URL
fornecido pelo provider que a framework depois vai buscar é exatamente o caso
para o qual o guard existe.

**O URL de download é uma credencial bearer.** O
`@microsoft.graph.downloadUrl` é pré-assinado e vive num host de CDN, e o
`/content` redireciona para o mesmo sítio. Por isso as listagens tiram-no com
`$select` (nunca está em `DriveItem.raw`, num sink ou num log), o `download`
vai buscá-lo **sem** cabeçalho `Authorization`, as entradas da allowlist são
`.sufixo` e nunca o domínio-pai nu, e uma falha do host de conteúdo é reportada
sem o corpo, porque as páginas de erro de CDN citam o URL do pedido.

### As subscrições expiram — a renovação é tua

O `watchConnection()` cria uma subscrição do Graph com o segredo do motor como
`clientState`, e expõe o `expiresAt`. O Graph nunca a renova, e uma subscrição
caducada é silenciosa: as notificações simplesmente param.

```ts
defineReconciler({
  name: 'drive-watch-renewal',
  every: '6h',
  find: async () =>
    (await drives.list({ tenantId })).filter((c) => c.provider === 'microsoft' && c.watching),
  redispatch: (c) =>
    watchConnection(drives, c.id, {
      tenantId: c.tenantId,
      notificationUrl: 'https://app.example.com/drives/microsoft/notifications',
    }),
}).schedule(scheduler)
```

O Graph valida o URL de notificação **enquanto** o `POST /subscriptions` está em
curso, com um `validationToken` que espera ver devolvido como `text/plain` em
segundos. A rota partilhada de notificações já responde a isso — a mesma que
responde ao `GET ?challenge=` do Dropbox. Um `watch()` que falha com
`subscriptionValidationFailed` significa que a rota não está acessível a partir
da internet.

Uma entrega pode agrupar entradas de várias subscrições que partilham o mesmo
URL, por isso também aqui o `outcome.connections` é uma lista.

### Limitações

- Uploads acima de **4 MB** precisam de `createUploadSession`, que não está
  implementado; ficheiros maiores são recusados à partida com
  `DRIVE_CONTENT_TOO_LARGE`. É o tecto mais baixo dos três providers.
- Uma **subscrição cobre a drive inteira**, não uma pasta: o Graph só aceita a
  raiz de uma drive como recurso de subscrição `driveItem`. Custa uma
  sincronização desperdiçada, nunca uma errada.
- Os **checksums diferem por tipo de conta** — `quickXorHash` no Business e no
  SharePoint, `sha1Hash`/`sha256Hash` no pessoal. Rotulados honestamente, e
  comparáveis apenas dentro de um provider e de um tipo de conta.
- **Itens sem bytes descarregáveis** aparecem com `exportOnly: true` — um
  caderno do OneNote (faceta `package`) e um atalho "Partilhado comigo" (faceta
  `remoteItem`) cujos bytes vivem noutra drive. O `importItem` salta-os com
  `no-content`; sem a flag, cada um seria um job que falha e volta à fila para
  sempre.
- **Itens partilhados de outras drives** estão de resto fora de âmbito: uma
  ligação está confinada a uma drive. Liga antes a drive dona.

## Importar

### O pipeline

A sincronização **descobre**; a fila **descarrega**. Um pedido HTTP nunca fica
bloqueado à espera de um drive, seja qual for o seu tamanho.

```ts
import { defineJob } from '@basaltkit/queue'
import { filesSink, importItem, syncConnection, type DriveImportTask } from '@basaltkit/drives'

export const ImportDriveItem = defineJob<DriveImportTask>({
  name: 'drives.import',
  attempts: 3,
  backoff: { type: 'exponential', delay: '30s' },
  async handle(task) {
    await importItem(drives, task.connectionId, task.item, filesSink(files), {
      strategy: task.strategy,
    })
  },
})

// Uma passagem de sincronização: percorre o feed de alterações e põe na fila.
// Não descarrega nada.
const result = await syncConnection(drives, connection.id, {
  enqueue: (task) => ImportDriveItem.dispatch(task),
  filter: (item) => item.name.endsWith('.pdf'),
  // Uma remoção transporta `externalId` ou `path` — ver "Ligar o Dropbox".
  onRemoved: ({ externalId, path, targetId }) => archiveDocument(targetId),
})
// → { seen, enqueued, skipped, removed, truncated, mode: 'delta' | 'listing' }
```

`maxItems` (1000 por omissão) e `maxPages` (50 por omissão) são **limites
rígidos**, não sugestões. A primeira sincronização de um Google Drive maduro
pode ter centenas de milhares de itens, por isso uma execução que pára num
limite tem de conseguir continuar — e isso depende de qual das três formas a
execução teve:

| Execução | Retoma? | Porquê |
| --- | --- | --- |
| **Delta** (`mode: 'delta'`) | sim | o cursor do fornecedor é guardado a cada página |
| **Backfill** — a passagem de listagem que um adaptador com `deltaIncludesExisting: false` precisa (Google) | sim | o motor guarda o seu próprio ponto de retoma no `cursor`, continua a enumeração na execução seguinte, e só passa ao feed quando a travessia termina |
| **Listagem simples** — um adaptador sem feed de alterações | **não** | não há nada de onde retomar: a travessia recomeça do início e o registo de importações absorve a repetição |

A terceira linha é a que exige atenção no desenho. Contra um adaptador sem
`delta`, um acervo maior que `maxItems` nunca é percorrido por inteiro, por isso
sobe os limites ou divide com `filter` em vez de esperar que a execução seguinte
recupere o atraso.

O ponto de retoma do backfill é um valor do próprio motor, não um cursor do
fornecedor — guarda o cursor de delta obtido **antes** da primeira página de
listagem, que é o que mantém todo o backfill multi-execução com entrega
pelo-menos-uma-vez. Trata o `connection.cursor` como opaco, que é o que ele
sempre foi.

### Manter a sincronização a correr

Usa o `defineReconciler` do [`@basaltkit/scheduler`](/pt/guide/scheduler) — já
resolve a guarda contra sobreposição e o lock entre réplicas:

```ts
import { defineReconciler } from '@basaltkit/scheduler'
import { dueConnections } from '@basaltkit/drives'

defineReconciler({
  name: 'drive-sync',
  every: '15m',
  find: () => dueConnections(drives, { tenantId, staleForMs: 15 * 60_000 }),
  redispatch: (connection) => SyncDrive.dispatch({ connectionId: connection.id }),
}).schedule(scheduler)
```

### Deduplicação

O registo de importações é consultado **antes** do download, indexado por
`(tenant, ligação, externalId)` e comparado por versão de conteúdo: primeiro a
revisão do fornecedor, depois o checksum, depois `updatedAt` + tamanho.

Esta ordem é deliberada — o `updatedAt` também muda quando um ficheiro é
renomeado ou voltado a partilhar, e voltar a descarregar um gigabyte porque
alguém mudou o nome a uma pasta é uma factura, não uma funcionalidade. Numa
sincronização nocturna sobre uma pasta que raramente muda, isto é a diferença
entre alguns kilobytes e o acervo inteiro, todas as noites.

::: warning Um checksum não é portável
O `DriveChecksum` transporta um `algorithm` porque os fornecedores publicam
funções diferentes de entradas diferentes, e o valor sozinho não significa nada
entre eles:

| Fornecedor | Algoritmo | Ressalva |
| --- | --- | --- |
| Dropbox | `dropboxContentHash` | uma construção em árvore de blocos, **não** o SHA-256 do ficheiro |
| Google | `md5` | só ficheiros binários — um Doc, Sheet ou Slide nativo não tem checksum nem `size` |
| Microsoft | `quickXorHash` *ou* `sha1`/`sha256` | **depende do tipo de conta**, por isso duas ligações do mesmo adaptador podem discordar para os mesmos bytes |

Por isso compara o `algorithm` antes do `value`, e não faças dedup por checksum
entre ligações sem verificar os dois. O `contentVersion()` já o faz: prefixa o
algoritmo à string de versão, para que dois algoritmos não possam colidir em
"inalterado". Se quiseres um único digest comparável em todo o lado, calcula-o
sobre os bytes que importaste — o `@basaltkit/files` faz um SHA-256 enquanto
eles passam.
:::

```ts
await drives.forgetImports(connection.id)  // a próxima sincronização reimporta tudo
```

## Cópia ou referência

Duas estratégias de primeira classe. `reference` não é um `copy` degradado.

| | `copy` | `reference` |
| --- | --- | --- |
| Bytes | descarregados para o teu armazenamento | **nada é descarregado** |
| Disponibilidade | sobrevive à eliminação ou ao fim da partilha no fornecedor | desaparece com o original |
| Retenção | aplica-se a tua política | aplica-se a do fornecedor |
| Auditabilidade | pode provar o que o documento dizia | só pode provar que foi visto |
| Revogação | revogar a ligação deixa a cópia | revogar a ligação torna-o inacessível |
| Custo | armazenamento + tráfego | zero |
| Protecção de dados | passas a ser responsável por esses dados | tens apenas metadados |

```ts
await importItem(drives, id, item, mySink, { strategy: 'reference' })
```

Em `reference` o sink não recebe `content` e **nenhum byte é obtido** — essa é a
garantia, não um efeito secundário.

## Escrever de volta

O `drives.upload()` existe, e **todos os adaptadores têm um limite de tamanho
baixo e rígido**. Só estão implementados uploads de um único pedido; a
alternativa nos três fornecedores é uma sessão retomável de várias chamadas, com
o seu próprio fatiamento e a sua própria retoma:

| Adaptador | Limite | O que um ficheiro maior precisaria |
| --- | --- | --- |
| `@basaltkit/drives-microsoft` | **4 MB** | `createUploadSession` |
| `@basaltkit/drives-google` | **5 MB** | `uploadType=resumable` |
| `@basaltkit/drives-dropbox` | **150 MB** | `files/upload_session/*` |

Qualquer coisa maior é recusada com `DRIVE_CONTENT_TOO_LARGE`. **Passa o
`DriveUploadInput.size` quando o souberes**: com ele a recusa acontece antes de
se abrir um socket; sem ele o limite de bytes dispara a meio e o pedido é
destruído — a mesma recusa, mas depois de os bytes já terem ido para a rede.
Nada é truncado em silêncio, e o `size` nunca substitui o limite, por isso uma
origem que declare menos do que envia é na mesma apanhada pelos bytes reais.

## Sinks próprios

O `DriveSink` é a fronteira entre o framework e o teu domínio. O `filesSink`
cobre o caso comum; qualquer outro é uma função:

```ts
const documentSink: DriveSink = async ({ item, content, connection, version }) => {
  const file = await files.upload(content!.stream, { name: item.name, contentType: content!.contentType! })
  const document = await db.document.create({
    data: { fileId: file.id, matterId: matterFor(item.path), source: connection.label, version },
  })
  return { targetId: document.id }
}
```

## Escrever um adaptador

Só `name`, `allowedHosts`, `authorization`, `list` e `download` são
obrigatórios; tudo o resto degrada com honestidade, devolvendo
`DRIVE_UNSUPPORTED` em vez de não fazer nada em silêncio.

```ts
export const myDrive = (keys: Keys): DriveProvider => ({
  name: 'mydrive',
  allowedHosts: ['api.mydrive.com', '.files.mydrive.com'],
  authorization: {
    authorizeUrl: ({ redirectUri, state, codeChallenge }) => `https://…`,
    exchange: async ({ code, redirectUri, codeVerifier, fetch }) => ({ /* DriveTokens */ }),
    refresh: async ({ refreshToken, fetch }) => ({ /* DriveTokens */ }),
  },
  async list(session, { folderId, cursor }) {
    const res = await session.fetch(`https://api.mydrive.com/files?…`)
    const json = await res.json<ListResponse>()
    return { items: json.items.map(toDriveItem), cursor: json.next ?? undefined }
  },
  async download(session, item) {
    const res = await session.fetch(`https://api.mydrive.com/files/${item.externalId}/content`)
    return { stream: res.body, contentType: res.headers['content-type'] }
  },
})
```

Duas regras que o motor garante por ti:

- **Um adaptador nunca vê o refresh token.** A `session` transporta um único
  access token de curta duração, já renovado se estava perto de expirar. Um bug
  dentro de um adaptador não consegue exfiltrar a credencial de longa duração
  nem alcançar as linhas de outro tenant.
- **Um adaptador nunca chama `fetch` directamente.** O `session.fetch` tem lista
  de hosts permitidos, validação SSRF, IP fixado, limite de bytes e timeout.

O `refresh` deve lançar `DriveCredentialsInvalidError` quando o fornecedor diz
que a autorização desapareceu (`invalid_grant`, consentimento revogado). Isso é
terminal: o motor marca a ligação como `invalid` e pára, em vez de tentar outra
vez a partir de cada job em fila. Qualquer outro erro é tratado como
transitório — e em particular, um `invalid_client` é uma má configuração **tua**,
não uma revogação do tenant, por isso não pode ser reportado como tal.

Existem quatro membros opcionais porque os fornecedores são genuinamente
diferentes. Declará-los é como um adaptador diz ao motor que fornecedor é:

| Membro | Declara-o quando |
| --- | --- |
| `deltaIncludesExisting` | o cursor do `startDelta` repete o que já existe (Dropbox, Microsoft Graph). O valor por omissão `false` faz o motor correr primeiro uma listagem, por isso um adaptador que se esqueça custa leituras de metadados a mais em vez de perder os ficheiros de um tenant. |
| `retryAfterFromBody` | o fornecedor põe a pista de rate-limit noutro sítio que não o `Retry-After` (Dropbox). |
| `DriveNotificationResult.accountIds` | as notificações identificam a ligação por uma conta do fornecedor em vez de um segredo escolhido por ti (Dropbox). |
| o `path` de uma remoção | as eliminações são reportadas por caminho porque o fornecedor não dá id para elas (Dropbox). |
| `DriveItem.exportOnly` | o fornecedor tem itens sem bytes para descarregar (os Docs nativos do Google, os documentos Paper do Dropbox). O `importItem` salta-os na estratégia `copy` com `reason: 'no-content'` em vez de fazer esse job falhar em todas as execuções para sempre. |

Lança `DriveCursorResetError` (`DRIVE_CURSOR_RESET`) quando o fornecedor
invalida um cursor guardado —
o `409 reset/` do Dropbox, o `410 resyncRequired` do Graph, um `pageToken` do
Google que expirou. Os três fazem isto, e o cursor está *persistido*: mapeado
para qualquer outro erro, uma expiração faz com que todas as sincronizações
futuras dessa ligação falhem exactamente da mesma forma para sempre, e nenhuma
política de retry ajuda. O motor responde deitando o cursor fora e reportando
`reset: true`; a execução seguinte volta a preparar o feed e o ledger absorve a
repetição, por isso um reset custa leituras de metadados em vez de um
novo download.

### Testar um adaptador

```ts
import { FakeDriveProvider } from '@basaltkit/drives/testing'

const fake = new FakeDriveProvider({ files: [{ externalId: 'f1', name: 'a.pdf' }] })
fake.expireAccessTokens()      // forçar um refresh
fake.rateLimitNextCalls = 2    // provocar backoff
fake.grantRevoked = true       // provocar a invalidação fail-closed
fake.edit('f1', 'novo conteúdo') // provocar uma reimportação
fake.remove('f1')              // provocar uma remoção
```

O fake é a especificação executável do contrato: todos os comportamentos que o
motor diz tratar podem ser provocados de forma determinista, sem rede.

## Multi-tenancy

O isolamento é imposto na **camada de dados**, não apenas nas rotas:

- O `tenantId` é um argumento explícito em todos os métodos do store, por isso
  uma consulta sem âmbito nem sequer é exprimível.
- A fachada volta a filtrar tudo o que um store devolve, por isso um store
  próprio ou com um bug não consegue alargar um conjunto de resultados.
- O tenant do contexto ganha sempre. Um `tenantId` explícito só é respeitado
  quando concorda — por isso uma rota que reencaminhe `?tenantId=` vindo do
  cliente recebe `DRIVE_TENANT_MISMATCH`, e não os dados de outro tenant.

Uma ligação que pertence a outro tenant devolve **404, nunca 403**: dizer a quem
chama "existe mas não é tua" transforma os ids das ligações num oráculo.

## Notificações

Quando um fornecedor suporta push, subscreve e verifica:

O `driveRoutes({ notifications })` é a forma suportada de servir isto — já
responde aos handshakes, aplica o limite de bytes e mantém as respostas
uniformes. O motor por baixo é público para uma aplicação com rota própria:

```ts
// Só onde o fornecedor tem uma subscrição por ligação para registar.
// O Dropbox não tem: o webhook é da aplicação, por isso isto reporta
// DRIVE_UNSUPPORTED.
const watch = await watchConnection(drives, connection.id, {
  notificationUrl: 'https://app.example.com/drives/google/notify',
})

// Na rota — guarda o corpo EM BRUTO: as assinaturas assinam bytes, não objectos.
const outcome = await handleNotification(drives, { method, headers, query, body: rawBuffer }, {
  provider: 'google',
  // Um array, ou um resolver: `({ accountIds }) => …` para um fornecedor cuja
  // notificação nomeia contas em vez de devolver um segredo escolhido por ti.
  connections: await connectionsForThisRoute(),
  replayGuard,
})

if (outcome.challenge) return reply.type('text/plain').send(outcome.challenge)
// Uma lista: uma notificação pode dizer respeito a várias ligações.
for (const connection of outcome.connections) {
  if (outcome.shouldSync) await SyncDrive.dispatch({ connectionId: connection.id })
}
```

Uma notificação validada que não corresponda a **nada** não é um erro: volta com
`reason: 'unmatched'` e um `connections` vazio, e a rota responde-lhe
exactamente como responde a uma correspondência. Responder de outra forma diria
a quem chama sem autenticação que contas e canais é que uma instalação tem.

::: warning "Verificada" não é uma garantia só
O motor reporta todas as notificações verificadas da mesma maneira, e o
`shouldSync` parece igual venha de que fornecedor vier. Não são equivalentes:

| Fornecedor | O que a autentica | O que isso cobre |
| --- | --- | --- |
| Dropbox | `X-Dropbox-Signature`, HMAC-SHA256 sobre o corpo **em bruto** com o segredo da aplicação | a própria mensagem |
| Google | `X-Goog-Channel-Token` — um segredo que *nós* gerámos | a subscrição; **o corpo não é coberto** |
| Microsoft | o `clientState` do Graph — um segredo que *nós* gerámos | a subscrição; **o corpo não é coberto** |

Só o Dropbox assina alguma coisa. É por isso que uma procura por `accountIds` do
Dropbox pode atravessar tenants (o id veio de um payload assinado), enquanto um
resultado correspondido por segredo só é comparado com a ligação que detém
aquela subscrição.
:::

::: warning Este endpoint não é autenticado, por construção
É o fornecedor que o chama, por isso não há sessão. O desenho limita isso em vez
de fingir o contrário: **nenhum fornecedor envia os dados alterados**, por isso
mesmo uma notificação perfeitamente forjada só consegue fazer com que a tua
aplicação vá perguntar ao fornecedor, com as credenciais dela, pelo tenant dela.
O alcance de um ataque destes é uma sincronização desperdiçada — e é isso, e não
a força do segredo, que torna os dois mais fracos aceitáveis.

A lista de ligações candidatas é fornecida por **ti** e a framework nunca a
percorre entre tenants, por isso quem chama sem autenticação não consegue sequer
endereçar a ligação de outro tenant. No Dropbox essa procura é necessariamente
por id de conta entre tenants — segura porque o id veio de um payload que o
segredo da aplicação assinou, e continua a ser a tua consulta e não uma
varredura de tabela da framework.
:::

## Segurança

- **Apenas `https:`** por omissão. Alargar é uma opção `allowedSchemes`
  separada e explícita, não um efeito secundário do `allowPrivateHosts`.
- **Lista de hosts permitidos por fornecedor**, verificada antes do DNS e outra
  vez depois de cada redireccionamento. Uma entrada `.sufixo` só corresponde a
  subdomínios, por isso `evilgoogleusercontent.com` é recusado.
- **SSRF + IP fixado.** Endereços privados, de loopback, link-local
  (`169.254.169.254`), CGNAT, ULA e reservados são recusados; todos os endereços
  resolvidos são verificados; o socket é fixado para que um DNS rebind não possa
  trocar por um endereço interno.
- **Limites de bytes impostos durante o stream**, e sem descompressão
  transparente — por isso o limite aplica-se a bytes reais no fio, que é o único
  número sobre o qual uma bomba de descompressão não pode mentir.
- **Timeouts sobre a troca inteira**, não apenas sobre a ligação.
- **Credenciais cifradas com AES-256-GCM**, ligadas por AAD ao seu
  `(tenant, ligação, fornecedor)` — um blob movido para outra linha falha a
  decifração em vez de entregar credenciais.
- **Nenhum token** em qualquer log, erro, payload `details`, payload de hook ou
  entrada de auditoria. Isso inclui os URLs: um URL de download de um fornecedor
  **é ele próprio uma credencial bearer** (`@microsoft.graph.downloadUrl`, o
  destino do redireccionamento assinado do Google), por isso é retirado das
  listagens com `$select`, mantido fora do `DriveItem.raw`, fora dos sinks e do
  registo de importações, e fora dos erros — uma recusa do fetch guardado nomeia
  o **host e uma razão fixa, nunca o URL**.

Ver [Segurança](/pt/guide/security) e a
[RFC 0002](https://github.com/basaltkit/basalt/blob/main/docs/rfcs/0002-basaltkit-drives.md).

## O que este package não faz

Traz os bytes de forma segura e regista a proveniência. Não tem opinião sobre o
que um documento **significa**. Política de quarentena, OCR, extracção,
classificação, fluxo de aprovação, retenção, e que pasta corresponde a que
processo ou cliente são todos teus. A fronteira é o `DriveSink`.

A eliminação no fornecedor é **reportada, nunca executada** — se deve apagar a
tua cópia é uma decisão de retenção, e retenção é uma questão legal.
