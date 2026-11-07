// Upload queue for attachments. Items are encrypted Blobs in IndexedDB, so they survive closing
// the app and going offline; uploads use Drive resumable sessions, one 8 MiB slice at a time.
// The file is read from IndexedDB afresh for every slice and never held across a write to the
// queue: Safari invalidates Blobs read from IndexedDB when their record is written again.
import { Emitter } from '../core/emitter'
import { AuthError, DriveError, OfflineError, UPLOAD_SLICE, type DriveClient } from '../drive/types'
import type { VaultLocation } from '../drive/vaultFolder'
import type { UploadRecord, VaultDB } from '../storage/db'
import { backoffDelay } from './backoff'

/** Drive keeps resumable sessions for a week; start over well before that. */
const SESSION_MAX_AGE = 5 * 24 * 3600_000

/**
 * Safety net on top of the Drive client's own timeouts: no single step may hold the queue for
 * ever (a request that never settles would otherwise block every upload until a restart).
 */
export const STEP_TIMEOUT = 90_000
/** A slice may take longer on a slow connection: STEP_TIMEOUT plus this per MiB. */
export const SLICE_TIMEOUT_PER_MIB = 30_000

class StepTimeout extends OfflineError {
  constructor() {
    super('Google Drive did not answer in time; trying again.')
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new StepTimeout()), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

export interface UploadProgress {
  fileId: string
  size: number
  uploaded: number
  attempts: number
  lastError: string | null
  nextAttemptAt: number
  active: boolean
}

export type QueueBlock = null | 'offline' | 'auth'

export class UploadQueue extends Emitter {
  private readonly db: VaultDB
  private readonly getDrive: () => DriveClient | null
  private readonly getLocation: () => VaultLocation | null
  private running: Promise<void> | null = null
  private again = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private progress = new Map<string, UploadProgress>()
  private activeId: string | null = null
  blocked: QueueBlock = null
  now: () => number = Date.now
  /** Tests shorten these. */
  stepTimeout = STEP_TIMEOUT
  sliceTimeoutPerMiB = SLICE_TIMEOUT_PER_MIB
  private lastProgressEmit = 0
  /** Bumped by retryNow(), so an attempt failing meanwhile doesn't push the retry back. */
  private retryGeneration = 0
  private migrated = false

  constructor(
    db: VaultDB,
    getDrive: () => DriveClient | null,
    getLocation: () => VaultLocation | null,
  ) {
    super()
    this.db = db
    this.getDrive = getDrive
    this.getLocation = getLocation
  }

  items(): UploadProgress[] {
    return [...this.progress.values()]
  }

  async refresh(): Promise<void> {
    const records = await this.db.uploads.toArray()
    this.progress = new Map(records.map((r) => [r.fileId, this.toProgress(r)]))
    this.emit()
  }

  private toProgress(r: UploadRecord): UploadProgress {
    return {
      fileId: r.fileId,
      size: r.size,
      uploaded: r.uploaded,
      attempts: r.attempts,
      lastError: r.lastError,
      nextAttemptAt: r.nextAttemptAt,
      active: this.activeId === r.fileId,
    }
  }

  /** Start (or restart) processing. Safe to call often. */
  kick(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.running) {
      this.again = true
      return this.running
    }
    this.running = (async () => {
      try {
        do {
          this.again = false
          await this.drain()
        } while (this.again)
      } finally {
        this.running = null
      }
    })()
    return this.running
  }

  /** "Sync now": retry everything waiting in backoff right away. */
  async retryNow(): Promise<void> {
    this.retryGeneration++
    await this.db.uploads.toCollection().modify({ nextAttemptAt: 0 })
    await this.refresh()
    void this.kick()
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private schedule(at: number) {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.kick(), Math.max(0, at - this.now()))
  }

  private async drain(): Promise<void> {
    if (!this.migrated) {
      this.migrated = true
      await this.db.migrateUploadBlobs().catch(() => 0)
    }
    await this.refresh()
    for (;;) {
      const drive = this.getDrive()
      const location = this.getLocation()
      if (!drive || !location) {
        this.blocked = 'auth'
        this.emit()
        return
      }
      const records = await this.db.uploads.orderBy('nextAttemptAt').toArray()
      if (!records.length) {
        this.blocked = null
        this.emit()
        return
      }
      const due = records.find((r) => r.nextAttemptAt <= this.now())
      if (!due) {
        this.schedule(records[0].nextAttemptAt)
        return
      }
      const outcome = await this.upload(drive, location, due)
      if (outcome === 'stop') return
    }
  }

  private async save(rec: UploadRecord, patch: Partial<UploadRecord>): Promise<UploadRecord> {
    const next = { ...rec, ...patch }
    // The item may have been removed meanwhile (attachment deleted): don't resurrect it.
    const updated = await this.db.uploads.update(rec.fileId, patch)
    if (updated) this.progress.set(rec.fileId, this.toProgress(next))
    this.emit()
    return next
  }

  private async upload(
    drive: DriveClient,
    location: VaultLocation,
    rec: UploadRecord,
  ): Promise<'next' | 'stop'> {
    const name = `${rec.fileId}.vdf`
    this.activeId = rec.fileId
    const generation = this.retryGeneration
    try {
      let status: Awaited<ReturnType<DriveClient['queryResumable']>> | null = null
      if (rec.sessionUrl && this.now() - rec.sessionStartedAt < SESSION_MAX_AGE) {
        try {
          status = await withTimeout(
            drive.queryResumable(rec.sessionUrl, rec.size),
            this.stepTimeout,
          )
        } catch (e) {
          if (!(e instanceof DriveError && (e.status === 404 || e.status === 410))) throw e
          status = null
        }
      }
      if (!status) {
        // An earlier attempt may have finished even though we never saw the reply.
        const existing = (
          await withTimeout(drive.findByName(location.filesId, name), this.stepTimeout)
        ).find((f) => f.size === rec.size)
        if (existing) {
          await this.finish(rec)
          return 'next'
        }
        const sessionUrl = await withTimeout(
          drive.startResumable(location.filesId, name, rec.size),
          this.stepTimeout,
        )
        rec = await this.save(rec, { sessionUrl, sessionStartedAt: this.now(), uploaded: 0 })
        status = { done: false, nextOffset: 0 }
      }
      let sliceDone = false
      while (!status.done) {
        const start: number = status.nextOffset
        // A slice went through: this is progress, so the next failure starts the backoff over.
        rec = await this.save(
          rec,
          sliceDone ? { uploaded: start, attempts: 0 } : { uploaded: start },
        )
        const bytes = await this.readSlice(
          rec.fileId,
          start,
          Math.min(rec.size, start + UPLOAD_SLICE),
        )
        if (!bytes) return 'next' // cancelled
        const slice = new Blob([bytes])
        status = await withTimeout(
          drive.putSlice(rec.sessionUrl!, slice, start, rec.size, (sent) =>
            this.sliceProgress(rec.fileId, start + sent),
          ),
          this.stepTimeout + (slice.size / (1024 * 1024)) * this.sliceTimeoutPerMiB,
        )
        sliceDone = true
      }
      if (status.file.size !== rec.size) {
        await drive.trash(status.file.id)
        throw new DriveError(0, 'Drive stored the wrong number of bytes; uploading again.')
      }
      await this.finish(rec)
      return 'next'
    } catch (e) {
      if (e instanceof AuthError) {
        this.blocked = 'auth'
        await this.save(rec, { lastError: 'Waiting for Google sign-in' })
        return 'stop'
      }
      const attempts = rec.attempts + 1
      // "Sync now" was tapped while this attempt was running: try again at once, as asked.
      const retryAsked = this.retryGeneration !== generation
      const nextAttemptAt = retryAsked ? this.now() : this.now() + backoffDelay(attempts)
      const offline = e instanceof OfflineError
      this.blocked = offline ? 'offline' : null
      if (offline) this.schedule(nextAttemptAt)
      await this.save(rec, {
        attempts,
        nextAttemptAt,
        lastError: (e as Error).message,
        // A rejected session (e.g. 400) is not worth resuming.
        ...(e instanceof DriveError && !e.retryable ? { sessionUrl: null } : {}),
      })
      return offline ? 'stop' : 'next'
    } finally {
      this.activeId = null
      // Show the item as waiting again (with its error, if any), not as still uploading.
      const p = this.progress.get(rec.fileId)
      if (p) this.progress.set(rec.fileId, { ...p, active: false })
      this.emit()
    }
  }

  /**
   * Bytes start…end of a queued file, read into memory (Safari can fail or stall when a request
   * body is a Blob that lives in IndexedDB). The Blob is fetched afresh each time, and once more
   * if reading fails, in case it went stale. Null if the item is no longer queued (cancelled).
   */
  private async readSlice(fileId: string, start: number, end: number): Promise<ArrayBuffer | null> {
    let lastError: unknown
    for (let tries = 0; tries < 2; tries++) {
      const blob = await this.db.uploadBlob(fileId)
      if (!blob || !(await this.db.uploads.get(fileId))) return null
      try {
        return await blob.slice(start, end).arrayBuffer()
      } catch (e) {
        lastError = e
      }
    }
    throw new Error(
      `Could not read the encrypted file from this device's storage (${(lastError as Error).message}).`,
      { cause: lastError },
    )
  }

  /** Bytes sent within the current slice (in memory only, at most 4 updates a second). */
  private sliceProgress(fileId: string, uploaded: number) {
    const p = this.progress.get(fileId)
    if (!p) return
    this.progress.set(fileId, { ...p, uploaded: Math.max(p.uploaded, uploaded) })
    const now = Date.now()
    if (now - this.lastProgressEmit > 250) {
      this.lastProgressEmit = now
      this.emit()
    }
  }

  private async finish(rec: UploadRecord) {
    await this.db.deleteUpload(rec.fileId)
    this.progress.delete(rec.fileId)
    this.emit()
  }
}
