import type { LineWriter } from '../render.js'
import type { MakeResult, ReviewStatus } from './types.js'

const REVIEW_MARK: Record<ReviewStatus, string> = { pass: '✓', warn: '⚠', fail: '✗' }

/** Render a {@link MakeResult} — what was generated, the review gate and follow-ups. */
export function renderMakeResult(result: MakeResult, io: LineWriter): void {
  for (const resource of result.resources) {
    const verb = result.dryRun ? 'Would generate' : 'Generated'
    const extras = [
      resource.augmented ? 'domain fields' : null,
      resource.guarded ? 'permission guards' : null,
      resource.audited ? 'audit' : null,
    ].filter((x): x is string => x !== null)
    const tag = extras.length > 0 ? ` (+ ${extras.join(', ')})` : ''
    io.log(`${verb} ${resource.name}${tag}:`)
    const paths = result.dryRun ? resource.files.map((f) => f.path) : resource.written
    for (const path of paths) io.log(`  ${result.dryRun ? '~' : '+'} ${path}`)
    if (!result.dryRun) {
      io.log(resource.registered ? '  ✓ wired into src/app.ts' : '  • src/app.ts not auto-wired')
    }
    if (resource.note) io.log(`  ⚠ ${resource.note}`)
    io.log('')
  }

  io.log('Review:')
  for (const item of result.review.items) {
    io.log(`  ${REVIEW_MARK[item.status]} ${item.label} — ${item.detail}`)
  }
  io.log('')

  if (result.followUps.length > 0) {
    io.log('Next steps (manual):')
    for (const step of result.followUps) io.log(`  - ${step}`)
    io.log('')
  }

  if (result.dryRun) {
    io.log('Dry run — nothing was written. Re-run without --dry-run to apply.')
  } else if (result.review.ok) {
    io.log('✓ Implementation completed.')
  } else {
    io.log('✗ Implementation completed with blocking review issues — see above.')
  }
}
