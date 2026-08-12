import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

export interface VerifyResult {
  ok: boolean
  /** Command that was run, e.g. `pnpm typecheck`. */
  command: string
  /** Combined stdout/stderr tail on failure. */
  output: string
}

/**
 * Run the project's typecheck as a review gate (spec §12/§20). Best-effort: if
 * the command is missing or errors, it reports failure rather than throwing.
 */
export async function verifyProject(
  baseDir: string,
  command = 'pnpm',
  args: string[] = ['-s', 'typecheck'],
): Promise<VerifyResult> {
  const label = `${command} ${args.join(' ')}`
  try {
    await run(command, args, { cwd: baseDir, timeout: 180_000, maxBuffer: 10 * 1024 * 1024 })
    return { ok: true, command: label, output: '' }
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; message?: string }
    const output = (e.stdout ?? '') + (e.stderr ?? '') || e.message || 'unknown error'
    return { ok: false, command: label, output: output.slice(-4000) }
  }
}
