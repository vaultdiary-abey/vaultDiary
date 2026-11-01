// Passkey slots in vault.json (FORMAT.md §3.3): the master key wrapped by a key derived from a
// WebAuthn PRF output. The PRF output is a secret the authenticator (iCloud Keychain, Google
// Password Manager, …) computes from the credential's own secret and our prfSalt, and only
// releases after user verification (Face ID, Touch ID, device PIN).
//
//   KEK = HKDF-SHA256(IKM = PRF output, salt = prfSalt, info = "VaultDiary passkey wrap v1")
//   ct  = AES-256-GCM(KEK, iv, MK, AAD = "VDV1/mk/<vaultId>/webauthn-prf/<slotId>")
//
// This file is pure crypto and is unit tested with mocked PRF outputs. The browser side
// (navigator.credentials) is in src/core/webauthn.ts.
import { fromBase64, fromBase64Url, isId, own, randomId, toBase64Url, utf8, wipe } from './bytes'
import { WrongSecretError } from './errors'
import { unwrapMk, wrapMk, type PasskeyWrapper, type VaultFile } from './vault'

export const PASSKEY_TYPE = 'webauthn-prf'
export const PASSKEY_HKDF_INFO = 'VaultDiary passkey wrap v1'
export const PRF_LENGTH = 32
export const PRF_SALT_LENGTH = 32

export function passkeyAad(vaultId: string, slotId: string): Uint8Array<ArrayBuffer> {
  return utf8(`VDV1/mk/${vaultId}/${PASSKEY_TYPE}/${slotId}`)
}

export async function passkeyKek(
  prfOutput: Uint8Array,
  prfSalt: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  if (prfOutput.length !== PRF_LENGTH) {
    throw new WrongSecretError('The passkey returned an unexpected secret.')
  }
  const ikm = await crypto.subtle.importKey('raw', own(prfOutput), 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: own(prfSalt), info: utf8(PASSKEY_HKDF_INFO) },
    ikm,
    256,
  )
  return new Uint8Array(bits)
}

function isB64Url(v: unknown, bytes?: number): v is string {
  if (typeof v !== 'string') return false
  try {
    const decoded = fromBase64Url(v)
    return bytes === undefined ? decoded.length > 0 : decoded.length === bytes
  } catch {
    return false
  }
}

function isB64(v: unknown, bytes: number): v is string {
  if (typeof v !== 'string') return false
  try {
    return fromBase64(v).length === bytes
  } catch {
    return false
  }
}

/** True for a well-formed passkey slot. vault.json is untrusted input. */
export function isPasskeyWrapper(w: unknown): w is PasskeyWrapper {
  const r = w as Record<string, unknown>
  return (
    !!r &&
    typeof r === 'object' &&
    r.type === PASSKEY_TYPE &&
    isId(r.id) &&
    typeof r.rpId === 'string' &&
    r.rpId.length > 0 &&
    isB64Url(r.credentialId) &&
    isB64Url(r.prfSalt, PRF_SALT_LENGTH) &&
    isB64(r.iv, 12) &&
    isB64(r.ct, 48)
  )
}

export function passkeyWrappers(vault: VaultFile | null): PasskeyWrapper[] {
  return (vault?.wrappers ?? []).filter(isPasskeyWrapper)
}

/** Passkey slots usable on this site: a passkey only works at the hostname it was made for. */
export function passkeysForHost(vault: VaultFile | null, hostname: string): PasskeyWrapper[] {
  return passkeyWrappers(vault).filter((w) => w.rpId === hostname)
}

export interface NewPasskeySlot {
  label: string
  provider: string
  rpId: string
  credentialId: Uint8Array
  prfSalt: Uint8Array
  prfOutput: Uint8Array
  /** Tests only. */
  id?: string
  createdAt?: string
}

export async function makePasskeyWrapper(
  vaultId: string,
  rawMk: Uint8Array,
  slot: NewPasskeySlot,
): Promise<PasskeyWrapper> {
  if (slot.prfSalt.length !== PRF_SALT_LENGTH) throw new Error('prfSalt must be 32 bytes')
  const id = slot.id ?? randomId()
  const kek = await passkeyKek(slot.prfOutput, slot.prfSalt)
  try {
    const wrapped = await wrapMk(kek, rawMk, passkeyAad(vaultId, id))
    return {
      type: PASSKEY_TYPE,
      id,
      label: slot.label.trim() || 'Passkey',
      provider: slot.provider,
      rpId: slot.rpId,
      credentialId: toBase64Url(slot.credentialId),
      prfSalt: toBase64Url(slot.prfSalt),
      ...wrapped,
      createdAt: slot.createdAt ?? new Date().toISOString(),
    }
  } finally {
    wipe(kek)
  }
}

/** Returns the raw MK. Callers must wipe() it as soon as possible. */
export async function unwrapWithPasskey(
  vault: VaultFile,
  wrapper: PasskeyWrapper,
  prfOutput: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!isPasskeyWrapper(wrapper)) throw new WrongSecretError('This passkey slot is damaged.')
  const kek = await passkeyKek(prfOutput, fromBase64Url(wrapper.prfSalt))
  try {
    const raw = await unwrapMk(kek, wrapper, passkeyAad(vault.vaultId, wrapper.id))
    if (!raw) throw new WrongSecretError('This passkey could not unlock the diary.')
    return raw
  } finally {
    wipe(kek)
  }
}

/** Finds the slot for the credential the browser returned. */
export function wrapperForCredential(
  vault: VaultFile | null,
  credentialId: Uint8Array,
): PasskeyWrapper | null {
  const id = toBase64Url(credentialId)
  return passkeyWrappers(vault).find((w) => w.credentialId === id) ?? null
}
