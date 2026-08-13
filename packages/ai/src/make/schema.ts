import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export interface ModelBlock {
  name: string
  block: string
}

/** Extract the `model <Name> { … }` block from a generated `.prisma` snippet. */
export function extractModelBlock(snippet: string): ModelBlock | null {
  const match = /model\s+(\w+)\s*\{[\s\S]*?\n\}/.exec(snippet)
  if (!match || !match[1]) return null
  return { name: match[1], block: match[0] }
}

export interface MergeOutcome {
  content: string
  merged: string[]
  skipped: string[]
}

/** Append model blocks to a schema, skipping any model already declared (idempotent). */
export function mergeModelsIntoSchema(schema: string, blocks: ModelBlock[]): MergeOutcome {
  let content = schema.replace(/\s*$/, '')
  const merged: string[] = []
  const skipped: string[] = []
  for (const { name, block } of blocks) {
    if (new RegExp(`\\bmodel\\s+${name}\\s*\\{`).test(content)) {
      skipped.push(name)
      continue
    }
    content += `\n\n${block.trim()}\n`
    merged.push(name)
  }
  return { content: content.endsWith('\n') ? content : `${content}\n`, merged, skipped }
}

export async function readSchema(baseDir: string, schemaPath: string): Promise<string | null> {
  try {
    return await readFile(join(baseDir, schemaPath), 'utf8')
  } catch {
    return null
  }
}

export async function writeSchema(baseDir: string, schemaPath: string, content: string): Promise<void> {
  await writeFile(join(baseDir, schemaPath), content)
}

export interface PrismaPushResult {
  ok: boolean
  /** Tail of stdout/stderr. */
  output: string
}

/** Run `npx prisma db push` — creates the table(s) and regenerates the client. Best-effort. */
export async function runPrismaPush(baseDir: string): Promise<PrismaPushResult> {
  try {
    const { stdout } = await run('npx', ['prisma', 'db', 'push'], {
      cwd: baseDir,
      timeout: 180_000,
      maxBuffer: 10 * 1024 * 1024,
    })
    return { ok: true, output: stdout.slice(-2000) }
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; message?: string }
    const output = (e.stdout ?? '') + (e.stderr ?? '') || e.message || 'unknown error'
    return { ok: false, output: output.slice(-3000) }
  }
}
