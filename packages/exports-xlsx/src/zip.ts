const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export interface ZipFile {
  name: string
  data: Buffer
}

/**
 * A minimal ZIP writer using the STORE method (no compression) — enough for a
 * valid .xlsx and dependency-free. STORE is a legal ZIP method, so the parts
 * are embedded uncompressed; Excel/LibreOffice open the result fine.
 */
export function zip(files: ZipFile[]): Buffer {
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0

  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8')
    const crc = crc32(file.data)
    const size = file.data.length

    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0) // local file header signature
    header.writeUInt16LE(20, 4) // version needed
    header.writeUInt16LE(0, 6) // flags
    header.writeUInt16LE(0, 8) // method: store
    header.writeUInt16LE(0, 10) // mod time
    header.writeUInt16LE(0x21, 12) // mod date (1980-01-01)
    header.writeUInt32LE(crc, 14)
    header.writeUInt32LE(size, 18) // compressed
    header.writeUInt32LE(size, 22) // uncompressed
    header.writeUInt16LE(name.length, 26)
    header.writeUInt16LE(0, 28) // extra
    local.push(header, name, file.data)

    const record = Buffer.alloc(46)
    record.writeUInt32LE(0x02014b50, 0) // central directory signature
    record.writeUInt16LE(20, 4) // version made by
    record.writeUInt16LE(20, 6) // version needed
    record.writeUInt16LE(0, 8) // flags
    record.writeUInt16LE(0, 10) // method
    record.writeUInt16LE(0, 12) // mod time
    record.writeUInt16LE(0x21, 14) // mod date
    record.writeUInt32LE(crc, 16)
    record.writeUInt32LE(size, 20)
    record.writeUInt32LE(size, 24)
    record.writeUInt16LE(name.length, 28)
    record.writeUInt16LE(0, 30) // extra len
    record.writeUInt16LE(0, 32) // comment len
    record.writeUInt16LE(0, 34) // disk number
    record.writeUInt16LE(0, 36) // internal attrs
    record.writeUInt32LE(0, 38) // external attrs
    record.writeUInt32LE(offset, 42) // local header offset
    central.push(record, name)

    offset += header.length + name.length + size
  }

  const centralBuffer = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0) // end of central directory signature
  end.writeUInt16LE(0, 4) // disk number
  end.writeUInt16LE(0, 6) // disk with central directory
  end.writeUInt16LE(files.length, 8) // entries on this disk
  end.writeUInt16LE(files.length, 10) // total entries
  end.writeUInt32LE(centralBuffer.length, 12) // central directory size
  end.writeUInt32LE(offset, 16) // central directory offset
  end.writeUInt16LE(0, 20) // comment length

  return Buffer.concat([...local, centralBuffer, end])
}
