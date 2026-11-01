// Encryption for data that only ever lives in this browser's IndexedDB (an in-progress
// recording, saved chunk by chunk so a crash doesn't lose it). It never goes to Drive and is not
// part of FORMAT.md; it only has to keep IndexedDB free of plaintext.
//
// Each item gets its own random 256-bit key, wrapped by MK with AES-256-GCM. Each piece is
// AES-256-GCM with a fresh 96-bit IV and an AAD naming the item and the piece's position, so
// pieces can't be swapped, reordered or moved to another item.
import { fromBase64, own, randomBytes, toBase64, utf8, wipe } from './bytes'
import { IntegrityError } from './errors'

export interface SealedKey {
  iv: string
  ct: string
}

function keyAad(purpose: string, id: string) {
  return utf8(`VDV1/local/key/${purpose}/${id}`)
}

async function importKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', own(raw), { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ])
}

export async function newLocalKey(
  mk: CryptoKey,
  purpose: string,
  id: string,
): Promise<{ key: CryptoKey; wrapped: SealedKey }> {
  const raw = randomBytes(32)
  try {
    const iv = randomBytes(12)
    const ct = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: keyAad(purpose, id) },
        mk,
        raw,
      ),
    )
    return { key: await importKey(raw), wrapped: { iv: toBase64(iv), ct: toBase64(ct) } }
  } finally {
    wipe(raw)
  }
}

export async function openLocalKey(
  mk: CryptoKey,
  purpose: string,
  id: string,
  wrapped: SealedKey,
): Promise<CryptoKey> {
  let raw: Uint8Array<ArrayBuffer>
  try {
    raw = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: fromBase64(wrapped.iv), additionalData: keyAad(purpose, id) },
        mk,
        fromBase64(wrapped.ct),
      ),
    )
  } catch {
    throw new IntegrityError('This saved item belongs to another vault or was modified.')
  }
  try {
    return await importKey(raw)
  } finally {
    wipe(raw)
  }
}

/** Returns IV (12 bytes) | ciphertext | tag. */
export async function seal(
  key: CryptoKey,
  aad: string,
  data: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  const iv = randomBytes(12)
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8(aad) }, key, own(data)),
  )
  const out = new Uint8Array(12 + ct.length)
  out.set(iv)
  out.set(ct, 12)
  return out
}

export async function unseal(
  key: CryptoKey,
  aad: string,
  sealed: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  if (sealed.length < 28) throw new IntegrityError('Saved piece is truncated.')
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: own(sealed.subarray(0, 12)), additionalData: utf8(aad) },
        key,
        own(sealed.subarray(12)),
      ),
    )
  } catch {
    throw new IntegrityError('Saved piece failed authentication.')
  }
}
