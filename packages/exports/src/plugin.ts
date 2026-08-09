import { createToken, definePlugin } from '@basaltkit/core'
import { Exports } from './exports.js'
import type { ExportFormatter } from './formatters.js'

export const EXPORTS = createToken<Exports>('exports')

export interface ExportsPluginOptions {
  /** Extra formatters beyond the native csv/tsv/json/ndjson (e.g. an XLSX driver). */
  formatters?: ExportFormatter[]
}

export function exportsPlugin(options: ExportsPluginOptions = {}) {
  return definePlugin({
    name: 'basalt:exports',
    register({ container }) {
      container.singleton(EXPORTS, () => new Exports(options))
    },
  })
}
