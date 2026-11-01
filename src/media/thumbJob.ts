// Background job that makes thumbnails for attachments that don't have one: older attachments
// (from before thumbnails existed), ones whose thumbnail failed earlier, and ones whose
// thumbnail file was lost from Drive.
//
// It is queue-based and resumable without bookkeeping of its own: the queue is "every photo or
// video attachment without a usable thumbnail", worked newest entry first, one at a time. After
// a restart it simply continues with what is still missing. Files it can't decode are tried
// twice and then skipped (kept in IndexedDB under KV "thumbFailed").
import { Emitter } from '../core/emitter'
import type { VaultSession } from '../core/session'
import { isId } from '../crypto/bytes'
import { compareEntriesDesc, type Attachment, type Entry } from '../model/entry'
import type { VaultDB } from '../storage/db'
import { LARGE_FILE } from './kind'
import { thumbnailable } from './thumbnail'

const FAILED_KEY = 'thumbFailed'
const MAX_TRIES = 2

export interface ThumbJobDeps {
  db: VaultDB
  session: () => VaultSession | null
  /** The encrypted attachment (upload queue or Drive), or null if it can't be reached now. */
  fetchEncrypted: (fileId: string) => Promise<Blob | null>
  /** File names in files/ on Drive, or null when Drive can't be listed (offline). */
  listDriveFiles: () => Promise<Set<string> | null>
  make: (plain: Blob, kind: 'image' | 'video') => Promise<Blob | null>
  /** Entries open in an editor are left alone. */
  isEditing: (entryId: string) => boolean
}

export interface ThumbJobStatus {
  running: boolean
  made: number
  failed: number
  /** Attachments still waiting (only known while running). */
  remaining: number
}

export interface ThumbState {
  /** Encrypted thumbnails cached on this device. */
  local: Set<string>
  /** Files waiting in the upload queue. */
  queued: Set<string>
  /** files/ on Drive, or null if unknown (offline). */
  drive: Set<string> | null
  failed: Record<string, number>
}

/** Does this attachment need a (new) thumbnail? Pure, so it can be tested. */
export function needsThumbnail(a: Attachment, state: ThumbState): boolean {
  if (!thumbnailable(a.mime, a.name) || a.size > LARGE_FILE) return false
  if ((state.failed[a.fileId] ?? 0) >= MAX_TRIES) return false
  const t = a.thumbFileId
  if (!isId(t)) return true
  if (state.local.has(t) || state.queued.has(t)) return false
  // Referenced but gone from Drive: regenerate. Offline we can't tell, so leave it.
  return state.drive !== null && !state.drive.has(`${t}.vdf`)
}

export class ThumbnailJob extends Emitter {
  private readonly deps: ThumbJobDeps
  private running: Promise<void> | null = null
  private again = false
  private stopped = false
  status: ThumbJobStatus = { running: false, made: 0, failed: 0, remaining: 0 }

  constructor(deps: ThumbJobDeps) {
    super()
    this.deps = deps
  }

  private set(patch: Partial<ThumbJobStatus>) {
    this.status = { ...this.status, ...patch }
    this.emit()
  }

  stop() {
    this.stopped = true
  }

  kick(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (this.running) {
      this.again = true
      return this.running
    }
    this.running = (async () => {
      try {
        do {
          this.again = false
          await this.run()
        } while (this.again && !this.stopped)
      } finally {
        this.running = null
        this.set({ running: false, remaining: 0 })
      }
    })()
    return this.running
  }

  private async state(): Promise<ThumbState> {
    const { db } = this.deps
    return {
      local: new Set((await db.thumbs.toCollection().primaryKeys()) as string[]),
      queued: new Set((await db.uploads.toCollection().primaryKeys()) as string[]),
      drive: await this.deps.listDriveFiles().catch(() => null),
      failed: (await db.getKv<Record<string, number>>(FAILED_KEY)) ?? {},
    }
  }

  private async run() {
    const session = this.deps.session()
    if (!session || session.locked) return
    const state = await this.state()
    const work: { entry: Entry; attachment: Attachment }[] = []
    for (const entry of [...session.entries.values()].sort(compareEntriesDesc)) {
      for (const attachment of entry.attachments) {
        if (needsThumbnail(attachment, state)) work.push({ entry, attachment })
      }
    }
    this.set({ running: work.length > 0, remaining: work.length })
    for (const { entry, attachment } of work) {
      const current = this.deps.session()
      if (this.stopped || !current || current.locked) return
      this.set({ remaining: this.status.remaining - 1 })
      if (this.deps.isEditing(entry.id)) continue
      const encrypted = await this.deps.fetchEncrypted(attachment.fileId).catch(() => null)
      if (!encrypted) continue // not reachable now (offline); try again next time
      let jpeg: Blob | null
      try {
        const plain = await current.decryptAttachment(attachment, encrypted)
        jpeg = await this.deps.make(plain, thumbnailable(attachment.mime, attachment.name)!)
      } catch {
        jpeg = null
      }
      if (!jpeg) {
        state.failed[attachment.fileId] = (state.failed[attachment.fileId] ?? 0) + 1
        await this.deps.db.setKv(FAILED_KEY, state.failed)
        this.set({ failed: this.status.failed + 1 })
        continue
      }
      await this.attach(current, entry.id, attachment.fileId, jpeg)
    }
  }

  /** Stores the thumbnail and points the entry's latest version at it. */
  private async attach(session: VaultSession, entryId: string, fileId: string, jpeg: Blob) {
    const thumbId = await session.addThumbnail(jpeg)
    const latest = session.entries.get(entryId)
    const at = latest?.attachments.findIndex((a) => a.fileId === fileId) ?? -1
    if (!latest || at < 0 || this.deps.isEditing(entryId) || session.locked) {
      await session.releaseFile(thumbId)
      return
    }
    const attachments = latest.attachments.map((a, i) =>
      i === at ? { ...a, thumbFileId: thumbId } : a,
    )
    await session.save({ ...latest, attachments, updatedAt: new Date().toISOString() })
    this.set({ made: this.status.made + 1 })
  }
}
