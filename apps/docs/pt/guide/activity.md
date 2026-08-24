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

Numa app multi-tenant, um feed nunca pode vazar atividade de outra organização. Por
omissão as queries são **scoped ao tenant em contexto** (`tenantScoped: true`): dentro
do tenant `acme` só vês registos `acme`; a partir de um contexto central/admin (sem
tenant) vês tudo. As escritas preenchem `tenantId` a partir do contexto automaticamente.

## Persistir

O store por omissão é em memória. Em produção fornece um `ActivityStore` durável
(`activityPlugin({ store })`) — implementa `save`/`query`, ou usa um store baseado em
Prisma/SQLite do ecossistema. Vê a [referência do pacote](/reference/packages/activity).
