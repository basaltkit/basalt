// After tsc: dist/client/i18n-messages.js becomes @basaltkit/i18n's own
// import-free messages module, then every page module is checked to import
// only relative paths (the browser resolves nothing else, and the CSP loads
// only this origin's scripts).
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const client = fileURLToPath(new URL('../dist/client/', import.meta.url))
const source = await readFile(fileURLToPath(import.meta.resolve('@basaltkit/i18n/messages')), 'utf8')
await writeFile(join(client, 'i18n-messages.js'), source.replace(/\n\/\/# sourceMappingURL=.*\n?$/, '\n'))

const bare = /(?:^|[\s;])(?:import|export)\b[^'"]*?\bfrom\s*['"](?![./])([^'"]+)['"]|\bimport\s*\(\s*['"](?![./])([^'"]+)['"]/m
for (const name of await readdir(client)) {
  if (!name.endsWith('.js')) continue
  const match = bare.exec(await readFile(join(client, name), 'utf8'))
  if (match) {
    console.error(`dist/client/${name} imports "${match[1] ?? match[2]}": the page can load only relative modules`)
    process.exit(1)
  }
}
