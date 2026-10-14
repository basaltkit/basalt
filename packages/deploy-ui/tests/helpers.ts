import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SshRunner, Spawn } from '../src/remote.js'

export const FAKE_SSH = join(import.meta.dirname, 'fake-ssh.mjs')
export const TRANSCRIPTS = join(import.meta.dirname, 'transcripts')

export interface Step {
  transcript?: string
  before?: string[]
  lines?: string[]
  bigLine?: number
  partial?: string
  stderr?: string
  exit?: number
  cut?: number
  pauseMs?: number
  expectFromSeq?: number
}

export type Scenario = Record<string, Record<string, Step | Step[]>>

export interface Call {
  argv: string[]
  envKeys: string[]
  stdin: string
  destination: string
  port?: number
  words: string[]
}

export interface Control {
  dir: string
  runner: SshRunner
  /** The fake ssh's record of every call. */
  calls(): Promise<Call[]>
  setScenario(hosts: Scenario): Promise<void>
  cleanup(): Promise<void>
}

/** A control directory for the fake ssh, and a runner that starts it (node + the script) instead of ssh. */
export async function control(hosts: Scenario): Promise<Control> {
  const dir = await mkdtemp(join(tmpdir(), 'basalt-deploy-ui-ssh-'))
  const setScenario = (h: Scenario) => writeFile(join(dir, 'scenario.json'), JSON.stringify({ transcripts: TRANSCRIPTS, hosts: h }))
  await setScenario(hosts)
  return {
    dir,
    runner: { program: process.execPath, prefix: [FAKE_SSH, dir], spawn: spawn as Spawn, env: process.env },
    async calls() {
      try {
        return (await readFile(join(dir, 'calls.ndjson'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as Call)
      } catch {
        return []
      }
    },
    setScenario,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}

export const transcript = async (name: string) => (await readFile(join(TRANSCRIPTS, `${name}.ndjson`), 'utf8')).split('\n').filter(Boolean)
