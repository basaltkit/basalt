import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { main } from '../src/cli.js'
import { GOOD_ENV, OLD, server } from './acme-server.js'
import { ACME_CONFIG } from './acme-config.js'

/**
 * Without --json, every command prints what it printed before RFC 0008. The
 * snapshot was recorded with the code as it was before the machine protocol
 * (commit 0bf7fc28) and must not change.
 */
let dir: string
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'basalt-deploy-human-'))
  await writeFile(join(dir, 'deploy.config.mjs'), ACME_CONFIG)
})
afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

const CONFIG = '--config=deploy.config.mjs'
const BARE_ENV = 'NODE_ENV=production\nHOST=127.0.0.1\nPORT=3002\nMAILER_URL=\n'

async function transcript(argv: string[], setup: Parameters<typeof server>[0] = {}, answers: string[] = []): Promise<string[]> {
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  try {
    const { host } = server({ dir, env: `${GOOD_ENV}SUPPORT_EMAIL=help@example.com\n`, ...setup })
    host.answers = answers
    host.tty = answers.length > 0
    const code = await main([...argv, CONFIG], host, dir)
    expect(write).not.toHaveBeenCalled()
    return [`exit ${code}`, ...host.printed.map((line) => line.split(dir).join('<dir>'))]
  } finally {
    write.mockRestore()
  }
}

describe('human mode, byte for byte', () => {
  it('run', async () => { expect(await transcript(['run'])).toMatchSnapshot() })
  it('run that rolls back', async () => { expect(await transcript(['run'], { healthyAt: (sha) => sha === OLD })).toMatchSnapshot() })
  it('run stopped at preflight', async () => { expect(await transcript(['run'], { dirty: ' M src/app.ts' })).toMatchSnapshot() })
  it('plan', async () => { expect(await transcript(['plan'], { env: BARE_ENV })).toMatchSnapshot() })
  it('status', async () => { expect(await transcript(['status'])).toMatchSnapshot() })
  it('env with answers at a terminal', async () => { expect(await transcript(['env'], { env: BARE_ENV }, ['', 'tok-typed-123456', ''])).toMatchSnapshot() })
  it('env without a terminal', async () => { expect(await transcript(['env'], { env: BARE_ENV })).toMatchSnapshot() })
  it('rollback with nothing to go back to', async () => { expect(await transcript(['rollback'])).toMatchSnapshot() })
})
