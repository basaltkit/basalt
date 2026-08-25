# Novidades no Basalt 1.4

> *"Basalt 1.4" é o rótulo umbrella desta vaga de trabalho; os pacotes
> `@basaltkit/*` são versionados de forma independente (ver
> [Versionamento](/pt/guide/versioning)). Abaixo está o que entrou e a versão do
> pacote que o traz.*

O Basalt 1.4 é uma release de fundações e endurecimento: moderniza a toolchain,
devolve dentes reais aos gates de qualidade e segurança, e gradua a superfície de
IA para um 1.0 estável.

## Destaques

### Toolchain TypeScript 7
- **Todo o monorepo compila, faz type-check e testa no compilador nativo do
  TypeScript 7.** O build de cada pacote passou de `tsup` para `tsc` puro —
  abandonando o `rollup-plugin-dts`, incompatível com o compilador do TS 7 — sem
  alterar os contratos `exports`/`types` publicados. O lint mantém-se no TypeScript
  que suporta até o `typescript-eslint` suportar o TS 7.

### IA & MCP → 1.0
- **`@basaltkit/ai` 1.0** — a experiência de desenvolvimento IA (dev-only): um motor
  agnóstico de provider mais o CLI `basalt ai` (`analyze`, `doctor`, `plan`, `make`,
  `review`), agora com API pública estável. Continua dev-only — nunca uma dependência
  de runtime da tua app. *(`@basaltkit/ai` 1.0)*
- **`@basaltkit/mcp` 1.0** — a superfície de runtime do Model Context Protocol:
  expõe rotas opt-in como ferramentas sobre **HTTP (qualquer adaptador)** ou
  **stdio**, e consome servidores MCP externos como cliente — tudo pela pipeline
  neutra de rotas, sem SDK externo. *(`@basaltkit/mcp` 1.0)*

### Gate de qualidade
- **O gate de cobertura volta a ser imposto.** Tinha ficado informativo; agora
  bloqueia regressões, focado em código de runtime testável por unidade (o tooling
  de CLI dev-only e os drivers de infra-live ficam fora de âmbito). Agregado real no
  re-baseline: statements 93% · branches 85% · funções 91% · linhas 95%.

### Endurecimento de segurança
- **Todos os achados de ReDoS alcançáveis em runtime foram eliminados.** As remoções
  quadráticas de caracteres finais foram reescritas como trims lineares sem regex em
  `audit`, `tenancy`, `mailer`, `auth`, `sdk` e `search-elasticsearch`, e o redator
  de PII limita o comprimento do input antes de correr a regex — cada um com um teste
  de regressão que prova que um input patológico retorna prontamente. O backlog de
  code-scanning está em **zero alertas abertos**. *(releases de correção nos pacotes
  afetados)*

## Atualização

Os pacotes são independentes — sobe só o que usas; os intervalos são semver, por isso
um minor `1.x` é drop-in e o `@basaltkit/ai` / `@basaltkit/mcp` atingem o primeiro
`1.0` estável. Não há mudanças de runtime disruptivas nesta vaga: a mudança de
toolchain é interna e as correções de segurança preservam o comportamento existente
(toda a remoção de caracteres finais e a deteção de email comportam-se exatamente
como antes, só que sem o backtracking quadrático).
