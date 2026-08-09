// @basaltkit/admin's memoryDataSource uses node:crypto's randomUUID; in the
// browser we map it to the Web Crypto equivalent.
export const randomUUID = (): string => globalThis.crypto.randomUUID()
