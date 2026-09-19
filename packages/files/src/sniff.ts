/**
 * Content sniffing — the real type of an upload, read from its first bytes.
 *
 * The content type a client declares is a claim, not a fact: an HTML page sent
 * as `application/pdf` passes an allowlist that only reads the header. This
 * module recognises a small, deliberate set of formats by their signatures
 * (magic bytes) with no dependency, so `validate.sniff` can check what the file
 * *is* rather than what it says it is.
 *
 * It detects two kinds of thing:
 * - formats apps accept on purpose (PDF, images, ZIP/OOXML), and
 * - formats that are dangerous when disguised (HTML, SVG, XML, executables),
 *   so an upload that claims to be something else is rejected.
 */

/** How many leading bytes the sniffer reads. Streams are sniffed once this much has arrived. */
export const SNIFF_WINDOW = 64 * 1024

/** A content detector: the real MIME type of `bytes` (the file's head), or `null` when unknown. */
export type ContentSniffer = (bytes: Uint8Array) => string | null

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0): boolean => {
  if (bytes.length < offset + signature.length) return false
  for (let i = 0; i < signature.length; i++) if (bytes[offset + i] !== signature[i]) return false
  return true
}

const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0))

const PDF = ascii('%PDF-')
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const JPEG = [0xff, 0xd8, 0xff]
const GIF87 = ascii('GIF87a')
const GIF89 = ascii('GIF89a')
const RIFF = ascii('RIFF')
const WEBP = ascii('WEBP')
const TIFF_LE = [0x49, 0x49, 0x2a, 0x00]
const TIFF_BE = [0x4d, 0x4d, 0x00, 0x2a]
const ZIP_LOCAL = [0x50, 0x4b, 0x03, 0x04]
const ZIP_EMPTY = [0x50, 0x4b, 0x05, 0x06]
const ZIP_SPANNED = [0x50, 0x4b, 0x07, 0x08]
const ELF = [0x7f, 0x45, 0x4c, 0x46]
const MZ = [0x4d, 0x5a]
const MACH_O = [
  [0xfe, 0xed, 0xfa, 0xce],
  [0xfe, 0xed, 0xfa, 0xcf],
  [0xce, 0xfa, 0xed, 0xfe],
  [0xcf, 0xfa, 0xed, 0xfe],
  [0xca, 0xfe, 0xba, 0xbe], // universal ("fat") binary
]
const SHEBANG = ascii('#!')

export const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
export const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
export const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'

/** Types the built-in sniffer recognises by signature — a declared one of these MUST match its bytes. */
const SIGNATURE_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/tiff',
  'application/zip',
  DOCX,
  XLSX,
  PPTX,
])

/**
 * Names of the entries whose ZIP local file headers start within `bytes`.
 *
 * Scans for every local-header signature instead of walking header to header:
 * writers that stream (bit 3, sizes in a trailing data descriptor) leave no
 * size to skip by, and the office parts must still be found.
 */
function zipEntryNames(bytes: Uint8Array): string[] {
  const names: string[] = []
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let offset = 0; offset + 30 <= bytes.length && names.length < 256; offset++) {
    if (!startsWith(bytes, ZIP_LOCAL, offset)) continue
    const nameLength = view.getUint16(offset + 26, true)
    const nameEnd = offset + 30 + nameLength
    if (nameLength === 0 || nameEnd > bytes.length) continue
    names.push(new TextDecoder().decode(bytes.subarray(offset + 30, nameEnd)))
    offset = nameEnd - 1
  }
  return names
}

function sniffZip(bytes: Uint8Array): string {
  const names = zipEntryNames(bytes)
  if (names.includes('[Content_Types].xml') || names.some((n) => /^(word|xl|ppt)\//.test(n))) {
    if (names.some((n) => n.startsWith('word/'))) return DOCX
    if (names.some((n) => n.startsWith('xl/'))) return XLSX
    if (names.some((n) => n.startsWith('ppt/'))) return PPTX
  }
  return 'application/zip'
}

/** HTML tags whose presence at the start of a document makes browsers render it as HTML (WHATWG sniffing). */
const HTML_OPENERS = [
  '<!doctype html',
  '<html',
  '<head',
  '<body',
  '<script',
  '<iframe',
  '<h1',
  '<div',
  '<font',
  '<table',
  '<a',
  '<style',
  '<title',
  '<b',
  '<br',
  '<p',
  '<img',
  '<object',
  '<embed',
  '<meta',
  '<link',
  '<form',
  '<!--',
]

function sniffText(bytes: Uint8Array): string | null {
  // Only the first 1 KiB decides, like browsers; skip a UTF-8 BOM and leading whitespace.
  let start = startsWith(bytes, [0xef, 0xbb, 0xbf]) ? 3 : 0
  while (start < bytes.length && [0x09, 0x0a, 0x0c, 0x0d, 0x20].includes(bytes[start]!)) start++
  if (bytes[start] !== 0x3c /* < */) return null
  const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(start, start + 1024)).toLowerCase()
  if (head.startsWith('<svg') || /^<\?xml[^>]*>[\s\S]*?<svg[\s/>]/.test(head) || /<!doctype svg/.test(head)) {
    return 'image/svg+xml'
  }
  // The window beyond the opener: an SVG root may follow a long prolog.
  if (head.startsWith('<?xml')) {
    const wider = new TextDecoder().decode(bytes.subarray(start, start + SNIFF_WINDOW)).toLowerCase()
    if (/<svg[\s/>]/.test(wider)) return 'image/svg+xml'
    if (/<html[\s/>]/.test(wider)) return 'text/html'
    return 'application/xml'
  }
  for (const opener of HTML_OPENERS) {
    if (!head.startsWith(opener)) continue
    const next = head.charAt(opener.length)
    // `<a` must be a tag, not `<abbr`/`<applet` prose: a tag ends in a space or `>`.
    if (opener === '<!--' || next === '' || next === ' ' || next === '>' || next === '\t' || next === '\n' || next === '\r' || next === '/') {
      return 'text/html'
    }
  }
  return null
}

/**
 * `MZ` alone is two printable letters a CSV can start with. A real DOS/PE
 * header is binary: its `e_lfanew` points at `PE\0\0`, or — for a head too
 * short to reach it — its 64-byte header holds a NUL no text file has.
 */
function isPortableExecutable(bytes: Uint8Array): boolean {
  if (bytes.length >= 64) {
    const peOffset = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0x3c, true)
    if (startsWith(bytes, [0x50, 0x45, 0x00, 0x00], peOffset)) return true
  }
  return bytes.subarray(0, 64).includes(0)
}

/**
 * The built-in sniffer. Recognises PDF, PNG, JPEG, GIF, WebP, TIFF (both byte
 * orders), ZIP and OOXML (docx/xlsx/pptx), HTML, SVG and XML text, and native
 * executables (PE/`MZ`, ELF, Mach-O, `#!` scripts). Returns `null` for anything
 * else — plain text, CSV, and formats it has no signature for.
 */
export function sniffContentType(bytes: Uint8Array): string | null {
  if (startsWith(bytes, PDF)) return 'application/pdf'
  if (startsWith(bytes, PNG)) return 'image/png'
  if (startsWith(bytes, JPEG)) return 'image/jpeg'
  if (startsWith(bytes, GIF87) || startsWith(bytes, GIF89)) return 'image/gif'
  if (startsWith(bytes, RIFF) && startsWith(bytes, WEBP, 8)) return 'image/webp'
  if (startsWith(bytes, TIFF_LE) || startsWith(bytes, TIFF_BE)) return 'image/tiff'
  if (startsWith(bytes, ZIP_LOCAL)) return sniffZip(bytes)
  if (startsWith(bytes, ZIP_EMPTY) || startsWith(bytes, ZIP_SPANNED)) return 'application/zip'
  if (startsWith(bytes, ELF)) return 'application/x-elf'
  if (startsWith(bytes, MZ) && isPortableExecutable(bytes)) return 'application/x-msdownload'
  if (MACH_O.some((sig) => startsWith(bytes, sig))) return 'application/x-mach-binary'
  if (startsWith(bytes, SHEBANG)) return 'text/x-shellscript'
  return sniffText(bytes)
}

/** Spellings clients send for the same type. */
const ALIASES: Record<string, string> = {
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'application/x-pdf': 'application/pdf',
  'application/x-zip-compressed': 'application/zip',
  'text/xml': 'application/xml',
  'application/x-msdos-program': 'application/x-msdownload',
  'application/vnd.microsoft.portable-executable': 'application/x-msdownload',
}

/** The bare, lowercase, canonical form of a content type (`Image/JPG; q=1` → `image/jpeg`). */
export function normalizeContentType(contentType: string): string {
  const bare = contentType.split(';')[0]!.trim().toLowerCase()
  return ALIASES[bare] ?? bare
}

const OOXML = new Set([DOCX, XLSX, PPTX])

/**
 * Whether bytes detected as `detected` may be stored under the client's
 * `declared` type. Identity (after normalisation) always is; so is a client that
 * declared nothing specific (`application/octet-stream`), and a ZIP-based
 * office document declared as a plain ZIP. Everything else is a disguise.
 */
export function isCompatibleType(declared: string, detected: string): boolean {
  const d = normalizeContentType(declared)
  if (d === detected) return true
  if (d === 'application/octet-stream' || d === '') return true
  if (d === 'application/zip' && OOXML.has(detected)) return true
  return false
}

/** Whether `declared` is a type the built-in sniffer can verify — so bytes that don't match it are a lie. */
export function isSignatureType(declared: string): boolean {
  return SIGNATURE_TYPES.has(normalizeContentType(declared))
}
