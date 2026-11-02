// Settings → "Make viewing copies for older photos": makes JPEG viewing copies for HEIC photos
// attached before viewing copies existed (or on a device that couldn't decode HEIC). Runs only
// when started, on a device that can decode HEIC, in batches: after each batch it waits until
// the upload queue has room, so a large diary doesn't fill this device's storage with copies
// that haven't reached Drive yet. Like the thumbnail job it keeps no bookkeeping beyond failures:
// the work is "every HEIC photo without a viewing copy", so it can stop and resume at any time.
import { Emitter } from '../core/emitter'
import type { VaultSession } from '../core/session'
import { isId } from '../crypto/bytes'
import { compareEntriesDesc, type Attachment, type Entry } from '../model/entry'
import type { VaultDB } from '../storage/db'
import { isHeic } from './heic'
import { LARGE_FILE } from './kind'

const FAILED_KEY = 'viewCopyFailed'
const MAX_TRIES = 2
export const BATCH_SIZE = 10
/** Before the next batch, wait until at most this many files are waiting to upload. */
export const MAX_QUEUED = 3

export interface ViewCopyJobDeps {
  db: VaultDB
  session: () => VaultSession | null
  canDecode: () => Promise<boolean>
  /** The encrypted attachment (upload queue or Drive), or null if it can't be reached now. */
  fetchEncrypted: (fileId: string) => Promise<Blob | null>
  make: (heic: Blob) => Promise<Blob | null>
  isEditing: (entryId: string) => boolean
  queuedUploads: () => Promise<number>
  sleep?: (ms: number) => Promise<void>
}

export interface ViewCopyStatus {
  running: boolean
  /** Waiting for the upload queue before the next batch. */
  waitingForUploads: boolean
  made: number
  failed: number
  skipped: number
  remaining: number
  message: string | null
}

export function needsViewCopy(a: Attachment, failed: Record<string, number>): boolean {
  return (
    isHeic(a.mime, a.name) &&
    !isId(a.viewCopyFileId) &&
    a.size <= LARGE_FILE &&
    (failed[a.fileId] ?? 0) < MAX_TRIES
  )
}

/** HEIC photos in the downloaded entries that have no viewing copy yet, newest first. */
export function viewCopyWork(
  entries: Iterable<Entry>,
  failed: Record<string, number>,
): { entry: Entry; attachment: Attachment }[] {
  const work: { entry: Entry; attachment: Attachment }[] = []
  for (const entry of [...entries].sort(compareEntriesDesc)) {
    for (const attachment of entry.attachments) {
      if (needsViewCopy(attachment, failed)) work.push({ entry, attachment })
    }
  }
  return work
}

const IDLE: ViewCopyStatus = {
  running: false,
  waitingForUploads: false,
  made: 0,
  failed: 0,
  skipped: 0,
  remaining: 0,
  message: null,
}

export class ViewCopyJob extends Emitter {
  private readonly deps: ViewCopyJobDeps
  private stopRequested = false
  status: ViewCopyStatus = { ...IDLE }

  constructor(deps: ViewCopyJobDeps) {
    super()
    this.deps = deps
  }

  private set(patch: Partial<ViewCopyStatus>) {
    this.status = { ...this.status, ...patch }
    this.emit()
  }

  async failures(): Promise<Record<string, number>> {
    return (await this.deps.db.getKv<Record<string, number>>(FAILED_KEY)) ?? {}
  }

  /** How many HEIC photos still need a viewing copy (in entries on this device). */
  async pending(): Promise<number> {
    const session = this.deps.session()
    if (!session) return 0
    return viewCopyWork(session.entries.values(), await this.failures()).length
  }

  stop() {
    this.stopRequested = true
  }

  async start(): Promise<void> {
    if (this.status.running) return
    this.stopRequested = false
    const sleep = this.deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)))
    this.set({ ...IDLE, running: true })
    try {
      if (!(await this.deps.canDecode())) {
        this.set({ message: "This browser can't read HEIC photos." })
        return
      }
      const failed = await this.failures()
      const session0 = this.deps.session()
      if (!session0) return
      const work = viewCopyWork(session0.entries.values(), failed)
      this.set({ remaining: work.length })
      for (let i = 0; i < work.length; i++) {
        if (i > 0 && i % BATCH_SIZE === 0) {
          // Let the upload queue catch up before the next batch.
          while (!this.stopRequested && (await this.deps.queuedUploads()) > MAX_QUEUED) {
            this.set({ waitingForUploads: true })
            await sleep(2000)
            if (!this.deps.session()) return
          }
          this.set({ waitingForUploads: false })
        }
        const session = this.deps.session()
        if (this.stopRequested || !session || session.locked) return
        const { entry, attachment } = work[i]
        this.set({ remaining: work.length - i - 1 })
        if (this.deps.isEditing(entry.id)) {
          this.set({ skipped: this.status.skipped + 1 })
          continue
        }
        const encrypted = await this.deps.fetchEncrypted(attachment.fileId).catch(() => null)
        if (!encrypted) {
          this.set({ skipped: this.status.skipped + 1 })
          continue
        }
        let jpeg: Blob | null = null
        try {
          jpeg = await this.deps.make(await session.decryptAttachment(attachment, encrypted))
        } catch {
          jpeg = null
        }
        if (!jpeg) {
          failed[attachment.fileId] = (failed[attachment.fileId] ?? 0) + 1
          await this.deps.db.setKv(FAILED_KEY, failed)
          this.set({ failed: this.status.failed + 1 })
          continue
        }
        if (await this.attach(session, entry.id, attachment.fileId, jpeg)) {
          this.set({ made: this.status.made + 1 })
        } else {
          this.set({ skipped: this.status.skipped + 1 })
        }
      }
    } finally {
      this.set({ running: false, waitingForUploads: false, remaining: 0 })
    }
  }

  /** Stores the copy and points the entry's latest version at it. */
  private async attach(session: VaultSession, entryId: string, fileId: string, jpeg: Blob) {
    const copyId = await session.addViewCopy(jpeg)
    const latest = session.entries.get(entryId)
    const at = latest?.attachments.findIndex((a) => a.fileId === fileId) ?? -1
    if (
      !latest ||
      at < 0 ||
      isId(latest.attachments[at].viewCopyFileId) ||
      this.deps.isEditing(entryId) ||
      session.locked
    ) {
      await session.releaseFile(copyId)
      return false
    }
    const attachments = latest.attachments.map((a, i) =>
      i === at ? { ...a, viewCopyFileId: copyId } : a,
    )
    await session.save({ ...latest, attachments, updatedAt: new Date().toISOString() })
    return true
  }
}
