import { describe, it } from 'vitest'
import { MemoryDomainStore } from '../src/index.js'
import { domainStoreContract } from '../src/testing.js'

describe('MemoryDomainStore honours the DomainStore contract', () => {
  for (const c of domainStoreContract(() => new MemoryDomainStore())) it(c.name, c.run)
})
