// vault.json is changed by more than one device (passkeys added on each, a passphrase changed on
// another). Pushing must never overwrite what another device added, so every local change is
// recorded as an operation, and before a push the app downloads Drive's copy and re-applies its
// pending operations on top of it:
//
//   - wrappers with an id (passkeys) are matched by id; adding replaces a same-id wrapper;
//   - a wrapper is removed only by a removal recorded on this device;
//   - of two passphrase wrappers, the one with the newest updatedAt wins;
//   - everything else in Drive's copy (recovery wrapper, unknown types, fields) is kept as is.
import { isPasskeyWrapper } from './passkey'
import { parseVault, type PassphraseWrapper, type PasskeyWrapper, type VaultFile } from './vault'

export type VaultOp =
  | { op: 'setPassphrase'; wrapper: PassphraseWrapper }
  | { op: 'addWrapper'; wrapper: PasskeyWrapper }
  | { op: 'removeWrapper'; id: string }

/** A pending operation as stored in IndexedDB (seq orders them and marks what was pushed). */
export type PendingVaultOp = VaultOp & { seq: number }

export interface MergeResult {
  vault: VaultFile
  /** Things the user should know, e.g. a passphrase change that lost to a newer one. */
  notes: string[]
}

function passphraseOf(vault: VaultFile): PassphraseWrapper | undefined {
  return vault.wrappers.find((w) => w.type === 'passphrase') as PassphraseWrapper | undefined
}

/**
 * When a passphrase wrapper was set. Phase 1 wrappers have no updatedAt; Phase 1 only changed
 * the vault's updatedAt when the passphrase changed, so that stands in for it.
 */
export function passphraseTime(wrapper: PassphraseWrapper, vault: VaultFile): string {
  return typeof wrapper.updatedAt === 'string' ? wrapper.updatedAt : vault.updatedAt
}

function laterOf(a: string, b: string): string {
  return a > b ? a : b
}

export function applyVaultOps(
  base: VaultFile,
  ops: readonly VaultOp[],
  now: Date = new Date(),
): MergeResult {
  const notes: string[] = []
  let wrappers = [...base.wrappers]
  // Give a Phase 1 passphrase wrapper its effective time, so later comparisons stay correct
  // once the vault's updatedAt moves on for other reasons.
  wrappers = wrappers.map((w) =>
    w.type === 'passphrase' && typeof w.updatedAt !== 'string'
      ? { ...w, updatedAt: base.updatedAt }
      : w,
  )
  for (const op of ops) {
    if (op.op === 'setPassphrase') {
      const current = wrappers.find((w) => w.type === 'passphrase') as PassphraseWrapper | undefined
      const incoming = op.wrapper.updatedAt ?? ''
      if (!current || incoming >= (current.updatedAt ?? '')) {
        wrappers = [op.wrapper, ...wrappers.filter((w) => w.type !== 'passphrase')]
      } else if (JSON.stringify(current) !== JSON.stringify(op.wrapper)) {
        notes.push(
          'The passphrase was changed on another device after you changed it here. The newer ' +
            'passphrase (from the other device) is the one that now unlocks the diary.',
        )
      }
    } else if (op.op === 'addWrapper') {
      if (!isPasskeyWrapper(op.wrapper)) continue
      const at = wrappers.findIndex((w) => (w as { id?: unknown }).id === op.wrapper.id)
      if (at >= 0) wrappers[at] = op.wrapper
      else wrappers.push(op.wrapper)
    } else if (op.op === 'removeWrapper') {
      // Only id-keyed slots can be removed; the passphrase and recovery wrappers never are.
      wrappers = wrappers.filter(
        (w) =>
          w.type === 'passphrase' || w.type === 'recovery' || (w as { id?: unknown }).id !== op.id,
      )
    }
  }
  const changed = JSON.stringify(wrappers) !== JSON.stringify(base.wrappers)
  return {
    vault: {
      ...base,
      updatedAt: changed ? laterOf(now.toISOString(), base.updatedAt) : base.updatedAt,
      wrappers,
    },
    notes,
  }
}

/**
 * Operations for a vault.json marked dirty by Phase 1 code, which recorded no operations: the
 * only thing Phase 1 changed locally was the passphrase.
 */
export function legacyOps(local: VaultFile): VaultOp[] {
  const pass = passphraseOf(local)
  return pass
    ? [{ op: 'setPassphrase', wrapper: { ...pass, updatedAt: passphraseTime(pass, local) } }]
    : []
}

/** Drive's copy plus this device's pending operations. */
export function mergeVault(
  remoteJson: string,
  local: VaultFile,
  ops: readonly VaultOp[],
  now: Date = new Date(),
): MergeResult {
  const remote = parseVault(remoteJson)
  if (remote.vaultId !== local.vaultId) {
    throw new Error('vault.json on Drive belongs to a different vault than this device.')
  }
  return applyVaultOps(remote, ops.length ? ops : legacyOps(local), now)
}

export function stripSeq(ops: readonly PendingVaultOp[]): VaultOp[] {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return ops.map(({ seq, ...op }) => op as VaultOp)
}
