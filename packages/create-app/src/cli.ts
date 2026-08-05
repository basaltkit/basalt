#!/usr/bin/env node
import { createProject, TargetNotEmptyError } from './index.js'

const USAGE = `Usage: npx create-mach <name> [options]

Options:
  --dir=<path>    Target directory (default: ./<name>)
  --no-tenancy    Skip multi-tenancy
  --no-auth       Skip authentication
  --billing       Include subscriptions/billing
`

const argv = process.argv.slice(2)
let name: string | undefined
let dir: string | undefined
let tenancy = true
let auth = true
let billing = false

for (const token of argv) {
  if (token === '--no-tenancy') tenancy = false
  else if (token === '--no-auth') auth = false
  else if (token === '--billing') billing = true
  else if (token.startsWith('--dir=')) dir = token.slice('--dir='.length)
  else if (token === '--help' || token === '-h') {
    console.log(USAGE)
    process.exit(0)
  } else if (!token.startsWith('--') && name === undefined) name = token
}

if (!name) {
  console.error(USAGE)
  process.exit(1)
}

try {
  const result = await createProject({ name, ...(dir ? { dir } : {}), tenancy, auth, billing })
  console.log(`\nCreated ${result.options.name} in ${result.dir}\n`)
  for (const file of result.files) console.log(`  ${file}`)
  console.log(`\nNext steps:\n  cd ${result.dir}\n  pnpm install\n  pnpm dev\n`)
} catch (error) {
  if (error instanceof TargetNotEmptyError) {
    console.error(error.message)
    process.exit(1)
  }
  throw error
}
