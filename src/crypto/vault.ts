// vault.json: the master key (MK) wrapped by each unlock method. See FORMAT.md.
import { argon2id } from 'hash-wasm'
import { fromBase64, own, randomBytes, randomId, toBase64, utf8, wipe } from './bytes'
import { entropyToWords, wordsToEntropy } from './bip39'
import { importMasterKey } from './container'
import { FormatError, WrongSecretError } from './errors'

export const VAULT_FORMAT = 'vaultdiary-vault'
export const VAULT_VERSION = 1
export const RECOVERY_HKDF_INFO = 'VaultDiary v1 recovery key'
export const MIN_PASSPHRASE_LENGTH = 10

export interface Argon2Params {
  memoryKiB: number
  iterations: number
  parallelism: number
}

export const DEFAULT_ARGON2: Argon2Params = { memoryKiB: 65536, iterations: 3, parallelism: 1 }

// Bounds accepted when reading vault.json, so a hostile file can't make us allocate gigabytes.
const ARGON2_BOUNDS = { memoryKiB: [8192, 1048576], iterations: [1, 32], parallelism: [1, 16] }

export interface PassphraseWrapper {
  type: 'passphrase'
  kdf: {
    name: 'argon2id'
    version: 19
    memoryKiB: number
    iterations: number
    parallelism: number
    salt: string
  }
  iv: string
  ct: string
  /**
   * When this passphrase was set (FORMAT.md revision 2, optional). Used to pick the newest
   * passphrase when two devices changed it before syncing. Missing in Phase 1 vaults, where the
   * vault's own updatedAt stands in for it.
   */
  updatedAt?: string
}

export interface RecoveryWrapper {
  type: 'recovery'
  kdf: { name: 'hkdf-sha256'; salt: string; info: string }
  iv: string
  ct: string
}

/** A passkey slot (WebAuthn PRF). See passkey.ts and FORMAT.md §3.3. */
export interface PasskeyWrapper {
  type: 'webauthn-prf'
  /** Slot id, 32 hex characters. Also part of the AAD. */
  id: string
  label: string
  /** Password manager that holds the passkey, e.g. "icloud-keychain", or "unknown". */
  provider: string
  /** The site the passkey belongs to (location.hostname when it was made). */
  rpId: string
  /** base64url */
  credentialId: string
  /** base64url, 32 bytes: the PRF input. */
  prfSalt: string
  iv: string
  ct: string
  createdAt: string
}

/** A wrapper type this version doesn't know. Kept unchanged. */
export interface UnknownWrapper {
  type: string
  [field: string]: unknown
}

export type KeyWrapper = PassphraseWrapper | RecoveryWrapper | PasskeyWrapper

export interface VaultFile {
  format: typeof VAULT_FORMAT
  v: typeof VAULT_VERSION
  vaultId: string
  createdAt: string
  updatedAt: string
  wrappers: (KeyWrapper | UnknownWrapper)[]
}

export function mkAad(vaultId: string, type: 'passphrase' | 'recovery'): Uint8Array<ArrayBuffer> {
  return utf8(`VDV1/mk/${vaultId}/${type}`)
}

export function normalisePassphrase(passphrase: string): Uint8Array<ArrayBuffer> {
  return utf8(passphrase.normalize('NFC'))
}

async function aesKey(raw: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', own(raw), { name: 'AES-GCM' }, false, usages)
}

export async function argon2Kek(
  passphrase: string,
  salt: Uint8Array,
  params: Argon2Params,
): Promise<Uint8Array<ArrayBuffer>> {
  const password = normalisePassphrase(passphrase)
  try {
    const out = await argon2id({
      password,
      salt,
      parallelism: params.parallelism,
      iterations: params.iterations,
      memorySize: params.memoryKiB,
      hashLength: 32,
      outputType: 'binary',
    })
    return own(out)
  } finally {
    wipe(password)
  }
}

export async function recoveryKek(
  entropy: Uint8Array,
  salt: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  const ikm = await crypto.subtle.importKey('raw', own(entropy), 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: own(salt), info: utf8(RECOVERY_HKDF_INFO) },
    ikm,
    256,
  )
  return new Uint8Array(bits)
}

/** AES-256-GCM wraps the raw MK under a KEK. Shared by every wrapper type. */
export async function wrapMk(
  kek: Uint8Array,
  rawMk: Uint8Array,
  aad: Uint8Array<ArrayBuffer>,
): Promise<{ iv: string; ct: string }> {
  const key = await aesKey(kek, ['encrypt'])
  const iv = randomBytes(12)
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, own(rawMk)),
  )
  return { iv: toBase64(iv), ct: toBase64(ct) }
}

/** Returns the raw MK, or null if the KEK or AAD is wrong. */
export async function unwrapMk(
  kek: Uint8Array,
  wrapper: { iv: string; ct: string },
  aad: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const key = await aesKey(kek, ['decrypt'])
  try {
    const raw = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: fromBase64(wrapper.iv), additionalData: aad },
        key,
        fromBase64(wrapper.ct),
      ),
    )
    return raw.length === 32 ? raw : null
  } catch {
    return null
  }
}

export async function makePassphraseWrapper(
  vaultId: string,
  rawMk: Uint8Array,
  passphrase: string,
  params: Argon2Params = DEFAULT_ARGON2,
): Promise<PassphraseWrapper> {
  const salt = randomBytes(16)
  const kek = await argon2Kek(passphrase, salt, params)
  try {
    const wrapped = await wrapMk(kek, rawMk, mkAad(vaultId, 'passphrase'))
    return {
      type: 'passphrase',
      kdf: { name: 'argon2id', version: 19, ...params, salt: toBase64(salt) },
      ...wrapped,
      updatedAt: new Date().toISOString(),
    }
  } finally {
    wipe(kek)
  }
}

export async function makeRecoveryWrapper(
  vaultId: string,
  rawMk: Uint8Array,
  entropy: Uint8Array,
): Promise<RecoveryWrapper> {
  const salt = randomBytes(16)
  const kek = await recoveryKek(entropy, salt)
  try {
    const wrapped = await wrapMk(kek, rawMk, mkAad(vaultId, 'recovery'))
    return {
      type: 'recovery',
      kdf: { name: 'hkdf-sha256', salt: toBase64(salt), info: RECOVERY_HKDF_INFO },
      ...wrapped,
    }
  } finally {
    wipe(kek)
  }
}

export interface NewVault {
  vault: VaultFile
  mk: CryptoKey
  recoveryWords: string[]
}

export async function createVault(
  passphrase: string,
  params: Argon2Params = DEFAULT_ARGON2,
): Promise<NewVault> {
  const rawMk = randomBytes(32)
  const entropy = randomBytes(32)
  try {
    const vaultId = randomId()
    const now = new Date().toISOString()
    const vault: VaultFile = {
      format: VAULT_FORMAT,
      v: VAULT_VERSION,
      vaultId,
      createdAt: now,
      updatedAt: now,
      wrappers: [
        await makePassphraseWrapper(vaultId, rawMk, passphrase, params),
        await makeRecoveryWrapper(vaultId, rawMk, entropy),
      ],
    }
    return {
      vault,
      mk: await importMasterKey(rawMk),
      recoveryWords: await entropyToWords(entropy),
    }
  } finally {
    wipe(rawMk)
    wipe(entropy)
  }
}

export function parseVault(json: string | unknown): VaultFile {
  let raw: unknown = json
  if (typeof json === 'string') {
    try {
      raw = JSON.parse(json)
    } catch {
      throw new FormatError('vault.json is not valid JSON.')
    }
  }
  const v = raw as Partial<VaultFile>
  if (!v || typeof v !== 'object' || v.format !== VAULT_FORMAT) {
    throw new FormatError('This is not a Vault Diary vault.json.')
  }
  if (v.v !== VAULT_VERSION) throw new FormatError(`Unsupported vault version ${String(v.v)}.`)
  if (typeof v.vaultId !== 'string' || !/^[0-9a-f]{32}$/.test(v.vaultId)) {
    throw new FormatError('vault.json has an invalid vaultId.')
  }
  if (!Array.isArray(v.wrappers)) throw new FormatError('vault.json has no key wrappers.')
  return v as VaultFile
}

function findWrapper<T extends KeyWrapper['type']>(
  vault: VaultFile,
  type: T,
): Extract<KeyWrapper, { type: T }> {
  const w = vault.wrappers.find((x) => x.type === type)
  if (!w) throw new FormatError(`vault.json has no ${type} wrapper.`)
  return w as unknown as Extract<KeyWrapper, { type: T }>
}

function checkArgon2(kdf: PassphraseWrapper['kdf']): Argon2Params {
  if (kdf.name !== 'argon2id' || kdf.version !== 19) throw new FormatError('Unsupported KDF.')
  for (const [field, [lo, hi]] of Object.entries(ARGON2_BOUNDS)) {
    const value = kdf[field as keyof Argon2Params]
    if (!Number.isInteger(value) || value < lo || value > hi) {
      throw new FormatError(`Argon2 ${field} out of range.`)
    }
  }
  return { memoryKiB: kdf.memoryKiB, iterations: kdf.iterations, parallelism: kdf.parallelism }
}

/** Returns the raw MK. Callers must wipe() it as soon as possible. */
export async function unwrapWithPassphrase(
  vault: VaultFile,
  passphrase: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const w = findWrapper(vault, 'passphrase')
  const params = checkArgon2(w.kdf)
  if (!passphrase) throw new WrongSecretError('Wrong passphrase.')
  const kek = await argon2Kek(passphrase, fromBase64(w.kdf.salt), params)
  try {
    const raw = await unwrapMk(kek, w, mkAad(vault.vaultId, 'passphrase'))
    if (!raw) throw new WrongSecretError('Wrong passphrase.')
    return raw
  } finally {
    wipe(kek)
  }
}

/** Returns the raw MK. Callers must wipe() it as soon as possible. */
export async function unwrapWithRecoveryWords(
  vault: VaultFile,
  words: string | string[],
): Promise<Uint8Array<ArrayBuffer>> {
  const w = findWrapper(vault, 'recovery')
  if (w.kdf.name !== 'hkdf-sha256') throw new FormatError('Unsupported recovery KDF.')
  const entropy = await wordsToEntropy(words)
  const kek = await recoveryKek(entropy, fromBase64(w.kdf.salt))
  wipe(entropy)
  try {
    const raw = await unwrapMk(kek, w, mkAad(vault.vaultId, 'recovery'))
    if (!raw) throw new WrongSecretError('These recovery words do not belong to this vault.')
    return raw
  } finally {
    wipe(kek)
  }
}

export async function unlockWithPassphrase(vault: VaultFile, passphrase: string) {
  const raw = await unwrapWithPassphrase(vault, passphrase)
  try {
    return await importMasterKey(raw)
  } finally {
    wipe(raw)
  }
}

/** Replaces the passphrase wrapper. MK, every other wrapper (recovery, passkeys, unknown types)
 * and every encrypted file stay the same. */
export async function rewrapPassphrase(
  vault: VaultFile,
  rawMk: Uint8Array,
  newPassphrase: string,
  params: Argon2Params = DEFAULT_ARGON2,
): Promise<VaultFile> {
  const wrapper = await makePassphraseWrapper(vault.vaultId, rawMk, newPassphrase, params)
  return {
    ...vault,
    updatedAt: new Date().toISOString(),
    wrappers: [wrapper, ...vault.wrappers.filter((w) => w.type !== 'passphrase')],
  }
}

export async function changePassphrase(
  vault: VaultFile,
  currentPassphrase: string,
  newPassphrase: string,
  params: Argon2Params = DEFAULT_ARGON2,
): Promise<VaultFile> {
  const raw = await unwrapWithPassphrase(vault, currentPassphrase)
  try {
    return await rewrapPassphrase(vault, raw, newPassphrase, params)
  } finally {
    wipe(raw)
  }
}

export function passphraseProblem(passphrase: string): string | null {
  if (passphrase.normalize('NFC').length < MIN_PASSPHRASE_LENGTH) {
    return `Use at least ${MIN_PASSPHRASE_LENGTH} characters. A few unrelated words work well.`
  }
  return null
}
