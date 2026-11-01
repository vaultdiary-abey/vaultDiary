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

/**
 * An in-progress or unsaved recording. Its chunks are encrypted (src/crypto/localSeal.ts) with
 * a per-recording key wrapped by MK. Stored in the clear: kind, MIME type, times, sizes and the
 * id/date of the entry it was made for.
 */
export interface RecordingRecord {
  id: string
  kind: 'audio' | 'video'
  mime: string
  entryId: string
  entryDate: string
  startedAt: number
  updatedAt: number
  bytes: number
  durationMs: number
  chunks: number
  key: { iv: string; ct: string }
}

export interface RecordingChunkRecord {
  recId: string
  seq: number
  /** Sealed: IV | ciphertext | tag. */
  data: Uint8Array<ArrayBuffer>
}

/** Encrypted thumbnail containers (.vdf, exactly as on Drive), so timelines work offline. */
export interface ThumbRecord {
  fileId: string
  data: Uint8Array<ArrayBuffer>
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
  recordings!: EntityTable<RecordingRecord, 'id'>
  recordingChunks!: Dexie.Table<RecordingChunkRecord, [string, number]>
  thumbs!: EntityTable<ThumbRecord, 'fileId'>

  constructor(name = 'vaultdiary') {
    super(name)
    this.version(1).stores({
      entries: 'id, dirty',
      uploads: 'fileId, nextAttemptAt',
      deletes: 'path',
      kv: 'key',
    })
    // Phase 2: crash-safe recordings and the encrypted thumbnail cache.
    this.version(2).stores({
      recordings: 'id',
      recordingChunks: '[recId+seq], recId',
      thumbs: 'fileId',
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
    const tables = [
      this.entries,
      this.uploads,
      this.deletes,
      this.kv,
      this.recordings,
      this.recordingChunks,
      this.thumbs,
    ]
    await this.transaction('rw', tables, async () => {
      await Promise.all(tables.map((t) => t.clear()))
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
