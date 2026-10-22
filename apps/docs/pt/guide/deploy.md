# Fazer deploy para um servidor

O `@basaltkit/deploy` faz o deploy de uma aplicação Basalt para um único
servidor Linux. Um comando trata do `.env`, da infraestrutura Docker (Postgres,
Redis, SeaweedFS), do build, de um dump da base de dados antes de migrar, da
migração, do PM2 ou Docker Compose, do Apache ou Caddy, de um health check e de
um rollback quando a nova release não responde. O `@basaltkit/deploy-ui` é uma
interface web opcional para ele. Corre na **tua** máquina e executa os mesmos
comandos através do teu próprio `ssh`.

Este guia acompanha uma aplicação, `acme`, desde um servidor novo até aos
deploys do dia a dia: primeiro no terminal, depois na interface.

![A interface de deploy depois de uma execução terminada: treze passos com tempos, e o log ao vivo a terminar em "acme e31d0a7 is live at https://acme.example.com"](/guide/deploy/hero-dark.png)

[[toc]]

## Como funciona {#how-it-works}

![Arquitetura: na tua máquina, o browser fala com o basalt-deploy-ui em 127.0.0.1, que lança o ssh do sistema. Por SSH, como utilizador da aplicação, o servidor corre o basalt-deploy a partir do node_modules do checkout: a aplicação, a infraestrutura dedicada e o diretório de estado. Abaixo de uma fronteira de confiança, o root corre apenas a sua própria cópia fixada, para bootstrap e install, e lê o install-plan.json como dados.](/guide/deploy/architecture.svg)

- **Nenhum agente no servidor.** Cada deploy é um comando simples, executado
  por SSH como utilizador da aplicação, no checkout da aplicação:
  `node node_modules/@basaltkit/deploy/dist/bin.js <command>`. A versão é a que
  o teu lockfile fixa.
- **A configuração é versionada.** O `deploy.config.ts` na raiz da aplicação
  não contém segredos. O `basalt-deploy init --domain=<host>` escreve-o a partir
  do projeto. O [README do pacote](https://github.com/basaltkit/basalt/tree/main/packages/deploy#the-config)
  documenta todas as opções.
- **O root fica à parte.** O root corre apenas a sua própria cópia fixada da
  ferramenta, fora do checkout, e apenas para `bootstrap` e `install`. Nunca
  carrega o `deploy.config.ts` nem o `node_modules` do checkout, e lê o plano de
  instalação do utilizador da aplicação como dados. Vê
  [Quem corre o quê](#trust-boundary).
- **A interface não acrescenta acessos.** Escuta apenas em `127.0.0.1` e corre
  o binário `ssh` com as tuas chaves e o teu `known_hosts`. Pode fazer o que a
  tua conta SSH pode fazer, e nada mais.

```sh
pnpm add -D @basaltkit/deploy      # na aplicação, versionado com o lockfile
```

::: warning Nunca adiciones a interface à aplicação
O `@basaltkit/deploy-ui` não pode ir para o `package.json` da aplicação, nem
sequer como devDependency. O deploy corre o `pnpm install` da aplicação no
servidor, que instala as devDependencies, e a interface acabaria em todos os
servidores. Corre-a com `npx` na tua máquina ([abaixo](#start-the-ui)).
:::

## O primeiro servidor {#first-server}

Precisas de um servidor Ubuntu ou Debian novo com Node, do repositório da
aplicação e de um utilizador para a aplicação. Neste guia, esse utilizador é
`deploy` e o checkout é `/srv/acme`.

### Bootstrap, com uma versão fixada {#bootstrap}

```sh
sudo adduser --disabled-password deploy && sudo git clone <repo> /srv/acme

# o root corre a SUA PRÓPRIA cópia, fixada na versão que o lockfile regista:
cd / && sudo -H npx --yes --package=@basaltkit/deploy@0.5.1 -- \
  basalt-deploy bootstrap --dir=/srv/acme --user=deploy --dry-run
# lê o que faria e volta a corrê-lo sem --dry-run
```

- **Fixa a versão exata** que o teu `pnpm-lock.yaml` regista para o
  `@basaltkit/deploy`. O `bootstrap` avisa quando as duas diferem.
- **O `cd /` e o `-H` importam.** Dentro do checkout, o `npx` escolheria a
  cópia do próprio checkout, que o utilizador da aplicação pode alterar. O `-H`
  dá ao root a sua própria cache do npm, em vez da do utilizador.
- **O `--dir` é obrigatório** e nunca é tirado do diretório atual. Tem de ser um
  caminho absoluto sem ligações simbólicas, feito de letras, dígitos e
  `. _ @ + -`, com `package.json` e `.git`, e não pode ser um diretório do
  sistema (`/`, `/srv`, `/home`, …). Prefira um checkout num diretório do root
  (`/srv/acme`) a um na home do utilizador: um diretório pai em que o
  utilizador escreve deixa-o trocar o checkout por uma ligação (o vhost do
  Apache protege-se disso; o Caddy não consegue, e o `install` avisa).

O `bootstrap` instala apenas o que falta: pacotes base, Docker com compose, o
Node indicado em `engines.node` e o pnpm que o lockfile regista. Entrega o
checkout e o grupo `docker` ao utilizador. Depois corre os passos do utilizador
**como o utilizador, no checkout**: `pnpm install`, `env` (pergunta o que não
consegue gerar) e `install-plan`. Por fim, acrescenta swap e uma firewall onde
for preciso e corre o `install`. Quando um passo falha, o bootstrap para aí.
Corrê-lo de novo não repete nada do que já está feito.

::: warning O grupo docker é root na máquina
Um contentor pode montar `/`, por isso pertencer ao grupo `docker` equivale, na
prática, a ser root. O `bootstrap` di-lo. A fronteira de confiança protege
contra erros e contra um checkout comprometido. Não protege contra o próprio
utilizador da aplicação. A solução real é o Docker rootless, e é um passo
posterior.
:::

### À mão: install-plan, depois o comando de root {#install-plan}

Os mesmos passos sem o `bootstrap`:

```sh
# como utilizador da aplicação (nunca root), no checkout:
pnpm install
node node_modules/@basaltkit/deploy/dist/bin.js env           # escreve o .env (pergunta uma vez), arranca os contentores, valida
node node_modules/@basaltkit/deploy/dist/bin.js install-plan  # escreve o plano de instalação (dados) e mostra o comando de root

# uma vez, como administrador: o comando que o install-plan mostrou, por exemplo
cd / && sudo -H npx --yes --package=@basaltkit/deploy@0.5.1 -- \
  basalt-deploy install --plan=/srv/acme/.basalt/install-plan.json --user=deploy
```

O `install` cria o diretório de estado `/var/lib/basalt/acme`, escreve o site
do Apache ou do Caddy e entrega os ficheiros de ambiente ao utilizador. Mostra o
que vai fazer antes de escrever o que quer que seja.

### Credenciais, TLS e o primeiro deploy {#first-deploy}

O `run` vai buscar o código ele próprio, por isso guarda as credenciais do git
uma vez, como utilizador da aplicação:
`git config credential.helper store && git fetch`, ou uma deploy key só de
leitura. Com o Apache, és tu que emites o certificado TLS
(`certbot --dns-cloudflare -d <domain> -d '*.<domain>'`). Com `caddy()`, é o
Caddy que o emite. Depois, faz o deploy:

```sh
sudo -u deploy -H sh -c 'cd /srv/acme && node node_modules/@basaltkit/deploy/dist/bin.js run'
```

::: tip Usa `node`, não `pnpm exec`
Corre os comandos do utilizador da aplicação com
`node node_modules/@basaltkit/deploy/dist/bin.js`. O pnpm 12 e seguintes
reescreve o `pnpm-lock.yaml` quando o lockfile veio de outro pnpm, e o deploy
recusa uma árvore modificada. Se quiseres, embrulha o comando num `deploy.sh` de
duas linhas.
:::

## Deploys do dia a dia no terminal {#terminal}

Tudo o que se segue corre como utilizador da aplicação, no checkout. O output
mostrado é output real do `basalt-deploy` para a aplicação de exemplo `acme`,
tirado das transcrições de teste do modo humano do próprio pacote (cujos
commits são `aaaaaaa` e `bbbbbbb`).

### `plan`: o que uma execução faria {#plan}

O `plan` corre todas as verificações e lista o que o `run` faria. Não pergunta
nada nem muda nada de que uma execução dependa.

```console
$ node node_modules/@basaltkit/deploy/dist/bin.js plan

==> preflight

==> plan — nothing below has run
    fetch: git fetch -- origin +refs/heads/master:refs/remotes/origin/master && git merge --ff-only refs/remotes/origin/master
    env: add APP_SECRET (generated)
    env: add PAYCO_CALLBACK_URL (derived from the domain/port)
    env: ask PAYCO_SECRET_TOKEN
    env: ask SUPPORT_EMAIL
    build: pnpm install (frozen), prisma generate --config prisma.config.ts, web build
    validate: src/env.ts against the new .env
    backup: skipped (backup.beforeMigrate is false)
    migrate: prisma migrate deploy + tenant:migrate
    release: pm2 acme-api on 127.0.0.1:3002
    health: http://127.0.0.1:3002/health (Host: acme.example.com), then https://acme.example.com/api/health
    commits: 3 to go out (aaaaaaa → bbbbbbb)
```

A última linha é o que a execução faria deploy: os commits entre o `HEAD` do
checkout e a ponta do branch no remoto. Para os ler, o `plan` faz fetch do
branch para uma ref privada (`refs/basalt-deploy/preview`, apagada a seguir) e
nunca para `refs/remotes/<remote>/<branch>`, a ref de onde o `run` faz merge. O
checkout, o `HEAD` e a ref de tracking ficam como estavam. Um branch reescrito
é assinalado (`the branch was rewritten — … run refuses it`). Se a lista não
puder ser lida (sem rede, um clone shallow, um commit que um force-push levou),
a linha diz `unavailable` e porquê. Isso nunca bloqueia o plan nem o deploy. A
lista completa está no resultado `--json`.

### `run`: fazer o deploy {#run}

O `run` passa por preflight, fetch, env, infra, build, validate, backup,
migrate, release, health e record:

![Um terminal a correr basalt-deploy run: cada passo sob um título "==> passo", linhas "ok" a verde para o .env, a release e os dois health checks, a terminar com "acme bbbbbbb is live at https://acme.example.com" e código de saída 0](/guide/deploy/terminal-run.png)

Um problema no preflight para a execução antes de qualquer alteração:

```console
$ node node_modules/@basaltkit/deploy/dist/bin.js run

==> preflight
    error [git] tracked files are modified on the server:
         M src/app.ts
      → git stash (or commit them where they belong); a deploy builds what is committed
    error preflight: 1 problem(s) above — nothing was changed
```

Quando a nova release não responde, o deploy repõe o commit anterior e sai com
`1`:

```console
==> health
    error the app does not answer on http://127.0.0.1:3002/health

==> restoring the code to aaaaaaa
    pnpm install --frozen-lockfile
    pnpm exec prisma generate --config prisma.config.ts
    pnpm --dir web run build

==> release aaaaaaa
    ok acme-api restarted (pnpm run start, port 3002)
    ok back on aaaaaaa
```

Uma migração falhada fica registada como `failed-migration`, e o deploy mostra
o comando `pg_restore` para o dump que tirou antes de migrar. Uma release que
aplicou uma migração listada em `destructive` nunca é revertida
automaticamente.

### `status` {#status}

O `status` mostra de onde vem o código, as últimas releases (quem fez o deploy
e de onde), o processo, o lock de deploy e um eventual hold:

```console
$ node node_modules/@basaltkit/deploy/dist/bin.js status

==> acme — last 0 release(s)
    source: origin/main (github.com/acme/app)
    no deploy running
    pm2 acme-api: online (pid 4242, /srv/acme)
```

### `commits`: o que mudou {#commits}

O `commits` lista os commits entre duas releases, ou o que um rollback tiraria
de produção. Só lê: sem lock, sem fetch.

```sh
node node_modules/@basaltkit/deploy/dist/bin.js commits --from=<sha> --to=<sha>
node node_modules/@basaltkit/deploy/dist/bin.js commits --rollback [--to=<sha>]
```

```console
$ node node_modules/@basaltkit/deploy/dist/bin.js commits --rollback
    commits: 2 would leave (bbbbbbb → aaaaaaa)
    - bbbbbbb Fix rounding in VAT totals (Ana, 2026-10-20T11:40:03Z)
    - 1f3c2d9 Invoices: add due_date column (Ana, 2026-10-20T10:02:41Z)
```

O `--rollback` resolve o destino exatamente como o `rollback`. Cada lista
inclui toda a ancestralidade, por isso os commits que um merge trouxe também
aparecem (o merge vem marcado `[merge]`). Cada lado tem no máximo 50 commits,
com o total real. Quando o histórico divergiu, os dois lados são listados. O
texto de um commit é do autor: o deploy retira os caracteres de controlo e
limita o comprimento, e um valor do `.env` numa mensagem de commit é redigido
em `--json`.

### `rollback` e holds {#rollback}

```sh
node node_modules/@basaltkit/deploy/dist/bin.js rollback              # a última release saudável
node node_modules/@basaltkit/deploy/dist/bin.js rollback --to=<sha>   # uma release à tua escolha
```

Um rollback repõe **apenas o código**: a base de dados mantém as suas
migrações. Um rollback manual recusa um checkout com alterações locais e
**retém** (hold) o commit que deixou. Um `run` agendado não volta a fazer o
deploy desse commit até o branch avançar. Para o fazer à mesma, de forma
deliberada:

```sh
node node_modules/@basaltkit/deploy/dist/bin.js run --unhold
```

Sem nada para onde voltar, o rollback falha:

```console
$ node node_modules/@basaltkit/deploy/dist/bin.js rollback
    error no earlier release to go back to; pass --to=<sha>
```

### Um deploy de cada vez, e códigos de saída {#exit-codes}

O `run`, o `env`, o `rollback` e o `install` tomam um lock no diretório de
estado. Um segundo deploy é recusado, e a mensagem diz quem tem o lock. O
primeiro Ctrl-C para o `run` no fim do passo atual. A partir da release, o
comando termina primeiro.

| Código de saída | Significado |
|---|---|
| `0` | concluído |
| `1` | falhou, ou foi recusado (um problema no preflight, um commit retido, uma release falhada) |
| `3` | outro deploy tem o lock; nada foi feito |
| `130` | parado por um sinal (um segundo sinal termina o processo de imediato: `130`/`129`/`143`) |

Opções úteis: `--skip=fetch,backup,tls`, `--config=<file>`,
`--actor=<name>` (registado com a release; por omissão `$BASALT_DEPLOY_ACTOR`,
senão `$USER`). O `--json` muda para o modo máquina: eventos NDJSON, usados
pela interface e por scripts. O modo máquina também permite execuções
destacadas: `run --json=1 --detach`, `attach <runId> --json --follow` e
`cancel <runId>`. Vê o
[README do pacote](https://github.com/basaltkit/basalt/tree/main/packages/deploy#machine-mode-json).

## Fazer deploy a partir da interface local {#ui}

A interface precisa de um servidor onde já se fez um deploy a partir de um
terminal, como acima, e de uma conta SSH (o utilizador da aplicação) à qual já
consegues chegar com `ssh`.

### Arrancar a interface {#start-the-ui}

Na tua máquina, nunca no servidor:

```console
$ npx @basaltkit/deploy-ui@0.1.1
basalt-deploy-ui: listening on http://127.0.0.1:53119/ (this machine only)
basalt-deploy-ui: targets in ~/.config/basalt/deploy-targets.json
```

Abre o browser com um código de uso único no URL, válido durante 120 segundos.
Com `--no-open`, mostra o URL em vez de abrir o browser. Numa máquina
partilhada com outros utilizadores, usa `--pair`: o browser abre sem o código,
e escreves o código curto de emparelhamento que o terminal mostra. Fixa uma versão exata,
porque esta ferramenta lida com os teus segredos de deploy. Outras opções:
`--targets=<file>`, `--ssh=<absolute path>`, `--idle-minutes=<n>` (por omissão
15). Não há opção `--host` nem `--port`: a interface escuta sempre em
`127.0.0.1`, numa porta escolhida pelo sistema operativo.

A interface para ao fim de 15 minutos de inatividade. Um log ao vivo aberto ou
um comando em curso mantém-na ativa. Para a parar, usa **Quit** na página ou
carrega em `Ctrl-C`. As execuções destacadas continuam no servidor.

### Adicionar um target {#add-a-target}

Um target é um servidor: um destino SSH e o diretório do checkout. Em
**Targets**, escolhe **Add a target**:

![O formulário "Add a target": nome staging-eu, destino SSH acme-staging-eu (um alias Host), checkout /srv/acme, node on the server com um caminho do nvm, e a caixa Protected](/guide/deploy/ui-target-add.png)

| Campo | |
|---|---|
| Name | `a-z`, `0-9`, `-`. A chave da interface; nunca entra num comando. |
| SSH destination | `[user@]host`, ou um alias `Host` do teu `~/.ssh/config` |
| Port | opcional; senão o teu `~/.ssh/config`, senão 22 |
| Checkout on the server | o caminho absoluto do checkout da aplicação |
| node on the server | caminho absoluto opcional, [para o nvm](#node-path) |
| Config file | opcional, relativo ao checkout (por omissão `deploy.config.ts`) |
| Protected | o deploy e o rollback exigem que escrevas o nome do target |

Os targets ficam no teu diretório de configuração, em
`~/.config/basalt/deploy-targets.json` (`%APPDATA%\basalt\` no Windows),
escritos com `0600`, nunca no repositório da aplicação. O ficheiro não contém
segredos. Diz para onde vão a tua chave e as respostas do `.env` que escreves,
por isso um commit num repositório partilhado não o pode alterar.

Depois escolhe **Check connection**. Um target que funciona responde com a
versão do deploy, o protocolo e o nome do servidor. Por baixo vês que app é
realmente esse target: o nome da app e de onde vem o seu código
(`github.com/acme/app (main)`, a partir do `@basaltkit/deploy` 0.9.0):

![A página Targets: três targets (staging, production marcado como protegido, preview) e um aviso verde "staging answers: @basaltkit/deploy 0.5.1, protocol 1, host web-1.example.com"](/guide/deploy/ui-targets.png)

### Chaves SSH: `~/.ssh/config` {#ssh-config}

A interface corre o `ssh` em modo batch: nunca pede palavra-passe, frase-passe
nem confirmação da chave do servidor. Chaves, jump hosts e proxies vão para o
`~/.ssh/config`, e o target indica o alias:

```ssh-config
Host acme-prod
  HostName prod.example.com
  User deploy
  Port 2222
  IdentityFile ~/.ssh/acme_deploy
  IdentitiesOnly yes
```

- O **`IdentityFile`** com **`IdentitiesOnly yes`** faz o ssh oferecer apenas
  essa chave. Sem `IdentitiesOnly`, o ssh oferece primeiro todas as chaves do
  teu agente, e um servidor com um `MaxAuthTries` baixo pode recusar-te antes de
  ver a chave certa.
- **Uma chave com frase-passe** tem de estar no teu agente:
  `ssh-add ~/.ssh/acme_deploy` (no macOS, `ssh-add --apple-use-keychain`).
- **Verifica primeiro num terminal.** O `ssh acme-prod` tem de funcionar sem
  perguntas. A interface faz exatamente o que esse comando faz.

### A primeira ligação: `known_hosts` {#known-hosts}

A interface passa sempre `StrictHostKeyChecking=yes`, por isso recusa um
servidor que nunca verificaste, diga o que disser a tua configuração (o
`accept-new` não se aplica). Liga-te uma vez a partir de um terminal, compara
a impressão digital com a do próprio servidor
(`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`, corrido no servidor) e
responde `yes`:

```sh
ssh acme-prod true
```

Até o fazeres, o **Check connection** mostra o erro `host-key`:

![Um aviso vermelho na página Targets: "this host's key is not in your known_hosts, or it changed [host-key]", com a sugestão "connect once from a terminal (ssh deploy@192.0.2.30) and check the fingerprint"](/guide/deploy/ui-error-host-key.png)

### O `node` com nvm {#node-path}

O `ssh host cmd` arranca uma shell não interativa, que não lê os ficheiros onde
o nvm, o fnm ou o volta põem o `node` no `PATH`. Se a verificação indicar
`no-node`, pergunta a uma shell de login no servidor onde está o `node`, e
põe esse caminho no campo **node on the server** do target:

```sh
ssh acme-prod 'bash -lc "command -v node"'
# /home/deploy/.nvm/versions/node/v22.11.0/bin/node
```

A partir do `@basaltkit/deploy` 0.5.1, o deploy também põe esse diretório em
primeiro lugar no `PATH` de tudo o que lança (`pnpm`, os scripts da aplicação).
Ativa o pnpm que o teu `packageManager` declara nesse Node com
`corepack enable`.

### Status {#ui-status}

O **Status** mostra o que corre agora no servidor: a release atual, o
processo, o lock e a última execução. Carrega uma vez quando escolhes um target.
Escolhe **Refresh** para o carregar de novo; a interface não faz polling.

![A página Status do staging: release atual b7e4c19d2a0f (saudável, deploy por alice via ui, migração 20261010_add_invoices), processo pm2 acme-api a correr, lock livre, última execução com saída 0](/guide/deploy/ui-status.png)

A barra no topo mostra sempre onde estás: o target, o seu destino SSH e
checkout e, depois de o servidor responder, o nome do servidor, a versão do
deploy, a aplicação e a sua origem (o endereço do remoto sem credenciais, e o
ramo).

#### Quando o deploy do servidor é mais antigo {#older-deploy}

A página usa funcionalidades de versões recentes do `@basaltkit/deploy`: as
listas de commits (0.8.0) e a origem da app (0.9.0). Quando o servidor corre
uma mais antiga, a versão do deploy na barra fica em âmbar, e o **Status** e o
**Check connection** dizem o que falta e como atualizar:

![A página Status com um aviso âmbar: "This server runs @basaltkit/deploy 0.6.0; this page uses features up to 0.9.0", as funcionalidades em falta, o comando pnpm add -D @basaltkit/deploy@^0.9.0, e que o primeiro deploy ainda corre a 0.6.0](/guide/deploy/ui-status-behind.png)

O servidor corre sempre a versão **que o lockfile da app fixa**, nunca a mais
recente do npm. Por isso, no repositório da app, corre `pnpm add -D
@basaltkit/deploy@^0.9.0`, faz commit e push. Depois faz um deploy: esse deploy
ainda corre a versão antiga, e o seu `pnpm install --frozen-lockfile` instala a
nova. A partir do comando seguinte, o servidor já a usa. Entretanto nada fica
bloqueado: uma funcionalidade em falta simplesmente não aparece.

### Plan & deploy {#plan-and-deploy}

**Plan & deploy → Run plan** corre o `plan` no servidor. Nada muda lá. Primeiro
vêm as findings, cada uma com o ID da verificação e uma correção. Um erro
bloqueia o deploy até o corrigires no servidor e escolheres **Plan again**:

![Plano com uma finding bloqueante: "ERROR [git] tracked files are modified on the server: M src/app.ts", correção "git stash (or commit them where they belong)", e um aviso C8 sobre o certificado](/guide/deploy/ui-plan-blocking.png)

Sem erros, a página mostra o plano e o formulário com o que a execução vai
perguntar:

![Plan & deploy: um aviso C8 sobre a expiração do certificado com a correção "certbot renew", a lista do que uma execução faria (fetch, env, build, validate, backup, migrate, release, health) e o formulário "What the run will ask"](/guide/deploy/ui-plan.png)

**What will go out** lista os commits que a execução faria deploy, do mais
recente para o mais antigo, com autor e data. Um merge vem marcado, e os
commits que traz aparecem com ele. Se o branch foi reescrito no remoto, o
cartão avisa que uma execução o recusaria e lista os commits que só o servidor
tem. Se a lista não puder ser lida, o cartão diz porquê, e o **Deploy…**
continua a funcionar.

![What will go out: 57 commits de d4d4d4d a e8e8e8e, do mais recente para o mais antigo: um merge do pull request #218, três commits de Ana Silva e renovate[bot], um assunto longo cortado com reticências, e "+ 52 older commits not shown — the server sends at most 50 per list"](/guide/deploy/ui-plan-commits.png)

### O formulário do `.env` {#env-form}

As perguntas vêm do `env.ask` no `deploy.config.ts`. As respostas secretas são
campos de palavra-passe. São enviadas uma vez, pelo teu ssh, para o deploy no
servidor, e os campos são esvaziados depois do envio. A interface nunca as
guarda.

![O formulário "What the run will ask": um campo secreto PayCo token, uma escolha Region, um Support address opcional com valor por omissão, uma secção Advanced e os botões "Write .env only…" e "Deploy…"](/guide/deploy/ui-env-form.png)

- **Write .env only…** corre o `env`: o `.env` e a infraestrutura dedicada, sem
  build nem reinício. Usa-o numa primeira configuração.
- **Advanced → Attended** corre o deploy ligado à página: para no passo
  seguinte se a página fechar ou a interface terminar. Por omissão, uma execução
  é **destacada** (detached), por isso fechar a tampa do portátil não a para.
- Quando um commit está retido, aparece uma caixa **Deploy anyway**. É o
  `run --unhold`.

### Confirmar {#confirm}

**Deploy…** abre uma confirmação que repete o destino, o checkout, o nome do
servidor e a aplicação. Avisa quando a execução vai migrar a base de dados. O
foco começa em **Cancel**, nunca no botão destrutivo:

![O diálogo de confirmação "Deploy to staging?" com deploy@staging.example.com · /srv/acme · host web-1.example.com · app acme, "This will migrate the database." e os botões Cancel e Deploy](/guide/deploy/ui-dialog-deploy.png)

Se o ficheiro de targets mudou depois de o diálogo abrir, a interface não envia
nada e mostra os novos valores.

### A execução ao vivo {#live-run}

A página da execução mostra os passos com os respetivos tempos e o log ao vivo.
O output do build e das migrações vem marcado com a origem (`[pnpm]`,
`[prisma]`, `[vite]`):

![Uma execução ao vivo no passo backup: lock, preflight, fetch, env, infra, build e validate concluídos com tempos; o log mostra um aviso C8, o fetch b7e4c19 → e31d0a7, o output do build e o pg_dump para /var/lib/basalt/acme/backups](/guide/deploy/ui-run-live.png)

No fim, a página mostra a release, o seu URL e as suas migrações:

![A execução terminada: "Release e31d0a7c4b9f: ok", https://acme.example.com, migrações 20261011_add_refunds, "Finished: exit 0", os treze passos concluídos](/guide/deploy/ui-run-finished.png)

### Voltar a ligar e cancelar {#reattach-cancel}

- **Uma ligação que cai** volta a ligar-se sozinha, a partir do evento
  seguinte, sem falhas nem linhas duplicadas.
- **Stop watching** deixa a execução a correr no servidor. **Re-attach** volta
  a acompanhá-la, e **Show from the start** reproduz o log inteiro.
- **A partir de outra sessão** (um novo separador, depois de reiniciar a
  interface, ou a partir do terminal de um colega), o **Status** mostra a
  **Active run** com um botão **Attach**, e a **Last run** com **Show its log**.
- **Cancel…** pede ao deploy para parar na fronteira do passo seguinte antes da
  migração. A partir da migração, o deploy termina primeiro.
  **Cancel again (stop now)…** abre uma segunda confirmação, separada: termina
  o deploy a meio do passo, uma migração pode ficar aplicada a meio, e o log
  contém o comando de restauro do dump anterior ao deploy. É o servidor que
  decide de que cancelamento se trata, por isso um cancelamento já enviado de
  um terminal conta.

### Histórico e rollback {#history}

O **History** lista as últimas 10 releases que o servidor registou: o commit e
o seu assunto, o estado, o ator, a forma como correu (`ui`, `ssh`, …), o
endereço do cliente, as migrações e o dump tirado antes delas. A seta de uma
linha abre os commits que essa release trouxe em relação à anterior. São lidos
uma vez do servidor e guardados durante a sessão.

![History: quatro releases com o assunto dos commits; a mais recente está aberta e mostra os três commits que trouxe, entre eles um merge do pull request #212; em baixo, o cartão Roll back com "Back to: the last healthy release (the deploy decides)", Preview changes e Roll back…](/guide/deploy/ui-history.png)

**Roll back** volta à última release saudável, ou a uma que escolhas em **Back
to**. Tal como no terminal, repõe apenas o código e retém o commit que deixa.
**Preview changes** lista os commits que sairiam de produção. **Roll back…**
volta a ler essa lista nesse momento e mostra-a na confirmação:

![A confirmação do rollback: "Back to the last healthy release — c3c3c3c now", uma lista vermelha "Leaves production 3" com três commits de faturas, e "The commit it leaves is held until the branch moves on"](/guide/deploy/ui-dialog-rollback-commits.png)

A página envia o mesmo pedido que enviaria sem a pré-visualização: com **the
last healthy release**, é o deploy que escolhe o destino quando corre. Se
escolher um commit diferente do pré-visualizado (porque entretanto houve um
deploy), a execução avisa. Uma pré-visualização que falhe nunca bloqueia o
rollback. O rollback corre destacado, e a página abre o respetivo log ao vivo.

### Targets protegidos {#protected}

Marca a produção como **Protected**. A barra do topo passa a mostrar uma faixa
vermelha e um selo **PROTECTED** em todas as páginas. O Status mostra o aviso
de hold, uma execução ativa de outra pessoa e o lock que ela detém:

![Status do target protegido production: selo vermelho PROTECTED na barra do topo, um aviso de commit retido "Commit 4c8e2a6f0b3d is held since 2026-10-07 by bob, rolled back to 9a1f3c7", uma execução ativa de bob com um botão Attach, e o lock detido pelo pid 5100](/guide/deploy/ui-status-protected.png)

O deploy, o **Write .env only** e o rollback num target protegido exigem que
escreva o nome do target no diálogo. O botão fica desativado até o nome
coincidir:

![O diálogo "Roll back production?" com o selo PROTECTED, "Back to the last healthy release." e o nome escrito só em parte, por isso o botão Roll back continua desativado](/guide/deploy/ui-dialog-rollback-protected.png)

### Idioma {#language}

A página fala inglês e português. Antes de haver sessão, segue o idioma do
browser (`pt-AO`, `pt-PT`, `pt-BR` → português; qualquer outro → inglês). O
seletor no fundo da barra lateral muda todos os ecrãs de uma vez, e a escolha
fica guardada como `"locale"` no teu ficheiro de targets para o próximo
arranque. As datas seguem a variante do idioma do teu browser.

Só as palavras da própria página são traduzidas. O que o `@basaltkit/deploy`
do servidor imprime — títulos dos passos, linhas do log, findings, os seus
erros — aparece exactamente como chegou, tal como qualquer recusa do servidor
local que a página não conheça.

![O ecrã Estado em português: «Release actual», «Processo», «Lock» e «Última execução», com o seletor de idioma em Português no fundo da barra lateral](/guide/deploy/ui-status-pt.png)

### Num telemóvel ou numa janela estreita {#narrow}

O layout passa a uma coluna: a navegação transforma-se em separadores e a barra
do target quebra em várias linhas.

<img src="/guide/deploy/ui-phone.png" alt="A interface de deploy com a largura de um telemóvel: o seletor de target e os separadores no topo, a página da execução com Cancel… e Stop watching, e a lista de passos no passo backup" width="320">

## Resolução de problemas {#troubleshooting}

Os erros de ligação mostram um código curto entre parênteses retos. A interface
nunca tenta corrigi-los sozinha; cada um corresponde a algo que fazes num
terminal.

| A interface diz | Código | O que fazer |
|---|---|---|
| the server refused your SSH key | `auth` | A chave está no teu agente (`ssh-add -l`)? O `ssh <destino>` funciona num terminal? Define `IdentityFile` e `IdentitiesOnly yes` ([Chaves SSH](#ssh-config)). |
| your SSH key needs its passphrase, and ssh runs here in batch mode | `passphrase` | Adiciona a chave ao teu agente: `ssh-add`. |
| this host's key is not in your known_hosts, or it changed | `host-key` | Liga-te uma vez num terminal e verifica a impressão digital ([known_hosts](#known-hosts)). Se a chave mudou sem estares à espera, para e descobre porquê. |
| node was not found on the server for a non-interactive shell | `no-node` | Define o **node on the server** do target com um caminho absoluto ([nvm](#node-path)). |
| the checkout has no installed @basaltkit/deploy | `no-deploy` | Corre o `pnpm install` no checkout uma vez, a partir de um terminal. |
| the target's dir does not exist on the server | `no-dir` | Verifica o caminho do checkout do target. |
| the host name does not resolve | `resolve` | Verifica o destino SSH, ou o alias `Host` no `~/.ssh/config`. |
| the connection timed out / was refused | `timeout` / `refused` | O servidor está ligado, e o sshd escuta nessa porta? |
| no protocol output from the server | | A conta tem uma shell de login POSIX (`sh`, `bash`, `zsh`)? O `@basaltkit/deploy` é recente o suficiente para ter `--json`? |

Estas vêm do próprio preflight do deploy, e aparecem como findings no plano e
no log de uma execução:

| Finding | Significado | Correção |
|---|---|---|
| `[state-dir]` `/var/lib/basalt/<app>` is missing or not reachable by this user | O estado do deploy (histórico de releases, lock, dumps) fica no checkout. | Corre o `install-plan`, depois o comando de root que ele mostra. O `install` dá o diretório ao utilizador (`0700`) e torna o diretório pai acessível. |
| `[dumps]` database dumps go to … inside the checkout, and git does not ignore them | Um dump da base de dados inteira poderia ir parar a um commit. | Acrescenta `/.basalt/` ao `.gitignore`, ou corre o `install` uma vez, para os dumps irem para `/var/lib/basalt/<app>/backups`. |
| `[dumps]` … inside the Docker build context | Um `COPY . .` pô-los-ia na imagem. | Acrescenta `.basalt` ao `.dockerignore`, ou corre o `install` uma vez. |
| `[dumps]` dump(s) left in `backups/predeploy` (the old place) | Já nada os apaga. | Move-os para junto dos novos, ou apaga-os. |
| `[C9]` node is not on PATH / older than `engines.node` | Falta a toolchain que o deploy vai chamar, ou é demasiado antiga. | Define o caminho do `node` do target, ou instala o Node que o `engines.node` pede. |
| `[C9]` pnpm is not on PATH, ou outra major que não a declarada em `packageManager` | | `corepack enable`. Passa então a correr a versão declarada. |
| `[C9]` pm2 / docker compose is not available to this user | | `npm i -g pm2` como utilizador da aplicação, depois `pm2 startup`; para o compose, verifica o Docker e o grupo `docker` do utilizador. |

Um commit retido (`run` recusado com `held`) não é um erro a corrigir: faz
push de uma correção (o hold termina quando o branch avança), ou usa **Deploy
anyway** (`--unhold`). Um código de saída `3` (`locked`) significa que outro
deploy está a correr. Quem o detém aparece na página Status.

## Segurança: o que a interface pode e não pode fazer {#security}

**Pode** fazer o que a tua conta SSH pode fazer no servidor, como utilizador da
aplicação: `status`, `plan`, `env`, `run`, `attach`, `cancel` e `rollback`,
cada um como uma invocação de `ssh` do
`node node_modules/@basaltkit/deploy/dist/bin.js <command> --json=1 --via=ui`
da própria aplicação, fixado pelo lockfile.

**Não pode:**

- **correr os comandos do root**, nem os que escrevem código. O `install`, o
  `bootstrap` e o `init` não estão acessíveis a partir da interface.
- **ser alcançada a partir de outra máquina.** Escuta em `127.0.0.1` e numa
  porta escolhida pelo sistema operativo, nunca em `0.0.0.0` nem `localhost`, e
  nada fica à escuta no servidor.
- **ser controlada por outra página web.** Aceita uma única sessão do browser:
  um código de arranque de uso único, trocado por um token guardado nesse
  separador, não um cookie. Cada pedido é verificado quanto ao `Host`, à
  `Origin` e ao token exatos, e a interface nunca envia cabeçalhos CORS. A CSP é
  estrita e o enquadramento em frames é negado.
- **enfraquecer o teu ssh.** Passa sempre `BatchMode=yes`,
  `StrictHostKeyChecking=yes` e `ForwardAgent=no`, só com argv e com `--` antes
  do destino.
- **guardar os teus segredos.** Viajam do browser → loopback → stdin do `ssh`,
  nunca em argv, no ambiente, num ficheiro, num log ou no URL. O deploy
  retira-os de todos os eventos que escreve no servidor.
- **confiar no output do servidor.** Cada linha é validada e mostrada apenas
  como texto, por isso um build que imprime um evento falso aparece como uma
  simples linha de log.

Os seus limites: numa máquina partilhada com outros utilizadores, o código de
arranque fica visível nos argumentos do programa que abre o browser durante um
instante. Se outra pessoa o reclamar, o teu separador falha de forma visível e
o terminal avisa; o `--pair` elimina esse intervalo. Quando o terminal disser que a interface parou, fecha o
separador. O modelo de ameaças completo está no
[RFC 0009](https://github.com/basaltkit/basalt/blob/main/docs/rfcs/0009-deploy-local-ui.md).

### Quem corre o quê: a fronteira de confiança {#trust-boundary}

| Quem | Corre | Pode alterar |
|---|---|---|
| o utilizador da aplicação | `env`, `run`, `rollback`, `plan`, `status`, `install-plan`; a própria aplicação | o checkout (`deploy.config.ts`, `node_modules`, todos os ficheiros), o seu `.env`, o diretório de estado |
| root | `bootstrap`, `install`, a partir de uma cópia da ferramenta que pertence ao root | tudo |

O root nunca corre código do utilizador da aplicação. O `install` lê o plano de
instalação, que só contém dados, e valida de novo cada campo. Como root, o
`install` e o `bootstrap` recusam correr a partir de ficheiros que outro
utilizador possa alterar (o checkout, a cache npm de um utilizador, um Node por
utilizador). Os comandos do utilizador da aplicação recusam correr como root.

## Ver também {#see-also}

- [Ir para Produção](/pt/guide/production): a checklist, e
  [Build e envio](/pt/guide/production#build-e-envio) para o caminho do Dockerfile.
- [Backups PostgreSQL](/pt/guide/backup): backups agendados para além do dump
  anterior à migração.
- Os READMEs do `@basaltkit/deploy` e do `@basaltkit/deploy-ui`: todas as
  opções do `deploy.config.ts`, aplicações Docker Compose, infraestrutura
  externa e hooks.
- RFCs [0006](https://github.com/basaltkit/basalt/blob/main/docs/rfcs/0006-basalt-deploy.md)
  (o pipeline), [0008](https://github.com/basaltkit/basalt/blob/main/docs/rfcs/0008-deploy-machine-protocol.md)
  (modo máquina), [0009](https://github.com/basaltkit/basalt/blob/main/docs/rfcs/0009-deploy-local-ui.md)
  (a interface) e [0010](https://github.com/basaltkit/basalt/blob/main/docs/rfcs/0010-deploy-seaweedfs.md)
  (SeaweedFS no lugar do MinIO).
