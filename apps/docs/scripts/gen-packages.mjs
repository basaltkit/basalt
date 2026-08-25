// Generates one VitePress page per @basaltkit package by mirroring its README —
// single-source (the README stays canonical), regenerated at build time. Output
// lives in reference/packages/<slug>.md (gitignored) + a generated sidebar.
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const docsRoot = join(here, '..')
const packagesDir = join(docsRoot, '../../packages')
const outDir = join(docsRoot, 'reference/packages')
const repo = 'https://github.com/basaltkit/basalt'

const F = '⁣CODEF' // invisible-safe sentinels for protected code spans
const I = '⁣CODEI'
const END = '⁣END'

/** Makes a README safe for VitePress/Vue and portable off the package folder. */
function toVitepress(readme, dirBasename) {
  const fences = []
  const inline = []
  // 1. Protect fenced + inline code so we never touch code content.
  let s = readme.replace(/```[\s\S]*?```/g, (m) => `${F}${fences.push(m) - 1}${END}`)
  s = s.replace(/`[^`\n]*`/g, (m) => `${I}${inline.push(m) - 1}${END}`)
  // 2. Escape angle brackets in prose — bare <name>/<iframe>/generics break the
  //    Vue compiler; code (protected above) keeps its brackets.
  s = s.replace(/</g, '&lt;').replace(/>/g, '&gt;')
  // 3. Rewrite README-relative links/images to GitHub so they never 404 in docs.
  const abs = (t) => `${repo}/blob/main/packages/${dirBasename}/${t.replace(/^\.\//, '')}`
  s = s.replace(/\]\((?!https?:|\/|#|mailto:)([^)\s]+)\)/g, (_m, t) => `](${abs(t)})`)
  s = s.replace(/^(\[[^\]]+\]:\s*)(?!https?:|\/|#|mailto:)(\S+)/gm, (_m, pre, t) => `${pre}${abs(t)}`)
  // 4. Restore code.
  s = s.replace(new RegExp(`${I}(\\d+)${END}`, 'g'), (_m, i) => inline[Number(i)])
  s = s.replace(new RegExp(`${F}(\\d+)${END}`, 'g'), (_m, i) => fences[Number(i)])
  return s
}

const readSafe = (p) => {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}

const pages = []
for (const dirBasename of readdirSync(packagesDir).sort()) {
  const pkgPath = join(packagesDir, dirBasename, 'package.json')
  const readmePath = join(packagesDir, dirBasename, 'README.md')
  if (!existsSync(pkgPath) || !existsSync(readmePath)) continue
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  if (pkg.private === true) continue

  const slug = pkg.name.replace(/^@[^/]+\//, '') // @basaltkit/auth -> auth
  const npm = `https://www.npmjs.com/package/${pkg.name}`
  const gh = `${repo}/tree/main/packages/${dirBasename}`
  const body = toVitepress(readSafe(readmePath), dirBasename)

  const frontmatter = `---\ntitle: "${pkg.name}"\neditLink: false\n---\n`
  const banner =
    `::: tip Package reference\n` +
    `Mirrors the package README (single source). Install \`${pkg.name}\` \`v${pkg.version}\` — ` +
    `[npm](${npm}) · [source](${gh}).\n:::\n\n`

  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, `${slug}.md`), frontmatter + banner + body, 'utf8')
  pages.push({ text: pkg.name, link: `/reference/packages/${slug}` })
}

// Generated sidebar: an ecosystem link + every package, alphabetical.
const sidebar = [
  { text: 'Ecosystem overview', link: '/reference/packages' },
  { text: `All packages (${pages.length})`, collapsed: false, items: pages },
]
mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, 'packages-sidebar.json'), JSON.stringify(sidebar, null, 2), 'utf8')

console.log(`gen-packages: wrote ${pages.length} package pages to reference/packages/`)
