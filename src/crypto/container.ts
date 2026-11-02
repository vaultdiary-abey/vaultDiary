// VDV1 encrypted container. See FORMAT.md for the byte layout.
//
//   "VDV1" | u32 BE header length | header JSON (UTF-8) | chunk 0 | chunk 1 | ...
//   chunk = 12-byte IV | AES-256-GCM ciphertext | 16-byte tag
//
// Every file has its own random 256-bit file key, wrapped by the master key (MK) and stored in
// the header. Chunk AAD binds the file id, chunk index and a last-chunk flag, so swapping,
// reordering, dropping or appending chunks fails authentication.
import {
  concatBytes,
  fromBase64,
  fromUtf8,
  isId,
  own,
  randomBytes,
  toBase64,
  utf8,
  wipe,
} from './bytes'
import { FormatError, IntegrityError } from './errors'

export const MAGIC = utf8('VDV1')
export const FORMAT_VERSION = 1
export const DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024
export const MAX_CHUNK_SIZE = 64 * 1024 * 1024
export const MAX_HEADER_LENGTH = 64 * 1024
export const IV_LENGTH = 12
export const TAG_LENGTH = 16
export const CHUNK_OVERHEAD = IV_LENGTH + TAG_LENGTH

/**
 * "settings" (settings.vds) is FORMAT.md revision 2: encrypted app settings such as templates.
 * "cache" is local-only (e.g. the search index cache in IndexedDB) and never written to Drive.
 */
export type FileKind = 'entry' | 'file' | 'index' | 'settings' | 'cache'
const KINDS: readonly FileKind[] = ['entry', 'file', 'index', 'settings', 'cache']

export interface WrappedKey {
  iv: string
  ct: string
}

export interface ContainerHeader {
  v: 1
  kind: FileKind
  id: string
  alg: 'A256GCM'
  chunkSize: number
  chunkCount: number
  size: number
  key: WrappedKey
}

/** Random-access read interface so big Blobs are never loaded whole. */
export interface ByteSource {
  readonly size: number
  read(offset: number, length: number): Promise<Uint8Array>
}

export function bytesSource(bytes: Uint8Array): ByteSource {
  return {
    size: bytes.length,
    read: async (offset, length) => bytes.subarray(offset, offset + length),
  }
}

export function blobSource(blob: Blob): ByteSource {
  return {
    size: blob.size,
    read: async (offset, length) =>
      new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer()),
  }
}

export function chunkAad(id: string, index: number, last: boolean): Uint8Array<ArrayBuffer> {
  return utf8(`VDV1/chunk/${id}/${index}/${last ? 1 : 0}`)
}

export function fileKeyAad(kind: FileKind, id: string): Uint8Array<ArrayBuffer> {
  return utf8(`VDV1/filekey/${kind}/${id}`)
}

export function chunkCountFor(size: number, chunkSize: number): number {
  // An empty file still has one (empty) final chunk, so it can't be truncated to nothing.
  return Math.max(1, Math.ceil(size / chunkSize))
}

/** Total encrypted length of a container's chunk area. */
export function encryptedDataLength(size: number, chunkSize: number): number {
  return size + chunkCountFor(size, chunkSize) * CHUNK_OVERHEAD
}

async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', own(raw), { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ])
}

export async function importMasterKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== 32) throw new Error('Master key must be 32 bytes')
  return importAesKey(raw)
}

async function gcmEncrypt(
  key: CryptoKey,
  plaintext: Uint8Array,
  aad: Uint8Array<ArrayBuffer>,
): Promise<{ iv: Uint8Array<ArrayBuffer>; ct: Uint8Array<ArrayBuffer> }> {
  const iv = randomBytes(IV_LENGTH)
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 },
      key,
      own(plaintext),
    ),
  )
  return { iv, ct }
}

async function gcmDecrypt(
  key: CryptoKey,
  iv: Uint8Array<ArrayBuffer>,
  ct: Uint8Array<ArrayBuffer>,
  aad: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer> | null> {
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 },
        key,
        ct,
      ),
    )
  } catch {
    return null
  }
}

export interface EncryptOptions {
  id: string
  kind: FileKind
  source: ByteSource
  /** Only tests and the fixture change this. The app always uses 4 MiB. */
  chunkSize?: number
  onProgress?: (doneBytes: number, totalBytes: number) => void
}

/** Yields the container piece by piece: first the preamble+header, then one item per chunk. */
export async function* encryptContainer(
  mk: CryptoKey,
  options: EncryptOptions,
): AsyncGenerator<Uint8Array<ArrayBuffer>> {
  const { id, kind, source } = options
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE
  if (!isId(id)) throw new Error('Invalid file id')
  if (!KINDS.includes(kind)) throw new Error('Invalid kind')
  if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > MAX_CHUNK_SIZE) {
    throw new Error('Invalid chunk size')
  }
  const size = source.size
  const chunkCount = chunkCountFor(size, chunkSize)

  const rawFileKey = randomBytes(32)
  let fileKey: CryptoKey
  let wrapped: { iv: Uint8Array; ct: Uint8Array }
  try {
    fileKey = await importAesKey(rawFileKey)
    wrapped = await gcmEncrypt(mk, rawFileKey, fileKeyAad(kind, id))
  } finally {
    wipe(rawFileKey)
  }

  const header: ContainerHeader = {
    v: FORMAT_VERSION,
    kind,
    id,
    alg: 'A256GCM',
    chunkSize,
    chunkCount,
    size,
    key: { iv: toBase64(wrapped.iv), ct: toBase64(wrapped.ct) },
  }
  const headerBytes = utf8(JSON.stringify(header))
  const lengthBytes = new Uint8Array(4)
  new DataView(lengthBytes.buffer).setUint32(0, headerBytes.length, false)
  yield concatBytes(MAGIC, lengthBytes, headerBytes)

  for (let index = 0; index < chunkCount; index++) {
    const start = index * chunkSize
    const length = Math.min(chunkSize, size - start)
    const plain = length > 0 ? await source.read(start, length) : new Uint8Array(0)
    if (plain.length !== length) throw new Error('Short read from source')
    const last = index === chunkCount - 1
    const { iv, ct } = await gcmEncrypt(fileKey, plain, chunkAad(id, index, last))
    yield concatBytes(iv, ct)
    options.onProgress?.(start + length, size)
  }
}

export async function encryptBytes(
  mk: CryptoKey,
  id: string,
  kind: FileKind,
  plaintext: Uint8Array,
  chunkSize?: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const parts: Uint8Array[] = []
  for await (const part of encryptContainer(mk, {
    id,
    kind,
    source: bytesSource(plaintext),
    chunkSize,
  })) {
    parts.push(part)
  }
  return concatBytes(...parts)
}

/** Encrypts into a Blob, one chunk at a time, so large files never sit in memory whole. */
export async function encryptToBlob(mk: CryptoKey, options: EncryptOptions): Promise<Blob> {
  const parts: Blob[] = []
  for await (const part of encryptContainer(mk, options)) parts.push(new Blob([part]))
  return new Blob(parts, { type: 'application/octet-stream' })
}

export interface ParsedHeader {
  header: ContainerHeader
  /** Byte offset of chunk 0. */
  dataOffset: number
}

function fail(message: string): never {
  throw new FormatError(message)
}

function isPositiveInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0
}

export async function readHeader(source: ByteSource): Promise<ParsedHeader> {
  if (source.size < 8) fail('Not a Vault Diary file (too short).')
  const pre = await source.read(0, 8)
  for (let i = 0; i < 4; i++) if (pre[i] !== MAGIC[i]) fail('Not a Vault Diary file (bad magic).')
  const headerLength = new DataView(pre.buffer, pre.byteOffset, 8).getUint32(4, false)
  if (headerLength < 2 || headerLength > MAX_HEADER_LENGTH) fail('Invalid header length.')
  if (source.size < 8 + headerLength) fail('File is truncated (header).')
  let raw: unknown
  try {
    raw = JSON.parse(fromUtf8(await source.read(8, headerLength)))
  } catch {
    fail('Header is not valid JSON.')
  }
  const h = raw as Partial<ContainerHeader>
  if (typeof h !== 'object' || h === null) fail('Header is not an object.')
  if (h.v !== FORMAT_VERSION) fail(`Unsupported format version ${String(h.v)}.`)
  if (h.alg !== 'A256GCM') fail('Unsupported algorithm.')
  if (!KINDS.includes(h.kind as FileKind)) fail('Unknown file kind.')
  if (!isId(h.id)) fail('Invalid file id in header.')
  if (!isPositiveInt(h.chunkSize) || h.chunkSize < 1 || h.chunkSize > MAX_CHUNK_SIZE) {
    fail('Invalid chunk size.')
  }
  if (!isPositiveInt(h.size)) fail('Invalid plaintext size.')
  if (h.chunkCount !== chunkCountFor(h.size, h.chunkSize)) fail('Chunk count does not match size.')
  if (!h.key || typeof h.key.iv !== 'string' || typeof h.key.ct !== 'string') {
    fail('Missing wrapped file key.')
  }
  const dataOffset = 8 + headerLength
  const expected = dataOffset + encryptedDataLength(h.size, h.chunkSize)
  if (source.size < expected) fail('File is truncated.')
  if (source.size > expected) fail('Unexpected data after the last chunk.')
  return { header: h as ContainerHeader, dataOffset }
}

export interface DecryptOptions {
  expectedId?: string
  expectedKind?: FileKind
  onProgress?: (doneBytes: number, totalBytes: number) => void
}

async function unwrapFileKey(mk: CryptoKey, header: ContainerHeader): Promise<CryptoKey> {
  let iv: Uint8Array<ArrayBuffer>, ct: Uint8Array<ArrayBuffer>
  try {
    iv = fromBase64(header.key.iv)
    ct = fromBase64(header.key.ct)
  } catch {
    fail('Wrapped file key is not valid base64.')
  }
  if (iv.length !== IV_LENGTH) fail('Wrapped file key has a bad IV.')
  const raw = await gcmDecrypt(mk, iv, ct, fileKeyAad(header.kind, header.id))
  if (!raw || raw.length !== 32) {
    throw new IntegrityError(
      'Could not unwrap the file key: this file belongs to another vault or its header was modified.',
    )
  }
  try {
    return await importAesKey(raw)
  } finally {
    wipe(raw)
  }
}

/** Yields plaintext chunk by chunk. Throws FormatError / IntegrityError on any problem. */
export async function* decryptContainer(
  mk: CryptoKey,
  source: ByteSource,
  options: DecryptOptions = {},
): AsyncGenerator<Uint8Array<ArrayBuffer>, ContainerHeader> {
  const { header, dataOffset } = await readHeader(source)
  if (options.expectedId && header.id !== options.expectedId) {
    throw new IntegrityError('File id in header does not match the file name.')
  }
  if (options.expectedKind && header.kind !== options.expectedKind) {
    throw new IntegrityError(`Expected a ${options.expectedKind} file, found ${header.kind}.`)
  }
  const fileKey = await unwrapFileKey(mk, header)
  let offset = dataOffset
  let done = 0
  for (let index = 0; index < header.chunkCount; index++) {
    const last = index === header.chunkCount - 1
    const plainLength = last ? header.size - index * header.chunkSize : header.chunkSize
    const chunk = await source.read(offset, plainLength + CHUNK_OVERHEAD)
    offset += plainLength + CHUNK_OVERHEAD
    const iv = own(chunk.subarray(0, IV_LENGTH))
    const ct = own(chunk.subarray(IV_LENGTH))
    const plain = await gcmDecrypt(fileKey, iv, ct, chunkAad(header.id, index, last))
    if (!plain) {
      throw new IntegrityError(
        `Chunk ${index} failed authentication: the file was modified, reordered or truncated.`,
      )
    }
    done += plain.length
    options.onProgress?.(done, header.size)
    yield plain
  }
  return header
}

export async function decryptBytes(
  mk: CryptoKey,
  data: Uint8Array,
  options: DecryptOptions = {},
): Promise<Uint8Array<ArrayBuffer>> {
  const parts: Uint8Array[] = []
  for await (const part of decryptContainer(mk, bytesSource(data), options)) parts.push(part)
  return concatBytes(...parts)
}

export async function decryptToBlob(
  mk: CryptoKey,
  source: ByteSource,
  mime: string,
  options: DecryptOptions = {},
): Promise<Blob> {
  const parts: Blob[] = []
  for await (const part of decryptContainer(mk, source, options)) parts.push(new Blob([part]))
  return new Blob(parts, { type: mime || 'application/octet-stream' })
}

export async function encryptJson(
  mk: CryptoKey,
  id: string,
  kind: FileKind,
  value: unknown,
): Promise<Uint8Array<ArrayBuffer>> {
  return encryptBytes(mk, id, kind, utf8(JSON.stringify(value)))
}

export async function decryptJson<T>(
  mk: CryptoKey,
  data: Uint8Array,
  options: DecryptOptions = {},
): Promise<T> {
  const plain = await decryptBytes(mk, data, options)
  try {
    return JSON.parse(fromUtf8(plain)) as T
  } catch {
    throw new FormatError('Decrypted content is not valid JSON.')
  }
}
