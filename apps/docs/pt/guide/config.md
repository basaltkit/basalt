# Configuração

Dois pacotes pequenos cobrem tudo o que uma app precisa de saber sobre as suas
próprias definições. O [`@basaltkit/env`](/reference/packages/env) valida o
**mundo exterior** — o `process.env` — uma única vez, no arranque, e devolve um
objeto tipado e congelado. O [`@basaltkit/config`](/reference/packages/config) é
o **mundo interior**: um repositório com namespaces, lido por dot-path, a que
qualquer plugin chega pelo token `CONFIG`. Ambos falham alto: uma variável em
falta ou uma chave em falta é um erro no boot, nunca um `undefined` que aparece
três camadas abaixo dentro de um handler.

[[toc]]

## Modelo mental

Há três camadas distintas, e confundi-las é a origem habitual do "afinal de onde
vem este valor?":

| Camada | Pertence a | Validada por | Lida como |
| --- | --- | --- | --- |
| Variáveis de ambiente | O host (shell, `.env`, o painel da plataforma) | `defineEnv(shape)` — uma vez, antes do `createApp` | `env.PORT` — tipado, congelado |
| Definições da aplicação | Tu, como um objeto organizado por namespace | Nada — o objeto é teu | `config.get('mail.from')` |
| Fatia de config por plugin | `createApp({ config })`, indexada pelo nome do plugin | O `configSchema` do próprio plugin | `context.config` dentro do plugin |

O fluxo corre num só sentido: **ambiente → objeto de definições →
`configPlugin`**. Não há nenhum scanner de ficheiros nem mapeamento automático
de `MAIL_FROM` para `mail.from`. O mapeamento é escrito por ti, e é por isso que
o consegues encontrar com um grep.

::: tip Dica: nenhum dos pacotes lê o `.env`
O `defineEnv` lê o `process.env` e mais nada. Carrega o ficheiro antes de o
módulo ser importado — `node --env-file=.env` (o Node 22 já o traz) ou o
mecanismo do teu gestor de processos. Um `.env` ao lado de `src/env.ts` não faz
nada por si só.
:::

## Início rápido

```ts
import { createApp, definePlugin } from '@basaltkit/core'
import { CONFIG, configPlugin } from '@basaltkit/config'
import { defineEnv, secret } from '@basaltkit/env'
import { z } from 'zod'

// 1. Valida primeiro o ambiente — isto lança antes de algo arrancar.
const env = defineEnv({
  PORT: z.coerce.number().default(3000),
  SMTP_HOST: z.string(),
  APP_SECRET: secret({ minLength: 32, devDefault: 'dev-only-insecure-secret-value' }),
})

// 2. Funde-o num único objeto de definições, organizado por área.
const settings = {
  app: { name: 'my-app', port: env.PORT, secret: env.APP_SECRET },
  mail: { from: 'hi@basalt.dev', smtp: { host: env.SMTP_HOST, port: 587 } },
}

// 3. Qualquer plugin o lê através do token CONFIG.
const mailPlugin = definePlugin({
  name: 'app:mail',
  dependsOn: ['basalt:config'], // o config regista-se primeiro
  register({ container }) {
    const config = container.get(CONFIG)
    const from = config.get<string>('mail.from')          // 'hi@basalt.dev'
    const port = config.get<number>('mail.smtp.port', 25) // 587 — 25 só se faltar
  },
})

await createApp({ plugins: [configPlugin(settings), mailPlugin] }).boot()
```

O `configPlugin` regista um singleton `ConfigRepository` sob `CONFIG` e faz
`structuredClone` do objeto que passaste, por isso escritas posteriores no
repositório nunca alteram o teu objeto de origem (nem o contrário).

## Leituras que falham alto

```ts
config.get('mail.from')          // → 'hi@basalt.dev'
config.get<number>('mail.smtp.port') // → 587, tipado pelo argumento de tipo explícito
config.get('mail.replyTo', null) // → null   (fallback explícito, sem throw)
config.get('mail.replyTo')       // → lança ConfigKeyError (CONFIG_KEY_MISSING)
config.has('queue.driver')       // → boolean, nunca lança
```

Uma chave em falta **sem** fallback lança `ConfigKeyError` — o erro aparece onde
o valor é preciso pela primeira vez (normalmente no registo do plugin, ou seja,
no boot) em vez de um `undefined` que se torna discretamente `NaN` às 3 da
manhã.

::: warning Aviso: um fallback `undefined` continua a contar como fallback
A verificação é sobre o número de argumentos, não sobre o valor. O
`get(path, undefined)` devolve `undefined` em vez de lançar. Se queres a
exceção, chama `get(path)` com exatamente um argumento.
:::

## Escrever e fundir

O `set` escreve um caminho, criando os objetos intermédios necessários. O
`merge` sobrepõe um objeto inteiro, fundindo em profundidade apenas objetos
simples:

```ts
config.set('queue.driver', 'bullmq')  // cria 'queue' e depois 'queue.driver'

config.merge({ mail: { smtp: { host: 'smtp.acme.com' } } })
config.get('mail.smtp.port') // 587 — a chave irmã sobrevive
config.get('mail.smtp.host') // 'smtp.acme.com'

config.all() // a árvore toda, tipada Readonly (é o objeto vivo, não uma cópia)
```

Arrays e primitivos são **substituídos**, não concatenados — só objetos simples
recorrem. Para acrescentar a um array, lê-o com `get`, altera-o e volta a
escrevê-lo com `set`.

::: danger Perigo: chaves de prototype pollution são recusadas
O `set('__proto__.isAdmin', true)` — ou um segmento `constructor` / `prototype`
— lança `ConfigUnsafeKeyError` (`CONFIG_UNSAFE_KEY`). O `merge` trata as mesmas
três chaves mas **descarta-as em silêncio** a qualquer profundidade, porque é o
método que tipicamente recebe JSON parseado ou overrides remotos. Nenhum dos
dois consegue chegar ao `Object.prototype`.
:::

## Tipar os teus namespaces

O `ConfigRepository.get` é genérico (`get<T>(path, fallback?)`), por isso uma
leitura é tão tipada quanto a fizeres. Para um namespace partilhado entre
pacotes, declara a sua forma uma vez com module augmentation — é para isso que
existe a interface `BasaltConfig`:

```ts
declare module '@basaltkit/config' {
  interface BasaltConfig {
    mail: { from: string; smtp: { host: string; port: number } }
  }
}
```

A augmentation documenta e tipa o namespace para todos os que consomem o
`BasaltConfig`; a leitura por dot-path continua a tirar o tipo do argumento
explícito, `config.get<number>('mail.smtp.port')`.

## A camada de ambiente

O `defineEnv(shape)` valida todas as variáveis numa só passagem e agrega
**todas** as falhas num único relatório, para corrigires o ambiente de uma vez
em vez de reiniciares a cada variável em falta:

```ts
import { defineEnv, EnvValidationError } from '@basaltkit/env'
import { z } from 'zod'

try {
  defineEnv({
    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url(),
    PORT: z.coerce.number().default(3000),
  })
} catch (error) {
  if (error instanceof EnvValidationError) {
    error.code   // 'ENV_INVALID'
    error.report // ['DATABASE_URL: Required', 'REDIS_URL: Required']
  }
}
```

Duas coisas a reter. As variáveis de ambiente são sempre **strings**, por isso
usa `z.coerce.number()` / `z.coerce.boolean()`, nunca um `z.number()` cru. E o
objeto devolvido leva `Object.freeze` — o ambiente é só de leitura por desenho;
se precisas de algo mutável, é para isso que existe o repositório de config.

Nos testes, aponta-o para outro lado em vez de alterares o `process.env`:

```ts
const env = defineEnv(
  { DATABASE_URL: z.string().url() },
  { source: { DATABASE_URL: 'postgres://localhost:5432/app' } },
)
```

## Segredos que falham fechados

O `secret()` é um schema Zod de string para chaves de assinatura e credenciais
de API, com uma política de produção já embutida:

```ts
export const env = defineEnv({
  // Arranca logo em dev; recusa arrancar em produção sem um valor real.
  APP_SECRET: secret({ minLength: 32, devDefault: 'dev-only-insecure-secret-value' }),
  // Sem devDefault: obrigatório em qualquer ambiente.
  STRIPE_SECRET_KEY: secret(),
})
```

Três regras, decididas lendo `process.env.NODE_ENV` no momento da validação:

- **Obrigatório em produção** — o `devDefault` nunca é aplicado quando
  `NODE_ENV=production`. Um clone acabado de fazer corre localmente; o mesmo
  código recusa arrancar em produção enquanto não existir um segredo a sério.
- **Placeholders recusados em produção** — um valor que corresponda a
  `change-me`, `changeme`, `placeholder`, `example`, `secret`, `password`,
  `default`, `test`, `xxxx…` ou `0000…` falha. Em desenvolvimento passam, por
  conveniência.
- **Comprimento mínimo em todo o lado** — 16 caracteres por predefinição,
  incluindo para o próprio `devDefault`, que é validado como qualquer outro
  valor.

Gera um a sério com `openssl rand -base64 48`. Vê o
[guia de segurança](/pt/guide/security) para o resto da checklist de produção.

## Fatias de config por plugin

Separado de tudo o acima, o `createApp({ config })` passa uma **fatia em bruto
por nome de plugin** ao ciclo de vida desse plugin, validada pelo `configSchema`
do próprio plugin antes de o `register` correr:

```ts
await createApp({
  config: { 'basalt:cache': { driver: 'memory' } },
  plugins: [cachePlugin()],
}).boot()
```

Uma fatia inválida lança `ConfigValidationError` (`CONFIG_INVALID`) no boot,
nomeando o plugin. A maioria dos plugins Basalt recebe as suas opções por
argumento (`cachePlugin({ … })`) e não por este canal — ele existe para plugins
que queiram a configuração declarada centralmente, e não tem relação com o
repositório `CONFIG`. Vê [Conceitos Fundamentais](/pt/guide/concepts).

## Fontes e precedência

Nada é implícito, por isso a precedência é apenas ordem de avaliação — a última
escrita ganha:

1. **`configPlugin(values)`** — a base, clonada em profundidade no boot.
2. **`config.merge(overrides)`** — sobreposta depois do boot (overrides de
   deployment ou por ambiente); objetos simples fundem-se em profundidade, tudo
   o resto substitui.
3. **`config.set(path, value)`** — uma única chave, a última palavra.
4. **`config.get(path, fallback)`** — a predefinição no local de leitura, usada
   *apenas* quando o caminho está completamente ausente. Nunca sobrepõe um valor
   guardado, nem sequer `null`.

As variáveis de ambiente não têm precedência independente: entram no passo 1,
onde as puseres.

## Referência de opções

`configPlugin(values?)` — regista o `ConfigRepository` como singleton sob
`CONFIG`, nome de plugin `basalt:config`:

| Opção | Tipo | Predefinição | Objetivo |
| --- | --- | --- | --- |
| `values` | `Record<string, unknown>` | `{}` | Árvore inicial de definições. Leva `structuredClone`, por isso só pode conter dados clonáveis — sem funções, instâncias de classes ou símbolos |

`ConfigRepository`:

| Método | Assinatura | Objetivo |
| --- | --- | --- |
| `get` | `get<T>(path, fallback?): T` | Leitura por dot-path. Sem chave **e** sem fallback → `ConfigKeyError` |
| `has` | `has(path): boolean` | Verificação de existência que nunca lança — usa-a para ramificar em funcionalidades opcionais |
| `set` | `set(path, value): void` | Escreve um caminho, criando objetos intermédios; recusa chaves inseguras |
| `merge` | `merge(values): void` | Funde objetos simples em profundidade sobre a árvore atual; descarta chaves inseguras em silêncio |
| `all` | `all(): Readonly<Record<string, unknown>>` | A árvore toda — para diagnósticos e logs de arranque (redige os segredos primeiro) |

`defineEnv(shape, options?)` — devolve um `z.infer` congelado do shape:

| Opção | Tipo | Predefinição | Objetivo |
| --- | --- | --- | --- |
| `shape` | `z.ZodRawShape` | — | Um schema Zod por variável. Usa `z.coerce.*` — todos os valores chegam como string |
| `options.source` | `Record<string, string \| undefined>` | `process.env` | Ler de outro sítio — testes, ou um gestor de segredos que carregaste tu |

`secret(options?)` — devolve `z.ZodType<string>`:

| Opção | Tipo | Predefinição | Objetivo |
| --- | --- | --- | --- |
| `minLength` | `number` | `16` | Comprimento mínimo em **todos** os ambientes, `devDefault` incluído. Sobe-o para chaves de assinatura JWT (32+) |
| `devDefault` | `string` | — | Valor usado fora de produção quando a variável não está definida, para um clone novo correr. Nunca aplicado com `NODE_ENV=production` |

## Modos de falha e resolução de problemas

| Erro | Código | HTTP | Quando |
| --- | --- | --- | --- |
| `ConfigKeyError` | `CONFIG_KEY_MISSING` | — | `get(path)` com um argumento e o caminho ausente |
| `ConfigUnsafeKeyError` | `CONFIG_UNSAFE_KEY` | — | `set()` num caminho que contém `__proto__`, `constructor` ou `prototype` |
| `EnvValidationError` | `ENV_INVALID` | boot | Uma ou mais variáveis falharam o `defineEnv`; o `error.report` lista todas |
| `ConfigValidationError` | `CONFIG_INVALID` | boot | Uma fatia de `createApp({ config })` falhou o `configSchema` desse plugin |
| `UnknownTokenError` | `DI_UNKNOWN_TOKEN` | — | `container.get(CONFIG)` sem o `configPlugin` em `plugins`, ou um consumidor que se registou primeiro |
| `DataCloneError` | — | boot | `configPlugin(values)` em que `values` contém uma função, instância de classe ou símbolo — o `structuredClone` recusa |

- **`CONFIG_KEY_MISSING` para uma chave que está de certeza no meu `.env`** —
  nada mapeia variáveis de ambiente para caminhos de config automaticamente. Lê
  a variável com o `defineEnv` e põe-na tu no objeto de definições.
- **O `get` devolve `undefined` em vez de lançar** — passaste `undefined` como
  segundo argumento explícito; o fallback é detetado pela aridade. Tira o
  argumento.
- **`ENV_INVALID` em produção com o mesmo `.env` que funciona localmente** — o
  `secret()` muda de regras com `NODE_ENV=production`: o `devDefault` deixa de
  se aplicar e valores com ar de placeholder são recusados. Confirma o que é
  realmente o `NODE_ENV` nesse ambiente.
- **O `merge` apagou o meu array** — só objetos simples se fundem em
  profundidade; arrays e primitivos são substituídos por inteiro.
- **`DI_UNKNOWN_TOKEN` num plugin que lê o `CONFIG`** — acrescenta
  `dependsOn: ['basalt:config']` para que se registe depois do `configPlugin`.

## Para onde a seguir

- [Conceitos Fundamentais](/pt/guide/concepts) — o container, o token `CONFIG` e
  o ciclo de vida dos plugins que determina a ordem de leitura.
- [Começar](/pt/guide/getting-started) — o `src/env.ts` gerado, que é
  exatamente este padrão.
- [Segurança](/pt/guide/security) — rotação de segredos, headers e a checklist
  de produção.
- [Produção](/pt/guide/production) — deploy com config vinda do ambiente.
