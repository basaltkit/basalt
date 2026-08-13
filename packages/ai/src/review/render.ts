import type { LineWriter } from '../render.js'
import type { AgentReview } from './types.js'

/** Render the Review agent's verdict in the spec's `Implementation rejected` style. */
export function renderAgentReview(review: AgentReview, io: LineWriter): void {
  io.log(review.approved ? '✓ Review agent: approved' : '✗ Review agent: changes requested')
  if (review.summary) io.log(`  ${review.summary}`)
  if (review.issues.length > 0) {
    io.log('  Issues:')
    for (const issue of review.issues) {
      io.log(`    ${issue.severity === 'error' ? '✗' : '⚠'} [${issue.dimension}] ${issue.message}`)
    }
  }
}
