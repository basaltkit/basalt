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

## Ligar uma conta

Dois passos, com um valor transportado entre eles num cookie.

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
  onRemoved: ({ externalId, targetId }) => archiveDocument(targetId),
})
// → { seen, enqueued, skipped, removed, truncated, mode: 'delta' | 'listing' }
```

`maxItems` (1000 por omissão) e `maxPages` (50 por omissão) são **limites
rígidos**, não sugestões. A primeira sincronização de um Google Drive maduro
pode ter centenas de milhares de itens; o cursor é guardado a cada página, por
isso uma execução truncada retoma exactamente onde parou.

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
vez a partir de cada job em fila. Qualquer outro erro é tratado como transitório.

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

```ts
const watch = await watchConnection(drives, connection.id, {
  notificationUrl: 'https://app.example.com/drives/google/notify',
})

// Na rota — guarda o corpo EM BRUTO: as assinaturas assinam bytes, não objectos.
const outcome = await handleNotification(drives, { method, headers, query, body: rawBuffer }, {
  provider: 'google',
  connections: await connectionsForThisRoute(),
  replayGuard,
})

if (outcome.challenge) return reply.type('text/plain').send(outcome.challenge)
if (outcome.shouldSync) await SyncDrive.dispatch({ connectionId: outcome.connection!.id })
```

::: warning Este endpoint não é autenticado, por construção
É o fornecedor que o chama, por isso não há sessão. O desenho limita isso em vez
de fingir o contrário: **nenhum fornecedor envia os dados alterados**, por isso
mesmo uma notificação perfeitamente forjada só consegue fazer com que a tua
aplicação vá perguntar ao fornecedor, com as credenciais dela, pelo tenant dela.
O alcance de um ataque destes é uma sincronização desperdiçada.

A lista de ligações candidatas é fornecida por **ti** e nunca é percorrida entre
tenants, por isso quem chama sem autenticação não consegue sequer endereçar a
ligação de outro tenant.
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
  entrada de auditoria.

Ver [Segurança](/pt/guide/security) e a
[RFC 0002](https://github.com/basaltkit/basalt/blob/main/docs/rfcs/0002-basaltkit-drives.md).

## O que este package não faz

Traz os bytes de forma segura e regista a proveniência. Não tem opinião sobre o
que um documento **significa**. Política de quarentena, OCR, extracção,
classificação, fluxo de aprovação, retenção, e que pasta corresponde a que
processo ou cliente são todos teus. A fronteira é o `DriveSink`.

A eliminação no fornecedor é **reportada, nunca executada** — se deve apagar a
tua cópia é uma decisão de retenção, e retenção é uma questão legal.
