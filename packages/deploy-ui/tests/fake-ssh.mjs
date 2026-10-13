#!/usr/bin/env node
/**
 * A fake `ssh` for the deploy UI's tests, started as
 * `node fake-ssh.mjs <controlDir> <ssh argv…>` through the UI's injectable
 * runner — the same on every OS, no shim.
 *
 * It records each call (argv, environment KEYS, stdin) to
 * `<controlDir>/calls.ndjson`, refuses an argv that does not have the shape
 * the UI must produce, splits the remote command with a POSIX word splitter,
 * and replays what `<controlDir>/scenario.json` says for the destination and
 * the deploy command: a recorded transcript, inline lines, stderr, an exit
 * code, a cut (the connection dropping after n lines), a pause.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { posixWords } from './posix-words.mjs'

const [controlDir, ...argv] = process.argv.slice(2)
const OPTIONS = ['BatchMode=yes', 'StrictHostKeyChecking=yes', 'ConnectTimeout=10', 'ServerAliveInterval=15', 'ServerAliveCountMax=3', 'ForwardAgent=no', 'ForwardX11=no', 'ClearAllForwardings=yes', 'PermitLocalCommand=no', 'RequestTTY=no', 'LogLevel=ERROR']
const BIN = 'node_modules/@basaltkit/deploy/dist/bin.js'

const die = (message, code = 254) => { process.stderr.write(`fake-ssh: ${message}\n`); process.exit(code) }

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

function checkShape(args) {
  let i = 0
  if (args[i++] !== '-T') die('argv must start with -T')
  for (const option of OPTIONS) {
    if (args[i] !== '-o' || args[i + 1] !== option) die(`expected -o ${option} at ${i}, got ${args[i]} ${args[i + 1]}`)
    i += 2
  }
  if (args[i] !== '-e' || args[i + 1] !== 'none') die('expected -e none')
  i += 2
  let port
  if (args[i] === '-p') { port = Number(args[i + 1]); i += 2 }
  if (args[i++] !== '--') die('expected -- before the destination')
  const destination = args[i++]
  const remote = args[i++]
  if (destination === undefined || remote === undefined || i !== args.length) die('expected exactly a destination and one remote command after --')
  return { destination, remote, port }
}

const stdin = await readStdin()
const { destination, remote, port } = checkShape(argv)
const { words, unquotedSpecials } = posixWords(remote)
if (unquotedSpecials.length !== 2 || unquotedSpecials.join('') !== '&&') die(`unquoted shell syntax in the remote command: ${unquotedSpecials.join(' ')}`)
if (words[0] !== 'cd' || words[2] !== '&&' || words[3] !== 'exec' || words[5] !== BIN) die(`unexpected remote command shape: ${JSON.stringify(words)}`)
const command = words[6]
const host = destination.includes('@') ? destination.slice(destination.lastIndexOf('@') + 1) : destination
appendFileSync(join(controlDir, 'calls.ndjson'), `${JSON.stringify({ argv, envKeys: Object.keys(process.env).sort(), stdin, destination, port, words })}\n`)

const scenario = JSON.parse(readFileSync(join(controlDir, 'scenario.json'), 'utf8'))
const byHost = scenario.hosts[host] ?? scenario.hosts['*']
if (!byHost) die(`no scenario for host ${host}`)
const steps = byHost[command]
if (!steps) die(`no scenario for ${command} on ${host}`)
const counterFile = join(controlDir, `count-${host}-${command}`)
const count = existsSync(counterFile) ? Number(readFileSync(counterFile, 'utf8')) : 0
writeFileSync(counterFile, String(count + 1))
const list = Array.isArray(steps) ? steps : [steps]
const step = list[Math.min(count, list.length - 1)]

if (step.expectFromSeq !== undefined) {
  const from = words.find((w) => w.startsWith('--from-seq='))
  if (from !== `--from-seq=${step.expectFromSeq}`) die(`expected --from-seq=${step.expectFromSeq}, got ${from}`)
}

const lines = []
if (step.before) lines.push(...step.before)
if (step.transcript) lines.push(...readFileSync(join(scenario.transcripts, `${step.transcript}.ndjson`), 'utf8').split('\n').filter(Boolean))
if (step.lines) lines.push(...step.lines)
if (step.bigLine) lines.push('x'.repeat(step.bigLine))
const shown = step.cut === undefined ? lines : lines.slice(0, step.cut)
const write = (text) => new Promise((resolve) => { if (process.stdout.write(text)) resolve(); else process.stdout.once('drain', resolve) })
for (const line of shown) await write(`${line}\n`)
if (step.partial) await write(step.partial)
if (step.stderr) process.stderr.write(step.stderr)
if (step.pauseMs) await new Promise((resolve) => setTimeout(resolve, step.pauseMs))
process.exitCode = step.exit ?? (step.cut !== undefined ? 255 : 0)
