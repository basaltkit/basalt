// Builds the typedoc config dynamically from the workspace: every PUBLIC package
// with a TS `src/index.ts` entry, minus JSX/React UI packages (typedoc has no
// React setup here — their READMEs cover them via docs:packages). Writes
// typedoc.json + typedoc.tsconfig.json so new packages are picked up automatically.
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const docsRoot = join(here, '..')
const packagesDir = join(docsRoot, '../../packages')

const hasTsx = (dir) => {
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (walk(join(d, e.name))) return true
      } else if (e.name.endsWith('.tsx')) return true
    }
    return false
  }
  return existsSync(dir) && walk(dir)
}

const entryPoints = []
for (const dir of readdirSync(packagesDir).sort()) {
  const pkgPath = join(packagesDir, dir, 'package.json')
  const entry = join(packagesDir, dir, 'src/index.ts')
  if (!existsSync(pkgPath) || !existsSync(entry)) continue
  if (JSON.parse(readFileSync(pkgPath, 'utf8')).private === true) continue
  if (hasTsx(join(packagesDir, dir, 'src'))) continue // JSX — skip (README covers it)
  entryPoints.push(`../../packages/${dir}/src/index.ts`)
}

const typedoc = {
  $schema: 'https://typedoc.org/schema.json',
  plugin: ['typedoc-plugin-markdown', 'typedoc-vitepress-theme'],
  entryPoints,
  tsconfig: './typedoc.tsconfig.json',
  out: 'reference/api',
  docsRoot: '.',
  entryFileName: 'index',
  readme: 'none',
  mergeReadme: false,
  excludeInternal: true,
  excludePrivate: true,
  excludeExternals: true,
  githubPages: false,
  hideGenerator: true,
  // Extract docs even if some package doesn't fully type-check in isolation —
  // we're documenting, not building. Keeps one bad file from failing all 79.
  skipErrorChecking: true,
  gitRevision: 'main',
}
writeFileSync(join(docsRoot, 'typedoc.json'), JSON.stringify(typedoc, null, 2) + '\n')

const tsconfig = {
  compilerOptions: {
    target: 'ES2022',
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    lib: ['ES2023'],
    strict: true,
    skipLibCheck: true,
    esModuleInterop: true,
    noEmit: true,
  },
  include: entryPoints,
}
writeFileSync(join(docsRoot, 'typedoc.tsconfig.json'), JSON.stringify(tsconfig, null, 2) + '\n')

console.log(`gen-typedoc: ${entryPoints.length} package entry points`)
