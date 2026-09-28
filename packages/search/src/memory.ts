import type { IndexDefinition, SearchDocument, SearchDriver, SearchQuery, SearchResult } from './types.js'

const tokenize = (text: string): string[] => text.toLowerCase().match(/[a-z0-9]+/g) ?? []
const docKey = (tenantId: string, id: string): string => `${tenantId}\u0000${id}`

/**
 * In-process full-text driver for dev and tests — no external engine. Scores by
 * term frequency with prefix matching, requires every query term to match (AND
 * semantics), scopes results to the query's tenant, and supports exact-match
 * filters. Good enough for development; swap in {@link MeilisearchDriver} for
 * production-scale relevance.
 */
export class MemorySearchDriver implements SearchDriver {
  private readonly documents = new Map<string, Map<string, SearchDocument>>()
  private readonly configs = new Map<string, IndexDefinition>()

  async register(index: IndexDefinition): Promise<void> {
    this.configs.set(index.name, index)
    if (!this.documents.has(index.name)) this.documents.set(index.name, new Map())
  }

  async index(indexName: string, document: SearchDocument): Promise<void> {
    this.store(indexName).set(docKey(document.tenantId, document.id), document)
  }

  async bulk(indexName: string, documents: SearchDocument[]): Promise<void> {
    for (const document of documents) await this.index(indexName, document)
  }

  async remove(indexName: string, tenantId: string, id: string): Promise<void> {
    this.store(indexName).delete(docKey(tenantId, id))
  }

  async clear(indexName: string): Promise<void> {
    this.documents.set(indexName, new Map())
  }

  async clearTenant(indexName: string, tenantId: string): Promise<void> {
    const store = this.store(indexName)
    for (const [key, document] of store) {
      if (document.tenantId === tenantId) store.delete(key)
    }
  }

  async search(indexName: string, query: SearchQuery): Promise<SearchResult> {
    const fields = this.searchableFields(indexName)
    const terms = tokenize(query.q)

    const scored: { id: string; score: number; document: SearchDocument }[] = []
    for (const document of this.store(indexName).values()) {
      if (document.tenantId !== query.tenantId) continue
      if (!this.passesFilters(document, query.filters)) continue

      const score = this.score(document, fields, terms)
      if (score < 0) continue // a required term didn't match
      scored.push({ id: document.id, score, document })
    }

    scored.sort((a, b) => b.score - a.score)
    const offset = query.offset ?? 0
    const limit = query.limit ?? 20
    return { hits: scored.slice(offset, offset + limit), total: scored.length }
  }

  private score(document: SearchDocument, fields: string[], terms: string[]): number {
    if (terms.length === 0) return 0 // empty query matches everything (listing)
    const tokens = tokenize(fields.map((field) => String(document[field] ?? '')).join(' '))
    let total = 0
    for (const term of terms) {
      let termScore = 0
      for (const token of tokens) {
        if (token === term) termScore += 2
        else if (token.startsWith(term)) termScore += 1
      }
      if (termScore === 0) return -1 // AND: every term must match
      total += termScore
    }
    return total
  }

  private passesFilters(document: SearchDocument, filters: Record<string, unknown> | undefined): boolean {
    if (!filters) return true
    for (const [field, value] of Object.entries(filters)) {
      const actual = document[field]
      if (Array.isArray(value) ? !value.includes(actual) : actual !== value) return false
    }
    return true
  }

  private searchableFields(indexName: string): string[] {
    const config = this.configs.get(indexName)
    if (config) return config.fields
    // No registered config → search every string field except the identifiers.
    const sample = this.store(indexName).values().next().value as SearchDocument | undefined
    if (!sample) return []
    return Object.keys(sample).filter((k) => k !== 'id' && k !== 'tenantId' && typeof sample[k] === 'string')
  }

  private store(indexName: string): Map<string, SearchDocument> {
    let store = this.documents.get(indexName)
    if (!store) {
      store = new Map()
      this.documents.set(indexName, store)
    }
    return store
  }
}
