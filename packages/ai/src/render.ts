import type { AnalysisReport } from './analyze/run.js'
import type { Diagnostic, Severity } from './doctor/types.js'

/** The single output method the CLI needs — matches `CommandIo.log`. */
export interface LineWriter {
  log(message: string): void
}

const MARK: Record<Severity, string> = { error: '✗', warning: '⚠', info: 'ℹ' }

/** Render the `ai:analyze` report in the spec's `✓ … detected` style. */
export function renderAnalysis(report: AnalysisReport, io: LineWriter): void {
  io.log('Analyzing project...')
  io.log('')
  if (report.capabilities.length === 0) {
    io.log('  No Basalt capabilities detected — is this a Basalt app? (looked for src/app.ts)')
  } else {
    for (const line of report.capabilities) io.log(`✓ ${line}`)
  }

  if (report.models.length > 0) {
    io.log('')
    io.log(`Data model (${report.models.length} model${report.models.length === 1 ? '' : 's'}):`)
    for (const name of report.models) {
      const scoped = report.tenantScopedModels.includes(name)
      io.log(`  • ${name}${scoped ? '  (tenant-scoped)' : ''}`)
    }
  }

  io.log('')
  if (report.diagnostics.length === 0) {
    io.log('✓ No issues found.')
  } else {
    const errors = report.diagnostics.filter((d) => d.severity === 'error').length
    const warnings = report.diagnostics.filter((d) => d.severity === 'warning').length
    const infos = report.diagnostics.filter((d) => d.severity === 'info').length
    io.log(`Diagnostics: ${errors} error(s), ${warnings} warning(s), ${infos} info.`)
    io.log('Run `basalt ai:doctor` for details and fixes.')
  }
}

/** Render the `ai:doctor` diagnostics in the spec's `AI DIAGNOSTICS` style. */
export function renderDoctor(diagnostics: Diagnostic[], io: LineWriter): void {
  io.log('AI DIAGNOSTICS')
  io.log('')
  if (diagnostics.length === 0) {
    io.log('✓ Everything looks healthy.')
    return
  }
  for (const d of diagnostics) {
    io.log(`${MARK[d.severity]} ${d.title}  [${d.category}]`)
    io.log('')
    io.log('  Detected:')
    io.log(`    ${d.detected}`)
    io.log('')
    io.log('  Recommended:')
    io.log(`    ${d.recommended}`)
    io.log('')
    io.log('  Reason:')
    io.log(`    ${d.reason}`)
    if (d.fix) {
      io.log('')
      io.log('  Fix:')
      for (const line of d.fix.split('\n')) io.log(`    ${line}`)
    }
    if (d.docs) {
      io.log('')
      io.log(`  Docs: https://basaltkit.dev${d.docs}`)
    }
    io.log('')
    io.log('  ' + '─'.repeat(60))
    io.log('')
  }
  const errors = diagnostics.filter((d) => d.severity === 'error').length
  const warnings = diagnostics.filter((d) => d.severity === 'warning').length
  io.log(
    `${diagnostics.length} finding(s): ${errors} error(s), ${warnings} warning(s), ` +
      `${diagnostics.length - errors - warnings} info.`,
  )
}
