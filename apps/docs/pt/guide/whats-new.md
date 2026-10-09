# Novidades no Basalt 1.12

> *"Basalt 1.12" é o rótulo umbrella desta vaga de trabalho; os pacotes
> `@basaltkit/*` são publicados de forma independente (ver
> [Versionamento](/pt/guide/versioning)). Abaixo está o que aterrou e a versão do
> pacote que o traz.*

::: warning Trinta e dois pacotes publicam um major — seis deles duas vezes
`auth` 4, `auth-prisma` 2, `auth-sqlite` 2, `auth-saml` 3, `permissions` 4
(`permissions-prisma` / `-sqlite` 2), `tenancy` 3, `tenancy-prisma` 2,
`storage` 5, `files` 6, `comments` 4, `search` 2, `search-elasticsearch` 2,
`audit` 3 (`audit-prisma` / `-sqlite` 2), `webhooks` 4 (`webhooks-prisma` /
`-sqlite` 2), `subscriptions` 5 (`subscriptions-prisma` / `-sqlite` 3),
`teams` 4, `queue` 3, `prisma` 3, `mcp` 5, `express` 2 e `hono` 2 — e os três
adapters de drives chegam à 1.0. Alguns pacotes passaram por dois majors nesta
vaga: `permissions`, `storage`, `files`, `audit`, `webhooks` e `mcp` publicaram
primeiro as correcções da auditoria (como 3, 4, 5, 2, 3 e 4) e depois, um dia
mais tarde, os seguimentos de [Fechar a colheita da
auditoria](#fechar-a-colheita-da-auditoria). Vindo da 1.11, aplicas os dois
conjuntos de passos. Três pacotes 0.x partem num minor: `drives` 0.3,
`mcp-core` 0.4 e `ai-mcp` 0.3 (passando pela 0.2). A maioria resolve-se com uma
opção ou uma chamada renomeada; quatro precisam de um passo de dados (uma
re-chavagem, uma re-cifragem, dois modelos de auth novos, políticas RLS
regeneradas). Ver [Atualização](#atualizacao).
:::

O Basalt 1.12 é a versão que **cumpre o que promete**. Cada pacote faz
promessas — no README, nos tipos, no nome de uma opção — e o 1.11 tinha
garantido que o comportamento seguro era a predefinição. O que ninguém tinha
verificado de forma sistemática era se a predefinição fazia o que a promessa
dizia. Por isso uma auditoria independente, em duas passagens, leu o código de
cada pacote ao lado da sua documentação e transformou cada discrepância que
encontrou num teste a falhar contra o build publicado.

Encontrou oitenta. Dez foram classificadas como altas, e nenhuma parecia um bug
de segurança vista de fora — cada uma era uma frase que o framework dizia sobre
si próprio. O README prometia que o `audit.verify()` detectava uma linha forjada,
e uma linha inserida directamente na tabela passava. O `idempotencyPlugin`
estava documentado para handlers `route()`, e um handler que *devolvia* o payload
— a forma que todos os exemplos usam — corria outra vez em cada retry. Uma
política para `project:constructor` resolvia através de `Object.prototype` e
autorizava qualquer pessoa. `meta.teamRole: 'Admin'`, um erro de escrita de
`'admin'`, tinha rank zero e admitia todos os membros. O `swap()` passava uma
subscrição gratuita para um plano pago sem a cobrar. O `@basaltkit/env` dizia que
um `NODE_ENV` por definir era produção e o `@basaltkit/auth` dizia que era
desenvolvimento.

As oitenta estão fechadas. Cada defeito real foi reproduzido com um teste a
falhar antes de ser corrigido, e esse teste vive agora na suite do próprio
pacote; uma hipótese que não se reproduziu fica documentada, não "corrigida". O
tema é a distância entre o comportamento declarado e o real, e atravessa todos
os itens abaixo: uma chave single-tenant que não pode ser o nome de um tenant,
um resolver que um header não consegue contrariar, três adapters que enviam os
mesmos bytes para a mesma rota, um endpoint MCP que sabe com que sessão está a
falar.

O relatório terminava também com uma colheita: lacunas de desenho e melhorias
para lá das oitenta constatações numeradas. Mais dois pull requests fecharam
essa lista depois do lançamento e seguem dentro da mesma vaga — políticas que
correm no guard da rota, detalhes de erro públicos por construção, hashes de
auditoria que nomeiam a sua chave, webhooks que respeitam uma política de portas
e um tecto de fan-out, e mais. Ver [Fechar a colheita da
auditoria](#fechar-a-colheita-da-auditoria).

## Desde a 1.12 (por publicar)

Entrou no `main` depois da publicação da 1.12 em minors e patches — nenhum
pacote precisa de uma major. Alguns defaults mudam, algumas configurações que
arrancavam passam a mostrar um aviso no arranque (recusadas na próxima major),
e só usos mal formados das novas formas de rate limit recusam o arranque. Lê [Mudanças de comportamento e notas de
upgrade](#behaviour-changes-and-upgrade-notes) antes de actualizar.


- **Idempotência em todos os adapters.** O `idempotencyPlugin` passou de
  `@basaltkit/fastify` para o pipeline de rotas partilhado em `@basaltkit/http`,
  por isso o Express e o Hono também o têm (o import do Fastify continua a
  funcionar). Duas opções novas: `fingerprint: 'body'` recusa uma chave
  reutilizada com um corpo diferente com `422 IDEMPOTENCY_KEY_REUSED`, e
  `replayAfterGuards: true` passa a verificação para depois dos guards da rota,
  para que um caller revogado receba `401`/`403` em vez do sucesso em cache. As
  duas vão passar a default numa futura major — vê
  [Mutações idempotentes](/pt/guide/security#mutacoes-idempotentes-—-idempotencyplugin).
- **Cabeçalhos por rota.** `meta.responseHeaders` aplica cabeçalhos de resposta
  estáticos (por exemplo `X-Robots-Tag: noindex` num link de partilha público) em
  todas as respostas que a rota produz, incluindo os erros dos guards, da
  validação e do handler — vê
  [Cabeçalhos por rota](/pt/guide/security#cabecalhos-por-rota-—-meta-responseheaders).
- **Webhooks operáveis.** `secretBox` sela os secrets de assinatura dos endpoints
  em repouso, `onAttempt` e `DeliveryResult.durationMs` reportam cada tentativa
  de entrega, `headerPrefix` muda o nome dos headers `x-basalt-*`, e
  `signPayload()` / `verifySignature()` aceitam bytes em bruto — vê
  [Webhooks](/pt/guide/webhooks#selar-secrets-em-repouso).
- **O outbox de webhooks funciona com endpoints por tenant.** Com schema por
  tenant (ou base de dados por tenant) e o store de webhooks sobre
  `tenantClient()`, cada entrada do relay falhava com `DB_UNAVAILABLE` e acabava
  morta. O `tenancyPlugin` passa a publicar um sinal `'tenancy:run'`
  (`TenantRunner`, minor do `@basaltkit/tenancy`), e o `webhooksPlugin` usa-o
  para correr a pesquisa de endpoints de um `dispatch()` fora do pedido
  delimitado por `tenantId` dentro de `tenancy.run` — só a pesquisa, nunca a
  entrega, por isso um endpoint lento não consegue prender um cliente do pool.
  `webhookOutboxPlugin({ tenantOnly: true })` ignora eventos emitidos sem tenant.
  **Ativo por defeito** sempre que o `tenancyPlugin` está registado, o que as
  apps em schema partilhado também notam: um `TenantSource.find` e um par
  `tenancy:switched`/`tenancy:exited` por cada dispatch destes, e as entradas de
  um tenant que já não existe acabam mortas (`TENANT_NOT_FOUND`) em vez de serem
  entregues. Desativa com `webhooksPlugin({ runInTenant: false })` — vê
  [Webhooks → Schema por tenant](/pt/guide/webhooks#schema-por-tenant).
- **Mail de entrada.** Um pacote novo, `@basaltkit/inbound-mail` 0.1, recebe
  email de um relay como bytes em bruto assinados (um destinatário por pedido,
  envelope dentro da assinatura), encaminha-o pelo destinatário assinado para
  handlers conscientes do tenant e faz o parse dentro de limites, confiando em
  `Authentication-Results` e ARC só de servidores que indicares. Traz um Worker
  de referência para o Cloudflare Email Routing — vê
  [Mail de entrada](/pt/guide/inbound-mail).
- **Clientes de tenant alugados por pedido.** O `prismaPlugin`
  (`@basaltkit/prisma` 3.1) passa a alugar (lease) o cliente do pool de um
  tenant para cada pedido HTTP e cada `tenancy.run()`, e devolve-o quando a
  resposta termina, através dos novos disposers de pedido (`RequestDisposer`,
  `ctx().onDispose()`) do `@basaltkit/http` 2.8 e de todos os adapters — vê
  [Escrever o teu próprio guard ou enricher](/pt/guide/concepts#escrever-o-teu-proprio-guard-ou-enricher). Antes,
  um cliente contava como em uso durante `idleMs` (30 s) depois de cada pedido,
  por isso, com os defaults, o 11.º tenant distinto em 30 s esperava 10 s por um
  `503` sem nada a correr. O pool que o plugin cria passa a usar `idleMs` de 1 s
  por defeito, um período de tolerância e não um orçamento por pedido — vê
  [O pool de clientes por tenant](/pt/guide/database-per-tenant#o-pool-de-clientes-por-tenant).

### Mudanças de comportamento e notas de upgrade {#behaviour-changes-and-upgrade-notes}

Nenhum pacote precisa de uma major, mas estas minors mudam o que algumas
aplicações vêem. Lê esta lista antes de actualizar.

#### Idempotência

- **Os handlers Fastify crus perdem a idempotência.** O `idempotencyPlugin`
  cobre agora só definições `route()` do Basalt. Um handler registado
  directamente na instância Fastify (`fastify.post(...)`, fora de
  `fastifyPlugin({ routes })`) que dependia do antigo hook só-Fastify deixa de
  estar protegido. Move-o para `route()`. Nenhum aviso no arranque os assinala,
  por isso verifica os teus handlers POST crus.
- **Só se regista o que o handler fez.** Uma recusa levantada antes de o handler
  correr (o `401`/`403` de um guard, o `429` do rate limiter, um `400` de
  validação) liberta a `Idempotency-Key` em vez de ser replicada durante todo o
  TTL, por isso um cliente que volta a autenticar-se ou respeita o `Retry-After`
  vê a operação executada no retry. O mesmo vale para um corpo `upload()`
  recusado enquanto o handler o lê em stream (`413` acima de um limite, `400`
  malformado, `415` um tipo de ficheiro recusado): repete com um ficheiro mais
  pequeno e a mesma chave e o handler corre. `408`, `425` e `429` nunca são registados,
  mesmo vindos do handler. Os outros `4xx` do handler continuam a ser
  replicados byte a byte. Idêntico em Fastify, Express e Hono.
- **A verificação corre depois dos enrichers** (e antes dos guards, salvo
  `replayAfterGuards: true`). O replay é decidido depois de resolvido o tenant,
  por isso um tenant suspenso recebe o seu `403` em vez da resposta em cache.
- **O que o escopo cobre.** O escopo do replay é: as credenciais do caller, os
  headers em bruto `x-tenant-id`/`host`, o método, o *padrão* da rota e a chave.
  **Não** inclui um tenant resolvido a partir do path ou de um claim do token,
  nem os params concretos do path: a mesma credencial a reutilizar uma chave em
  `/t/acme/...` e `/t/globex/...`, ou em `/orders/1/pay` e `/orders/2/pay`,
  recebe a primeira resposta. Gera uma chave nova por operação e por tenant, e
  associa-a ao URL com
  `fingerprint: ({ request }) => request.url + '\n' + JSON.stringify(request.body)`.
  `fingerprint: 'body'` cobre só o corpo, não a query string nem os params.
- **Rolling deploys com `fingerprint`.** O `RedisIdempotencyStore` grava as
  reservas em curso como `pending:<fingerprint>`, que instâncias antigas lêem
  mal. Faz primeiro o deploy da nova versão em todo o lado e só depois liga o
  `fingerprint`. Respostas vazias (`204`) passam a ser registadas e replicadas.
- **Um enricher que envia a resposta termina o pedido.** Depois de um
  `reply.send()` num enricher, os restantes enrichers, os guards e o handler já
  não correm.

Vê [Mutações idempotentes](/pt/guide/security#mutacoes-idempotentes-—-idempotencyplugin).

#### Disposers de pedido e leases do Prisma

- **Os leases precisam do `@basaltkit/http` 2.8.** O `prismaPlugin` só aluga
  quando o pipeline liberta o lease no fim da resposta: `@basaltkit/http` 2.8
  com um adapter da mesma versão, e `@basaltkit/tenancy` 3.2 para o
  `tenancy.run()`. Com versões antigas nada fica preso: o plugin segura o
  cliente durante 30 s e depois devolve-o, como fazia o `pool.get()`. O
  `@basaltkit/http` passa a ser um peer opcional do `@basaltkit/prisma`.
  Actualiza o http, o teu adapter e o tenancy junto com o prisma.
- **A ordem de registo deixa de importar para o `ctx().db`.** O lease é tirado
  assim que o tenant é conhecido, por isso um enricher registado entre o
  `tenancyPlugin` e o `prismaPlugin` (o auth, por exemplo) vê o `ctx().db`. Cada
  pedido tem exactamente um lease, libertado mesmo quando um enricher ou guard
  posterior recusa o pedido.
- **Os disposers esperam pelo handler.** Num abort do cliente a meio do pedido,
  o Fastify e o Express corriam os disposers dos enrichers com o handler ainda a
  correr, o que podia desligar o seu cliente alugado a meio de uma query. Os
  disposers correm agora exactamente uma vez, depois de o handler terminar *e*
  de a resposta estar completa: enviada ou abandonada no Fastify/Express; no
  Hono uma resposta em buffer fica completa quando é construída, por isso os
  seus disposers são aguardados antes de ser entregue ao runtime. Os corpos
  `stream()` e `sse()` continuam cobertos até ao último byte ou até o cliente
  sair. Um disposer entregue ao `ctx().onDispose()` depois desse ponto (a partir
  de um timer que o handler deixou, por exemplo) corre de imediato, em todos os
  adapters. Um disposer que falha é reportado como `REQUEST_DISPOSER_FAILED` em
  todos os caminhos (o `onError` do adapter, o `reportError` do
  `@basaltkit/mcp`, `console.error` para um `runRoute` sem adapter). O
  `ctx().onDispose` não existe dentro do `tenancy.run()`, em jobs nem em
  pipelines antigos: verifica se existe em vez de chamar
  `ctx().onDispose?.(…)`, que aí descarta a limpeza em silêncio.
- **O `ctx().db` depois da resposta não está protegido.** O lease acaba com a
  resposta, e o cliente fica reservado só mais 1 s. Trabalho que sobrevive à
  resposta tem de fazer `await` antes de responder, ou correr em
  `tenancy.run()` / `DB_POOL.use()`. Se usavas `DB_POOL.get()` no pool do plugin
  para trabalho com mais de 1 s, passa para `DB_POOL.use()` ou indica `idleMs`
  explicitamente. Um `tenancy:switched` emitido no contexto de um pedido depois
  de a resposta acabar recebe a cedência legada de 30 s, nunca um lease que
  ninguém devolve.
- **Dimensiona o `max` pelos tenants distintos activos em poucos segundos.**
  Exceder o pool já não responde `503`; gera rotação: um cliente inactivo é
  fechado e um novo aberto em cada pedido. Monitoriza quantas vezes corre a tua
  factory `forTenant`.
- **Os corpos `PRISMA_POOL_EXHAUSTED` são neutros.** O `503` leva só o código e
  "Service unavailable.". `max`, `leased`, `recentlyUsed` e o id do tenant vão
  só para o log do servidor.

#### Configurações que passam a mostrar um aviso no arranque (recusadas na próxima major) {#configurations-that-now-warn-at-boot-refused-in-the-next-major}

Cada uma destas arrancava e continua a arrancar, com o mesmo comportamento em
runtime de antes; cada uma mostra agora um aviso `[basalt] …` no arranque que
diz o que está mal. A próxima major transforma cada aviso numa recusa do
arranque, por isso corrige-as já — cada uma tem uma correcção de uma linha.

- **`@basaltkit/auth`: um cookie de sessão com prefixo e `secure: false` ou um
  sub-path.** Um `sessionCookie.name` que começa por `__Host-` ou `__Secure-`
  com um `secure: false` explícito (incluindo o habitual
  `secure: process.env.NODE_ENV === 'production'` em dev e testes), ou um cookie
  `__Host-` com um `path` diferente de `/`. O cookie continua a ser emitido tal
  como configurado; os browsers descartam-no, por isso essa app não tem aí
  sessões de browser a funcionar. Retira `secure`/`path`, ou usa um nome sem
  prefixo fora de produção: `name: isProd ? '__Host-sid' : 'sid'`. A próxima
  major lança `AUTH_SESSION_COOKIE_INVALID` (`SessionCookieConfigError`, já
  exportado). Os prefixos são reconhecidos sem distinguir maiúsculas
  (`__host-sid` conta), e um cookie `__Host-` com sub-path e `secure` por
  definir recebe também, fora de produção, o aviso do `Secure` implícito. À
  parte (só aviso, nunca recusado), um cookie sem prefixo com
  `sameSite: 'None'` e sem `Secure` gera um aviso: os browsers também o
  descartam.
- **`@basaltkit/tenancy`: `meta.tenant` diferente de `true`, `false` ou
  `'never'`.** Um valor como `'none'`, `'optional'`, `'false'` ou `null` cai no
  default `required` da app, como antes. Se querias só plano central, o valor é
  `'never'`. A próxima major recusa o arranque com `HTTP_INVALID_ROUTE_META`.
- **`@basaltkit/http`: um `meta.responseHeaders` inválido.** Tem de ser um
  registo de valores string sem caracteres de controlo e não pode definir
  `set-cookie`, `content-type`, `content-length`, `transfer-encoding`, headers
  hop-by-hop nem `x-request-id`. Um registo inválido é ignorado por inteiro —
  nenhum dos seus cabeçalhos é enviado — e o pedido nunca falha por causa dele.
  A chave é nova: uma app que guarda dados seus em `meta.headers` não é
  afectada, porque nada lê nem envia `meta.headers`.

#### Configurações que passam a recusar o arranque {#configurations-that-now-refuse-to-boot}

Só uma, e só para formas acrescentadas nesta versão:

- **`@basaltkit/http`: `meta.rateLimit` mal formado nas formas novas.** Um array
  (incluindo `[]`) com uma entrada mal formada, um objecto cujo `bucket` é uma
  string que não é um nome de bucket válido, ou rotas que partilham um `bucket`
  mas discordam no limite, na janela ou na chave, recusam o arranque com
  `HTTP_INVALID_ROUTE_META`. O objecto único sem `bucket` string — incluindo
  `bucket: null` — mantém o parse tolerante e é aplicado por rota, como antes.

#### Outras mudanças

- **Audit — recusas de API keys.** O `auth:apikey_rejected` deixa de ser
  registado por defeito, porque qualquer cliente anónimo podia inundar o trail
  com chaves desconhecidas. As recusas de uma chave que *foi* verificada
  (`tenant_mismatch`, `not_allowed`, `scope`) continuam registadas, com o novo
  hook `auth:apikey_refused`. Uma lista `hooks` própria também aplica as
  exclusões por defeito. Para voltar a registar todas as rejeições, nomeia-a:
  `hooks: ['auth:**', 'auth:apikey_rejected']` (uma recusa de chave válida fica
  então registada duas vezes) — ou usa o listener com throttle em
  [Que hooks são auditados](/pt/guide/persistence#which-hooks-are-audited).
- **Audit — cadeias apagáveis.** Actualiza todos os serviços que correm
  `audit.verify()` antes do primeiro `audit.redact()` ou antes de ligar
  `integrity: { mode: 'hash-chain', erasable: true }`: versões antigas reportam
  as entradas v3 e as redigidas como `hash-mismatch`. Vê
  [Apagar dados pessoais](/pt/guide/persistence#erasing-personal-data-audit-redact).
- **Auth — um cookie de sessão com prefixo passa a implicar `Secure` em
  qualquer ambiente.** Com `secure` por definir, um cookie `__Host-…`/
  `__Secure-…` passa a ser `Secure` (e `Path=/` para `__Host-`) também fora de
  produção; antes era emitido sem `Secure` e os browsers descartavam-no. Os
  fluxos de browser passam a funcionar, incluindo `http://localhost`.
  **Atenção aos clientes de teste:** os cookie jars que respeitam `Secure`
  (supertest/superagent, tough-cookie) não o devolvem sobre `http` simples, por
  isso uma suite que dependia da emissão antiga recebe 401; fora de produção
  isto mostra um aviso único no arranque. Usa um nome sem prefixo fora de
  produção, ou define `secure` explicitamente (`secure: true` silencia-o).
- **Auth — o `sessionIdleTtl` é validado.** A nova opção falha fechada no
  arranque (`AUTH_SESSION_IDLE_CONFIG_INVALID`) quando não é uma duração
  positiva ou o store de sessões não tem `touch()`; apps que não a definem não
  são afectadas.
- **Auth — `UserSource` própria sem `update()`.** O `create()` passa a receber
  `emailVerified`; persiste-o para ter contas sociais e de confiança
  verificadas. Uma source que não o persiste nem implementa `update()` continua
  a autenticar utilizadores OAuth através da ligação de identidades, não
  verificados como antes. Dois casos continuam a falhar nessa source: um
  utilizador SAML (sem identidade ligada) é recusado no segundo login, como já
  acontecia antes desta versão. O `register(…, { emailVerified: true })` (novo
  nesta versão) exige `update()` e, sem ele, lança `AUTH_UPDATE_UNSUPPORTED`
  antes de escrever o que quer que seja — nenhuma conta é criada, por isso uma
  nova tentativa nunca recebe `EmailTakenError`. Implementa `update()` (e
  persiste `emailVerified` no `create()`) para teres ambos.
- **Aviso no arranque para `meta.rateLimit` sem rate limiter.** Quando
  qualquer rota declara `meta.rateLimit` — o `authRoutes()` declara, e as tuas
  próprias rotas também podem — e o `securityPlugin({ rateLimit })` não está
  registado, a app imprime agora um `console.warn` no arranque com essas rotas,
  porque nada aplica o limite. Regista o limiter, passa
  `authRoutes({ rateLimit: false })` para as rotas de auth, ou silencia-o com
  `allowUnguardedMeta: ['rateLimit']` (ou `true`) no plugin do adapter se um
  edge à frente já limita.
- **Webhooks — `runInTenant` ligado por defeito.** Com o `tenancyPlugin`
  registado, cada `dispatch()` fora do pedido delimitado por `tenantId` faz uma
  chamada a `TenantSource.find` e dispara `tenancy:switched`/`tenancy:exited`;
  com schema ou base de dados por tenant, o `prismaPlugin` aluga também o
  cliente desse tenant, o que pode falhar com `PRISMA_POOL_EXHAUSTED` com o pool
  saturado. Um tenant apagado ou um id inválido rejeita com `TENANT_NOT_FOUND` /
  `TENANT_ID_INVALID`, e as entradas do outbox acabam mortas depois de
  `maxAttempts`. Se as tabelas de webhooks são centrais, passa
  `webhooksPlugin({ runInTenant: false })` — vê
  [o que custa](/pt/guide/webhooks#run-in-tenant-costs).
- **Drives — a saúde da ligação é opt-in por store.** `lastSucceededAt`,
  `lastFailedAt` e `lastErrorCode` só são escritos num store que declara
  `persistsHealth: true` (o store em memória declara). Um store durável continua
  a funcionar sem mudanças e não reporta saúde. Para a ligar, acrescenta as três
  colunas nullable, migra e só depois define `readonly persistsHealth = true` —
  vê [Saúde da ligação](/pt/guide/drives#saude-da-ligacao).
- **Notificações — o `Notifier` decide através de `preference()`.** Decide cada
  canal através de `NotificationPreferences.preference()` e, a seguir, dos
  `defaults` e `mandatory` da notificação. Uma subclasse que redefine
  `allowed()` continua a funcionar: o `Notifier` detecta a redefinição e
  deixa-a decidir, como antes (os `defaults` não se lhe aplicam; os `mandatory`
  continuam a ignorá-la). Redefinir `allowed()` está obsoleto — redefine
  `preference()`; a próxima major deixa de consultar uma redefinição de
  `allowed()`.
- **MCP — os erros internos são registados.** Um erro que escapa a uma tool
  continua a responder `Internal error`, e a causa vai agora para o stderr por
  defeito. Usa `mcpPlugin({ onError })` para a enviar para outro lado, ou
  `onError: false` para a silenciar.
- **MCP — sem chave de idempotência nas chamadas de tools.** Uma chamada de
  tool nunca encaminha a `Idempotency-Key` (nem o header definido por
  `idempotencyPlugin({ header })`) para a rota, mesmo listada em
  `forwardHeaders`: um replay entregaria ao modelo o corpo de erro gravado sem
  a redação do resultado da tool. Cada chamada corre o handler; deduplica dentro
  do handler se precisares.
- **Tenancy — o `basalt prisma:sync` não acrescenta as novas colunas de
  `TenantDomain`.** O modelo incluído ganha `verificationToken`, `verified`,
  `createdAt` e `verifiedAt`. O `prisma:sync` só acrescenta modelos em falta,
  por isso uma app que já tem `TenantDomain` tem de acrescentar os quatro campos
  à mão (copia-os de `@basaltkit/tenancy-prisma/prisma/schema.prisma`) e correr
  uma migração antes de publicar um cliente gerado a partir do novo modelo.
- **Tabela de rotas — `central-only`.** O `basalt routes` mostra
  `meta.tenant: 'never'` como `central-only` (o `meta.tenant: 'never'` na rota e
  o `central-only` na tabela são a mesma coisa). O novo `describeRoutes()` lê o
  `RouteRow.tenant` só do `meta.tenant`; o `meta.central: true` (o bypass de
  membership do teams) aparece nas guardas como `central`.
- **Apps criadas com `--prisma` pelo create-basalt 1.8–1.11 — muda um
  script.** O seu `db:seed` é `tsx prisma/seed.ts`, que não carrega o `.env`,
  por isso o `pnpm db:seed` falha com `ENV_INVALID` (URL da base de dados e
  segredo da app em falta) salvo se exportares as variáveis; e o `migrate dev`
  do Prisma 7 nunca corre o seed, por isso o tenant `demo` que os resolvers
  esperam nunca foi criado (o passo seguinte «creates the tables and seeds the
  demo tenant» estava errado). No `package.json`, define
  `"db:seed": "prisma db seed"` — o `prisma.config.ts` passa a carregar o
  `.env` e corre o comando `migrations.seed` que já declara — e corre
  `pnpm db:seed` depois do `pnpm db:migrate`. Nada reescreve o script por ti:
  o `create-basalt doctor` assinala-o e o `create-basalt update` mostra a
  linha.

## Destaques

### Promessas que o código passa a cumprir
- **O trilho de auditoria detecta o que o README dizia que detectava.** O
  `verify()` passa a ler também as linhas de um tenant fora da sua cadeia: uma
  linha escrita depois de a cadeia começar sem lugar nela falha com
  `unchained-entry` e fica listada em `unverified`; `verify({ expectedHead })`
  ancora a cabeça, para que uma cauda apagada seja `truncated` e não silêncio.
  Os payloads são congelados em profundidade, o redactor reconhece chaves
  secretas pelas suas palavras (`privateKey`, `client_secret`, `dsn`…) e
  pseudonimiza números de telefone internacionais como documentado, e os filtros
  dos stores são validados — `?tenantId[not]=x` já não chega a um `where` do
  Prisma. *(`@basaltkit/audit` 2.0, `audit-prisma` / `audit-sqlite` 2.0)*
- **O `idempotencyPlugin` repete handlers que devolvem um valor.** Só os handlers
  que chamavam `reply.send()` eles próprios estavam cobertos; todas as outras
  rotas corriam em cada retry da mesma `Idempotency-Key` e reportavam um 500
  espúrio. *(`@basaltkit/fastify` 2.5)*
- **Uma verificação de permissão responde só à pergunta que lhe fizeram.** A
  procura de políticas já não percorre o protótipo, uma verificação só autoriza
  quando devolve exactamente `true`, só um `resource:action` exacto escolhe a
  verificação de uma política, um id de utilizador em falta é um 401 e não um
  bucket partilhado, e uma permissão com um segmento vazio (`'projects:'`) não
  corresponde a nada. Com tenancy activa, uma escrita sem tenant e sem scope lança
  `PERMISSION_SCOPE_REQUIRED` em vez de atribuir em silêncio para toda a
  plataforma. *(`@basaltkit/permissions` 3.0)*
- **Um role mal escrito falha o arranque.** Um `meta.teamRole` desconhecido tinha
  rank zero e admitia toda a gente; agora faz todos os adapters recusarem
  arrancar com `InvalidRouteMetaError`, nomeando a rota. Um role sem rank
  corresponde só a si próprio, e "um convite pendente por e-mail" deixa de
  distinguir maiúsculas. *(`@basaltkit/teams` 4.0)*
- **Uma só regra de `NODE_ENV` em todo o lado.** O `isProductionEnvironment()` é
  a única política, e falha fechado: só um `development` ou `test` explícito não
  é produção. O `auth` aplica sob ela o mínimo de 32 caracteres do segredo e os
  cookies `Secure`, o `mailer` deixa de registar o corpo dos e-mails, e o `queue`
  avisa sobre um driver sync implícito. *(`@basaltkit/core` 1.5, `auth` 4.0,
  `mailer` 2.1, `queue` 3.0)*
- **A chave single-tenant não pode ser um tenant.** O `SINGLE_TENANT_SCOPE` era
  `'default'` — um id de tenant válido, por isso um pedido que nomeasse o tenant
  `default` chegava aos registos de uma app single-tenant. Passa a ser
  `'@single'` em files, comments, search e drives, e um tenant igual a ela é
  recusado. *(`@basaltkit/files` 5.0, `comments` 4.0, `search` 2.0, `drives` 0.3)*
- **As chaves de storage nomeiam um só objecto em todos os drivers.** Um segmento
  de tenant tem de ser canónico (`Acme` e `acme` partilhavam uma directoria num
  disco que não distingue maiúsculas), todos os discos com scope falham fechado
  sem tenant (um `new Disk()` construído à mão recuava para a raiz do bucket), as
  chaves com segmentos `.` ou vazios são recusadas, e uma cópia a partir de um
  disco de tenant não pode aterrar na árvore de outro tenant.
  *(`@basaltkit/storage` 4.0)*
- **As entregas de webhooks mantêm a sua identidade.** As entregas da outbox têm
  um id estável entre retries, as falhas permanentes deixam de ser reenviadas a
  endpoints saudáveis (`onPermanentFailure`), cada retry é assinado com o seu
  próprio timestamp, e o `register()` valida o endpoint — URL, esquema, um segredo
  com pelo menos 16 caracteres, eventos — em vez de guardar um que falha em todas
  as entregas. *(`@basaltkit/webhooks` 3.0)*

### Quem pergunta, e em nome de quem
- **É o Host que decide o tenant, não um header.** `subdomainResolver`,
  `domainResolver` e `routeResolver` são autoritativos: correm antes de qualquer
  fallback, e um nome que não existe resolve para nenhum tenant em vez de passar a
  decisão ao `x-tenant-id`. A gramática de id de tenant aplica-se à resolução e ao
  `run()`, o `normalizeDomain()` valida em vez de fazer parse de URL
  (`acme.basalt.app@evil.com` passava a `evil.com`), os pedidos de domínio não
  verificados expiram, e o `CustomDomains.reverify()` deixa um domínio caducado
  mudar de dono. *(`@basaltkit/tenancy` 3.0)*
- **Um login social fica ligado ao subject do provider.** As ligações de conta
  (provider + subject → utilizador) substituem a correspondência só por e-mail;
  uma segunda conta no mesmo IdP a reclamar um e-mail já ligado recebe
  `409 AUTH_ACCOUNT_LINK_CONFLICT`. Os providers OIDC podem ficar restritos aos
  seus domínios de e-mail — obrigatório quando há mais de um provider configurado
  — e o `aud`, o `exp` e o `iss` do `id_token` são verificados.
  *(`@basaltkit/auth` 4.0)*
- **As passkeys e os segredos TOTP aguentam concorrência e adulteração.** O
  contador WebAuthn é escrito por compare-and-set, por isso um autenticador
  clonado em corrida com o genuíno perde; o `remove()` verifica o dono; o desafio
  fica ligado ao utilizador. Os segredos TOTP são selados com AES-256-GCM sob um
  anel de chaves HKDF, com o id do utilizador como dados associados, e um valor
  que não seja um envelope é recusado em vez de lido como texto simples.
  *(`@basaltkit/auth` 4.0, `auth-prisma` / `auth-sqlite` 2.0)*
- **As respostas SAML pertencem ao browser que as pediu, assinadas com SHA-2.**
  As `samlRoutes()` ligam cada login a um cookie HttpOnly (CSRF de login), os
  erros do node-saml são um 400, e as assinaturas e digests SHA-1 são recusados
  por omissão. *(`@basaltkit/auth-saml` 3.0)*
- **Um job corre como quem o despachou, e como mais ninguém.** O worker
  reconstrói o contexto a partir de uma allowlist — ids de pedido, um tenant
  validado, o `userId` restaurado como `user: { id }` para as entradas de
  auditoria nomearem um actor — em vez de espalhar o que quer que o broker
  tivesse. Os envelopes podem ser assinados com HMAC (`signingKey`), e uma segunda
  definição com um nome de job já usado lança. O backplane Redis do realtime pode
  ser assinado também, e o `subscribe()` volta a verificar a ligação depois do seu
  gate assíncrono. *(`@basaltkit/queue` 3.0, `queue-bullmq` 1.1,
  `queue-rabbitmq` 1.4, `queue-sqs` 1.3, `realtime` 1.5)*

### Dinheiro, índices e linhas
- **A facturação cobra antes de conceder.** O `swap()` para um plano pago a partir
  de uma subscrição sem gateway por trás lança `402 BILLING_PAYMENT_REQUIRED`; as
  quantidades de uso têm de ser inteiros positivos em todos os stores; um webhook
  de uma subscrição de gateway substituída já não cancela a activa; as renovações
  do Lemon Squeezy deixam de ser descartadas como duplicadas; as assinaturas do
  Paddle e do Lemon Squeezy são lidas dos seus próprios headers, e ambos passam
  pelo `checkout()`. Cupões, facturas e o ledger de pagamentos validam o que
  recebem. *(`@basaltkit/subscriptions` 5.0, `subscriptions-prisma` / `-sqlite` 3.0)*
- **Uma reconstrução só limpa o que consegue voltar a encher.** O `reindex()`
  nunca arquiva uma linha sem tenant sob o tenant que chama, valida todas as
  linhas antes de limpar seja o que for, e dentro de um tenant reconstrói só esse
  tenant — uma reconstrução do índice inteiro diz `{ all: true }`. A paginação e
  os filtros são limitados e validados. Os documentos do Elasticsearch com
  caracteres especiais de URL no id voltam a ser endereçados por um só `_id`.
  *(`@basaltkit/search` 2.0, `search-elasticsearch` 2.0, `search-postgres` 1.2)*
- **O pool de tenants nunca desliga um cliente em uso.** O `TenantClientPool` só
  despeja clientes inactivos e, quando todos estão ocupados, espera e depois
  responde `503 PRISMA_POOL_EXHAUSTED` — o tecto nunca é ultrapassado. As
  políticas RLS comparam com `NULLIF(current_setting(…), '')`, uma troca de
  tenant sem cliente falha fechado, e os DTOs de classe são delimitados como
  objectos simples. *(`@basaltkit/prisma` 3.0)*
- **O MySQL deixa de truncar em silêncio.** Cada pacote `*-prisma` traz um
  `schema.mysql.prisma` com as colunas de texto livre alargadas, o
  `basalt prisma:sync` copia-o para uma datasource MySQL, e um
  `columnLimits: 'mysql'` opcional recusa um valor demasiado longo com
  `COLUMN_LENGTH_EXCEEDED` em vez de escrever um hash cortado. Os saves de
  tenancy são atómicos, e os endpoints de webhook têm chave por tenant.
  *(`@basaltkit/prisma` 3.0, `tenancy-prisma` 2.0, `webhooks-prisma` 2.0, e os
  restantes stores `*-prisma`)*

### Três adapters, um só protocolo
- **A mesma rota envia os mesmos bytes em Fastify, Express e Hono.** Uma string é
  `text/plain` nos três (o Express servia-a como `text/html` — um XSS refletido
  só nesse adapter); JSON é `application/json` ou `+json` pelo media type exacto;
  um corpo malformado é um 400; uma chave de query repetida é um array; o limite
  do corpo é 1 MiB; o `sse()` mantém os headers de CORS e de segurança definidos
  antes dele; os after-hooks correm para respostas abandonadas. Uma suite de
  paridade partilhada garante-o. *(`@basaltkit/http` 2.6, `fastify` 2.5,
  `express` 2.0, `hono` 2.0)*
- **A meta das rotas é validada no arranque.** Os plugins registam validadores
  para os valores que as suas chaves de meta levam (`http:meta-validators`), e
  verificações de visibilidade sem efeitos secundários (`http:route-visibility`)
  deixam uma listagem esconder o que quem chama nunca conseguiria passar. O
  `expose = false` mantém a resposta de um upstream fora de um 502.
  *(`@basaltkit/http` 2.6)*

### MCP através da rede
- **O `/mcp` conhece quem chama e a sua sessão.** Um `Origin` estranho recebe 403,
  um corpo que não é JSON recebe 415, uma chamada de tool recebe uma allowlist de
  headers em vez de todos, e um 4xx do handler é um resultado `isError`. O
  `initialize` emite um `Mcp-Session-Id` ligado a quem chama, por isso um
  cancelamento num POST posterior chega à chamada que nomeia e a nenhuma outra; o
  `tools/list` esconde o que quem chama não poderia usar. *(`@basaltkit/mcp` 4.0)*
- **O núcleo MCP recusa ficar acessível por acidente.** O `serveHttp` não se liga
  fora do loopback sem `authorize`, limita o corpo dos pedidos, nunca responde a
  uma notificação, suporta batches JSON-RPC e elicitação real no stdio — por isso
  o `basalt_make` do `ai-mcp` recusa um `apply` que não consegue confirmar em vez
  de escrever em silêncio. *(`@basaltkit/mcp-core` 0.4, `ai-mcp` 0.2)*
- **As drives externas ficam dentro da sua raiz.** Os cursores de listagem são
  assinados para o seu tenant e ligação (um cursor do Graph é um URL obtido com o
  token da ligação), um `rootId` confina todas as chamadas, e os três adapters
  chegam à 1.0. *(`@basaltkit/drives` 0.3, `drives-dropbox` / `drives-google` /
  `drives-microsoft` 1.0)*

### Fechar a colheita da auditoria
O relatório da auditoria não parou nas oitenta constatações: fechava com uma
colheita de lacunas de desenho e melhorias. Dois pull requests aterraram
depois do lançamento e terminaram essa lista, por isso seguem dentro da 1.12 — e
seis pacotes publicam o seu segundo major da vaga.
- **As políticas correm no guard da rota.** Um `meta.can` simples era só RBAC: o
  guard nunca passava um recurso, por isso uma política registada com
  `definePolicy` nunca decidia uma rota. O `meta.can` aceita agora também
  `{ permission, resource, notFound? }`, sozinho ou num array all-of: o guard
  carrega o recurso com o input já validado da rota, chama
  `gate.authorize(user, permission, resource)`, responde 404
  `RESOURCE_NOT_FOUND` quando ele não existe (ou um 403 auditado com
  `notFound: 'deny'`), e o handler lê-o com `canResource()`. Um requisito que
  nenhuma política registada decide recusa o arranque.
  *(`@basaltkit/permissions` 4.0)*
- **O `hasRole()` responde à pertença, e o `/me/access` mostra todas as portas
  que abrem.** Um super admin já não "tem" todos os nomes de role alguma vez
  escritos — o bypass é autoridade, não pertença, e o `gate.isSuperAdmin()`
  pergunta por ele explicitamente. O `GET /me/access` vem agora do
  `gate.describeAccess()`: atribuições globais, atribuições temporárias,
  delegações e o bypass de super admin, cada uma com a sua origem. As
  atribuições temporárias e as delegações ganham stores duráveis, por isso
  sobrevivem a um reinício e são vistas por todas as instâncias.
  *(`@basaltkit/permissions` 4.0, `permissions-prisma` / `-sqlite` 2.1)*
- **Os detalhes de erro são públicos por construção.** O `new HttpError(…, {
  internalDetails })` é um canal só para logs que o reporter de erros recebe e
  que nenhuma resposta nem resultado de tool leva. O `@basaltkit/mcp` passa os
  `details` de um erro lançado pelo `redactSensitiveDetails` antes de chegarem
  ao modelo, e os erros das chamadas de tool, que desapareciam, passam a ser
  reportados. *(`@basaltkit/http` 2.7, `mcp` 5.0)*
- **Os hashes de auditoria nomeiam o seu algoritmo e a sua chave.** As entradas
  novas são `v2:sha256:…` ou `v2:hmac-sha256:<keyId>:…`, por isso a chave HMAC
  pode ser rodada (`keyId`, `verifyKeys`) sem fazer falhar todas as entradas que
  a chave antiga assinou; as entradas v1 continuam a verificar. O `verify()`
  apanha também um `seq` duplicado na fronteira de uma página.
  *(`@basaltkit/audit` 3.0, `audit-prisma` / `-sqlite` 2.0.1)*
- **Os webhooks respeitam uma política de portas e um tecto de fan-out.** As
  entregas vão para `80`, `443` ou uma porta não privilegiada fora de
  `DEFAULT_BLOCKED_PORTS` — já não para um Redis ou um Postgres expostos. A
  resolução de DNS corre dentro do prazo de cada tentativa, um dispatch para mais
  de 100 endpoints por evento e scope é recusado, correm no máximo 16 entregas
  em simultâneo, e o `rotateSecret()` assina com os dois segredos durante uma
  janela de tolerância. *(`@basaltkit/webhooks` 4.0, `webhooks-prisma` /
  `-sqlite` 2.1)*
- **O storage devolve as chaves que recebe, e cobra ao tamanho a sua palavra.**
  O `list()` num disco de tenant devolve `a/1.txt`, e não
  `tenants/<id>/a/1.txt`, que o `get()` voltava a prefixar; o prefixo é uma
  directoria em todos os drivers. Um `contentLength` é validado e contado, e um
  corpo que o contradiga nunca é gravado. O S3 envia por multipart um upload de
  tamanho desconhecido em vez de o guardar em memória. *(`@basaltkit/storage`
  5.0, `storage-s3` 1.4)*
- **As rotas de ficheiros respondem com uma projecção pública.** O `GET /files`
  e companhia devolviam o registo em bruto — o caminho no storage, o checksum, o
  `uploadedBy`, o output do scanner. Agora enviam `toPublicFile(record)`, e o
  `fileRoutes({ present })` escolhe outra forma. *(`@basaltkit/files` 6.0)*
- **Um tenant suspenso é um 403, e um estado desconhecido falha fechado.**
  Qualquer estado que não fosse `ready` era um 503 "ainda em provisionamento" —
  incluindo `suspended`, por isso os clientes voltavam a tentar numa conta
  bloqueada. *(`@basaltkit/tenancy` 3.1)*
- **O passo de MFA deixa de ser um oráculo de passwords.** O
  `AUTH_MFA_REQUIRED` só é devolvido para uma password correcta, por isso passa
  a contar para os limites de login como uma errada. *(`@basaltkit/auth` 4.1)*
- **A ponte de IA impõe o "só em desenvolvimento".** O `ai-mcp` recusa arrancar
  com `NODE_ENV=production` sem um override explícito, e o `workspaceRoot` de
  uma tool tem de resolver dentro da raiz do projecto.
  *(`@basaltkit/ai-mcp` 0.3)*

### Docs
- Todos os guias que as correcções tocaram foram atualizados, em inglês e em
  português: [o comportamento na rede nos três
  adapters](/pt/guide/adapters#comportamento-na-rede-—-identico-nos-tres),
  [sessões e cancelamento no MCP](/pt/guide/mcp#sessions-and-cancellation) e
  [o que o `tools/list` mostra](/pt/guide/mcp#what-tools-list-shows), [a fronteira
  de confiança num worker de
  queue](/pt/guide/queues#o-contexto-no-worker-—-e-a-fronteira-de-confianca),
  [escritas de permissões que precisam de um
  tenant](/pt/guide/authorization#as-escritas-precisam-de-um-tenant-ou-de-um-scope-explicito),
  [persistência em MySQL](/pt/guide/persistence#mysql), [reconstruir um índice de
  pesquisa](/pt/guide/search#reconstruir-um-indice), [cifrar os segredos TOTP em
  repouso](/pt/guide/auth#mfa-encryption) e [migrar as drives da
  0.2.x](/pt/guide/drives#migrar-da-0-2-x).
- A colheita acrescentou [políticas no
  guard](/pt/guide/authorization#politicas-no-guard-requisitos-de-recurso),
  [o `GET /me/access`](/pt/guide/authorization#o-que-posso-fazer-—-get-me-access),
  [o que o modelo vê quando uma tool
  falha](/pt/guide/mcp#what-the-model-sees-when-a-tool-fails), e nos webhooks a
  [política de portas](/pt/guide/webhooks#politica-de-portas), o [tecto de
  fan-out](/pt/guide/webhooks#tecto-de-fan-out) e a [rotação de
  segredos](/pt/guide/webhooks#rodar-um-secret-de-assinatura); o
  `CONTRIBUTING.md` ganhou uma checklist de testes.

## Atualização

Os pacotes são independentes — sobe só o que usas. Cada changeset traz as notas
de migração completas no `CHANGELOG.md` do pacote; abaixo estão as mudanças com
maior probabilidade de chegar a uma aplicação.

### Predefinições que passam a recusar

| Pacote | O que recusa | Opt-out / correcção |
| --- | --- | --- |
| `auth` 4 | um `NODE_ENV` por definir com um segredo abaixo de 32 caracteres (`AUTH_WEAK_SECRET`); os cookies de sessão passam a `Secure`; vários providers OAuth em que um OIDC não declara domínios de e-mail; uma segunda conta do IdP a reclamar um e-mail já ligado (`409`); duas API keys diferentes no mesmo pedido (`400`) | `NODE_ENV=development` localmente, `sessionCookie: { secure: false }`; `allowedEmailDomains` ou `allowAnyEmailDomain: true`; `oauthPlugin({ subjectConflict: 'link' })`; enviar uma só chave |
| `mailer` 2.1 | o corpo dos e-mails no log com `NODE_ENV` por definir | `NODE_ENV=development` ou `logBody: true` |
| `tenancy` 3 | um header a sobrepor-se a um resolver de Host; um subdomínio desconhecido a cair para o header; ids fora da gramática na resolução e no `run()`; não-hostnames no `normalizeDomain()` | `authoritative(fn)` para um resolver custom de confiança; alargar `validateTenantId`; IDNs na forma `xn--` |
| `permissions` 3 | escritas sem scope fora de um tenant com tenancy activa; permissões com um segmento vazio; permissões de três segmentos contra uma política; `grantTemporarily()` sem prazo | passar `GLOBAL_SCOPE` explicitamente ou `allowGlobalWrites: true`; `ttlMs` / `expiresAt` |
| `storage` 4 | um `Disk` construído à mão ou um scope custom sem tenant; ids de tenant não canónicos no scope por omissão; chaves como `a//b`, `./a`, uma `/` final; uma cópia de um disco com scope para um central dentro de `tenants/` | `scope: null` ou `onMissingScope: 'root'`; um `scope` custom que mapeie os ids; construir chaves com `parts.join('/')` |
| `files` 5 | HTML, SVG, XML ou executáveis enviados como `application/octet-stream` | declarar o tipo e deixar o `allowedTypes` julgá-lo |
| `webhooks` 3 | `register()` com um URL inválido, um segredo abaixo de 16 caracteres ou sem eventos (`WEBHOOK_ENDPOINT_INVALID`); um id de outro tenant (`409`) | validar o input antes; ligar o `onPermanentFailure` para alertar sobre falhas que a outbox deixa de repetir |
| `mcp` 4 | um `Origin` estranho (`403`); um corpo que não é JSON (`415`); um POST posterior sem o seu `Mcp-Session-Id` (`400` / `404`) | `mcpRoutes({ allowedOrigins })`; `mcpRoutes({ sessions: false })`; acrescentar `Mcp-Session-Id` ao `exposeHeaders` do CORS para clientes de browser |
| `mcp-core` 0.4 / `ai-mcp` 0.2 | `serveHttp` fora do loopback sem `authorize`; corpos acima de 1 MiB; um `apply` que não pode ser confirmado | `authorize` / `allowRequest`, `maxBodyBytes`; `--token`; `--allow-unconfirmed-apply` |
| `auth-saml` 3 | assinaturas e digests SHA-1; uma resposta não ligada ao browser que iniciou o login; um `emailAttribute` configurado que não vem na asserção | `allowSha1: true` por provider; `bindToBrowser: false`; corrigir o nome do atributo |
| `teams` 4 | um `meta.teamRole` ou `tenantMembershipPlugin({ role })` desconhecido — a app não arranca | corrigir o role, ou dar-lhe rank em `roleRank` |
| `queue` 3 | dois jobs diferentes com o mesmo nome; `attempts: 0`; contexto de job com um tenant fora da gramática | renomear, ou `queuedOn(…, { name })`; `attempts` ≥ 1; passar o mesmo `validateTenantId` ao plugin de queue |
| `subscriptions` 5 | `swap()` para um plano pago sem subscrição no gateway (`402`); `subscribe()` a um plano pago no Paddle ou Lemon Squeezy (`501`); uso que não seja inteiro positivo | `swap(id, plan, { allowUnpaid: true })`; `checkout()` |
| `search` 2 | um `reindex()` simples fora de um tenant com tenancy registada; `limit` acima de 1000, `offset` acima de 10000; filtros em campos não declarados ou com valores `null` | `reindex(name, { all: true })`; `searchPlugin({ maxLimit, maxOffset })`; declarar o campo `filterable` |
| `prisma` 3 | um tenant novo quando todos os clientes do pool estão em uso — `503` depois do `acquireTimeoutMs` | dimensionar `max` para os tenants activos em simultâneo; no `prisma` 3.0 manter `idleMs` acima do pedido mais longo, ou `pool.use(tenantId, fn)` — a partir da 3.1 cada pedido tem um lease (vê as [notas de upgrade](#behaviour-changes-and-upgrade-notes)) |
| `audit` 2 | `verify()` / `verifyAll()` falham para linhas fora da cadeia escritas depois de ela começar | `legacyUntil` para uma origem conhecida e benigna, como um deploy gradual |

### Passos de dados

**A sentinela `'@single'`.** Uma app single-tenant com registos persistidos
re-chaveia-os uma vez, ou passam a ler-se como inexistentes. Salta este passo se
`default` já foi um tenant real nessa base de dados — essas linhas pertencem-lhe.

```sql
UPDATE files         SET "tenantId" = '@single' WHERE "tenantId" = 'default';
UPDATE file_versions SET "tenantId" = '@single' WHERE "tenantId" = 'default'; -- com files-versions
UPDATE comments      SET "tenantId" = '@single' WHERE "tenantId" = 'default'; -- comments-prisma
UPDATE comments      SET tenant_id  = '@single' WHERE tenant_id  = 'default'; -- comments-sqlite
```

O índice de pesquisa é derivado: reconstrói-o (`search.reindex(name)`), ou com o
`search-postgres` re-chaveia no sítio. As ligações de drives não se re-chaveiam
com SQL — cada segredo é selado com o seu tenant como dados associados — por isso
volta a selá-las com o `DriveSecretBox` como mostra o changelog do
`@basaltkit/drives`, e depois move o ledger de importação.

**Segredos MFA.** As chaves têm de ter pelo menos 32 bytes, e as linhas seladas
antes da 1.12 são recusadas. Atualiza com um opt-in temporário, re-cifra, e
depois remove-o:

```ts
authPlugin({
  mfaEncryption: {
    keys: [{ id: '2026-09', key: NEW_KEY_32_BYTES }],
    legacy: { v1Keys: [OLD_MFA_ENCRYPTION_KEY], plaintext: true },
  },
})
for (const userId of usersWithMfa) await auth.reencryptMfaSecret(userId)
// depois retira o `legacy`
```

**Dois modelos de auth novos.** O `@basaltkit/auth-prisma` acrescenta
`AuthAccountLink` e `AuthPasskey` — `basalt prisma:sync`, depois uma migração (em
cada schema de tenant com schema-per-tenant; as apps MySQL tiram-nos do
`schema.mysql.prisma`). Depois corre `normalizeAuthUserEmails(prisma, { dryRun: true })`,
de novo sem `dryRun`, e junta os `conflicts` reportados — até lá esses e-mails
lançam `AUTH_EMAIL_AMBIGUOUS`. O `@basaltkit/auth-sqlite` cria as tabelas no
`migrate()`. Configura um store durável de `accountLinks`: os utilizadores
existentes ficam ligados no próximo login pelo e-mail verificado.

**Políticas RLS.** O `rlsPolicySql` e o `rlsSearchFunctionSql` passam a comparar
com `NULLIF(current_setting(…, true), '')`. Volta a correr o SQL gerado — ambos
são idempotentes — numa migração nova.

**Os mais pequenos.** As subscrições Paddle e Lemon Squeezy criadas pelo
`subscribe()` guardam um id de checkout como `gatewayRef`: limpa-o ou define o id
`sub_…` real. Os documentos do Elasticsearch indexados um a um com caracteres
especiais de URL no tenant ou no id precisam de um
`reindex(name, { all: true })`. As atribuições guardadas com um segmento de
permissão vazio nunca concederam nada e podem ser apagadas.

### O Express e o Hono mudam o que o cliente recebe

No **Express**: devolve HTML com um `content-type` explícito; envia JSON com um
media type JSON; um corpo JSON vazio passa a ser `undefined`, por isso define-lhe
um valor por omissão no schema (`z.object({…}).default({})`); o routing distingue
maiúsculas e é estrito, e o parser de query é o `simple` — passa a tua própria
`app` se dependias do comportamento antigo. No **Hono**: lê uma chave de query
repetida como `string | string[]`; o `request.url` é o caminho e a query string,
por isso constrói um URL absoluto com `new URL(request.url, base)`; um corpo JSON
malformado é um 400 antes do handler; passa `errorHandler: false` se instalas o
teu próprio `onError`.

### Stores, drivers e gateways custom implementam mais

Um `PasskeyStore` custom tem de implementar `compareAndSetCounter` (o serviço
recusa arrancar sem ele). Um `BillingGateway` custom implementa
`resumeSubscription` ou o `resume()` lança, e o
`CouponStore.incrementRedemptions` recebe um `limit` e pode devolver `null`.
Opcionais, mas valem a pena: `SearchDriver.clearTenant` (reconstruções por
tenant), `AuditStore.auditTenants`, `DomainStore.replace` / `listVerified`, e
`replayKey` num adapter de drive custom. Os clientes Prisma escritos à mão e os
fakes de teste precisam de `$transaction` (`tenancy-prisma`) e de `create` /
`updateMany` (`webhooks-prisma`, `auth-prisma`); um `PrismaClient` gerado já os
tem.

### Os limites de coluna do MySQL são opt-in

Nada muda em PostgreSQL nem em SQLite, nem em MySQL até o pedires. Para o adoptar,
deixa o `basalt prisma:sync` copiar as variantes `schema.mysql.prisma`, migra, e
passa `columnLimits: 'mysql'` às factories dos stores. O
[guia de MySQL](/pt/guide/persistence#mysql) tem os detalhes.

### O que a colheita muda

Estes são os passos para as versões de [Fechar a colheita da
auditoria](#fechar-a-colheita-da-auditoria). Vindo da 1.11, aplica-os por cima
de tudo o que está acima: as linhas de `permissions` 3, `storage` 4, `files` 5,
`audit` 2, `webhooks` 3 e `mcp` 4 continuam a valer para o major seguinte.
Nenhum destes passos precisa de migração de dados, a menos que adoptes um store
ou uma coluna novos.

**`permissions` 4 — o `hasRole()` é pertença.** O `gate.hasRole(user, role)` já
não devolve `true` para todos os roles a um super admin; o `can()`, o
`authorize()` e o `meta.can` continuam a respeitar o bypass. Onde o `hasRole()`
servia de verificação de autorização, verifica antes a permissão, ou pede o
bypass explicitamente:

```ts
if ((await gate.isSuperAdmin(user)) || (await gate.hasRole(user, 'billing-manager'))) { … }
```

O `GET /me/access` mantém `roles` e `permissions` — os clientes passam a ver mais
entradas, e correctas: roles e atribuições globais, atribuições temporárias e
delegações em vigor, `'*'` para um super admin — e acrescenta `superAdmin` e
`grants` (cada permissão com a sua `source`). Os stores duráveis de atribuições
temporárias e delegações são opt-in: com o `permissions-prisma`, ligá-los
significa acrescentar `PermTemporaryGrant` e `PermDelegation`
(`basalt prisma:sync`) e migrar; o `permissions-sqlite` cria as tabelas no
`migrate()`.

**`audit` 3 — hashes v2.** As entradas novas usam o formato v2; as entradas v1
existentes continuam a verificar e as novas encadeiam-se nelas, por isso não há
nada a migrar. Mas:

- **Não voltes atrás** para um `@basaltkit/audit` anterior depois de escrever
  entradas v2 — não as consegue verificar.
- O código que assumia um `hash` de 64 caracteres hex (uma coluna, uma regex, o
  `--expected-head`) tem de aceitar até 144 caracteres; os stores incluídos e o
  preset de MySQL cabem.
- Ferramentas que recalculam hashes: o `computeAuditHash()` continua a calcular
  a v1 — usa o `computeAuditHashV2()` ou o `checkAuditHash(entry, keysById)`.
- Um `switch` exaustivo sobre `AuditVerifyFailure` precisa de um caso
  `'unknown-key'`.
- Para rodar a chave: `integrity: { mode: 'hash-chain', key: NEW, keyId:
  '2026-09', verifyKeys: [OLD] }`.

**`webhooks` 4 — portas, fan-out e concorrência.** Um endpoint numa porta
bloqueada é recusado no `register()` e na entrega: permite-o com
`ssrf: { allowedPorts: […] }` (ou `'any'`). Um dispatch para mais de 100
endpoints correspondentes num scope é recusado — sobe o
`maxEndpointsPerDispatch`. Correm no máximo 16 entregas em simultâneo
(`dispatchConcurrency`). Para usar o `rotateSecret()`, quem usa Prisma
acrescenta `previousSecret` / `previousSecretExpiresAt` (`basalt prisma:sync`) e
migra primeiro; o `webhooks-sqlite` acrescenta as colunas no `migrate()`; um
store custom tem de persistir os dois campos e limpá-los quando o `add()` os
recebe como `undefined`. O `@basaltkit/drives` fica com a mesma política de
portas em cada salto.

**`storage` 5 — chaves relativas e tamanhos exactos.** O `Disk.list()` devolve
chaves relativas ao scope do disco: retira o código que cortava `tenants/<id>/`
à mão, e lista uma directoria real em vez de contar com um prefixo de nome
parcial num driver de cloud. Um `contentLength` que não seja um inteiro seguro
não negativo é um `400 STORAGE_CONTENT_LENGTH_INVALID`; um corpo que não
corresponda a ele é um `400 STORAGE_CONTENT_LENGTH_MISMATCH` e não grava nada.
Os drivers custom não precisam de mudar.

**`files` 6 — a forma das rotas.** O `GET /files`, o `GET /files/:id` e o
`POST /files` enviam `toPublicFile(record)`: sem `path`, `checksum`,
`tenantId`, `uploadedBy` nem o detalhe do scan. Um cliente que lia algum deles
precisa de um `present`:

```ts
fileRoutes({ present: (file) => ({ ...toPublicFile(file), uploadedBy: file.uploadedBy }) })
```

O `files.get()` / `list()` e os hooks `file:*` continuam a devolver o registo
completo. O `upload({ contentLength })` passa a ser verificado
(`413 FILE_TOO_LARGE` logo à partida, `400` numa discrepância) — nunca passes o
`Content-Length` do próprio pedido multipart.

**`mcp` 5 — detalhes redigidos, erros reportados.** Um valor sob uma chave com
nome de segredo nos `details` de um erro lançado chega ao modelo como
`'[REDACTED]'`: move os dados só para operadores para `internalDetails`, ou
passa `redactErrorDetails: false` (ou o teu próprio redactor). Os erros das
chamadas de tool chegam agora ao `reportError` — a consola por omissão;
`reportError: false` repõe o silêncio.

**`tenancy` 3.1 — códigos de estado.** Um tenant `suspended` responde um
`403 TENANT_SUSPENDED` sem retry em vez de `503`; um estado que o tenancy não
conhece (como `active`) é `500 TENANT_STATUS_UNKNOWN`. Guarda `ready`, ou nenhum
estado, para um tenant em serviço.

**`auth` 4.1 — MFA e os limites.** Um primeiro passo sem código numa conta com
MFA gasta agora uma vaga do limite de login, como uma password errada;
dimensiona o `ipLoginThrottle` para populações grandes atrás de NAT partilhado.

**`ai-mcp` 0.3 — só em desenvolvimento, imposto.** Recusa
`NODE_ENV=production` (`--allow-production`, `allowProduction: true` ou
`BASALT_AI_MCP_ALLOW_PRODUCTION=1` para contornar), e o `basalt_analyze`, o
`basalt_doctor` e o `basalt_plan` recusam um `workspaceRoot` fora da raiz do
projecto.

---

## Anteriormente — Basalt 1.11

> *A versão que **falha fechado**: bugs de composição de uma segunda auditoria de
> segurança, catorze majors que tornam o comportamento seguro a predefinição,
> streaming em todos os adapters, um trilho de auditoria verificável, e dois pacotes
> novos — backup e drives.*

::: warning Catorze pacotes publicam um major
Esta vaga muda predefinições de segurança. `auth` 3, `auth-saml` 2, `env` 3,
`permissions` 2, `prisma` 2, `tenancy` 2, `storage` 3, `files` 4, `comments` 3,
`audit-viewer` 3, `webhooks` 2, `subscriptions` 4, `teams` 3 e `mcp` 3 partem
cada um algo que funcionava *porque* funcionava sem ninguém ter pedido. A regra
para todos: uma app a funcionar parte sem alteração de código, configuração ou
dados. Ver [Atualizar para 1.11](#atualizar-para-1-11) — a maioria das edições é uma opção, duas
precisam de migração de dados.
:::

O Basalt 1.11 é a versão que **falha fechado**. Aconteceram duas coisas no mesmo
mês. Uma segunda auditoria profunda de segurança — catorze auditores, oitenta e
sete achados distintos, um crítico — percorreu o framework à procura não de bugs
nos pacotes mas de bugs *entre* eles: uma API key válida em todos os tenants
porque as chaves e a tenancy nunca tinham sido apresentadas; uma operação Prisma
que a extensão de tenant não conhecia e por isso não delimitava; um endpoint de
webhook assinado com o segredo global do plugin porque ninguém tinha dito a que
tenant pertencia. E duas aplicações continuaram a construir sobre o framework —
um SaaS de gestão documental e um SaaS de logística — e mantiveram a lista de
todos os sítios em que o framework as fez escrever o que devia ter escrito:
streaming, erros estruturados, um trilho de auditoria verificável, roles para
todos os tenants, uma forma de encontrar trabalho preso sob row-level security.

Setenta e sete dos achados estão corrigidos com testes de regressão, e vinte e
oito itens da lista das aplicações estão fechados. O tema que partilham é a
predefinição. Onde o 1.10 fornecia a metade que faltava, o 1.11 muda o que
acontece quando uma metade falta: um disco sem tenant recusa em vez de escrever
na raiz do bucket; uma query raw dentro de um tenant recusa em vez de ver tudo;
um `NODE_ENV` por definir conta como produção em vez de desenvolvimento. Nada
nesta lista é uma capacidade nova. Cada uma é uma capacidade que era opt-in a
tornar-se aquilo de que é preciso fazer opt *out*.

### Bugs de composição que a auditoria encontrou
- **As API keys ficam ligadas ao seu tenant.** Uma chave emitida dentro de um
  tenant é recusada em qualquer pedido que resolva outro tenant, ou nenhum
  (`403 AUTH_APIKEY_TENANT_MISMATCH`); uma chave emitida sem tenant é recusada em
  pedidos de tenant salvo com `allowTenantlessKeys`. Foi o único achado crítico:
  chaves e tenancy funcionavam cada uma, e juntas uma chave era válida em todo o
  lado. Os scopes passam também a ser um tecto — uma chave sem `*` não age como
  o dono em rotas sem `meta.scopes`, e `meta.apiKey: false` torna uma rota só de
  sessão. *(`@basaltkit/auth` 3.0)*
- **A extensão de tenant do Prisma recusa o que não consegue delimitar.**
  Operações raw ao nível do cliente, leituras raw do MongoDB e
  `updateManyAndReturn` dentro de um tenant são recusadas
  (`PRISMA_RAW_IN_TENANT`, `PRISMA_UNSCOPED_OPERATION`); escritas aninhadas em
  relações ficam restritas ao tenant e dados de update que mudem o campo do
  tenant lançam `PRISMA_CROSS_TENANT_WRITE`. O `tenantSchema()` é injectivo, por
  isso dois ids já não partilham um schema. *(`@basaltkit/prisma` 2.0)*
- **Storage, cache e realtime falham fechado sem tenant.** Um disco no scope por
  omissão, com tenancy activa, recusa uma escrita sem tenant
  (`STORAGE_TENANT_REQUIRED`) em vez de recuar para a raiz do bucket; os discos
  centrais dizem `scope: null`. Os URLs temporários ficam limitados a sete dias.
  Um id de tenant com `:` não consegue endereçar as chaves de cache nem os canais
  de outro tenant, porque o id passa a ser validado
  (`/^[a-z0-9][a-z0-9_-]{0,62}$/`, `global` reservado) antes de se escrever seja
  o que for. *(`@basaltkit/tenancy` 2.0, `storage` 3.0, `cache` 2.0.1, `realtime` 1.4.1)*
- **O scope global de permissões não pode ser um tenant.** `GLOBAL_SCOPE` é
  `'@global'`, um valor que nenhum id de tenant pode ter; o Gate recusa avaliar
  um tenant cujo id seja um scope reservado. As linhas escritas sob o antigo
  `'global'` precisam de uma migração de uma linha. *(`@basaltkit/permissions` 2.0)*
- **Os webhooks de tenant têm o seu próprio segredo.** Um endpoint de tenant
  nunca é assinado com o segredo global do plugin e as entregas nunca saem sem
  assinatura por omissão; um dispatch sem tenant só chega a endpoints
  agnósticos de tenant. O guard de SSRF classifica IPv6 pelos bytes, por isso
  endereços privados mapeados e traduzidos são recusados também.
  *(`@basaltkit/webhooks` 2.0)*
- **Autorização ao nível do objecto em ficheiros, comentários e visualizador de
  auditoria.** O `fileRoutes()` é só-dono salvo indicação; o
  `auditViewerRoutes()` recusa arrancar sem guard; um argumento `tenantId`
  explícito dentro de um contexto de tenant tem de coincidir com ele.
  *(`@basaltkit/files` 4.0, `comments` 3.0, `audit-viewer` 3.0, `search` 1.6)*
- **Convites, facturação, SSO e MCP fecham as suas portas.** Aceitar um convite
  de equipa exige e-mail verificado e um token inscreve uma conta; um driver de
  facturação com `webhookSecret` vazio lança em vez de aceitar um HMAC vazio, e
  os redirects do checkout ficam restritos a origens conhecidas; cada provider
  SAML fica restrito aos domínios de e-mail que pode afirmar; um servidor MCP
  lançado herda uma allow-list de variáveis de ambiente, não o `APP_SECRET`.
  *(`@basaltkit/teams` 3.0, `subscriptions` 4.0, `auth-saml` 2.0, `mcp` 3.0)*
- **Um `NODE_ENV` por definir é produção.** O `secret()` aplica o `devDefault`
  só quando `NODE_ENV` é explicitamente `development` ou `test`, por isso um
  deploy que se esqueça da variável já não arranca com o segredo público de
  desenvolvimento. As apps novas recebem também `teamsPlugin()` +
  `tenantMembershipPlugin()` por omissão, e o `make:resource` gera código
  autenticado e pertencente ao tenant, com um teste que o prova.
  *(`@basaltkit/env` 3.0, `create-basalt` 1.5, `generator` 1.4)*

### O que duas aplicações fizeram o framework escrever
- **Streaming, nos dois sentidos, em todos os adapters.** `disk.putStream` /
  `getStream` / `copy` / `stat` em S3, Azure e GCS, com `maxBytes` aplicado
  enquanto os bytes chegam; multipart no S3 para streams de tamanho desconhecido
  como capacidade opcional; `route({ body: upload({ maxBytes, maxFiles, allowedTypes }) })`
  para multipart em Fastify, Express e Hono por igual; e um handler que devolve
  `stream(source, { contentType, filename })` — a backpressure é real, um
  cliente que desliga destrói a fonte, e o `GET /files/:id/content` usa-o.
  *(`@basaltkit/storage` 3.2, `storage-s3` 1.3, `http` 2.2 e 2.4, `files` 4.1–4.3)*
- **`rawBody()` — os octetos que foram mesmo enviados.** Todos os providers de
  webhooks assinam os bytes que enviaram, e todos os adapters faziam parse do
  JSON antes de um handler os ver; o `JSON.stringify` do objecto parseado não são
  esses bytes. As apps a verificar assinaturas do Stripe, Paddle ou Lemon
  Squeezy podiam estar a falhar todas as entregas genuínas. Uma rota `rawBody()`
  deixa o corpo por ler até depois dos guards, e recusa (`RAW_BODY_UNAVAILABLE`)
  em vez de reconstruir. *(`@basaltkit/http` 2.5, `fastify` 2.4, `express` 1.9,
  `hono` 1.9, `subscriptions` 4.0.1)*
- **Os erros levam dados.** `new HttpError(status, code, message, { details })`
  e `BasaltError` expõem `error.details`, limitado e sanitizado pelo serializer,
  para uma UI deixar de extrair "Checks failed: A, B" de uma mensagem.
  `BasaltClientError.errorDetails` lê-o de volta. *(`@basaltkit/core` 1.4,
  `http` 2.3, `sdk` 2.1)*
- **Um trilho de auditoria verificável.** `integrity: 'hash-chain'` dá a cada
  entrada uma sequência e um hash sobre a anterior; `audit.verify()` detecta
  linhas editadas, apagadas, reordenadas e forjadas; `requestContext: true`
  regista IP e user-agent através do redactor. *(`@basaltkit/audit` 1.6,
  `audit-prisma` / `audit-sqlite` 1.2)*
- **MFA por política, throttles entre réplicas.** `authPlugin({ requireMfa })`
  recusa credenciais obtidas sem segundo factor; os tokens levam `amr`; um
  `ThrottleStore` (memória ou Redis) suporta os throttles de login e de e-mail
  entre instâncias; o logout termina uma sessão de cookie com corpo vazio; as
  rotas de auth levam `meta.account`, que o guard de membership respeita.
  *(`@basaltkit/auth` 3.1, `teams` 3.0.1)*
- **Row-level security, aplicada e varrida.** `tenancyExtension({ rls: true })`
  define o tenant na ligação antes de cada operação, para as políticas do
  Postgres filtrarem também; `prismaPlugin({ assertMigrated })` recusa arrancar
  contra a base errada; `crossTenantScan` / `crossTenantSweep` dão a um
  reconciliador uma forma auditada de encontrar trabalho preso em todos os
  tenants e tratar cada linha dentro do contexto do seu tenant; e o índice GIN
  sobrevive à pesquisa full-text sob RLS. *(`@basaltkit/prisma` 2.1–2.3,
  `search-postgres` 1.1, `scheduler` 1.5, `events` 1.3)*
- **Roles para todos os tenants, uma vez.** O `roleCatalog` no Gate é um mapa
  role → permissões definido em código e válido em todos os scopes, por isso um
  catálogo já não tem de ser copiado para cada tenant; o `teams.members()` e a
  fonte de utilizadores conseguem nomear toda a gente com um role sem tocar nas
  tabelas de auth. *(`@basaltkit/permissions` 2.1, `auth` 3.2, `teams` 3.1)*
- **Uploads directos pré-assinados**, com Content-Type, tamanho e SHA-256
  ligados à assinatura no S3 (e o subconjunto honesto no Azure e GCS), mais a
  correcção do `s3Disk` que deixava cair todas as opções do disco excepto
  `scope`. *(`@basaltkit/storage` 3.1)*
- **Os ficheiros sabem o que são.** `validate.sniff` lê o tipo real dos magic
  bytes; `requireScan` põe um ficheiro em quarentena até um scanner o libertar
  (`423 FILE_NOT_SCANNED`). *(`@basaltkit/files` 4.1)*
- **Prefixos de env por app.** `defineEnv(shape, { prefix: 'MY_SAAS' })` lê
  primeiro `MY_SAAS_DATABASE_URL`, por isso `node --env-file` já não arranca uma
  app contra a base exportada de outro projecto. Os scaffolds ligam-no.
  *(`@basaltkit/env` 3.1, `create-basalt` 1.7)*
- **Código gerado que compila.** O `make:service` sozinho já não importa um
  repositório que nunca criou; todos os `make:<kind>` nomeiam os irmãos que
  ainda faltam. O `create-basalt` pergunta ao registry a versão mais recente de
  cada dependência, e `--prisma` gera uma app com PostgreSQL.
  *(`@basaltkit/generator` 1.5, `create-basalt` 1.5–1.8)*

### Dois pacotes estreiam
- **`@basaltkit/backup`** — backups PostgreSQL como serviço: dumps em formato
  custom transmitidos para qualquer disco Basalt, manifestos com checksums,
  retenção, restauro com verificação de integridade, alvos por schema e por base
  de tenant, integração com o scheduler e a CLI. As passwords chegam ao
  `pg_dump` pelo ambiente, nunca pela linha de comandos. *(0.3.0)*
- **`@basaltkit/drives`** — ligar o armazenamento externo de ficheiros de um
  tenant e mantê-lo sincronizado: fluxo de ligação OAuth, listagem, feeds de
  alterações com reset de cursor, download e upload em streaming, notificações
  assinadas num endpoint neutro testado em paridade nos três adapters. Três
  adapters saem com ele: **`drives-dropbox`**, **`drives-google`** e
  **`drives-microsoft`** (OneDrive / SharePoint). A auditoria de fase 2 dos
  adapters encontrou uma fuga de credenciais e um bug silencioso de perda de
  dados antes de mais alguém. *(0.2.0 / 0.1.0)*

### Docs
- **[O padrão multi-tenant](/pt/guide/multi-tenant-pattern)** — a forma canónica
  de construir um SaaS schema-per-tenant em Basalt, escrita como dez regras
  verificáveis depois de auditar três apps de produção, com as cadeias de
  privilégio que cada uma delas realmente entregou. A dica de base partilhada,
  o troubleshooting de tenancy e o cookbook foram corrigidos onde a contradiziam.
- Guias de [backups](/pt/guide/backup) e [drives externos](/pt/guide/drives).

### Atualizar para 1.11

Os pacotes são independentes — sobe só o que usas. Cada major abaixo tem um
opt-out explícito ao lado; prefere corrigir a app.

#### Predefinições que passam a recusar

| Pacote | O que recusa | Opt-out / correcção |
| --- | --- | --- |
| `auth` 3 | API keys fora do seu tenant; chaves estreitas em rotas sem scope; escritas cross-site só com cookie (`AUTH_CSRF_REJECTED`); login social com e-mail não verificado; OAuth sem binding ao browser | `apiKeysPlugin({ allowTenantlessKeys, allowNarrowKeysOnUnscopedRoutes })`, `authPlugin({ csrf: { trustedOrigins } })`, `socialLogin({ mfa: 'skip' })`, usar `OAuth.authorize()` |
| `env` 3 | `devDefault` com `NODE_ENV` por definir | define `NODE_ENV=development` onde era essa a intenção |
| `tenancy` 2 | ids fora da gramática; `tenantScoped()` sem tenant em contexto | renomear ids; `requireTenantId(id)` / `tenancy.run(id, …)` em código de sistema |
| `prisma` 2 | operações raw e escritas cross-tenant dentro de um tenant; nomes de schema não canónicos | `setTenantConfigSql` é a única instrução raw permitida; renomear schemas uma vez (README) |
| `storage` 3 | acesso sem tenant num disco com scope de tenant; URLs temporários acima de 7 dias | `scope: null` nos discos centrais; `maxTemporaryUrlTtl` |
| `permissions` 2 | avaliar um tenant com nome de scope | migrar as linhas `'global'` (abaixo) |
| `files` 4 / `comments` 3 / `audit-viewer` 3 | acesso a ficheiros de outro dono; visualizador de auditoria sem guard; um `tenantId` diferente do contexto | `fileRoutes({ authorize, shared })`, `auditViewerRoutes({ meta: { can } })` |
| `webhooks` 2 | entregas de tenant sem assinatura ou com segredo partilhado; register/list sem tenant | `allowUnsigned`, `allowSharedSecret`, `{ system: true }` |
| `subscriptions` 4 | `webhookSecret` vazio; URLs de redirect fora das origens configuradas | definir o segredo; `allowedRedirectOrigins` |
| `teams` 3 | aceitar convite sem e-mail verificado; atribuir roles acima do teu | `teamRoutes({ requireVerifiedEmail: false })`, `grantableRoles` |
| `auth-saml` 2 | asserções de outros domínios; respostas iniciadas pelo IdP; node-saml < 5.1 | `allowedEmailDomains`, `validateInResponseTo: 'ifPresent'` |
| `mcp` 3 | `process.env` completo para servidores lançados | allow-list `env` no cliente |

#### Duas migrações de dados

**Permissões.** As atribuições escritas sob o scope global anterior à 2.0
deixam de ser lidas. Renomeia-as uma vez:

```sql
UPDATE perm_user_roles       SET scope = '@global' WHERE scope = 'global';
UPDATE perm_user_permissions SET scope = '@global' WHERE scope = 'global';
UPDATE perm_role_permissions SET scope = '@global' WHERE scope = 'global';
```

`readLegacyGlobalScope: true` no Gate continua a ler as linhas antigas enquanto
a migração é agendada — uma ajuda de transição, não uma definição para manter.

**Nomes de schema do Prisma.** O `tenantSchema()` passa a acrescentar um sufixo
a qualquer id que não seja canónico (`acme`, `acme_co` mantêm o nome; `Acme Co`
passa a `tenant_acme_co__<hash>`). Os tenants com ids não canónicos têm um
schema com o nome antigo e têm de ser renomeados uma vez — o README do
`@basaltkit/prisma` tem a instrução. Os ids canónicos não são afectados.

#### Colunas que se acrescentam, nunca se exigem

O `@basaltkit/audit-prisma` 1.2 acrescenta `ip`, `userAgent`, `chain`, `seq`,
`prevHash`, `hash` (todas nullable) e um único `(chain, seq)`; só se escrevem
quando `integrity` ou `requestContext` está ligado. O `@basaltkit/events-prisma`
1.2 acrescenta `lockedUntil` / `lockedBy` para o claim da outbox entre réplicas
(`claim: true`). Corre `basalt prisma:sync` e uma migração; os stores SQLite
acrescentam as colunas sozinhos.

#### `GLOBAL_SCOPE` é uma constante, não uma string

Se algum código escreve `'global'` — um script de seed, um comando da CLI, um
teste — passa a atribuir para um scope que ninguém lê. Importa `GLOBAL_SCOPE`
de `@basaltkit/permissions`. O
[padrão multi-tenant](/pt/guide/multi-tenant-pattern#regra-7-—-um-sistema-de-permissoes-com-scope-por-plano)
tem a forma.

#### `sharp` e `nodemailer`

O `@basaltkit/image-sharp` 1.1.4 exige um `sharp` corrigido (vulnerabilidades
do libheif); o `@basaltkit/mailer-smtp` 1.0.1 aceita nodemailer 9 e 10.

---

## Anteriormente — Basalt 1.10

> *A versão das **metades que faltavam**: um tenant que pode ser destruído, um
> índice que pode ser reconstruído, um store durável para ficheiros, revisões
> para documentos, e permissões que sabem quem pergunta.*

::: warning Dois contratos mudaram
O `@basaltkit/files` revê o contrato do seu store, e o `app.server` do
`@basaltkit/testing` passa a ser esperado com `await`. As duas edições são
mecânicas — ver [Atualizar para 1.10](#atualizar-para-1-10). As apps Prisma que usam API keys
precisam também de uma coluna nova.
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

### Atualizar para 1.10

Os pacotes são independentes — sobe só o que usas. Dois contratos mudaram, e as
duas edições são mecânicas.

#### O `app.server` passa a ser esperado

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

#### O contrato do store de ficheiros tem três revisões

O `@basaltkit/files` publica um major. Um `FileStore` próprio precisa de três
edições:

| Era | É | Porquê |
| --- | --- | --- |
| `scanned?: boolean` | `scannedAt?: number` | A data deriva o booleano e o booleano não deriva a data. "Analisado", sem saber quando, deixa de ser resposta no momento em que as regras do scanner mudam — a única coisa que as regras de antivírus fazem de forma fiável. O hook `file:scanned` mantém o nome: o evento não é o campo |
| `metadata?: Record<string, unknown>` | `metadata?: FileMetadata` | `Record<string, JsonValue>` — de outra forma cada store durável faz um cast para passar pelo tipo JSON do seu driver, um cast que cada implementação repete e tem de acertar |
| `FilePatch = Partial<Pick<…>>` | escrito por extenso | Para poder dizer que uma chave presente com `undefined` **limpa** a coluna enquanto uma chave ausente a deixa em paz — o que o `Partial` de um campo opcional não consegue exprimir sob `exactOptionalPropertyTypes`, e que é como quem chama descarta um resultado de análise velho |

O `prisma:sync` aprende o domínio dos ficheiros, por isso os seus modelos juntam-se
como os de todos os outros.

#### As apps Prisma acrescentam uma coluna para a expiração das API keys

O `@basaltkit/auth-prisma` 1.5.0 acrescentou uma coluna `expiresAt` anulável ao
`AuthApiKey` (`auth_api_keys`) para a nova expiração opcional das chaves.
Regenerar o client não chega — a base de dados precisa da coluna, ou todos os
pedidos com API key falham. Acrescenta uma migração
(`prisma migrate dev --name add_api_key_expires_at`), que em PostgreSQL é:

```sql
ALTER TABLE "auth_api_keys" ADD COLUMN "expiresAt" TIMESTAMP(3);
```

Com schema-per-tenant a coluna tem de existir em **todos** os schemas de tenant:
acrescenta a migração às tuas migrações de tenant e depois corre
`basalt tenant:migrate`. Uma suite de testes que nunca emite uma API key não dá
por nada. Desde o `auth-prisma` 1.5.1 uma coluna em falta lança
`AUTH_API_KEY_SCHEMA_OUTDATED` com estas instruções em vez de um `P2022` cru do
Prisma. O `@basaltkit/auth-sqlite` não precisa de nada: acrescenta a coluna
sozinho quando a base de dados é aberta.

#### Dois pacotes estreiam em 0.1.0

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
