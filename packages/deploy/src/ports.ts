import type { Host } from './host.js'

export interface Listener {
  port: number
  address: string
  /** Empty when the socket belongs to another user (ss shows no process then). */
  pids: number[]
}

/** TCP listeners on this machine, from `ss -ltnpH`. */
export async function listeners(host: Host): Promise<Listener[]> {
  const result = await host.exec('ss', ['-ltnpH'])
  if (result.code !== 0) return []
  const out: Listener[] = []
  for (const line of result.stdout.split('\n')) {
    const fields = line.trim().split(/\s+/)
    const local = fields[3]
    if (!local) continue
    const colon = local.lastIndexOf(':')
    const port = Number(local.slice(colon + 1))
    if (!Number.isInteger(port)) continue
    const pids = [...line.matchAll(/pid=(\d+)/g)].map((m) => Number(m[1]))
    out.push({ port, address: local.slice(0, colon), pids })
  }
  return out
}

export async function freePort(host: Host, from: number, avoid: number[] = [], taken: number[] = []): Promise<number> {
  const busy = new Set([...(await listeners(host)).map((l) => l.port), ...avoid, ...taken])
  for (let port = from; port < from + 1000; port++) if (!busy.has(port)) return port
  throw new Error(`no free port between ${from} and ${from + 999}`)
}
