import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { memoryDataSource } from '../src/index.js'

/**
 * F-14 · The package must import cleanly in a browser bundle.
 *
 * This package calls itself "the engine any React admin renders" and has two
 * React bindings (`admin-react`, `admin-shadcn`). Its destination is the
 * browser. It nonetheless imported `node:crypto` — used once, to mint an id in
 * `memoryDataSource` — and the barrel re-exports that module, so importing
 * `defineResource` dragged a Node builtin into the bundle.
 *
 * That is not degradation: bundlers fail outright. Every application using this
 * package had to alias `node:crypto` to a shim of its own.
 */
describe('F-14 · no Node builtins reach the bundle', () => {
  it('no source file imports from node:', () => {
    // The regression guard the whole fix exists for. A single `node:` import
    // anywhere in `src` breaks every consumer's build, and the failure appears
    // in *their* bundler — far from the line that caused it.
      // Walked with `node:fs` rather than `import.meta.glob`: the glob is a
      // Vite API that `tsc --noEmit` does not know about, and a test guarding
      // the build should not itself fail the typecheck.
      const src = new URL('../src/', import.meta.url).pathname
      const offenders = readdirSync(src, { recursive: true })
        .map(String)
        .filter((path) => path.endsWith('.ts'))
        .filter((path) => /from ['"]node:/.test(readFileSync(join(src, path), 'utf8')))

    expect(offenders).toEqual([])
  })
})

describe('F-14 · memoryDataSource still mints usable ids', () => {
  it('generates a distinct id per record', async () => {
    const source = memoryDataSource<{ id: string; nome: string }>()
    const a = await source.create({ nome: 'a' })
    const b = await source.create({ nome: 'b' })

    expect(a.id).toBeTruthy()
    expect(b.id).toBeTruthy()
    expect(a.id).not.toBe(b.id)
  })

  it('keeps an id the caller supplied', async () => {
    const source = memoryDataSource<{ id: string; nome: string }>()
    const r = await source.create({ id: 'escolhido', nome: 'a' })
    expect(r.id).toBe('escolhido')
  })

  it('works where crypto.randomUUID does not exist', async () => {
    /**
     * `crypto.randomUUID()` requires a **secure context**: it is undefined on
     * plain http, which is exactly how a developer reaches a dev server from a
     * phone on the local network. Swapping one unavailable API for another
     * would have moved the failure rather than fixed it.
     */
    const original = globalThis.crypto
    try {
      Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true })

      const source = memoryDataSource<{ id: string; nome: string }>()
      const a = await source.create({ nome: 'a' })
      const b = await source.create({ nome: 'b' })

      expect(a.id).toBeTruthy()
      expect(a.id).not.toBe(b.id)
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: original, configurable: true })
    }
  })
})
