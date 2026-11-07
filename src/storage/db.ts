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

/**
 * An attachment waiting to reach Drive: progress and retry bookkeeping only. The encrypted file
 * itself is in `uploadBlobs`, which is written once and never updated: this record is rewritten
 * often (progress, errors, retries), and Safari replaces a stored Blob whenever its record is
 * written again, so a Blob read earlier stops working ("The object can not be found here.").
 */
export interface UploadRecord {
  fileId: string
  /** Only in records queued before version 3; moved to `uploadBlobs` by migrateUploadBlobs(). */
  blob?: Blob
  size: number
  sessionUrl: string | null
  sessionStartedAt: number
  uploaded: number
  attempts: number
  nextAttemptAt: number
  lastError: string | null
  createdAt: number
}

/** The encrypted .vdf container of a queued upload. Written once, deleted with its upload. */
export interface UploadBlobRecord {
  fileId: string
  blob: Blob
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
  uploadBlobs!: EntityTable<UploadBlobRecord, 'fileId'>
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
    // Upload files apart from their bookkeeping (see UploadRecord). Existing queue items are
    // moved lazily by migrateUploadBlobs(), so a failed move can never stop the app opening.
    this.version(3).stores({ uploadBlobs: 'fileId' })
  }

  /** Queues an encrypted file for upload (`meta` describes it, `blob` is the file). */
  async addUpload(meta: Omit<UploadRecord, 'blob'>, blob: Blob): Promise<void> {
    await this.transaction('rw', this.uploads, this.uploadBlobs, async () => {
      await this.uploadBlobs.put({ fileId: meta.fileId, blob })
      await this.uploads.put(meta)
    })
  }

  /**
   * The encrypted file of a queued upload, read afresh: never keep the Blob across writes to
   * the queue (Safari may invalidate it). Null once the upload has finished or was cancelled.
   */
  async uploadBlob(fileId: string): Promise<Blob | null> {
    const stored = await this.uploadBlobs.get(fileId)
    if (stored) return stored.blob
    return (await this.uploads.get(fileId))?.blob ?? null
  }

  async deleteUpload(fileId: string): Promise<void> {
    await this.transaction('rw', this.uploads, this.uploadBlobs, async () => {
      await this.uploads.delete(fileId)
      await this.uploadBlobs.delete(fileId)
    })
  }

  /**
   * Moves the files of queue items saved before version 3 into `uploadBlobs`. Returns how many
   * could not be moved (they keep working from the old place, just less reliably on Safari).
   */
  async migrateUploadBlobs(): Promise<number> {
    let failed = 0
    const keys = (await this.uploads.toCollection().primaryKeys()) as string[]
    for (const fileId of keys) {
      try {
        await this.transaction('rw', this.uploads, this.uploadBlobs, async () => {
          const rec = await this.uploads.get(fileId)
          if (!rec?.blob) return
          // Copy first; only then rewrite the old record (which is what drops the old copy).
          if (!(await this.uploadBlobs.get(fileId))) {
            await this.uploadBlobs.put({ fileId, blob: rec.blob })
          }
          const { blob: _old, ...meta } = rec
          void _old
          await this.uploads.put(meta)
        })
      } catch {
        failed++
      }
    }
    return failed
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
      this.uploadBlobs,
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
  /** settings.vds as on Drive (encrypted container, kind "settings"). */
  settingsData: 'settingsData',
  settingsDirty: 'settingsDirty',
  /** Bumped on every local settings change, so sync never drops an edit made while it ran. */
  settingsRev: 'settingsRev',
  settingsMd5: 'settingsMd5',
  /** Encrypted search index (container kind "cache"), local only. */
  searchCache: 'searchCache',
  account: 'account',
} as const
