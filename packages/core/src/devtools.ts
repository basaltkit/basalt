import type { DependencyGraph } from './container.js'

/**
 * Render a {@link DependencyGraph} as a Mermaid `graph TD` — drop it into a
 * Markdown viewer (or an artifact) to see how the container's services wire
 * together. Pair with `container.enableGraph()` + `container.dependencyGraph()`.
 */
export function renderDependencyGraph(graph: DependencyGraph): string {
  const idOf = (token: string): string => `n_${token.replace(/[^a-zA-Z0-9_]/g, '_')}`
  const lines = ['graph TD']
  for (const node of graph.nodes) {
    lines.push(`  ${idOf(node.token)}["${node.token}<br/>(${node.lifetime})"]`)
  }
  for (const edge of graph.edges) {
    lines.push(`  ${idOf(edge.from)} --> ${idOf(edge.to)}`)
  }
  return lines.join('\n')
}
