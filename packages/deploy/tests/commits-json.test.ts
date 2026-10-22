import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseEvent } from '../src/protocol.js'
import { ok, type FakeHost } from './fake-host.js'
import { NEW, OLD, server } from './acme-server.js'
import { ACME_CONFIG, expectFramed, ofType, runJson } from './json-helpers.js'

let dir: string
const CONFIG = '--config=deploy.config.mjs'

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'basalt-deploy-commits-json-'))
  await writeFile(join(dir, 'deploy.config.mjs'), ACME_CONFIG)
})
afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

/** git as commits.ts calls it (`-c …` first): one commit, OLD → NEW, whose subject quotes a secret of the .env. */
function withHistory(host: FakeHost, subject: string): FakeHost {
  return host.on(({ command, args }) => {
    if (command !== 'git' || args[0] !== '-c') return undefined
    const plain = args.filter((a, i) => a !== '-c' && args[i - 1] !== '-c')
    const [verb] = plain
    if (verb === 'rev-parse') return ok(plain.includes('--is-shallow-repository') ? 'false\n' : `${(plain.at(-1) as string).replace('^{commit}', '').replace('HEAD', OLD)}\n`)
    if (verb === 'cat-file') return ok()
    if (verb === 'merge-base') return ok(`${OLD}\n`)
    if (verb === 'rev-list') return ok('0\t1\n')
    if (verb === 'log') return ok(`${NEW}\u0000${OLD}\u0000Dev\u00002026-10-01T10:00:00Z\u0000${subject}\u0000`)
    return undefined
  })
}

describe('commits --json', () => {
  it('the range in one result event; a secret of the .env in a commit message is redacted', async () => {
    const { host } = server({ dir })
    withHistory(host, 'rotate tok-SECRET in the payco config')
    const result = await runJson(['commits', `--from=${OLD}`, `--to=${NEW}`, '--json', CONFIG], host, dir)
    expectFramed(result)
    expect(result.code).toBe(0)
    const [event] = ofType(result.events, 'result')
    expect(event).toMatchObject({ command: 'commits', redacted: true, data: { purpose: 'range', from: OLD, to: NEW, commits: { ok: true, range: { relation: 'ahead', addedTotal: 1 } } } })
    expect(JSON.stringify(event)).not.toContain('tok-SECRET')
    expect(JSON.stringify(event)).toContain('[redacted:PAYCO_SECRET_TOKEN]')
    // No lock, no run log: read-only.
    expect([...host.files.keys()].some((p) => p.includes('/.basalt/runs/') || p.endsWith('deploy.lock'))).toBe(false)
  })

  it('a git that fails is an answer, not an error: exit 0, unavailable', async () => {
    const { host } = server({ dir })
    const result = await runJson(['commits', '--rollback', '--json', CONFIG], host, dir)
    expect(result.code).toBe(0)
    expect(ofType(result.events, 'result')[0]).toMatchObject({ command: 'commits', data: { purpose: 'rollback', commits: { ok: false } } })
  })

  it('refuses anything but shas, and the forms it knows', async () => {
    for (const argv of [
      ['commits'],
      ['commits', `--from=${OLD}`],
      ['commits', '--from=HEAD', `--to=${NEW}`],
      ['commits', `--from=${OLD}`, '--to=--upload-pack=x'],
      ['commits', '--rollback', `--from=${OLD}`],
      ['commits', '--rollback=abc1234'],
    ]) {
      const { host } = server({ dir })
      const result = await runJson([...argv, '--json', CONFIG], host, dir)
      expect(result.code, argv.join(' ')).toBe(1)
      expect(ofType(result.events, 'error')[0]?.code, argv.join(' ')).toBe('usage')
      expect(host.calls.some((c) => c.command === 'git' && c.args[0] === '-c'), argv.join(' ')).toBe(false)
    }
  })

  it('a reader that predates the field still parses the plan and status results (additive within v1)', () => {
    const line = JSON.stringify({ v: 1, ts: 'x', seq: 3, type: 'result', command: 'plan', data: { findings: [], lines: [], questions: [], blocking: false, commits: { ok: false, reason: 'not-fetched' } } })
    expect(parseEvent(line)).toMatchObject({ ok: true, known: true })
    const unknown = JSON.stringify({ v: 1, ts: 'x', seq: 3, type: 'result', command: 'commits', data: { purpose: 'range', commits: { ok: false, reason: 'some-future-reason' } } })
    expect(parseEvent(unknown).ok).toBe(true)
  })
})
