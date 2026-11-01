// IndexedDB (Dexie): encrypted offline cache + upload queue. Nothing here is plaintext diary
// content. Stored in the clear: entry/file ids, Drive ids, sync bookkeeping (including the
// `updatedAt` timestamps of synced versions) and vault.json (which only holds wrapped keys).
import Dexie, { type EntityTable } from 'dexie'

export interface EntryRecord {
  id: string
  /** The encrypted .vde container exactly as stored on Drive. */
  data: Uint8Array<ArrayBuffer>
  /** Bumped on every local save, so sync never overwrites an edit made while it ran. */
  rev: number
  dirty: 0 | 1
  deleted: 0 | 1
  driveId: string | null
  /** Drive checksum of the version this device last read or wrote. */
  remoteMd5: string | null
  /** `updatedAt` of the version Drive is known to hold. */
  syncedUpdatedAt: string | null
  /** `updatedAt` of a version we tried to upload (the response may have been lost). */
  pushingUpdatedAt: string | null
}

export interface UploadRecord {
  fileId: string
  /** The encrypted .vdf container. */
  blob: Blob
  size: number
  sessionUrl: string | null
  sessionStartedAt: number
  uploaded: number
  attempts: number
  nextAttemptAt: number
  lastError: string | null
  createdAt: number
}

export interface DeleteRecord {
  /** Drive file name, e.g. "files/<id>.vdf" or "entries/<id>.vde". */
  path: string
  driveId: string | null
  createdAt: number
}

export interface KvRecord {
  key: string
  value: unknown
}

export class VaultDB extends Dexie {
  entries!: EntityTable<EntryRecord, 'id'>
  uploads!: EntityTable<UploadRecord, 'fileId'>
  deletes!: EntityTable<DeleteRecord, 'path'>
  kv!: EntityTable<KvRecord, 'key'>

  constructor(name = 'vaultdiary') {
    super(name)
    this.version(1).stores({
      entries: 'id, dirty',
      uploads: 'fileId, nextAttemptAt',
      deletes: 'path',
      kv: 'key',
    })
  }

  async getKv<T>(key: string): Promise<T | undefined> {
    return (await this.kv.get(key))?.value as T | undefined
  }

  async setKv(key: string, value: unknown): Promise<void> {
    await this.kv.put({ key, value })
  }

  async deleteKv(key: string): Promise<void> {
    await this.kv.delete(key)
  }

  async wipeAll(): Promise<void> {
    await this.transaction('rw', [this.entries, this.uploads, this.deletes, this.kv], async () => {
      await Promise.all([
        this.entries.clear(),
        this.uploads.clear(),
        this.deletes.clear(),
        this.kv.clear(),
      ])
    })
  }
}

export const KV = {
  vaultJson: 'vaultJson',
  vaultDriveId: 'vaultDriveId',
  vaultDirty: 'vaultDirty',
  /** PendingVaultOp[]: local vault.json changes not yet merged into Drive's copy. */
  vaultOps: 'vaultOps',
  vaultMd5: 'vaultMd5',
  location: 'location',
  indexData: 'indexData',
  indexMd5: 'indexMd5',
  indexDriveId: 'indexDriveId',
  lastSyncedAt: 'lastSyncedAt',
  account: 'account',
} as const
