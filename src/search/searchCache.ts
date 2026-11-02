// The search index, encrypted with the vault's own container format (kind "cache") and kept
// in IndexedDB only. It never goes to Drive and holds nothing that isn't in the entries; it
// just saves re-indexing a large diary on every unlock.
import { randomId } from '../crypto/bytes'
import { decryptJson, encryptJson } from '../crypto/container'
import { KV, type VaultDB } from '../storage/db'
import { SearchIndex } from './searchIndex'

export async function loadSearchCache(db: VaultDB, mk: CryptoKey): Promise<SearchIndex | null> {
  const data = await db.getKv<Uint8Array>(KV.searchCache)
  if (!data) return null
  try {
    return SearchIndex.fromJSON(await decryptJson<unknown>(mk, data, { expectedKind: 'cache' }))
  } catch {
    await db.deleteKv(KV.searchCache) // unreadable (another vault, damaged): rebuild
    return null
  }
}

export async function saveSearchCache(db: VaultDB, mk: CryptoKey, index: SearchIndex) {
  await db.setKv(KV.searchCache, await encryptJson(mk, randomId(), 'cache', index.toJSON()))
}
