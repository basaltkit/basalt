/** Types for the reference Worker, which is plain JavaScript because that is what the docs publish. */
export function signDelivery(
  raw: Uint8Array,
  from: string,
  to: string,
  oversize: number | undefined,
  secret: string,
  t: number,
): Promise<Record<string, string>>

declare const worker: {
  email(
    message: {
      from: string
      to: string
      raw: ReadableStream<Uint8Array> | null
      rawSize: number
      setReject(reason: string): void
    },
    env: { BASALT_INBOUND_URL: string; BASALT_INBOUND_SECRET: string },
  ): Promise<void>
}
export default worker
