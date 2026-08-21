# Versionamento & compatibilidade

O que o Basalt promete sobre versões, runtimes e mudança — para que possas
depender dele sem surpresas.

[[toc]]

## Versionamento semântico

Cada pacote `@basaltkit/*` segue [semver](https://semver.org). A partir da **1.0**,
a API pública é **estável**: breaking changes apenas num novo **major**, novas
funcionalidades num **minor**, e correções num **patch**. Podes depender de um
intervalo `^1` e obter funcionalidades e correções sem quebras até ao próximo major.

## Versões dos pacotes & a release do Basalt

O versionamento funciona em dois níveis, de propósito:

- **Cada pacote `@basaltkit/*` é versionado de forma independente.** Um pacote
  incrementa o seu próprio semver só quando *ele* muda, por isso o
  `@basaltkit/subscriptions` pode estar em `2.x` enquanto o `@basaltkit/core`
  ainda está em `1.x`. Depende de cada um com um range `^`; cada pacote é
  construído e testado contra o `@basaltkit/core` atual. A versão exata e atual de
  cada pacote está na página [Ecossistema](./ecosystem).
- **O framework como um todo tem uma "release do Basalt"** — atualmente **1.1**
  (o número no nav). É um marcador amigável para uma *geração* do framework, usado
  apenas para comunicação e para estes docs — a `1.0` foi a primeira release
  estável, a `1.1` a vaga de reforço de segurança. **Não** é a versão de nenhum
  pacote em particular.

::: tip De que número dependo?
Depende das versões dos **pacotes** — são essas que o npm instala e resolve. O
número da **release do Basalt** (ex.: "Basalt 1.1") é só uma etiqueta amigável
para "que geração do framework estes docs descrevem".
:::

## Suporte de runtime

| Aspeto | Política |
| --- | --- |
| **Node.js** | **22 ou mais recente.** O CI testa em Node 22 e 24. |
| **Stores `node:sqlite`** | Os pacotes de store `*-sqlite` precisam de **Node 22.5+**; estáveis e sem flag no Node 24, e no 22.x requerem `--experimental-sqlite`. Declaram `engines.node >= 22.5.0`. |
| **Módulos** | **Apenas ESM.** Cada pacote inclui `"type": "module"` com exports apenas de `import` — não há build CommonJS. Usa ESM (ou um bundler) na tua app. |
| **TypeScript** | Os tipos vêm com cada pacote. `exactOptionalPropertyTypes` e a família strict são honrados, por isso os tipos são seguros de consumir em modo strict. |
| **Gestor de pacotes** | O repositório usa pnpm, mas qualquer gestor serve para consumir os pacotes publicados. |

Se não usares os pacotes `*-sqlite`, Node 22+ é suficiente; esses são os únicos
pacotes que requerem 22.5+.

## Política de deprecação

Agora que a 1.0 foi lançada, nada na API pública é removido sem aviso:

1. Um símbolo marcado para remoção é assinalado como `@deprecated` no seu JSDoc,
   com o substituto nomeado, num release **minor**.
2. Continua a funcionar durante o resto da linha `1.x`.
3. Só é removido no **próximo major** (`2.0`).

"API pública" significa cada export de topo de um pacote. Qualquer coisa marcada
como `@internal`, ou não exportada do ponto de entrada do pacote, não está coberta
por esta política e pode mudar a qualquer momento.

## Atualizar a partir de 0.x

**A 1.0 é um compromisso de estabilidade, não uma reescrita** — é funcionalmente
idêntica à `0.32.0`, sem breaking changes. A migrar de qualquer `0.x` recente:

- Sobe todas as dependências `@basaltkit/*` para `1.0.0` em conjunto (lançam em
  lockstep) e fixa um intervalo `^1` daí em diante.
- Se estiveres nos stores duráveis, nada muda — os contratos dos stores já
  estavam na sua forma 1.0 e estão agora congelados.
- É tudo. Daqui em diante, `^1` dá-te funcionalidades e correções sem quebras.

## Segurança & versões suportadas

As correções de segurança aterram no minor `1.x` mais recente — atualiza para o
`1.x` mais novo para as receber. Ver [SECURITY.md](https://github.com/Zebedeu/basalt/blob/main/SECURITY.md)
para o processo de divulgação.
