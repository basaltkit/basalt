import { Disk, type StorageDriver } from '@basaltkit/storage'

/** In-memory driver: enough of a disk to observe what was (not) written. */
export class FakeDriver implements StorageDriver {
  readonly name = 'fake'
  readonly files = new Map<string, Buffer>()
  readonly types = new Map<string, string | undefined>()
  async put(path: string, content: Buffer | string, options?: { contentType?: string }): Promise<void> {
    this.files.set(path, Buffer.isBuffer(content) ? content : Buffer.from(content))
    this.types.set(path, options?.contentType)
  }
  async get(path: string): Promise<Buffer> {
    const buffer = this.files.get(path)
    if (!buffer) throw new Error('not found')
    return buffer
  }
  async exists(path: string): Promise<boolean> {
    return this.files.has(path)
  }
  async delete(path: string): Promise<boolean> {
    return this.files.delete(path)
  }
  async list(prefix: string): Promise<string[]> {
    return [...this.files.keys()].filter((k) => k.startsWith(prefix))
  }
  async temporaryUrl(path: string, expiresInMs: number): Promise<string> {
    return `https://fake/${path}?e=${expiresInMs}`
  }
  async disconnect(): Promise<void> {}
}

export const fakeDisk = () => {
  const driver = new FakeDriver()
  return { driver, disk: new Disk('uploads', driver) }
}

const bytes = (...parts: (string | number[] | Uint8Array)[]): Buffer =>
  Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.from(p))))

/** A minimal ZIP: one stored local header per entry (no central directory — sniffing never reads it). */
export function zip(entries: string[], options: { dataDescriptor?: boolean } = {}): Buffer {
  const parts: Buffer[] = []
  for (const name of entries) {
    const body = Buffer.from(`content of ${name}`)
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(options.dataDescriptor ? 0x08 : 0, 6)
    header.writeUInt32LE(options.dataDescriptor ? 0 : body.length, 18)
    header.writeUInt32LE(options.dataDescriptor ? 0 : body.length, 22)
    header.writeUInt16LE(Buffer.byteLength(name), 26)
    parts.push(header, Buffer.from(name), body)
    if (options.dataDescriptor) parts.push(Buffer.alloc(16))
  }
  parts.push(bytes([0x50, 0x4b, 0x05, 0x06], new Uint8Array(18)))
  return Buffer.concat(parts)
}

/** A PE executable head: `MZ`, `e_lfanew` at 0x3C pointing at `PE\0\0`. */
export function exe(): Buffer {
  const b = Buffer.alloc(256)
  b.write('MZ', 0, 'latin1')
  b.writeUInt32LE(0x80, 0x3c)
  b.write('PE\0\0', 0x80, 'latin1')
  return b
}

export const corpus = {
  pdf: bytes('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n'),
  png: bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], [0, 0, 0, 13], 'IHDR', new Uint8Array(17)),
  jpeg: bytes([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10], 'JFIF\0', new Uint8Array(32)),
  gif: bytes('GIF89a', new Uint8Array(16)),
  gif87: bytes('GIF87a', new Uint8Array(16)),
  webp: bytes('RIFF', [0x24, 0, 0, 0], 'WEBPVP8 ', new Uint8Array(16)),
  tiffLE: bytes([0x49, 0x49, 0x2a, 0x00], new Uint8Array(16)),
  tiffBE: bytes([0x4d, 0x4d, 0x00, 0x2a], new Uint8Array(16)),
  zip: zip(['readme.txt', 'src/index.ts']),
  docx: zip(['[Content_Types].xml', '_rels/.rels', 'word/document.xml']),
  docxStreamed: zip(['[Content_Types].xml', '_rels/.rels', 'word/document.xml'], { dataDescriptor: true }),
  xlsx: zip(['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml']),
  pptx: zip(['[Content_Types].xml', '_rels/.rels', 'ppt/presentation.xml']),
  exe: exe(),
  elf: bytes([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], new Uint8Array(32)),
  machO: bytes([0xcf, 0xfa, 0xed, 0xfe], new Uint8Array(32)),
  html: bytes('<!DOCTYPE html><html><body><script>alert(document.cookie)</script></body></html>'),
  svg: bytes('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><circle r="5"/></svg>'),
  svgWithProlog: bytes('<?xml version="1.0" encoding="UTF-8"?>\n<!-- drawn by hand -->\n<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
  xml: bytes('<?xml version="1.0"?><invoice><total>10</total></invoice>'),
  text: bytes('just some notes\nline two\n'),
  csv: bytes('MZ,Maputo\nAO,Luanda\n'),
}
