// The unlocked vault: decrypted entries in memory, encrypted copies in IndexedDB.
// Locking drops this object; the master key is a non-extractable CryptoKey referenced only here.
import { isId, randomId } from '../crypto/bytes'
import {
  blobSource,
  decryptJson,
  decryptToBlob,
  encryptJson,
  encryptToBlob,
} from '../crypto/container'
import {
  compareEntriesDesc,
  parseEntry,
  parseIndex,
  type Attachment,
  type Entry,
  type EntrySummary,
} from '../model/entry'
import { blobType } from '../media/kind'
import { KV, type EntryRecord, type VaultDB } from '../storage/db'
import { Emitter } from './emitter'

export type ListItem = { kind: 'entry'; entry: Entry } | { kind: 'summary'; summary: EntrySummary }

export class VaultSession extends Emitter {
  readonly db: VaultDB
  private mk: CryptoKey | null
  readonly entries = new Map<string, Entry>()
  /** From index.vdi, for entries this device hasn't downloaded yet. */
  readonly summaries = new Map<string, EntrySummary>()
  readonly problems: string[] = []
  /** Set by the app so local changes trigger a sync soon after. */
  onLocalChange: () => void = () => {}

  private constructor(db: VaultDB, mk: CryptoKey) {
    super()
    this.db = db
    this.mk = mk
  }

  static async open(db: VaultDB, mk: CryptoKey): Promise<VaultSession> {
    const s = new VaultSession(db, mk)
    for (const rec of await db.entries.toArray()) {
      if (rec.deleted) continue
      try {
        s.entries.set(rec.id, await s.decryptEntry(rec.data, rec.id))
      } catch (e) {
        s.problems.push(`Local copy of entry ${rec.id} is unreadable: ${(e as Error).message}`)
      }
    }
    await s.loadIndexCache()
    return s
  }

  get key(): CryptoKey {
    if (!this.mk) throw new Error('The vault is locked.')
    return this.mk
  }

  get locked(): boolean {
    return this.mk === null
  }

  lock(): void {
    this.mk = null
    this.entries.clear()
    this.summaries.clear()
    this.emit()
  }

  async decryptEntry(data: Uint8Array, expectedId: string): Promise<Entry> {
    const raw = await decryptJson<unknown>(this.key, data, { expectedId, expectedKind: 'entry' })
    return parseEntry(raw, expectedId)
  }

  encryptEntry(entry: Entry): Promise<Uint8Array<ArrayBuffer>> {
    return encryptJson(this.key, entry.id, 'entry', entry)
  }

  async loadIndexCache(): Promise<void> {
    const data = await this.db.getKv<Uint8Array>(KV.indexData)
    if (!data) return
    try {
      const plain = await decryptJson<unknown>(this.key, data, { expectedKind: 'index' })
      this.setSummaries(parseIndex(plain).entries)
    } catch (e) {
      this.problems.push(`Cached index is unreadable: ${(e as Error).message}`)
    }
  }

  setSummaries(list: EntrySummary[]): void {
    this.summaries.clear()
    for (const s of list) if (!this.entries.has(s.id)) this.summaries.set(s.id, s)
    this.emit()
  }

  /** Entries plus not-yet-downloaded summaries, newest first. */
  list(): ListItem[] {
    const items: ListItem[] = [...this.entries.values()].map((entry) => ({ kind: 'entry', entry }))
    for (const summary of this.summaries.values()) {
      if (!this.entries.has(summary.id)) items.push({ kind: 'summary', summary })
    }
    const pick = (i: ListItem) => (i.kind === 'entry' ? i.entry : i.summary)
    return items.sort((a, b) => compareEntriesDesc(pick(a), pick(b)))
  }

  /** Days that have at least one entry, with counts. */
  dayCounts(): Map<string, number> {
    const counts = new Map<string, number>()
    for (const item of this.list()) {
      const date = item.kind === 'entry' ? item.entry.date : item.summary.date
      counts.set(date, (counts.get(date) ?? 0) + 1)
    }
    return counts
  }

  /** Saves locally (encrypted) and marks the entry for upload. */
  async save(entry: Entry): Promise<void> {
    const data = await this.encryptEntry(entry)
    await this.db.transaction('rw', this.db.entries, async () => {
      const rec = await this.db.entries.get(entry.id)
      const next: EntryRecord = rec
        ? { ...rec, data, rev: rec.rev + 1, dirty: 1, deleted: 0 }
        : {
            id: entry.id,
            data,
            rev: 1,
            dirty: 1,
            deleted: 0,
            driveId: null,
            remoteMd5: null,
            syncedUpdatedAt: null,
            pushingUpdatedAt: null,
          }
      await this.db.entries.put(next)
    })
    this.entries.set(entry.id, entry)
    this.summaries.delete(entry.id)
    this.emit()
    this.onLocalChange()
  }

  async remove(id: string): Promise<void> {
    const entry = this.entries.get(id)
    await this.db.transaction('rw', this.db.entries, async () => {
      const rec = await this.db.entries.get(id)
      if (!rec) return
      if (!rec.driveId) await this.db.entries.delete(id)
      else await this.db.entries.put({ ...rec, rev: rec.rev + 1, dirty: 1, deleted: 1 })
    })
    this.entries.delete(id)
    this.summaries.delete(id)
    if (entry) for (const a of entry.attachments) await this.releaseAttachment(a)
    this.emit()
    this.onLocalChange()
  }

  isReferenced(fileId: string): boolean {
    for (const e of this.entries.values()) {
      if (e.attachments.some((a) => a.fileId === fileId || a.thumbFileId === fileId)) return true
    }
    return false
  }

  /** Releases an attachment's file and its thumbnail (see releaseFile). */
  async releaseAttachment(a: Attachment): Promise<void> {
    await this.releaseFile(a.fileId)
    if (isId(a.thumbFileId)) await this.releaseFile(a.thumbFileId)
  }

  /**
   * Deletes an attachment's file once no entry uses it (conflict copies share files). If some
   * entries are only known from the index we can't be sure, so the file is kept.
   */
  async releaseFile(fileId: string): Promise<void> {
    if (this.isReferenced(fileId) || this.summaries.size > 0) return
    const queued = await this.db.uploads.get(fileId)
    if (queued) await this.db.uploads.delete(fileId)
    await this.db.thumbs.delete(fileId)
    await this.db.deletes.put({ path: `files/${fileId}.vdf`, driveId: null, createdAt: Date.now() })
  }

  /**
   * Encrypts a JPEG preview as its own files/<id>.vdf, queues it for upload and keeps the
   * encrypted copy in IndexedDB so previews show offline. Returns its file id.
   */
  async addThumbnail(jpeg: Blob): Promise<string> {
    const fileId = randomId()
    const blob = await encryptToBlob(this.key, {
      id: fileId,
      kind: 'file',
      source: blobSource(jpeg),
    })
    const data = new Uint8Array(await blob.arrayBuffer())
    await this.db.thumbs.put({ fileId, data })
    await this.queueUpload(fileId, blob)
    return fileId
  }

  private async queueUpload(fileId: string, blob: Blob): Promise<void> {
    await this.db.uploads.put({
      fileId,
      blob,
      size: blob.size,
      sessionUrl: null,
      sessionStartedAt: 0,
      uploaded: 0,
      attempts: 0,
      nextAttemptAt: 0,
      lastError: null,
      createdAt: Date.now(),
    })
    this.onLocalChange()
  }

  /** Decrypts a thumbnail container into a JPEG Blob. */
  async decryptThumbnail(fileId: string, encrypted: Blob): Promise<Blob> {
    return decryptToBlob(this.key, blobSource(encrypted), 'image/jpeg', {
      expectedId: fileId,
      expectedKind: 'file',
    })
  }

  /** Encrypts a file on this device into the upload queue. */
  async addAttachment(
    file: File,
    onProgress?: (done: number, total: number) => void,
  ): Promise<Attachment> {
    const fileId = randomId()
    const blob = await encryptToBlob(this.key, {
      id: fileId,
      kind: 'file',
      source: blobSource(file),
      onProgress,
    })
    await this.queueUpload(fileId, blob)
    return {
      fileId,
      name: file.name || 'file',
      mime: file.type || 'application/octet-stream',
      size: file.size,
    }
  }

  async decryptAttachment(
    attachment: Attachment,
    encrypted: Blob,
    onProgress?: (done: number, total: number) => void,
  ): Promise<Blob> {
    return decryptToBlob(
      this.key,
      blobSource(encrypted),
      blobType(attachment.mime, attachment.name),
      {
        expectedId: attachment.fileId,
        expectedKind: 'file',
        onProgress,
      },
    )
  }

  // --- used by the sync engine ---

  applyRemote(entry: Entry): void {
    this.entries.set(entry.id, entry)
    this.summaries.delete(entry.id)
    this.emit()
  }

  forget(id: string): void {
    this.entries.delete(id)
    this.summaries.delete(id)
    this.emit()
  }

  changed(): void {
    this.emit()
  }

  async decryptIndex(data: Uint8Array): Promise<EntrySummary[]> {
    const plain = await decryptJson<unknown>(this.key, data, { expectedKind: 'index' })
    return parseIndex(plain).entries
  }
}
