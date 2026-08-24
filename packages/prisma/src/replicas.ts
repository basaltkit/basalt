/**
 * Read/write splitting for a Prisma client. Reads (`findMany`, `count`,
 * `aggregate`, `$queryRaw`, …) fan out across one or more read replicas;
 * everything else — writes, transactions, `$executeRaw` — stays on the primary.
 *
 * It's a thin `Proxy`, not a dependency: pass the result straight to
 * `prismaPlugin({ client })`. The escape hatch `db().$primary` forces the
 * primary for read-your-writes consistency right after a write.
 */

/** Model operations that only read — safe to serve from a replica. */
const READ_OPERATIONS = new Set([
  'findFirst',
  'findFirstOrThrow',
  'findUnique',
  'findUniqueOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
])

/** Client-level raw reads. `$executeRaw*` mutates, so it is NOT here. */
const READ_ROOT = new Set(['$queryRaw', '$queryRawUnsafe'])

export interface ReadReplicaOptions<TClient extends object> {
  /** The read-write primary — every write and transaction goes here. */
  primary: TClient
  /** One or more read-only replicas. Reads round-robin across them. */
  replicas: TClient[]
  /** Extra model methods to treat as reads (e.g. a Prisma extension's). */
  readOps?: string[]
}

/**
 * Wrap a primary + replicas into one client that routes reads to the replicas
 * and writes to the primary. With no replicas it returns the primary unchanged
 * (plus `$primary`), so the same wiring works in every environment.
 */
export function readReplica<TClient extends object>(
  options: ReadReplicaOptions<TClient>,
): TClient & { $primary: TClient } {
  const { primary, replicas } = options
  const reads = options.readOps ? new Set([...READ_OPERATIONS, ...options.readOps]) : READ_OPERATIONS

  // No replicas configured → every call is primary. Still expose `$primary`.
  if (replicas.length === 0) {
    return new Proxy(primary, {
      get: (target, prop, receiver) =>
        prop === '$primary' ? primary : Reflect.get(target, prop, receiver),
    }) as TClient & { $primary: TClient }
  }

  let cursor = 0
  const nextReplica = (): TClient => {
    const replica = replicas[cursor % replicas.length]!
    cursor += 1
    return replica
  }

  const modelCache = new Map<string, unknown>()

  return new Proxy(primary, {
    get(target, prop, receiver) {
      if (prop === '$primary') return primary

      // Client-level raw reads → a replica; every other client method (writes,
      // $transaction, $executeRaw, $connect, lifecycle) stays on the primary.
      if (typeof prop === 'string' && READ_ROOT.has(prop)) {
        return (...args: unknown[]) =>
          (nextReplica() as Record<string, (...a: unknown[]) => unknown>)[prop]!(...args)
      }

      const value = Reflect.get(target, prop, receiver)
      const isModel =
        typeof prop === 'string' && !prop.startsWith('$') && value !== null && typeof value === 'object'
      if (!isModel) {
        return typeof value === 'function' ? value.bind(target) : value
      }

      // A model delegate (client.project, client.user…): route its read
      // operations to a replica, writes to the primary.
      const modelName = prop as string
      let modelProxy = modelCache.get(modelName)
      if (!modelProxy) {
        const primaryModel = value as Record<string, unknown>
        modelProxy = new Proxy(primaryModel, {
          get(model, op) {
            if (typeof op === 'string' && reads.has(op)) {
              return (...args: unknown[]) => {
                const replicaModel = (nextReplica() as Record<string, Record<string, (...a: unknown[]) => unknown>>)[
                  modelName
                ]!
                return replicaModel[op]!(...args)
              }
            }
            const fn = Reflect.get(model, op)
            return typeof fn === 'function' ? (fn as (...a: unknown[]) => unknown).bind(model) : fn
          },
        })
        modelCache.set(modelName, modelProxy)
      }
      return modelProxy
    },
  }) as TClient & { $primary: TClient }
}
