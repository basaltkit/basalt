# @machize/config

Configuração central e organizada por espaços de nomes para aplicações Machize, com leitura por "caminho com pontos" (`config.get('mail.from')`). Precisas dele quando queres um único sítio para guardar e consultar as definições da tua aplicação (endereços, portas, opções de serviços).

## O que este módulo resolve

Quase todas as aplicações têm definições: o remetente dos e-mails, a porta do servidor SMTP, o driver da fila de trabalhos, etc. Sem um sistema, estas definições ficam espalhadas por constantes, ficheiros soltos e objetos passados de mão em mão — e ninguém sabe onde está o valor "verdadeiro".

O `@machize/config` dá-te um repositório único: o `ConfigRepository`. Colocas lá um objeto com todas as definições, organizado por áreas (`mail`, `queue`, `app`, …), e depois lês qualquer valor com um caminho simples separado por pontos, como `mail.smtp.port`. Se pedires uma chave que não existe e não deres um valor de recurso (*fallback*), o repositório lança um erro claro em vez de devolver `undefined` silenciosamente — apanhas o problema cedo.

O pacote inclui ainda o `configPlugin`, que liga o repositório à aplicação Machize (do `@machize/core`): o repositório fica registado no *container* (a "caixa" de serviços partilhados) e qualquer plugin o pode ir buscar através do token `CONFIG`.

## Instalação

```bash
pnpm add @machize/config
```

O pacote depende de `@machize/core` (instalado automaticamente como dependência).

## Começar em 5 minutos

1. Define as tuas configurações num objeto normal.
2. Adiciona o `configPlugin` à aplicação.
3. Lê valores em qualquer plugin através do token `CONFIG`.

```ts
import { createApp, definePlugin } from '@machize/core'
import { CONFIG, configPlugin } from '@machize/config'

// 1. As definições da aplicação, organizadas por áreas:
const definicoes = {
  app: { name: 'a-minha-app' },
  mail: { from: 'oi@machize.dev', smtp: { port: 587 } },
}

// 2. Um plugin qualquer que lê a configuração:
const mailPlugin = definePlugin({
  name: 'app:mail',
  dependsOn: ['machize:config'], // garante que a config regista primeiro
  boot({ container }) {
    const config = container.get(CONFIG)
    console.log(config.get('mail.from'))            // 'oi@machize.dev'
    console.log(config.get('mail.smtp.port'))       // 587
    console.log(config.get('mail.replyTo', 'n/a'))  // 'n/a' (fallback)
  },
})

// 3. Arranca a aplicação com o plugin de configuração:
await createApp({
  plugins: [configPlugin(definicoes), mailPlugin],
}).boot()
```

Nota: o `configPlugin` faz uma cópia profunda (`structuredClone`) do objeto que lhe passas — alterações posteriores no repositório não afetam o objeto original, e vice-versa.

## Guia de utilização

### Usar o `ConfigRepository` diretamente (sem aplicação)

Podes usar o repositório sozinho, por exemplo em scripts ou testes:

```ts
import { ConfigRepository } from '@machize/config'

const config = new ConfigRepository({
  mail: { from: 'oi@machize.dev', smtp: { port: 587 } },
})

config.get('mail.from')          // 'oi@machize.dev'
config.has('queue.driver')       // false
config.get('mail.replyTo', 'x')  // 'x' — fallback quando a chave falta
config.get('mail.replyTo')       // lança ConfigKeyError (sem fallback)
```

### Escrever e fundir valores

`set` cria os níveis intermédios automaticamente; `merge` faz uma fusão profunda (*deep merge*) sem apagar as chaves vizinhas:

```ts
import { ConfigRepository } from '@machize/config'

const config = new ConfigRepository({
  mail: { from: 'oi@machize.dev', smtp: { port: 587 } },
})

// set: cria 'queue' e depois 'queue.driver'
config.set('queue.driver', 'bullmq')
config.get('queue.driver') // 'bullmq'

// merge: acrescenta 'host' sem apagar 'port'
config.merge({ mail: { smtp: { host: 'smtp.acme.com' } } })
config.get('mail.smtp.port') // 587 — continua lá
config.get('mail.smtp.host') // 'smtp.acme.com'

// all(): o objeto completo (só leitura por convenção)
console.log(config.all())
```

Atenção: no `merge`, arrays e valores simples são **substituídos**, não fundidos — só objetos simples são fundidos em profundidade.

### Tipar os teus espaços de nomes (Avançado)

Pacotes e aplicações podem declarar o formato do seu espaço de nomes através de *module augmentation* (uma técnica do TypeScript para estender interfaces de outro módulo):

```ts
declare module '@machize/config' {
  interface MachizeConfig {
    mail: { from: string }
  }
}
```

Isto documenta e tipa o namespace `mail` para quem usar a interface `MachizeConfig`.

## Referência da API

### `ConfigRepository`

`new ConfigRepository(values?)` — `values` é o objeto inicial (default `{}`). O objeto é usado tal e qual (sem cópia); se quiseres isolamento, passa uma cópia ou usa o `configPlugin`.

| Método | Parâmetros | Devolve | Descrição |
|---|---|---|---|
| `get<T>(path, fallback?)` | `path: string`, `fallback?: T` | `T` | Lê por caminho com pontos. Sem a chave **e** sem fallback, lança `ConfigKeyError`. O fallback conta mesmo que seja `undefined` (basta passares o 2.º argumento). |
| `has(path)` | `path: string` | `boolean` | `true` se o caminho existir. |
| `set(path, value)` | `path: string`, `value: unknown` | `void` | Escreve, criando níveis intermédios se necessário. |
| `merge(values)` | `values: Record<string, unknown>` | `void` | Fusão profunda de objetos simples por cima dos valores atuais. |
| `all()` | — | `Readonly<Record<string, unknown>>` | Todos os valores. |

### `configPlugin(values?)`

| Parâmetro | Tipo | Obrigatório? | Default | Descrição |
|---|---|---|---|---|
| `values` | `Record<string, unknown>` | não | `{}` | Valores iniciais; são clonados com `structuredClone`. |

Devolve um plugin Machize com `name: 'machize:config'` que, na fase `register`, regista um `ConfigRepository` como *singleton* no container sob o token `CONFIG`.

### `CONFIG`

Token de injeção de dependências (`Token<ConfigRepository>`) para obter o repositório: `container.get(CONFIG)`.

### `ConfigKeyError`

Erro lançado por `get()` sem fallback. Estende `MachizeError` do core, com `code: 'CONFIG_KEY_MISSING'` e mensagem que inclui o caminho em falta.

### `MachizeConfig` (Avançado)

Interface vazia extensível por *module augmentation* para tipar espaços de nomes (ver acima).

## Erros comuns e soluções (FAQ)

**"Missing configuration key: …" (`CONFIG_KEY_MISSING`)** — Pediste uma chave que não existe e não deste fallback. Ou defines o valor no objeto inicial, ou passas um segundo argumento: `config.get('mail.replyTo', 'valor-por-omissao')`.

**`get` devolve `undefined` em vez de lançar erro** — Provavelmente passaste `undefined` explicitamente como fallback: `get(path, undefined)` conta como "tem fallback" (a verificação é pelo número de argumentos). Chama `get(path)` só com um argumento para obteres o erro.

**O `merge` apagou o meu array/valor** — O `merge` só funde objetos simples; arrays e primitivos são substituídos por inteiro. Se precisares de acrescentar a um array, lê-o com `get`, altera-o e grava com `set`.

**Alterei a config mas o objeto original não mudou (ou vice-versa)** — Com o `configPlugin`, os valores são clonados no arranque; é o comportamento esperado. Usa `container.get(CONFIG)` como única fonte de verdade depois do arranque.

**`container.get(CONFIG)` lança `DI_UNKNOWN_TOKEN`** — O `configPlugin` não foi adicionado à aplicação, ou o teu plugin correu antes dele. Adiciona `configPlugin(...)` a `plugins` e declara `dependsOn: ['machize:config']` no plugin consumidor.

## Como se liga aos outros módulos

- **`@machize/core`** — é a base: o `configPlugin` é um plugin do core, o `CONFIG` é um token do container do core, e o `ConfigKeyError` estende `MachizeError`. Nota: isto é diferente do `configSchema` dos plugins do core — o `configSchema` valida a fatia de config **de um plugin** no arranque; o `@machize/config` é um repositório de leitura/escrita para **toda** a aplicação.
- **`@machize/env`** — combinação típica: valida as variáveis de ambiente com `defineEnv` e usa esses valores para construir o objeto que passas ao `configPlugin` (ambiente → configuração).
- **`@machize/events`** — não há ligação direta, mas ambos seguem o mesmo padrão: um plugin que regista um serviço singleton no container (`EVENTS` / `CONFIG`).
