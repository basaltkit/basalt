import type { DeployEvent, ErrorEvent, HelloEvent } from '@basaltkit/deploy/protocol'

/**
 * What the local server sends the page (RFC 0009 §7). Types only: shared by
 * the server and the browser code, erased at compile time.
 */

/** Why a remote command produced no usable answer, as the UI shows it. */
export interface Failure {
  code: string
  message: string
  hint?: string
}

/** The answer of a collected command (status, plan, run --detach, rollback --detach, cancel). */
export interface CommandReply {
  ok: boolean
  hello?: HelloEvent
  result?: unknown
  error?: ErrorEvent
  exitCode?: number
  failure?: Failure
  /** Foreign text before `hello` and ssh's stderr, sanitised. */
  diagnostics: string[]
}

/** One NDJSON line of a stream (env, an attended run, attach): local state is never confused with a server event. */
export type StreamMessage =
  | { kind: 'hello'; hello: HelloEvent }
  | { kind: 'event'; event: DeployEvent; known: boolean }
  | { kind: 'diagnostic'; text: string }
  | {
    kind: 'state'
    state: 'connecting' | 'reconnecting' | 'ended'
    exitCode?: number
    code?: string
    reason?: string
    hint?: string
    retryInMs?: number
  }

export interface TargetView {
  name: string
  ssh: string
  port?: number
  dir: string
  node?: string
  config?: string
  protected?: boolean
}

export interface TargetsReply {
  path: string
  exists: boolean
  actor?: string
  targets: TargetView[]
  error?: string
}
