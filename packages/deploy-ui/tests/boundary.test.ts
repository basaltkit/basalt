import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The package's boundaries (RFC 0009 §3.1, §9): it loads only the deploy's
 * pure protocol module, its browser code only as types, and the browser code
 * has no HTML sink at all.
 */
const SRC = join(import.meta.dirname, '..', 'src')
const CLIENT = join(SRC, 'client')

async function files(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...await files(path))
    else if (entry.name.endsWith('.ts')) out.push(path)
  }
  return out
}

const importsOf = (source: string) => [...source.matchAll(/^\s*(import|export)\s+(type\s+)?[^'"]*?from\s+'([^']+)'/gm)].map((m) => ({ typeOnly: Boolean(m[2]), from: m[3] as string, line: m[0] }))

describe('dependency boundaries', () => {
  it('only @basaltkit/deploy/protocol from the deploy — never the CLI or the pipeline', async () => {
    for (const file of await files(SRC)) {
      const source = await readFile(file, 'utf8')
      for (const { from } of importsOf(source)) {
        if (from.startsWith('@basaltkit/')) expect(from, file).toBe('@basaltkit/deploy/protocol')
        expect(from.startsWith('.') || from.startsWith('node:') || from === '@basaltkit/deploy/protocol', `${file}: ${from}`).toBe(true)
      }
      expect(source, file).not.toMatch(/import\(\s*['"]/)
    }
    const pkg = JSON.parse(await readFile(join(SRC, '..', 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
    expect(pkg.dependencies).toEqual({ '@basaltkit/deploy': 'workspace:^' })
  })

  it('the browser code: types only from the protocol, no Node API, no HTML sink, no eval, no inline style', async () => {
    for (const file of await files(CLIENT)) {
      const source = await readFile(file, 'utf8')
      for (const { typeOnly, from, line } of importsOf(source)) {
        if (!from.startsWith('.')) {
          expect(typeOnly, `${file}: ${line}`).toBe(true)
          expect(from).toBe('@basaltkit/deploy/protocol')
        }
      }
      expect(source, file).not.toMatch(/\binnerHTML\b|\bouterHTML\b|insertAdjacentHTML|document\.write|\bnew Function\b|\beval\s*\(|\.style\b|setAttribute\(\s*['"](?:style|on)|localStorage|document\.cookie|DOMParser|createContextualFragment|srcdoc/)
    }
  })

  it('no secret value is ever written: the server writes one file, the targets', async () => {
    for (const file of await files(SRC)) {
      if (file.includes(`${join('src', 'client')}`)) continue
      const source = await readFile(file, 'utf8')
      const writes = source.match(/\b(writeFile|appendFile|createWriteStream|writeFileSync|appendFileSync)\b/g) ?? []
      if (file.endsWith('targets.ts')) expect(writes.length).toBeGreaterThan(0)
      else expect(writes, file).toEqual([])
    }
  })
})
