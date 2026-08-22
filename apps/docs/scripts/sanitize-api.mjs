// Post-processes the typedoc markdown so VitePress/Vue never chokes on bare
// angle-bracket tokens in JSDoc prose (e.g. `--dir=<path>`, `<Name>`). The
// vitepress theme escapes generics in type signatures, but not arbitrary HTML
// in comment prose — so we protect code spans and escape `<`/`>` everywhere else.
// The theme emits no intentional raw HTML, so this is lossless.
import { readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const apiDir = join(dirname(fileURLToPath(import.meta.url)), '../reference/api')

const FENCE = '@@BASALT_FENCE_'
const INLINE = '@@BASALT_INLINE_'
const END = '_END@@'

function sanitize(md) {
  const fences = []
  const inline = []
  let s = md.replace(/```[\s\S]*?```/g, (m) => FENCE + (fences.push(m) - 1) + END)
  s = s.replace(/`[^`\n]*`/g, (m) => INLINE + (inline.push(m) - 1) + END)
  s = s.replace(/</g, '&lt;').replace(/>/g, '&gt;')
  s = s.replace(new RegExp(INLINE + '(\\d+)' + END, 'g'), (_m, i) => inline[Number(i)])
  s = s.replace(new RegExp(FENCE + '(\\d+)' + END, 'g'), (_m, i) => fences[Number(i)])
  return s
}

let count = 0
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p)
    else if (name.endsWith('.md')) {
      const before = readFileSync(p, 'utf8')
      const after = sanitize(before)
      if (after !== before) {
        writeFileSync(p, after)
        count++
      }
    }
  }
}

try {
  walk(apiDir)
  console.log(`sanitize-api: cleaned ${count} file(s)`)
} catch (err) {
  console.error('sanitize-api:', err.message)
  process.exit(1)
}
