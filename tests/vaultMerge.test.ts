import { describe, expect, it } from 'vitest'
import { randomBytes, wipe } from '../src/crypto/bytes'
import { makePasskeyWrapper, passkeyWrappers, unwrapWithPasskey } from '../src/crypto/passkey'
import { applyVaultOps, mergeVault, type VaultOp } from '../src/crypto/vaultMerge'
import {
  createVault,
  rewrapPassphrase,
  unlockWithPassphrase,
  unwrapWithPassphrase,
  type PassphraseWrapper,
  type VaultFile,
} from './helpers'

const FAST = { memoryKiB: 8192, iterations: 1, parallelism: 1 }

async function setup() {
  const { vault } = await createVault('first passphrase', FAST)
  const rawMk = await unwrapWithPassphrase(vault, 'first passphrase')
  const passkey = async (label: string) => {
    const prfOutput = randomBytes(32)
    const wrapper = await makePasskeyWrapper(vault.vaultId, rawMk, {
      label,
      provider: 'unknown',
      rpId: 'diary.example',
      credentialId: randomBytes(16),
      prfSalt: randomBytes(32),
      prfOutput,
    })
    return { wrapper, prfOutput }
  }
  return { vault, rawMk, passkey }
}

const json = (v: VaultFile) => JSON.stringify(v, null, 2)
const later = (ms: number) => new Date(Date.now() + ms)

describe('vault.json merge', () => {
  it('two devices each adding a passkey keep both', async () => {
    const { vault, passkey, rawMk } = await setup()
    const a = await passkey('Device A')
    const b = await passkey('Device B')
    const opsA: VaultOp[] = [{ op: 'addWrapper', wrapper: a.wrapper }]
    const opsB: VaultOp[] = [{ op: 'addWrapper', wrapper: b.wrapper }]
    const localA = applyVaultOps(vault, opsA).vault
    const localB = applyVaultOps(vault, opsB).vault

    // A pushes first (Drive still has the original), then B merges onto A's result.
    const drive1 = mergeVault(json(vault), localA, opsA).vault
    const drive2 = mergeVault(json(drive1), localB, opsB).vault
    expect(passkeyWrappers(drive2).map((w) => w.label)).toEqual(['Device A', 'Device B'])
    expect(drive2.wrappers.filter((w) => w.type === 'recovery')).toHaveLength(1)
    expect(drive2.wrappers.filter((w) => w.type === 'passphrase')).toHaveLength(1)
    for (const { wrapper, prfOutput } of [a, b]) {
      expect(await unwrapWithPasskey(drive2, wrapper, prfOutput)).toEqual(rawMk)
    }
    wipe(rawMk)
  })

  it('a passkey added on one device while the passphrase changes on another keeps both', async () => {
    const { vault, passkey, rawMk } = await setup()
    const a = await passkey('Phone')
    const opsA: VaultOp[] = [{ op: 'addWrapper', wrapper: a.wrapper }]
    const changed = await rewrapPassphrase(vault, rawMk, 'second passphrase', FAST)
    const newPass = changed.wrappers.find((w) => w.type === 'passphrase') as PassphraseWrapper
    const opsB: VaultOp[] = [{ op: 'setPassphrase', wrapper: newPass }]

    for (const order of ['A first', 'B first']) {
      const [first, second] =
        order === 'A first'
          ? [
              [applyVaultOps(vault, opsA).vault, opsA],
              [changed, opsB],
            ]
          : [
              [changed, opsB],
              [applyVaultOps(vault, opsA).vault, opsA],
            ]
      const drive1 = mergeVault(json(vault), first[0] as VaultFile, first[1] as VaultOp[]).vault
      const drive2 = mergeVault(json(drive1), second[0] as VaultFile, second[1] as VaultOp[])
      expect(drive2.notes).toEqual([])
      const result = drive2.vault
      expect(passkeyWrappers(result).map((w) => w.label)).toEqual(['Phone'])
      await expect(unlockWithPassphrase(result, 'first passphrase')).rejects.toThrow()
      await expect(unlockWithPassphrase(result, 'second passphrase')).resolves.toBeTruthy()
      expect(await unwrapWithPasskey(result, a.wrapper, a.prfOutput)).toEqual(rawMk)
    }
  })

  it('the newest passphrase wins when both devices changed it', async () => {
    const { vault, rawMk } = await setup()
    const older = (await rewrapPassphrase(vault, rawMk, 'older change', FAST)).wrappers[0]
    await new Promise((r) => setTimeout(r, 5))
    const newer = (await rewrapPassphrase(vault, rawMk, 'newer change', FAST)).wrappers[0]
    const olderOp: VaultOp = { op: 'setPassphrase', wrapper: older as PassphraseWrapper }
    const newerOp: VaultOp = { op: 'setPassphrase', wrapper: newer as PassphraseWrapper }

    // Newer pushed first; the older device's later push must not undo it, and says so.
    const drive1 = mergeVault(json(vault), vault, [newerOp]).vault
    const drive2 = mergeVault(json(drive1), vault, [olderOp], later(1000))
    expect(drive2.notes.join(' ')).toMatch(/changed on another device/)
    await expect(unlockWithPassphrase(drive2.vault, 'newer change')).resolves.toBeTruthy()
    // Older pushed first; the newer one replaces it.
    const drive3 = mergeVault(json(mergeVault(json(vault), vault, [olderOp]).vault), vault, [
      newerOp,
    ]).vault
    await expect(unlockWithPassphrase(drive3, 'newer change')).resolves.toBeTruthy()
  })

  it('removes a wrapper only when the removal was recorded on this device', async () => {
    const { vault, passkey } = await setup()
    const a = await passkey('A')
    const b = await passkey('B')
    const drive = applyVaultOps(vault, [
      { op: 'addWrapper', wrapper: a.wrapper },
      { op: 'addWrapper', wrapper: b.wrapper },
    ]).vault
    // This device has a stale copy without B and pushes an unrelated change: B stays.
    const stale = applyVaultOps(vault, [{ op: 'addWrapper', wrapper: a.wrapper }]).vault
    const c = await passkey('C')
    const merged = mergeVault(json(drive), stale, [{ op: 'addWrapper', wrapper: c.wrapper }]).vault
    expect(passkeyWrappers(merged).map((w) => w.label)).toEqual(['A', 'B', 'C'])
    // A recorded removal of A removes exactly A.
    const removed = mergeVault(json(merged), merged, [{ op: 'removeWrapper', id: a.wrapper.id }])
    expect(passkeyWrappers(removed.vault).map((w) => w.label)).toEqual(['B', 'C'])
    // A passkey removed on another device is not brought back by this device's stale copy.
    const again = mergeVault(json(removed.vault), merged, [
      { op: 'removeWrapper', id: c.wrapper.id },
    ])
    expect(passkeyWrappers(again.vault).map((w) => w.label)).toEqual(['B'])
  })

  it('keeps unknown wrapper types and fields from Drive untouched', async () => {
    const { vault, passkey } = await setup()
    const future = { type: 'future-thing', id: 'f'.repeat(32), data: [1, 2] }
    const drive = { ...vault, extra: 'kept', wrappers: [...vault.wrappers, future] }
    const a = await passkey('A')
    const merged = mergeVault(json(drive as VaultFile), vault, [
      { op: 'addWrapper', wrapper: a.wrapper },
    ]).vault as VaultFile & { extra?: string }
    expect(merged.extra).toBe('kept')
    expect(merged.wrappers).toContainEqual(future)
  })

  it('a Phase 1 vault marked dirty without operations pushes its passphrase change', async () => {
    const { vault, rawMk } = await setup()
    const phase1Change = await rewrapPassphrase(vault, rawMk, 'changed by phase one', FAST)
    // Phase 1 wrote no updatedAt on the wrapper; the vault's updatedAt stands in for it.
    const pass = { ...phase1Change.wrappers[0] } as PassphraseWrapper
    delete pass.updatedAt
    const local = { ...phase1Change, wrappers: [pass, ...phase1Change.wrappers.slice(1)] }
    const merged = mergeVault(json(vault), local, []).vault
    await expect(unlockWithPassphrase(merged, 'changed by phase one')).resolves.toBeTruthy()
  })

  it('refuses to merge a different vault', async () => {
    const { vault } = await setup()
    const other = (await createVault('another vault here', FAST)).vault
    expect(() => mergeVault(json(other), vault, [])).toThrow(/different vault/)
  })
})
