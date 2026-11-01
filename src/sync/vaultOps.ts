// Records a local change to vault.json: applies it to this device's copy immediately and keeps
// it as a pending operation, so the next sync can merge it onto Drive's copy (see
// src/crypto/vaultMerge.ts) instead of overwriting changes made on other devices.
import { parseVault, type VaultFile } from '../crypto/vault'
import { applyVaultOps, type PendingVaultOp, type VaultOp } from '../crypto/vaultMerge'
import { KV, type VaultDB } from '../storage/db'

const SEQ_KEY = 'vaultOpSeq'

export async function recordVaultOps(db: VaultDB, ops: VaultOp[]): Promise<VaultFile> {
  return db.transaction('rw', db.kv, async () => {
    const json = await db.getKv<string>(KV.vaultJson)
    if (!json) throw new Error('No vault on this device.')
    const next = applyVaultOps(parseVault(json), ops).vault
    const pending = (await db.getKv<PendingVaultOp[]>(KV.vaultOps)) ?? []
    let seq = (await db.getKv<number>(SEQ_KEY)) ?? 0
    for (const op of ops) pending.push({ ...op, seq: ++seq })
    await db.setKv(SEQ_KEY, seq)
    await db.setKv(KV.vaultOps, pending)
    await db.setKv(KV.vaultJson, JSON.stringify(next, null, 2))
    await db.setKv(KV.vaultDirty, true)
    return next
  })
}
