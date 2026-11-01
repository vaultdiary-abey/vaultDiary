import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { randomBytes } from '../src/crypto/bytes'
import { importMasterKey } from '../src/crypto/container'
import { IntegrityError } from '../src/crypto/errors'
import { newLocalKey, openLocalKey, seal, unseal } from '../src/crypto/localSeal'
import { extensionFor, isAppleWebKit, pickMimeType, recordingName } from '../src/media/recorder'
import { RecordingStore } from '../src/media/recordingStore'
import { VaultDB } from '../src/storage/db'

let n = 0
const mkKey = () => importMasterKey(randomBytes(32))

describe('local sealing (IndexedDB-only data)', () => {
  it('round trips and binds the key and pieces to their place', async () => {
    const mk = await mkKey()
    const { key, wrapped } = await newLocalKey(mk, 'recording', 'a'.repeat(32))
    const data = randomBytes(1000)
    const sealed = await seal(key, 'piece/0', data)
    expect(sealed.length).toBe(1000 + 28)
    expect(await unseal(key, 'piece/0', sealed)).toEqual(data)
    await expect(unseal(key, 'piece/1', sealed)).rejects.toThrow(IntegrityError)
    const reopened = await openLocalKey(mk, 'recording', 'a'.repeat(32), wrapped)
    expect(await unseal(reopened, 'piece/0', sealed)).toEqual(data)
    await expect(openLocalKey(mk, 'recording', 'b'.repeat(32), wrapped)).rejects.toThrow(
      IntegrityError,
    )
    await expect(openLocalKey(await mkKey(), 'recording', 'a'.repeat(32), wrapped)).rejects.toThrow(
      IntegrityError,
    )
  })
})

describe('recording store (crash-safe recordings)', () => {
  it('stores pieces encrypted and reassembles them in order', async () => {
    const db = new VaultDB(`rec-${++n}`)
    const store = new RecordingStore(db)
    const mk = await mkKey()
    const w = await store.create(mk, {
      kind: 'video',
      mime: 'video/webm',
      entryId: 'e'.repeat(32),
      entryDate: '2026-11-01',
    })
    const pieces = [randomBytes(3000), randomBytes(10), randomBytes(5000)]
    await Promise.all(pieces.map((p, i) => w.append(p, (i + 1) * 1000)))
    await w.flushed()

    const [meta] = await store.list()
    expect(meta).toMatchObject({ id: w.id, chunks: 3, bytes: 8010, durationMs: 3000 })
    expect(meta).not.toHaveProperty('key')
    // Nothing in IndexedDB is the plaintext.
    for (const c of await db.recordingChunks.toArray()) {
      expect(pieces.some((p) => Buffer.from(c.data).includes(Buffer.from(p.subarray(0, 10))))).toBe(
        false,
      )
    }
    const blob = await store.assemble(mk, w.id)
    expect(blob.type).toBe('video/webm')
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(
      new Uint8Array(Buffer.concat(pieces.map((p) => Buffer.from(p)))),
    )
    await store.discard(w.id)
    expect(await store.list()).toEqual([])
    expect(await db.recordingChunks.count()).toBe(0)
  })

  it('survives a "crash": a new store on the same database recovers what was written', async () => {
    const name = `rec-${++n}`
    const mk = await mkKey()
    const w = await new RecordingStore(new VaultDB(name)).create(mk, {
      kind: 'audio',
      mime: 'audio/mp4',
      entryId: 'e'.repeat(32),
      entryDate: '2026-11-01',
    })
    await w.append(new Uint8Array([1, 2, 3]), 1000)
    await w.append(new Uint8Array([4, 5]), 2000)
    const again = new RecordingStore(new VaultDB(name))
    const [meta] = await again.list()
    expect(meta.durationMs).toBe(2000)
    const blob = await again.assemble(mk, meta.id)
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([1, 2, 3, 4, 5])
    await expect(again.assemble(await mkKey(), meta.id)).rejects.toThrow(IntegrityError)
  })

  it('keeps the contiguous start when a piece is missing', async () => {
    const db = new VaultDB(`rec-${++n}`)
    const store = new RecordingStore(db)
    const mk = await mkKey()
    const w = await store.create(mk, {
      kind: 'audio',
      mime: 'audio/webm',
      entryId: 'x',
      entryDate: 'y',
    })
    for (const b of [[1], [2], [3]]) await w.append(new Uint8Array(b), 1)
    await db.recordingChunks.delete([w.id, 1])
    const blob = await store.assemble(mk, w.id)
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([1])
  })
})

describe('recording formats', () => {
  it('records MP4 on Apple browsers and WebM elsewhere (Chrome MP4 is not incremental)', () => {
    const all = () => true
    expect(pickMimeType('video', all, true)).toBe('video/mp4;codecs=avc1,mp4a.40.2')
    expect(pickMimeType('audio', all, true)).toBe('audio/mp4;codecs=mp4a.40.2')
    expect(pickMimeType('video', all, false)).toBe('video/webm;codecs=vp9,opus')
    expect(pickMimeType('audio', all, false)).toBe('audio/webm;codecs=opus')
    const mp4Only = (t: string) => t.includes('mp4')
    expect(pickMimeType('video', mp4Only, false)).toBe('video/mp4;codecs=avc1,mp4a.40.2')
    const webmOnly = (t: string) => t.includes('webm')
    expect(pickMimeType('video', webmOnly, true)).toBe('video/webm;codecs=vp9,opus')
    expect(pickMimeType('video', () => false, false)).toBeNull()
  })

  it('detects Apple WebKit browsers', () => {
    const iphone =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1'
    const iosChrome = iphone.replace('Version/18.1', 'CriOS/131.0.0.0')
    const macSafari =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15'
    const macChrome =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    const android =
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'
    expect([iphone, iosChrome, macSafari].map((u) => isAppleWebKit(u))).toEqual([true, true, true])
    expect([macChrome, android].map((u) => isAppleWebKit(u))).toEqual([false, false])
  })

  it('names files with the right extension', () => {
    expect(extensionFor('audio/mp4;codecs=mp4a.40.2', 'audio')).toBe('m4a')
    expect(extensionFor('video/mp4', 'video')).toBe('mp4')
    expect(extensionFor('video/webm;codecs=vp8,opus', 'video')).toBe('webm')
    expect(recordingName('audio', 'audio/webm', new Date(2026, 10, 1, 9, 5, 7))).toBe(
      'Voice note 2026-11-01 09.05.07.webm',
    )
  })
})
