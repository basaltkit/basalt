# Log de atividade

O [`@basaltkit/activity`](/reference/packages/activity) grava um feed legível por
pessoas — "a Maria publicou o projeto X há 5 minutos" — automaticamente associado ao
utilizador e tenant atuais. Ideal para uma timeline de projeto, um perfil, ou um
dashboard de equipa.

## Registar uma ação

Regista o plugin, depois escreve com uma one-liner fluente. Dentro de um pedido, o
**causer** (utilizador) e o **tenant** vêm do contexto — não os passas:

```ts
import { ACTIVITY, activityPlugin } from '@basaltkit/activity'

const app = await createApp({ plugins: [activityPlugin()] }).boot()
const activity = app.container.get(ACTIVITY)

// dentro de um pedido / runWithContext({ user, tenant })
await activity
  .in('project')                              // o nome do log
  .performedOn('project', 'p1')               // o subject
  .withProperties({ from: 'draft', to: 'published' })
  .log('published')                           // descrição + guarda
// → { description: 'published', causerId: 'u1', tenantId: 'acme', ... }
```

Precisas de atribuir uma ação a alguém que não o utilizador do contexto? Encadeia
`.causedBy(userId)` antes do `.log(...)`.

## Ler o feed

```ts
const projectFeed = await activity.for('project', 'p1') // mais recente primeiro (limite 20)
const daMaria      = await activity.byCauser('u1')      // tudo o que um utilizador fez
const projectLog   = await activity.inLog('project')    // um log nomeado inteiro
```

Cada registo leva `causerId`, o subject (`subjectType`/`subjectId`), a `description`,
as `properties` e um timestamp — o suficiente para renderizar "quem fez o quê, sobre o
quê, quando".

## Scoping por tenant

Numa app multi-tenant, um feed nunca pode vazar atividade de outra organização.
As escritas preenchem o `tenantId` a partir do contexto automaticamente, e as
queries são scoped ao tenant em contexto.

**Com o `@basaltkit/tenancy` registado, uma query que não resolva tenant lança**
em vez de responder com os registos de todos — o `activityPlugin` escolhe
`tenantScoped: 'required'` por ti, a menos que digas outra coisa. Uma linha de
feed não é um número agregado: lê-se *«a Dra. Kiala abriu o caso 2026/014 para a
Kwanza Lda»*, que é o cliente de outro escritório, pelo nome, em texto.

Uma app single-tenant não tem dimensão de tenant e fica como estava. Uma consola
de operador que queira mesmo ler através de tenants diz `tenantScoped: false` e
é obedecida; passar um `tenantId` explícito na query também salta o scoping
automático.

## Registar a partir de eventos de domínio

Ligar um feed à mão é um `hooks.on(...)` por evento, e puxa-te para chamar o
`activity` de dentro dos teus serviços. O `activityRule` mantém-nos separados —
**o domínio emite, este pacote escuta, e nenhum conhece o outro** — com a mesma
forma do `syncRule` do [search](/pt/guide/search) e do `bridgeRule` do
[realtime](/pt/guide/realtime).

```ts
import { activityPlugin, activityRule } from '@basaltkit/activity'

activityPlugin({
  rules: [
    activityRule({
      hook: 'matter:opened',
      log: 'matters',
      subject: ({ matter }) => ({ type: 'matter', id: matter.id }),
      description: ({ matter }) => `abriu o caso ${matter.number}`,
      causer: ({ by }) => by,
    }),
  ],
})
```

Um `description` que devolva `null` não regista nada, portanto um hook pode
produzir linha só para os eventos que a merecem.

::: tip Uma regra nunca derruba quem emitiu
O `HookBus` propaga a falha de um handler a quem emitiu o evento. Isso está
certo para uma trilha de auditoria — um facto que não se conseguiu registar não
pode ser reportado como registado — e errado aqui: uma linha de histórico que
não se consegue escrever não pode fazer falhar o encerramento do caso que a
produziu. As falhas vão para o `onRuleError`, que por omissão avisa na consola.
:::

## Persistir

O store por omissão é em memória. Em produção fornece um `ActivityStore` durável
(`activityPlugin({ store })`) — implementa `save`/`query`, ou usa um store baseado em
Prisma/SQLite do ecossistema. Vê a [referência do pacote](/reference/packages/activity).
