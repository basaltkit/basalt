# Referência do `deploy.config.ts`

Todas as opções do `deploy.config.ts`, o ficheiro que o `@basaltkit/deploy` lê
em cada `plan` e `run`. Fica na raiz da aplicação, vai para o repositório e
**não guarda segredos**: os segredos vivem no `.env` do servidor, que o deploy
escreve e mantém.

O `basalt-deploy init --domain=<host>` escreve uma primeira versão a partir do
projeto. O `basalt-deploy check` valida-o sem servidor. Para o fluxo completo,
de um servidor novo aos deploys do dia a dia, vê
[Fazer deploy para um servidor](/pt/guide/deploy).

[[toc]]

## Um exemplo completo {#example}

```ts
import type { env } from './src/env.js'   // só o tipo: a aplicação nunca é carregada
import { apache, ask, defineDeploy, dockerInfra, pm2, secret } from '@basaltkit/deploy'

export default defineDeploy<typeof env>({
  app: 'acme',
  domain: 'acme.example.com',
  tenants: 'subdomain',
  branch: 'main',
  env: {
    schema: 'src/env.ts',
    fixed: { NODE_ENV: 'production', HOST: '127.0.0.1' },
    generate: { APP_SECRET: secret(32) },
    ask: {
      SMTP_URL: ask.secret('SMTP URL', { optional: true }),
      PAYCO_SECRET_TOKEN: ask.secret('PayCo token'),
    },
    derive: ({ domain }) => ({ PAYCO_CALLBACK_URL: `https://${domain}/api/webhooks/payco` }),
    forbid: ['PAYCO_FAKE'],
  },
  infra: dockerInfra('acme', {
    postgres: { urlParams: { schema: 'public' } },
    seaweedfs: { buckets: ['acme-documents'] },
  }),
  build: { prisma: ['prisma.config.ts'], script: 'build', web: 'web' },
  migrate: { central: true, tenants: true },
  backup: { keep: 10 },
  runtime: pm2({ avoid: [3000] }),
  proxy: apache(),
  health: { path: '/health', timeoutSeconds: 60 },
})
```

## `defineDeploy` e chaves tipadas {#define-deploy}

O `defineDeploy(config)` devolve o config sem o alterar. Existe por causa dos
tipos. Passa-lhe o tipo do teu `defineEnv(...)`, e cada chave do `.env` que o
config nomeia passa a ser completada e verificada pelo editor e pelo
`basalt-deploy check`:

- **Chaves verificadas:** `env.fixed`, `generate`, `ask`, `derive`, `migrate.env`, `backup.urlKey`, e os `urlKey` e `keys` da infra.
- **Valores tipados pelo schema:** um `z.enum` completa os seus membros, um número aceita dígitos, um booleano aceita `'true' | 'false'`.

```ts
export default defineDeploy<typeof env>({
  env: { fixed: { NODE_ENV: 'prod' } },  // ✗ não é "development" | "production" | "test"
  backup: { urlKey: 'DATABSE_URL' },      // ✗ Did you mean "DATABASE_URL"?
  // …
})
```

Sem o argumento de tipo, cada chave é uma string qualquer.

## Opções de topo {#top-level}

| Opção | Obrigatória | Por omissão | O que é |
|---|---|---|---|
| [`app`](#app) | sim | — | O rótulo que dá nome a tudo o que o deploy gere |
| [`domain`](#domain) | sim | — | O host onde a aplicação responde |
| [`tenants`](#tenants) | | `'none'` | `'subdomain'` quando os tenants vivem em `<id>.<domain>` |
| [`branch`](#branch) | | `'main'` | O branch que um deploy vai buscar |
| [`remote`](#branch) | | `'origin'` | O remote git de onde o vai buscar |
| [`env`](#env) | sim | — | O `.env`: onde fica e o que o deploy mantém nele |
| [`infra`](#infra) | | nenhuma | Postgres, Redis e armazenamento S3: `dockerInfra()` ou `external()` |
| [`build`](#build) | | nada é compilado | Clientes Prisma, o script de build da aplicação, o frontend |
| [`migrate`](#migrate) | | nada é migrado | Que migrações correm |
| [`backup`](#backup) | | dump ao migrar | O `pg_dump` antes de migrar |
| [`runtime`](#runtime) | sim | — | Como a aplicação corre: `pm2()` ou `compose()` |
| [`proxy`](#proxy) | | `none()` | O que fica à frente: `apache()`, `caddy()` ou `none()` |
| [`health`](#health) | | `/health`, 60 s | A verificação que decide se uma release fica no ar |
| [`verify`](#verify) | | nenhuma | Mais verificações depois do health check |
| [`hooks`](#hooks) | | nenhum | Comandos da própria aplicação em pontos fixos |
| [`destructive`](#destructive) | | `[]` | Migrações que impedem um rollback automático |
| [`system`](#system) | | nenhum | Pacotes apt de que a aplicação precisa no servidor |
| [`bootstrap`](#bootstrap) | | swap de 4 GB, firewall ligada | O que o `bootstrap` prepara num servidor novo |
| [`audit`](#audit) | | sem syslog | Registar também cada release no syslog |

## `app` {#app}

O rótulo do dono, no formato `[a-z][a-z0-9-]{1,30}`. Dá nome a cada processo,
contentor, volume, vhost e backup que o deploy cria: `acme-api` (pm2),
`acme-pg`, `acme-redis`, `acme-seaweedfs`, `acme.conf`.

O deploy só mexe no que tem este rótulo: um nome de processo pm2, uma tag de
imagem do compose ou um ficheiro de vhost fora dele é um erro de configuração.

## `domain` {#domain}

O host, em minúsculas, onde a aplicação responde, por exemplo
`acme.example.com`. O deploy usa-o para:

- verificar o DNS e o certificado;
- escrever o vhost;
- fazer o health check público;
- preencher o [`env.derive`](#env-derive).

## `tenants` {#tenants}

- `'none'` (por omissão): um só host.
- `'subdomain'`: os tenants vivem em `<id>.<domain>`. O certificado wildcard e
  o DNS wildcard (`*.<domain>`) também são verificados.

Atrás do [`caddy()`](#caddy), `'subdomain'` exige `onDemandTls`.

## `branch` e `remote` {#branch}

O `branch` (por omissão `'main'`) é o branch que um deploy vai buscar ao
`remote` (por omissão `'origin'`) e para onde avança em fast-forward. Um nome de
branch nunca começa por `-` e só tem letras, dígitos e `. _ / + -`. Um remote é
o nome de um remote, nunca um URL.

## `env` {#env}

O `.env` com que a aplicação corre. Só o próprio `env` é obrigatório; todas as opções dentro dele são opcionais.

| Opção | Por omissão | O que faz |
|---|---|---|
| `file` | `'.env'` | Onde fica o ficheiro: relativo à pasta da aplicação, ou absoluto diretamente em `/etc/<app>/`. É escrito com `0600` e copiado antes de cada alteração. |
| `mirror` | `[]` | Cópias exatas do ficheiro, reescritas com ele. Uma cópia diferente é um erro (C10). |
| `schema` | — | O módulo que corre o `defineEnv(...)` da aplicação, por exemplo `'src/env.ts'`. O novo `.env` é validado contra ele antes de migrar. |
| `fixed` | `{}` | Sempre estes valores; um valor diferente no ficheiro é corrigido. |
| `generate` | `{}` | Gerados uma vez quando faltam, depois mantidos: `secret(bytes)`. |
| `ask` | `{}` | Perguntados uma vez quando faltam ou estão vazios, depois mantidos: `ask.secret()` ou `ask.text()`. |
| `derive` | — | Uma função que calcula valores a partir do deploy, em cada execução. |
| `forbid` | `[]` | Chaves que não podem existir no ficheiro. Uma chave não pode ser proibida e definida ao mesmo tempo. |

### `secret(bytes)` {#secret}

O `secret(32)` escreve 32 bytes aleatórios em hexadecimal (64 caracteres). Por
omissão são 32. O valor só é gerado quando a chave falta, por isso um segredo
rodado nunca é sobrescrito.

```ts
generate: { APP_SECRET: secret(), BI_HASH_KEY: secret(48) }
```

### `ask.secret()` e `ask.text()` {#ask}

As perguntas que o `run` (ou o [formulário do `.env` da interface](/pt/guide/deploy#env-form))
faz quando uma chave falta ou está vazia. A resposta fica guardada.

| Função | Opções | A resposta |
|---|---|---|
| `ask.secret(prompt, { optional })` | `optional` (por omissão `false`) | Escondida enquanto é escrita |
| `ask.text(prompt, { optional, default })` | `optional`, `default` | Visível; o `default` é sugerido |

Com `optional: true` a resposta pode ficar vazia: a aplicação corre sem esse
valor (por exemplo, o correio vai para o log).

### `derive` {#env-derive}

```ts
derive: ({ app, domain, port }) => ({
  PUBLIC_URL: `https://${domain}`,
  PAYCO_CALLBACK_URL: `https://${domain}/api/webhooks/payco`,
}),
```

Recebe `{ app, domain, port }` (a porta já resolvida do runtime) e devolve
valores. São recalculados em cada execução, por isso uma mudança de domínio em
`/etc/basalt/<app>.json` chega até eles.

## `infra` {#infra}

Os serviços de que a aplicação precisa. Há dois tipos:

- **`dockerInfra(app, options)`:** o deploy cria e mantém contentores dedicados.
- **`external(services)`:** os contentores já existem; o deploy verifica-os e mantém o que está lá dentro.

### `dockerInfra(app, options)` {#docker-infra}

Contentores dedicados em `127.0.0.1`, só para esta aplicação, com nomes vindos
de `app`: `<app>-pg`, `<app>-redis`, `<app>-seaweedfs`. Num servidor que já tem
um contentor com esse nome, ele é adotado, não duplicado.

Os URLs de ligação são escritos no `.env`. Numa nova execução, uma password que
já existe é mantida.

| Opção | Por omissão | O que faz |
|---|---|---|
| `postgres` | ligado | Opções do Postgres (abaixo); `false` desliga-o |
| `redis` | ligado | Opções do Redis (abaixo); `false` desliga-o |
| `seaweedfs` | desligado | Armazenamento compatível com S3 (abaixo); ligado quando é passado |
| `project` | a aplicação | O projeto compose a que os contentores pertencem. Uma aplicação `compose()` precisa de outro, por exemplo `'acme-infra'`. |
| `access` | `'host'` | Quem usa os serviços através dos URLs do `.env`. Com `'host'`, um processo no host (pm2) recebe `127.0.0.1:<porta>`. Com `'containers'`, os contentores da aplicação recebem `<contentor>:<porta interna>`. |

**`postgres`**

| Opção | Por omissão | O que faz |
|---|---|---|
| `image` | `'postgres:16'` | A imagem |
| `port` | `'auto'` | Porta no host. `'auto'` mantém a do contentor em execução, senão a do URL no `.env`, senão a primeira livre a partir de 5433. |
| `user` / `database` | a aplicação | O dono e a base de dados |
| `urlKey` | `'DATABASE_URL'` | A chave do `.env` que recebe o URL |
| `urlParams` | `{}` | Acrescentados ao URL, por exemplo `{ schema: 'public' }` para o Prisma |
| `container` | `<app>-pg` | Adotar um contentor com outro nome |
| `appRole` | — | Um role sem DDL para a aplicação; vê [`appRole`](#app-role) |

**`redis`**

| Opção | Por omissão | O que faz |
|---|---|---|
| `image` | `'redis:7-alpine'` | A imagem |
| `port` | `'auto'` | Como no Postgres, a partir de 6380 |
| `urlKey` | `'REDIS_URL'` | A chave do `.env` que recebe o URL (com uma password gerada) |
| `container` | `<app>-redis` | Adotar um contentor com outro nome |

**`seaweedfs`**

Armazenamento de objetos compatível com S3 num só contentor. Só a API S3 é
publicada, em `127.0.0.1`.

| Opção | Por omissão | O que faz |
|---|---|---|
| `image` | `'chrislusf/seaweedfs:4.48'` | Fixa: uma atualização é uma decisão |
| `port` | `'auto'` | Como no Postgres, a partir de 8333 |
| `accessKey` | a aplicação | A access key que um armazenamento novo recebe |
| `buckets` | `[]` | Criados e mantidos; vê [Buckets](#buckets) |
| `keys` | `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` | As chaves do `.env` que recebem o endpoint e as credenciais |
| `container` | `<app>-seaweedfs` | Adotar um contentor com outro nome |

```ts
infra: dockerInfra('acme', {
  redis: false,
  postgres: { image: 'postgres:17', urlParams: { schema: 'public' } },
  seaweedfs: { buckets: ['acme-documents', { name: 'acme-backups', versioned: true }] },
}),
```

### `external(services)` {#external}

Contentores que este deploy não cria, porque os seus dados duram mais do que
qualquer release. Mesmo assim, o deploy:

- verifica que estão a correr, no preflight;
- mantém o role da aplicação na base de dados e os buckets em cada deploy;
- faz o dump da base de dados antes de migrar.

O `external()` sem serviços quer dizer "nada a fazer".

| Serviço | Opções |
|---|---|
| `postgres` | `container` (obrigatório); `urlKey` (por omissão `'DATABASE_URL'`): a chave com o URL do **dono**, usado para o role, os grants e o dump; `appRole` |
| `redis` | `container` |
| `s3` | `keys` (como no SeaweedFS); `buckets`; `hostEndpoint`: onde o deploy chega ao armazenamento quando o endpoint do `.env` só resolve dentro dos contentores, por exemplo `'http://127.0.0.1:8333'` |

```ts
infra: external({
  postgres: { container: 'globex-postgres', appRole: { name: 'globex_app', urlKey: 'APP_DATABASE_URL' } },
  s3: { buckets: ['globex-files'], hostEndpoint: 'http://127.0.0.1:8333' },
}),
```

### `appRole` {#app-role}

`{ name, urlKey }`: o role com que a aplicação se liga, sem DDL e sem
superuser. O deploy:

- cria o role quando falta;
- mantém a password dele igual à do URL em `urlKey`, e gera esse URL quando falta;
- dá-lhe DML através dos privilégios por omissão do dono.

As migrações continuam a correr como o dono. O `name` é um identificador
Postgres em minúsculas.

### Buckets {#buckets}

Um bucket é um nome (`'acme-documents'`) ou um objeto com uma política, aplicada
uma vez:

| Campo | O que faz |
|---|---|
| `name` | Um nome de bucket S3 válido (`[a-z0-9][a-z0-9.-]{2,62}`) |
| `versioned` | `true` liga o versionamento |
| `expireDays` | Acrescenta uma regra de expiração (um número inteiro ≥ 1) |

## `build` {#build}

| Opção | O que faz |
|---|---|
| `prisma` | Ficheiros de config do Prisma, cada um corrido com `prisma generate --config <ficheiro>` |
| `script` | O script do package.json que compila a aplicação, corrido depois do `prisma generate`. Uma aplicação create-basalt precisa de `'build'`, porque o `start` dela corre o `dist/`. |
| `web` | Uma pasta de frontend, compilada com `<pm> --dir <web> build` |

## `migrate` {#migrate}

| Opção | O que faz |
|---|---|
| `central` | `true`: `prisma migrate deploy` com o config Prisma da raiz |
| `tenants` | `true`: `<pm> basalt tenant:migrate`. Um array de strings: esses argumentos de script do package.json. |
| `command` | O comando de migração da própria aplicação, corrido no checkout **em vez de** `central`/`tenants`, por exemplo `['pnpm', 'db:deploy']` |
| `env` | `(values) => ({ … })`: valores que substituem os do `.env` na migração e no dump |

O `env` serve para URLs que nomeiam um contentor mas têm de lhe chegar a partir
do host:

```ts
migrate: {
  central: true,
  env: (values) => ({
    DATABASE_URL: values.get('DATABASE_URL')?.replace('@globex-postgres:5432', '@127.0.0.1:5433'),
  }),
},
```

## `backup` {#backup}

O `pg_dump` feito antes de migrar. Quando uma migração falha, o comando de
restauro aponta para ele.

| Opção | Por omissão | O que faz |
|---|---|---|
| `beforeMigrate` | não definido | Não definido: faz o dump quando algo é migrado e há um Postgres. `true`/`false` forçam num sentido ou noutro. |
| `keep` | `10` | Dumps guardados; os mais antigos são apagados |
| `dir` | `<stateDir>/backups` | Relativo ao checkout. Por omissão é `/var/lib/basalt/<app>/backups` (`0700`) depois de o `install` correr: fora do checkout, por isso nunca numa imagem nem num commit. |
| `urlKey` | `'DATABASE_URL'` | Com infra externa: a chave com o URL da base de dados |
| `container` | — | Com infra externa: faz o dump dentro deste contentor (`docker exec`), com o `pg_dump` do próprio servidor |

Para backups agendados, vê [Backups PostgreSQL](/pt/guide/backup).

## `runtime` {#runtime}

Como a aplicação corre. Obrigatório: `pm2()` ou `compose()`.

### `pm2(options)` {#pm2}

| Opção | Por omissão | O que faz |
|---|---|---|
| `name` | `<app>-api` | O nome do processo pm2; tem de começar por `<app>-` |
| `script` | `'start'` | O script do package.json que o processo corre |
| `port` | `'auto'` | `'auto'` mantém o `PORT` do `.env`, senão escolhe a primeira porta livre a partir de 3000 |
| `avoid` | `[]` | Portas que o `'auto'` nunca escolhe |
| `loadEnv` | `true` | Entrega à aplicação o seu `env.file`; vê abaixo |

O processo recebe sempre `NODE_ENV`, `PORT` e `HOST` do pm2. Com `loadEnv`
ligado, recebe também o caminho do ficheiro e um preload que o carrega só dentro
dos processos da própria aplicação. Os valores nunca chegam ao daemon do pm2 nem
ao dump do `pm2 save`.
[Como a app recebe o `.env`](/pt/guide/deploy#env-file) tem os detalhes.

O `loadEnv: false` é para uma aplicação que carrega o ambiente sozinha. O
preflight avisa quando o script de start não mostra nenhum loader.

### `compose(options)` {#compose}

Um projeto Docker Compose, com as imagens compiladas para cada commit.

| Opção | Por omissão | O que faz |
|---|---|---|
| `file` | — | O ficheiro compose, relativo ao checkout |
| `images` | — | Pelo menos um `{ tag, dockerfile, context?, env }`. Cada um é compilado como `<tag>:<sha>`, e a tag é `<app>` ou começa por `<app>-`. O `env` é a variável do compose que recebe `<tag>:<sha>`. O `context` é `.` por omissão. |
| `upstream` | — | `{ service, port }`: o que o proxy e o health check alcançam em `127.0.0.1` |
| `env` | `{}` | Valores de interpolação do compose; nunca segredos |
| `passEnv` | — | Chaves do `.env` passadas ao compose para a interpolação `${KEY}`, só no ambiente dele |
| `keepImages` | `3` | Releases cujas imagens são guardadas para um rollback sem recompilar |
| `attach` | — | `{ contentor: [redes] }`: contentores que este projeto não gere, ligados às redes dele antes do `up` |
| `jobs` | — | Comandos pontuais antes do `up`, com as imagens deste commit; vê abaixo |

Um **job** é `{ service, command?, once? }`. Corre como
`docker compose run --rm --no-deps <service> [command]`. O
`once: { exists: '/caminho/glob' }` salta-o quando esse caminho já existe
dentro do contentor.

```ts
runtime: compose({
  file: 'docker-compose.prod.yml',
  images: [{ tag: 'acme-api', dockerfile: 'docker/api/Dockerfile', env: 'API_IMAGE' }],
  upstream: { service: 'api', port: 3000 },
  attach: { 'acme-pg': ['data'] },
  jobs: [{ service: 'clamav', command: ['freshclam'], once: { exists: '/var/lib/clamav/main.c?d' } }],
}),
infra: dockerInfra('acme', { project: 'acme-infra', access: 'containers' }),
```

Com `compose()` e `dockerInfra()`, o `infra.project` tem de ser diferente do
nome da aplicação. Caso contrário, os dois projetos apagariam os contentores um
do outro como órfãos.

## `proxy` {#proxy}

O que fica à frente da aplicação: `apache()`, `caddy()` ou `none()` (por omissão).

### `apache(options)` {#apache}

| Opção | Por omissão | O que faz |
|---|---|---|
| `webRoot` | `'web/dist'` | Pasta servida em `/`, relativa ao checkout |
| `apiPrefix` | `'/api'` | Prefixo de caminho encaminhado para a aplicação (removido) |
| `vhost` | `<app>.conf` | Nome do ficheiro em `sites-available/`; `<app>.conf` ou a começar por `<app>-` |
| `certName` | o domínio | Nome do certificado Let's Encrypt (`/etc/letsencrypt/live/<nome>/`) |
| `root` | `/etc/apache2` | A pasta de configuração do Apache |
| `managed` | `true` | `false`: os vhosts são da própria aplicação; vê abaixo |
| `vhosts` | — | Com `managed: false`: os ficheiros `*.conf` a verificar |

O `install` escreve o vhost gerido; os deploys comparam-no e nunca o
reescrevem. Com `managed: false` o deploy nunca gera nem escreve um vhost. Em
cada deploy verifica que:

- cada ficheiro está ligado em `sites-enabled` (C2);
- cada `ProxyPass` para `127.0.0.1` aponta para a porta da aplicação (C1).

### `caddy(options)` {#caddy}

| Opção | Por omissão | O que faz |
|---|---|---|
| `webRoot` | `'web/dist'` | Pasta servida em `/` |
| `apiPrefix` | `'/api'` | Prefixo de caminho encaminhado para a aplicação (removido) |
| `onDemandTls` | — | `{ ask: '/tls/allowed' }`: um certificado por host, emitido só quando `GET <ask>?domain=<host>` responde 200. Obrigatório com `tenants: 'subdomain'`. |
| `extra` | — | Texto de Caddyfile acrescentado tal e qual ao ficheiro do site (sem `import`) |
| `managed` | `true` | `false`: o ficheiro do site é da própria aplicação, verificado e nunca escrito |
| `root` | `/etc/caddy` | A pasta de configuração do Caddy |

O `install` escreve `/etc/caddy/sites/<app>.caddy` e recarrega o Caddy depois
de um `caddy validate`. O TLS é o do próprio Caddy.

### `none()` {#none}

Sem proxy: a aplicação só responde em `127.0.0.1:<porta>`, e o health check
público é saltado.

## `health` {#health}

| Opção | Por omissão | O que faz |
|---|---|---|
| `path` | `'/health'` | Caminho na própria aplicação, sem o prefixo do proxy |
| `timeoutSeconds` | `60` | Quanto tempo uma release nova tem para responder antes do rollback |
| `public` | `true` com um proxy | Verificar também `https://<domain><apiPrefix><path>`, que é o que os utilizadores alcançam |

## `verify` {#verify}

Verificações declarativas depois do health check. Uma falha é uma release
falhada, que leva rollback.

| Opção | O que faz |
|---|---|
| `http` | Mais URLs da aplicação, cada um a responder `expect` (por omissão 200): `[{ path: '/readyz' }]` |
| `logs` | Por serviço compose, texto que não pode aparecer nos logs desde o início da release: `{ 'ingest-worker': ['ECONNREFUSED'] }` |

## `hooks` {#hooks}

Comandos de que só esta aplicação precisa. Cada um é um array de strings: um
comando e os seus argumentos, sem shell. Correm:

- no checkout, como o utilizador do deploy;
- com os valores do `.env` mais `DEPLOY_SHA` e `DEPLOY_APP` no ambiente;
- em cada deploy, por isso têm de ser idempotentes.

| Ponto | Quando | Uma falha |
|---|---|---|
| `infra` | Depois do `.env` e da infra, antes do build | Para o deploy, e o código é reposto |
| `verify` | Depois do health check | Falha a release, que leva rollback |

```ts
hooks: {
  infra: [['pnpm', 'tsx', 'scripts/ensure-search-index.ts']],
  verify: [['pnpm', 'tsx', 'scripts/smoke.ts']],
},
```

## `destructive` {#destructive}

Nomes de pastas de migração que não podem correr com o código da release
anterior, por exemplo `'20261011_drop_legacy'`. Uma release que aplica uma
delas nunca leva rollback automático: a falha do health check mostra, em vez
disso, o comando para restaurar o dump anterior à migração.

## `system` {#system}

`{ packages: [...] }`: pacotes apt do Debian/Ubuntu de que a aplicação precisa
fora do `node_modules`, como binários que executa ou bibliotecas que carrega.
Indica só os nomes, cada um uma vez, sem versão.

Cada deploy verifica-os (C12) antes de compilar, mas nunca os instala: é o root
que os instala, através do `bootstrap` ou do `install`, a partir do plano de
instalação.

```ts
system: { packages: ['tesseract-ocr', 'tesseract-ocr-por', 'poppler-utils'] },
```

## `bootstrap` {#bootstrap}

O que o `basalt-deploy bootstrap` prepara num servidor novo.

| Opção | Por omissão | O que faz |
|---|---|---|
| `swapGb` | `4` | Swap criada quando a RAM tem menos de 6 GB e não há swap; `0` quer dizer nunca |
| `firewall` | `true` | ufw: SSH, mais 80/443 atrás de um proxy. Só é ligada quando nada mais está a escutar. |

## `audit` {#audit}

Cada registo de release já diz quem a fez (`--actor` ou `$USER`), de onde
(`$SSH_CONNECTION`) e como. O `audit: { syslog: true }` envia também uma linha
por release para o log do sistema (`logger -t basalt-deploy`).

## Substituições por servidor: `/etc/basalt/<app>.json` {#overrides}

O que só é verdade num servidor, e por isso não pode ir para o repositório, fica
em `/etc/basalt/<app>.json`. Só guarda dados, e chaves desconhecidas são um
erro.

| Chave | Substitui |
|---|---|
| `domain` | `domain` |
| `branch` | `branch` |
| `port` | `pm2({ port })`, ou `compose({ upstream.port })` |
| `infra.postgres.port`, `infra.redis.port`, `infra.seaweedfs.port` | As portas do `dockerInfra()` |

```json
{ "port": 3005, "infra": { "postgres": { "port": 5434 } } }
```

## Ver também {#see-also}

- [Fazer deploy para um servidor](/pt/guide/deploy): o fluxo completo, os comandos e a interface.
- [Como a app recebe o `.env`](/pt/guide/deploy#env-file).
- A [referência da API `DeployConfig`](/reference/api/deploy/src/interfaces/DeployConfig), gerada a partir do código (em inglês).
