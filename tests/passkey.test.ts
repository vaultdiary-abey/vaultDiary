import { describe, expect, it } from 'vitest'
import { fromBase64Url, randomBytes, randomId, toBase64Url, utf8, wipe } from '../src/crypto/bytes'
import { decryptBytes, encryptBytes, importMasterKey } from '../src/crypto/container'
import { WrongSecretError } from '../src/crypto/errors'
import {
  isPasskeyWrapper,
  makePasskeyWrapper,
  passkeyAad,
  passkeysForHost,
  unwrapWithPasskey,
  wrapperForCredential,
} from '../src/crypto/passkey'
import {
  changePassphrase,
  createVault,
  importMasterKeyFromRecovery,
  rewrapPassphrase,
  unlockWithPassphrase,
  unwrapWithPassphrase,
  type VaultFile,
} from './helpers'

async function vaultWithPasskey(passphrase = 'passkey test passphrase') {
  const created = await createVault(passphrase)
  const rawMk = await unwrapWithPassphrase(created.vault, passphrase)
  const prfOutput = randomBytes(32)
  const credentialId = randomBytes(20)
  const wrapper = await makePasskeyWrapper(created.vault.vaultId, rawMk, {
    label: 'iPhone Face ID',
    provider: 'icloud-keychain',
    rpId: 'vaultdiary.example',
    credentialId,
    prfSalt: randomBytes(32),
    prfOutput,
  })
  wipe(rawMk)
  const vault: VaultFile = { ...created.vault, wrappers: [...created.vault.wrappers, wrapper] }
  return { ...created, vault, wrapper, prfOutput, credentialId, passphrase }
}

describe('passkey wrapper (WebAuthn PRF, mocked PRF output)', () => {
  it('round trips: the PRF output unwraps the same master key', async () => {
    const { vault, mk, wrapper, prfOutput } = await vaultWithPasskey()
    expect(isPasskeyWrapper(wrapper)).toBe(true)
    expect(wrapper.type).toBe('webauthn-prf')
    expect(wrapper.id).toMatch(/^[0-9a-f]{32}$/)
    expect(fromBase64Url(wrapper.prfSalt)).toHaveLength(32)
    const enc = await encryptBytes(mk, randomId(), 'entry', utf8('secret'))
    const raw = await unwrapWithPasskey(vault, wrapper, prfOutput)
    const viaPasskey = await importMasterKey(raw)
    expect(new TextDecoder().decode(await decryptBytes(viaPasskey, enc))).toBe('secret')
  })

  it('fails cleanly on a wrong PRF output, wrong vault or moved slot', async () => {
    const { vault, wrapper, prfOutput } = await vaultWithPasskey()
    await expect(unwrapWithPasskey(vault, wrapper, randomBytes(32))).rejects.toThrow(
      WrongSecretError,
    )
    await expect(unwrapWithPasskey(vault, wrapper, randomBytes(16))).rejects.toThrow(
      WrongSecretError,
    )
    // The slot id and vault id are in the AAD: relabelling a slot or moving it fails.
    await expect(
      unwrapWithPasskey(vault, { ...wrapper, id: randomId() }, prfOutput),
    ).rejects.toThrow(WrongSecretError)
    await expect(
      unwrapWithPasskey({ ...vault, vaultId: randomId() }, wrapper, prfOutput),
    ).rejects.toThrow(WrongSecretError)
    // A different salt gives a different key.
    await expect(
      unwrapWithPasskey(vault, { ...wrapper, prfSalt: toBase64Url(randomBytes(32)) }, prfOutput),
    ).rejects.toThrow(WrongSecretError)
  })

  it('uses the documented AAD and HKDF info', async () => {
    expect(new TextDecoder().decode(passkeyAad('a'.repeat(32), 'b'.repeat(32)))).toBe(
      `VDV1/mk/${'a'.repeat(32)}/webauthn-prf/${'b'.repeat(32)}`,
    )
  })

  it('rejects malformed slots from a hostile vault.json', async () => {
    const { wrapper } = await vaultWithPasskey()
    expect(isPasskeyWrapper({ ...wrapper, prfSalt: 'short' })).toBe(false)
    expect(isPasskeyWrapper({ ...wrapper, credentialId: 'not base64url!' })).toBe(false)
    expect(isPasskeyWrapper({ ...wrapper, id: 'x' })).toBe(false)
    expect(isPasskeyWrapper({ ...wrapper, ct: 'AAAA' })).toBe(false)
    expect(isPasskeyWrapper({ type: 'webauthn-prf' })).toBe(false)
  })

  it('finds slots by host and by returned credential id', async () => {
    const { vault, wrapper, credentialId } = await vaultWithPasskey()
    expect(passkeysForHost(vault, 'vaultdiary.example')).toEqual([wrapper])
    expect(passkeysForHost(vault, 'other.example')).toEqual([])
    expect(wrapperForCredential(vault, credentialId)).toEqual(wrapper)
    expect(wrapperForCredential(vault, randomBytes(20))).toBeNull()
  })

  it('changing the passphrase keeps every passkey slot working', async () => {
    const { vault, wrapper, prfOutput, recoveryWords, passphrase } = await vaultWithPasskey()
    const changed = await changePassphrase(vault, passphrase, 'a different passphrase')
    expect(changed.wrappers).toContainEqual(wrapper)
    const raw = await unwrapWithPasskey(changed, wrapper, prfOutput)
    expect(raw).toHaveLength(32)
    // and the recovery words still re-wrap without touching it
    const rawMk = await unwrapWithPassphrase(changed, 'a different passphrase')
    const reset = await rewrapPassphrase(changed, rawMk, 'third passphrase here')
    expect(reset.wrappers).toContainEqual(wrapper)
    await expect(unlockWithPassphrase(reset, 'third passphrase here')).resolves.toBeTruthy()
    await expect(importMasterKeyFromRecovery(reset, recoveryWords)).resolves.toBeTruthy()
  })
})
