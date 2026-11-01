// Small byte helpers. No crypto here beyond calling crypto.getRandomValues.

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

export function utf8(text: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(text)
}

export function fromUtf8(bytes: Uint8Array): string {
  return decoder.decode(bytes)
}

export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(length)
  // getRandomValues is limited to 65536 bytes per call.
  for (let i = 0; i < length; i += 65536) {
    crypto.getRandomValues(out.subarray(i, Math.min(length, i + 65536)))
  }
  return out
}

/** 128-bit random id as 32 lowercase hex characters. */
export function randomId(): string {
  return toHex(randomBytes(16))
}

export const ID_PATTERN = /^[0-9a-f]{32}$/

export function isId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value)
}

export function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

export function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) throw new Error('Invalid hex')
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

export function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  if (typeof text !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) {
    throw new Error('Invalid base64')
  }
  const binary = atob(text)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

/** RFC 4648 §5 base64url without padding (WebAuthn credential ids). */
export function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) {
    throw new Error('Invalid base64url')
  }
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/')
  return fromBase64(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  let length = 0
  for (const p of parts) length += p.length
  const out = new Uint8Array(length)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

/** Overwrite a buffer we own. JS can't promise the engine kept no other copy. */
export function wipe(bytes: Uint8Array | null | undefined): void {
  if (bytes) bytes.fill(0)
}

/** Copy into a fresh ArrayBuffer-backed array (WebCrypto wants exactly that). */
export function own(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes)
}
