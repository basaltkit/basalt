import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { StreamMessage } from '../src/client/messages.js'
import { MAX_SSH_SESSIONS, startUiServer, type UiServer } from '../src/server.js'
import { writeTargets } from '../src/targets.js'
import { control, type Control } from './helpers.js'

/** Limits, lifetime and the refusals the end-to-end file does not reach. */

let home: string
let ssh: Control

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'basalt-deploy-ui-edges-'))
  ssh = await control({
    'slow.example.com': { status: { transcript: 'status-ok', pauseMs: 1500 }, env: { transcript: 'env-answers', pauseMs: 1500 }, plan: { transcript: 'plan-questions' } },
    'hold.example.com': {
      status: { transcript: 'status-ok', pauseMs: 800 },
      attach: { lines: ['{"v":1,"ts":"2026-10-11T12:00:00.000Z","seq":0,"type":"hello","tool":"@basaltkit/deploy","version":"0.0.0","protocol":1,"command":"attach","pid":4100,"host":"server-1"}'], pauseMs: 20_000 },
    },
    'fast.example.com': { run: { transcript: 'env-answers', stderr: 'a warning on stderr\n' }, plan: { transcript: 'plan-questions' }, env: { stderr: 'Permission denied (publickey).\n', exit: 255 } },
  })
})
afterAll(async () => {
  await ssh.cleanup()
  await rm(home, { recursive: true, force: true })
})

async function session(server: UiServer) {
  const origin = `http://127.0.0.1:${server.port}`
  const post = (route: string, body: unknown, token?: string, signal?: AbortSignal) => fetch(`${origin}/api/${route}`, {
    method: 'POST', body: JSON.stringify(body), ...(signal ? { signal } : {}),
    headers: { 'Content-Type': 'application/json', Origin: origin, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  })
  const { token } = await (await post('session', { code: server.launchUrl.split('#launch=')[1] })).json() as { token: string }
  return (route: string, body: unknown = {}, signal?: AbortSignal) => post(route, body, token, signal)
}

async function serverWith(targets: Array<{ name: string; ssh: string }>, extra: Partial<Parameters<typeof startUiServer>[0]> = {}) {
  const path = join(home, `targets-${Math.random().toString(16).slice(2)}.json`)
  await writeTargets(path, { version: 1, targets: targets.map((t) => ({ ...t, dir: '/srv/myapp' })) })
  const server = await startUiServer({ targetsPath: path, runner: ssh.runner, clientDir: null, log: () => undefined, ...extra })
  return { server, path, api: await session(server) }
}

describe('limits', () => {
  it(`at most ${MAX_SSH_SESSIONS} ssh sessions; one change per target at a time; released when the page goes away`, async () => {
    const { server, api } = await serverWith([{ name: 'slow', ssh: 'deploy@slow.example.com' }])
    try {
      expect((await api('plan', { target: 'slow' })).status).toBe(200)
      const slow = Array.from({ length: MAX_SSH_SESSIONS }, () => api('status', { target: 'slow' }))
      await new Promise((r) => setTimeout(r, 200))
      expect((await api('status', { target: 'slow' })).status).toBe(429)
      expect((await Promise.all(slow)).map((r) => r.status)).toEqual(Array(MAX_SSH_SESSIONS).fill(200))

      const leaving = new AbortController()
      const first = await api('env', { target: 'slow', confirm: true, answers: [] }, leaving.signal)
      expect(first.status).toBe(200)
      expect((await api('env', { target: 'slow', confirm: true })).status).toBe(409)
      // The page goes away mid-stream: the attended ssh is stopped and the target is free again.
      leaving.abort()
      await new Promise((r) => setTimeout(r, 300))
      const again = await api('env', { target: 'slow', confirm: true })
      expect(again.status).toBe(200)
      const messages = (await again.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l) as StreamMessage)
      expect(messages.at(-1)).toEqual({ kind: 'state', state: 'ended', exitCode: 0 })
    } finally {
      await server.close()
    }
  })

  it('refuses malformed requests field by field; unknown routes are 404', async () => {
    const { server, api, path } = await serverWith([{ name: 'fast', ssh: 'deploy@fast.example.com' }])
    try {
      expect((await api('nope')).status).toBe(404)
      expect((await api('attach', { target: 'fast', runId: '20261011T120000Z-0123456789ab', fromSeq: -1 })).status).toBe(400)
      expect((await api('attach', { target: 'fast', runId: '20261011T120000Z-0123456789ab', fromSeq: '3' })).status).toBe(400)
      expect((await api('plan', { target: 'fast' })).status).toBe(200)
      for (const answers of ['x', [{ id: 'PAYCO', value: 'x' }], [{ id: 'env.PAYCO_SECRET_TOKEN', value: 1 }], [null], Array(300).fill({ id: 'env.A', value: '' })]) {
        expect((await api('run', { target: 'fast', confirm: true, answers })).status, JSON.stringify(answers).slice(0, 60)).toBe(400)
      }
      expect((await api('targets/remove', { name: '../x' })).status).toBe(400)
      expect((await api('targets/save', { actor: 'bad actor' })).status).toBe(422)
      expect((await (await api('targets/save', { actor: '' })).json() as { actor?: string }).actor).toBeUndefined()

      // An attended run streams; ssh's stderr arrives as diagnostics.
      const attended = await api('run', { target: 'fast', confirm: true, attended: true, answers: [] })
      const messages = (await attended.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l) as StreamMessage)
      expect(messages).toContainEqual({ kind: 'diagnostic', text: 'a warning on stderr\n' })
      // A refused key on an attended stream ends it with the explanation.
      const env = await api('env', { target: 'fast', confirm: true })
      const ended = (await env.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l) as StreamMessage).at(-1)
      expect(ended).toMatchObject({ kind: 'state', state: 'ended', code: 'auth' })

      expect((await (await api('targets/remove', { name: 'fast' })).json() as { targets: unknown[] }).targets).toEqual([])
      if (process.platform !== 'win32') {
        await writeFile(path, JSON.stringify({ version: 1, targets: [] }))
        await chmod(path, 0o666)
        expect((await (await api('targets')).json() as { error?: string }).error).toMatch(/writable by other users/)
        expect((await api('status', { target: 'fast' })).status).toBe(409)
        expect((await api('targets/save', { actor: 'x' })).status).toBe(409)
      }
    } finally {
      await server.close()
    }
  })
})

describe('lifetime', () => {
  it('stops after the idle time; close is idempotent', async () => {
    const pending: Array<() => void> = []
    let stopped: string | undefined
    const { server } = await serverWith([], {
      idleMinutes: 999,
      timers: { set: (callback) => { pending.push(callback); return pending.length }, clear: () => undefined },
      onStop: (reason) => { stopped = reason },
    })
    pending.at(-1)?.()
    await new Promise((r) => setTimeout(r, 50))
    expect(stopped).toBe('idle')
    await expect(fetch(server.url)).rejects.toThrow()
    await server.close()
  })

  it('an open attach stream and a remote command in flight hold the idle stop; it fires once both are over', async () => {
    const pending: Array<() => void> = []
    let stopped: string | undefined
    const fireAll = () => { for (const callback of pending.splice(0)) callback() }
    const { server, api } = await serverWith([{ name: 'hold', ssh: 'deploy@hold.example.com' }], {
      idleMinutes: 1,
      timers: { set: (callback) => { pending.push(callback); return pending.length }, clear: () => undefined },
      onStop: (reason) => { stopped = reason },
    })
    try {
      // A status that takes a while: every armed idle callback fires while it is in flight.
      const before = (await ssh.calls()).length
      const status = api('status', { target: 'hold' })
      while ((await ssh.calls()).length === before) await new Promise((r) => setTimeout(r, 20))
      fireAll()
      await new Promise((r) => setTimeout(r, 50))
      expect(stopped).toBeUndefined()
      expect((await status).status).toBe(200)

      // An open attach: the same.
      const leaving = new AbortController()
      const attach = await api('attach', { target: 'hold', runId: '20261011T120000Z-aaaaaaaaaaa2' }, leaving.signal)
      expect(attach.status).toBe(200)
      fireAll()
      await new Promise((r) => setTimeout(r, 50))
      expect(stopped).toBeUndefined()
      expect((await api('targets')).status).toBe(200)
      fireAll()
      await new Promise((r) => setTimeout(r, 50))
      expect(stopped).toBeUndefined()

      // The page goes away: the stream closes, the count starts again, and then it stops.
      leaving.abort()
      await new Promise((r) => setTimeout(r, 300))
      fireAll()
      await new Promise((r) => setTimeout(r, 50))
      expect(stopped).toBe('idle')
    } finally {
      await server.close()
    }
  })

  it('serves the compiled client from dist/client by default (none when it is not built)', async () => {
    const path = join(home, 'none.json')
    const server = await startUiServer({ targetsPath: path, runner: ssh.runner, log: () => undefined, osUser: 'not a valid actor' })
    try {
      const api = await session(server)
      expect(await (await api('targets')).json()).toEqual({ path, exists: false, targets: [] })
      expect([200, 404]).toContain((await fetch(`${server.url}client/main.js`, { headers: {} })).status)
    } finally {
      await server.close()
    }
  })
})
