import { readFileSync } from 'node:fs'

/** This package's own version (its package.json, next to dist/): what the printed root commands pin. */
export const VERSION: string = (() => {
  try {
    return String((JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: unknown }).version ?? '0.0.0')
  } catch {
    return '0.0.0'
  }
})()
