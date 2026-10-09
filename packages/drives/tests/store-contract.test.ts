import { describe, it } from 'vitest'
import { MemoryDriveConnectionStore, MemoryDriveImportLedger } from '../src/store.js'
import { runDriveStoreContract } from '../src/testing.js'

runDriveStoreContract(
  () => ({ store: new MemoryDriveConnectionStore(), ledger: new MemoryDriveImportLedger() }),
  { describe, it },
  { name: 'Memory drive stores satisfy the store contract' },
)
