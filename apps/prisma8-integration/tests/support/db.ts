import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/** TEST_DATABASE_URL names the server; the harness works in its own database on it. */
export const serverUrl = process.env['TEST_DATABASE_URL']
export const DATABASE = 'basalt_prisma8'

export function databaseUrl(): string {
  const url = new URL(serverUrl!)
  url.pathname = `/${DATABASE}`
  return url.toString()
}

export const appDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const prismaBin = join(appDir, 'node_modules', '.bin', 'prisma')

/** The result envelope of a `prisma … --json` run: the last NDJSON line of kind `result`. */
export interface CliResult {
  ok: boolean
  result?: {
    ok: boolean
    mode?: string
    plan?: {
      operations: Array<{ id: string; label: string; operationClass: string }>
      preview?: { statements: Array<{ text: string }> }
    }
  }
  [key: string]: unknown
}

/** Runs the Prisma 8 CLI with `--json` against the harness database and returns its result envelope. */
export async function prisma(args: string[], options: { cwd?: string; config?: string } = {}): Promise<CliResult> {
  const argv = [...args, '--json', ...(options.config ? ['--config', options.config] : [])]
  let stdout: string
  try {
    ;({ stdout } = await promisify(execFile)(prismaBin, argv, {
      cwd: options.cwd ?? appDir,
      env: { ...process.env, PRISMA8_DATABASE_URL: databaseUrl() },
      maxBuffer: 16 * 1024 * 1024,
    }))
  } catch (error) {
    stdout = (error as { stdout?: string }).stdout ?? ''
    if (!stdout) throw error
  }
  const lines = stdout.split('\n').filter((line) => line.startsWith('{'))
  const result = lines.map((line) => JSON.parse(line) as { kind?: string; envelope?: CliResult }).reverse().find((e) => e.kind === 'result')
  if (!result?.envelope) throw new Error(`prisma ${args.join(' ')}: no result envelope in\n${stdout}`)
  return result.envelope
}

/** The SQL a dry run would apply. */
export const planSql = (envelope: CliResult) => (envelope.result?.plan?.preview?.statements ?? []).map((s) => s.text)
