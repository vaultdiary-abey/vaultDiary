import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { randomBytes, randomId } from '../src/crypto/bytes'
import { importMasterKey } from '../src/crypto/container'
import { VaultSession } from '../src/core/session'
import { needsThumbnail, ThumbnailJob, type ThumbState } from '../src/media/thumbJob'
import { mergeThumbnailsOnly, newEntry, type Attachment, type Entry } from '../src/model/entry'
import { VaultDB } from '../src/storage/db'

let n = 0
const att = (patch: Partial<Attachment> = {}): Attachment => ({
  fileId: randomId(),
  name: 'IMG_1.jpg',
  mime: 'image/jpeg',
  size: 1000,
  ...patch,
})
const empty = (): ThumbState => ({
  local: new Set(),
  queued: new Set(),
  drive: new Set(),
  failed: {},
})

describe('which attachments need a thumbnail', () => {
  it('photos and videos without one, not other files or huge ones', () => {
    const s = empty()
    expect(needsThumbnail(att(), s)).toBe(true)
    expect(needsThumbnail(att({ mime: 'video/webm', name: 'v.webm' }), s)).toBe(true)
    expect(needsThumbnail(att({ mime: 'application/pdf', name: 'a.pdf' }), s)).toBe(false)
    expect(needsThumbnail(att({ mime: 'audio/mp4', name: 'a.m4a' }), s)).toBe(false)
    expect(needsThumbnail(att({ size: 200 * 1024 * 1024 + 1 }), s)).toBe(false)
  })

  it('regenerates a thumbnail whose file was lost, but not when offline', () => {
    const t = randomId()
    const a = att({ thumbFileId: t })
    expect(needsThumbnail(a, { ...empty(), drive: new Set([`${t}.vdf`]) })).toBe(false)
    expect(needsThumbnail(a, { ...empty(), local: new Set([t]) })).toBe(false)
    expect(needsThumbnail(a, { ...empty(), queued: new Set([t]) })).toBe(false)
    expect(needsThumbnail(a, empty())).toBe(true) // referenced, gone from Drive
    expect(needsThumbnail(a, { ...empty(), drive: null })).toBe(false) // offline: can't tell
  })

  it('gives up on a file after two failed tries', () => {
    const a = att()
    expect(needsThumbnail(a, { ...empty(), failed: { [a.fileId]: 1 } })).toBe(true)
    expect(needsThumbnail(a, { ...empty(), failed: { [a.fileId]: 2 } })).toBe(false)
  })
})

describe('merging versions that only differ in thumbnails', () => {
  const base = (): Entry => ({ ...newEntry('2026-11-01'), title: 'x', attachments: [att(), att()] })

  it('merges instead of conflicting; Drive wins, this device fills gaps', () => {
    const e = base()
    const t1 = randomId()
    const t2 = randomId()
    const t3 = randomId()
    const local = {
      ...e,
      updatedAt: 'b',
      attachments: [
        { ...e.attachments[0], thumbFileId: t1 },
        { ...e.attachments[1], thumbFileId: t3 },
      ],
    }
    const remote = {
      ...e,
      updatedAt: 'c',
      attachments: [{ ...e.attachments[0], thumbFileId: t2 }, e.attachments[1]],
    }
    const m = mergeThumbnailsOnly(local, remote)!
    expect(m.merged.attachments.map((a) => a.thumbFileId)).toEqual([t2, t3])
    expect(m.changed).toBe(true)
    expect(m.dropped).toEqual([t1])
    expect(mergeThumbnailsOnly({ ...local, title: 'edited' }, remote)).toBeNull()
    expect(
      mergeThumbnailsOnly(local, { ...remote, attachments: remote.attachments.slice(1) }),
    ).toBeNull()
  })
})

describe('background thumbnail job', () => {
  async function setup() {
    const db = new VaultDB(`thumbs-${++n}`)
    const mk = await importMasterKey(randomBytes(32))
    const session = await VaultSession.open(db, mk)
    const files = new Map<string, Blob>()
    const add = async (name: string, mime: string, bytes = 100) => {
      const a = await session.addAttachment(new File([randomBytes(bytes)], name, { type: mime }))
      files.set(a.fileId, (await db.uploadBlob(a.fileId))!)
      await db.deleteUpload(a.fileId) // as if uploaded
      return a
    }
    const photo = await add('a.jpg', 'image/jpeg')
    const broken = await add('b.heic', 'image/heic')
    const doc = await add('c.pdf', 'application/pdf')
    const e: Entry = {
      ...newEntry('2026-11-01'),
      title: 'media',
      attachments: [photo, broken, doc],
    }
    await session.save(e)
    let made = 0
    const editing = new Set<string>()
    const drive = new Set<string>()
    const job = new ThumbnailJob({
      db,
      session: () => session,
      fetchEncrypted: async (id) => files.get(id) ?? null,
      listDriveFiles: async () => drive,
      make: async (plain) => {
        made++
        return plain.type === 'image/heic' ? null : new Blob([new Uint8Array([0xff, 0xd8, 0xff])])
      },
      isEditing: (id) => editing.has(id),
    })
    return { db, session, job, e, photo, broken, doc, editing, drive, made: () => made }
  }

  it('adds encrypted thumbnails, is resumable, and gives up on undecodable files', async () => {
    const t = await setup()
    await t.job.kick()
    const after = t.session.entries.get(t.e.id)!
    const thumbId = after.attachments[0].thumbFileId!
    expect(thumbId).toMatch(/^[0-9a-f]{32}$/)
    expect(after.attachments[1].thumbFileId).toBeUndefined()
    expect(after.attachments[2].thumbFileId).toBeUndefined()
    // Encrypted .vdf cached locally and queued for upload; the entry is saved for sync.
    expect(await t.db.thumbs.get(thumbId)).toBeTruthy()
    expect(await t.db.uploads.get(thumbId)).toBeTruthy()
    expect((await t.db.entries.get(t.e.id))!.dirty).toBe(1)
    const thumb = await t.session.decryptThumbnail(thumbId, (await t.db.uploadBlob(thumbId))!)
    expect([...new Uint8Array(await thumb.arrayBuffer())]).toEqual([0xff, 0xd8, 0xff])

    // Second run: nothing left except the broken file (tried once more, then given up).
    const before = t.made()
    await t.job.kick()
    await t.job.kick()
    expect(t.made() - before).toBe(1)
    expect(t.job.status.failed).toBe(2)
  })

  it('leaves entries open in an editor alone', async () => {
    const t = await setup()
    t.editing.add(t.e.id)
    await t.job.kick()
    expect(t.session.entries.get(t.e.id)!.attachments[0].thumbFileId).toBeUndefined()
  })

  it('regenerates a thumbnail whose file disappeared from Drive', async () => {
    const t = await setup()
    await t.job.kick()
    const first = t.session.entries.get(t.e.id)!.attachments[0].thumbFileId!
    // Uploaded, then lost: not in the local cache, the queue, or Drive.
    await t.db.thumbs.delete(first)
    await t.db.uploads.delete(first)
    await t.job.kick()
    const second = t.session.entries.get(t.e.id)!.attachments[0].thumbFileId!
    expect(second).not.toBe(first)
    // While it's on Drive, it's left alone.
    t.drive.add(`${second}.vdf`)
    await t.db.thumbs.delete(second)
    await t.db.uploads.delete(second)
    await t.job.kick()
    expect(t.session.entries.get(t.e.id)!.attachments[0].thumbFileId).toBe(second)
  })
})
