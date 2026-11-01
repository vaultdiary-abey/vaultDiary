// Saves a recording to IndexedDB as it is made (one encrypted chunk per MediaRecorder timeslice),
// so a crash, a closed tab or a lock doesn't lose it. Once the user keeps or discards it, the
// rows are deleted. Rows still here when the app next unlocks are offered for recovery.
import { randomId } from '../crypto/bytes'
import { newLocalKey, openLocalKey, seal, unseal } from '../crypto/localSeal'
import type { RecordingRecord, VaultDB } from '../storage/db'

const PURPOSE = 'recording'
const chunkAad = (id: string, seq: number) => `VDV1/local/recording/${id}/${seq}`

export type RecordingMeta = Omit<RecordingRecord, 'key'>

export interface RecordingWriter {
  readonly id: string
  /** Appends the next piece; pieces are written in call order. */
  append(data: Uint8Array, durationMs: number): Promise<void>
  /** Resolves once every appended piece is stored. */
  flushed(): Promise<void>
}

export class RecordingStore {
  private readonly db: VaultDB
  constructor(db: VaultDB) {
    this.db = db
  }

  async create(
    mk: CryptoKey,
    meta: { kind: 'audio' | 'video'; mime: string; entryId: string; entryDate: string },
  ): Promise<RecordingWriter> {
    const id = randomId()
    // The per-recording key stays usable even if the vault locks mid-recording, so the last
    // pieces are still saved (encrypted) and can be recovered after the next unlock.
    const { key, wrapped } = await newLocalKey(mk, PURPOSE, id)
    const now = Date.now()
    await this.db.recordings.put({
      id,
      ...meta,
      startedAt: now,
      updatedAt: now,
      bytes: 0,
      durationMs: 0,
      chunks: 0,
      key: wrapped,
    })
    let seq = 0
    let bytes = 0
    let chain: Promise<void> = Promise.resolve()
    return {
      id,
      append: (data, durationMs) => {
        const n = seq++
        const copy = new Uint8Array(data)
        chain = chain.then(async () => {
          const sealed = await seal(key, chunkAad(id, n), copy)
          bytes += copy.length
          await this.db.transaction('rw', this.db.recordings, this.db.recordingChunks, async () => {
            await this.db.recordingChunks.put({ recId: id, seq: n, data: sealed })
            await this.db.recordings.update(id, {
              chunks: n + 1,
              bytes,
              durationMs,
              updatedAt: Date.now(),
            })
          })
        })
        return chain
      },
      flushed: () => chain,
    }
  }

  async setMime(id: string, mime: string): Promise<void> {
    await this.db.recordings.update(id, { mime })
  }

  async list(): Promise<RecordingMeta[]> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    return (await this.db.recordings.toArray()).map(({ key, ...meta }) => meta)
  }

  async get(id: string): Promise<RecordingMeta | undefined> {
    return (await this.list()).find((r) => r.id === id)
  }

  /** Decrypts the stored pieces, in order, into one Blob. Stops at a missing piece. */
  async assemble(mk: CryptoKey, id: string): Promise<Blob> {
    const rec = await this.db.recordings.get(id)
    if (!rec) throw new Error('This recording is no longer on this device.')
    const key = await openLocalKey(mk, PURPOSE, id, rec.key)
    const chunks = await this.db.recordingChunks.where('recId').equals(id).sortBy('seq')
    const parts: BlobPart[] = []
    for (const [i, c] of chunks.entries()) {
      if (c.seq !== i) break // a gap: keep what is contiguous from the start
      parts.push(await unseal(key, chunkAad(id, c.seq), c.data))
    }
    return new Blob(parts, { type: rec.mime })
  }

  async discard(id: string): Promise<void> {
    await this.db.transaction('rw', this.db.recordings, this.db.recordingChunks, async () => {
      await this.db.recordingChunks.where('recId').equals(id).delete()
      await this.db.recordings.delete(id)
    })
  }
}
