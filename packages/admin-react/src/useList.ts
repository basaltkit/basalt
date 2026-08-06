import { useCallback, useEffect, useState } from 'react'
import type { AdminDataSource, ListParams } from '@machize/admin'

export interface UseListResult<T> {
  data: T[]
  loading: boolean
  error: unknown
  reload: () => Promise<void>
}

/** Loads a resource list from a data source on mount, with a manual reload. */
export function useList<T>(source: AdminDataSource<T>, params?: ListParams): UseListResult<T> {
  const [data, setData] = useState<T[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<unknown>(null)

  const key = JSON.stringify(params ?? null)
  const reload = useCallback(async () => {
    setLoading(true)
    try {
      setData(await source.list(params))
      setError(null)
    } catch (caught) {
      setError(caught)
    } finally {
      setLoading(false)
    }
    // params is captured via `key` to avoid identity churn
  }, [source, key])

  useEffect(() => {
    void reload()
  }, [reload])

  return { data, loading, error, reload }
}
