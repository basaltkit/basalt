#!/usr/bin/env node
import { main } from './cli.js'

const code = await main(process.argv.slice(2))
// Events still queued for a pipe reach it before the process ends (a reader gone: at most 2 s).
if (process.stdout.writableLength > 0) {
  await new Promise<void>((resolve) => {
    process.stdout.once('drain', resolve)
    setTimeout(resolve, 2000).unref()
  })
}
process.exit(code)
