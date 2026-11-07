import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { randomBytes, randomId } from '../src/crypto/bytes'
import { importMasterKey } from '../src/crypto/container'
import { VaultSession } from '../src/core/session'
import { isHeic, viewCopyName } from '../src/media/heic'
import { needsThumbnail, thumbSource } from '../src/media/thumbJob'
import { needsViewCopy, ViewCopyJob, viewCopyWork } from '../src/media/viewCopyJob'
import { cantPlayMessage, codecInMoov, sniffVideoCodec } from '../src/media/videoCodec'
import {
  derivedFileIds,
  mergeThumbnailsOnly,
  newEntry,
  parseEntry,
  type Attachment,
  type Entry,
} from '../src/model/entry'
import { viewCopyPath } from '../src/recovery/export'
import { VaultDB } from '../src/storage/db'

const heic = (patch: Partial<Attachment> = {}): Attachment => ({
  fileId: randomId(),
  name: 'IMG_0100.HEIC',
  mime: 'image/heic',
  size: 3000,
  ...patch,
})

describe('HEIC basics', () => {
  it('recognises HEIC by type or name', () => {
    expect(isHeic('image/heic')).toBe(true)
    expect(isHeic('image/HEIF')).toBe(true)
    expect(isHeic('image/heic-sequence')).toBe(true)
    expect(isHeic('application/octet-stream', 'IMG_1.HEIC')).toBe(true)
    expect(isHeic('image/jpeg', 'IMG_1.jpg')).toBe(false)
  })

  it('names viewing copies after the original', () => {
    expect(viewCopyName('IMG_0100.HEIC')).toBe('IMG_0100-view.jpg')
    expect(viewCopyName('holiday.photo.heic')).toBe('holiday.photo-view.jpg')
    const id = 'ab'.repeat(16)
    expect(viewCopyPath(id, 'IMG_0100.HEIC')).toBe('files/abababab-IMG_0100-view.jpg')
    expect(viewCopyPath(id, '.heic')).toBe('files/abababab-file-view.jpg')
  })

  it('keeps viewCopyFileId when parsing and counts it as a derived file', () => {
    const v = randomId()
    const t = randomId()
    const a = heic({ viewCopyFileId: v, thumbFileId: t })
    const e = parseEntry({ ...newEntry('2026-03-08'), attachments: [a] })
    expect(e.attachments[0].viewCopyFileId).toBe(v)
    expect(derivedFileIds(e.attachments[0]).sort()).toEqual([t, v].sort())
  })
})

describe('merging versions that only differ in viewing copies', () => {
  it('fills gaps from either side instead of making a conflict copy', () => {
    const base: Entry = { ...newEntry('2026-03-08'), title: 'x', attachments: [heic(), heic()] }
    const v1 = randomId()
    const v2 = randomId()
    const v3 = randomId()
    const local = {
      ...base,
      attachments: [
        { ...base.attachments[0], viewCopyFileId: v1 },
        { ...base.attachments[1], viewCopyFileId: v3 },
      ],
    }
    const remote = {
      ...base,
      updatedAt: '2026-03-09T00:00:00.000Z',
      attachments: [{ ...base.attachments[0], viewCopyFileId: v2 }, base.attachments[1]],
    }
    const r = mergeThumbnailsOnly(local, remote)!
    expect(r.changed).toBe(true)
    expect(r.merged.attachments[0].viewCopyFileId).toBe(v2) // Drive's wins
    expect(r.merged.attachments[1].viewCopyFileId).toBe(v3) // this device fills the gap
    expect(r.dropped).toEqual([v1])
  })

  it('still conflicts when anything else differs', () => {
    const e: Entry = { ...newEntry('2026-03-08'), title: 'x', attachments: [heic()] }
    const other = {
      ...e,
      title: 'y',
      attachments: [{ ...e.attachments[0], viewCopyFileId: randomId() }],
    }
    expect(mergeThumbnailsOnly(e, other)).toBeNull()
  })
})

describe('thumbnails for HEIC photos', () => {
  it('are made from the viewing copy when there is one', () => {
    const v = randomId()
    const a = heic({ viewCopyFileId: v })
    expect(thumbSource(a)).toBe(v)
    expect(thumbSource(heic())).not.toBe(v)
    const state = { local: new Set<string>(), queued: new Set<string>(), drive: new Set<string>() }
    // Failed twice on the original (e.g. in Chrome) – a viewing copy gives it another chance.
    const failed = { [a.fileId]: 2 }
    expect(needsThumbnail(a, { ...state, failed })).toBe(true)
    expect(needsThumbnail({ ...a, viewCopyFileId: undefined }, { ...state, failed })).toBe(false)
  })
})

describe('which photos need a viewing copy', () => {
  it('HEIC photos without one, not others, not huge ones, not after two failures', () => {
    expect(needsViewCopy(heic(), {})).toBe(true)
    expect(needsViewCopy(heic({ viewCopyFileId: randomId() }), {})).toBe(false)
    expect(needsViewCopy(heic({ mime: 'image/jpeg', name: 'a.jpg' }), {})).toBe(false)
    expect(needsViewCopy(heic({ size: 201 * 1024 * 1024 }), {})).toBe(false)
    const a = heic()
    expect(needsViewCopy(a, { [a.fileId]: 2 })).toBe(false)
  })

  it('lists the work newest entry first', () => {
    const old: Entry = { ...newEntry('2025-01-01'), attachments: [heic()] }
    const recent: Entry = { ...newEntry('2026-01-01'), attachments: [heic(), heic()] }
    expect(viewCopyWork([old, recent], {}).map((w) => w.entry.date)).toEqual([
      '2026-01-01',
      '2026-01-01',
      '2025-01-01',
    ])
  })
})

describe('"Make viewing copies for older photos"', () => {
  let n = 0
  async function setup(count: number, canDecode = true) {
    const db = new VaultDB(`viewcopies-${++n}`)
    const session = await VaultSession.open(db, await importMasterKey(randomBytes(32)))
    const files = new Map<string, Blob>()
    const attachments: Attachment[] = []
    for (let i = 0; i < count; i++) {
      const a = await session.addAttachment(
        new File([randomBytes(50)], `IMG_${i}.HEIC`, { type: 'image/heic' }),
      )
      files.set(a.fileId, (await db.uploadBlob(a.fileId))!)
      await db.deleteUpload(a.fileId) // as if uploaded
      attachments.push(a)
    }
    const e: Entry = { ...newEntry('2026-03-08'), attachments }
    await session.save(e)
    let queued = 0
    const job = new ViewCopyJob({
      db,
      session: () => session,
      canDecode: async () => canDecode,
      fetchEncrypted: async (id) => files.get(id) ?? null,
      make: async (plain) =>
        plain.size === 50 ? new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])]) : null,
      isEditing: () => false,
      queuedUploads: async () => {
        // Pretend the queue drains a little every time it is checked.
        queued = Math.max(0, (await db.uploads.count()) - ++checks * 4)
        return queued
      },
      sleep: async () => {},
    })
    let checks = 0
    return { db, session, job, e }
  }

  it('makes encrypted copies in batches through the upload queue, and is resumable', async () => {
    const t = await setup(23)
    expect(await t.job.pending()).toBe(23)
    await t.job.start()
    const after = t.session.entries.get(t.e.id)!
    const ids = after.attachments.map((a) => a.viewCopyFileId)
    expect(ids.every((id) => /^[0-9a-f]{32}$/.test(id ?? ''))).toBe(true)
    expect(t.job.status.made).toBe(23)
    // Queued for upload (not cached like thumbnails), and the entry is saved for sync.
    expect(await t.db.uploads.get(ids[0]!)).toBeTruthy()
    expect(await t.db.thumbs.get(ids[0]!)).toBeUndefined()
    const copy = await t.session.decryptThumbnail(ids[0]!, (await t.db.uploadBlob(ids[0]!))!)
    expect([...new Uint8Array(await copy.arrayBuffer())]).toEqual([0xff, 0xd8, 0xff, 0xe0])
    // The original is untouched.
    expect(after.attachments.map((a) => a.fileId)).toEqual(t.e.attachments.map((a) => a.fileId))
    expect(await t.job.pending()).toBe(0)
  })

  it('stops when asked and continues later', async () => {
    const t = await setup(12)
    const run = t.job.start()
    t.job.stop()
    await run
    const made = t.job.status.made
    expect(made).toBeLessThan(12)
    await t.job.start()
    expect(await t.job.pending()).toBe(0)
  })

  it('does nothing on a browser that cannot decode HEIC', async () => {
    const t = await setup(2, false)
    await t.job.start()
    expect(t.job.status.made).toBe(0)
    expect(t.job.status.message).toMatch(/can't read HEIC/)
    expect(await t.job.pending()).toBe(2)
  })
})

describe('video codec check', () => {
  function box(type: string, body: Uint8Array): Uint8Array {
    const out = new Uint8Array(8 + body.length)
    new DataView(out.buffer).setUint32(0, out.length)
    out.set(new TextEncoder().encode(type), 4)
    out.set(body, 8)
    return out
  }
  const cat = (...parts: Uint8Array[]) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
    let o = 0
    for (const p of parts) {
      out.set(p, o)
      o += p.length
    }
    return out
  }
  function mp4(fourcc: string, moovAtEnd: boolean): Uint8Array {
    const entry = box(fourcc, new Uint8Array(78))
    const stsd = box('stsd', cat(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 1]), entry))
    const moov = box('moov', box('trak', box('mdia', box('minf', box('stbl', stsd)))))
    const ftyp = box('ftyp', new TextEncoder().encode('qt  \0\0\0\0qt  '))
    const mdat = box('mdat', new Uint8Array(5000))
    return moovAtEnd ? cat(ftyp, mdat, moov) : cat(ftyp, moov, mdat)
  }
  const reader = (b: Uint8Array) => async (o: number, l: number) => b.subarray(o, o + l)

  it('finds the codec whether moov is at the start or the end (iPhone .mov)', async () => {
    for (const end of [false, true]) {
      const hevc = mp4('hvc1', end)
      expect(await sniffVideoCodec(reader(hevc), hevc.length)).toBe('hevc')
      const avc = mp4('avc1', end)
      expect(await sniffVideoCodec(reader(avc), avc.length)).toBe('h264')
    }
  })

  it('ignores files that are not MP4/MOV', async () => {
    const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0])
    expect(await sniffVideoCodec(reader(webm), webm.length)).toBeNull()
    expect(codecInMoov(new Uint8Array(100))).toBeNull()
  })

  it('explains HEVC in plain words', () => {
    expect(cantPlayMessage('hevc')).toMatch(/HEVC \(H\.265\).*iPhones/)
    expect(cantPlayMessage(null)).toMatch(/can't play this video/)
  })
})
