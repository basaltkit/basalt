import type { DependencyGraph } from './container.js'

/**
 * Render a {@link DependencyGraph} as a Mermaid `graph TD` — drop it into a
 * Markdown viewer (or an artifact) to see how the container's services wire
 * together. Pair with `container.enableGraph()` + `container.dependencyGraph()`.
 */
export function renderDependencyGraph(graph: DependencyGraph): string {
  const idOf = (token: string): string => `n_${token.replace(/[^a-zA-Z0-9_]/g, '_')}`
  // Token descriptions are usually developer constants, but a codebase that
  // mints tokens from user/tenant-derived names would otherwise let a label
  // break out of the Mermaid node (`"`/`]`) or inject live HTML (Mermaid renders
  // htmlLabels). Neutralise the label so the diagram is inert wherever it renders.
  const label = (token: string): string =>
    token.replace(/[\\<>"&[\]|{}]/g, (ch) => `#${ch.charCodeAt(0)};`)
  const lines = ['graph TD']
  for (const node of graph.nodes) {
    lines.push(`  ${idOf(node.token)}["${label(node.token)}<br/>(${label(node.lifetime)})"]`)
  }
  for (const edge of graph.edges) {
    lines.push(`  ${idOf(edge.from)} --> ${idOf(edge.to)}`)
  }
  return lines.join('\n')
}
