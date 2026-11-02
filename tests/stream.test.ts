import { describe, expect, it } from 'vitest'
import { randomId } from '../src/crypto/bytes'
import { bytesSource, encryptBytes, importMasterKey, openContainer } from '../src/crypto/container'
import { IntegrityError } from '../src/crypto/errors'
import { FakeDrive } from '../src/drive/fake'
import { PlainReader } from '../src/stream/plainReader'
import { chunksFor, parseRange, streamToken } from '../src/stream/protocol'
import { driveSource } from '../src/stream/sources'
import { PIECE, streamResponse, type PageLink } from '../src/stream/workerHandler'
import type { InfoReply, ReadReply, WorkerToPage } from '../src/stream/protocol'

const mk = await importMasterKey(crypto.getRandomValues(new Uint8Array(32)))

function pattern(size: number): Uint8Array {
  const out = new Uint8Array(size)
  for (let i = 0; i < size; i++) out[i] = (i * 31 + (i >> 8)) & 0xff
  return out
}

async function container(size: number, chunkSize = 1000) {
  const id = randomId()
  const plain = pattern(size)
  const data = await encryptBytes(mk, id, 'file', plain, chunkSize)
  return { id, plain, data }
}

describe('Range header parsing', () => {
  it('handles closed, open-ended and suffix ranges', () => {
    expect(parseRange('bytes=0-1', 100)).toEqual({ start: 0, end: 1 })
    expect(parseRange('bytes=10-', 100)).toEqual({ start: 10, end: 99 })
    expect(parseRange('bytes=90-500', 100)).toEqual({ start: 90, end: 99 })
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 })
    expect(parseRange('bytes=-500', 100)).toEqual({ start: 0, end: 99 })
    expect(parseRange('bytes=5-9, 20-30', 100)).toEqual({ start: 5, end: 9 })
  })
  it('reports unsatisfiable ranges and ignores nonsense', () => {
    expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable')
    expect(parseRange('bytes=9-5', 100)).toBe('unsatisfiable')
    expect(parseRange('bytes=-0', 100)).toBe('unsatisfiable')
    expect(parseRange(null, 100)).toBeNull()
    expect(parseRange('items=0-5', 100)).toBeNull()
    expect(parseRange('bytes=-', 100)).toBeNull()
  })
  it('maps byte ranges to chunks', () => {
    expect(chunksFor({ start: 0, end: 0 }, 4)).toEqual([0, 0])
    expect(chunksFor({ start: 3, end: 4 }, 4)).toEqual([0, 1])
    expect(chunksFor({ start: 8, end: 11 }, 4)).toEqual([2, 2])
  })
})

describe('stream URLs', () => {
  const scope = 'https://example.test/vaultDiary/'
  const token = 'a'.repeat(32)
  it('only matches stream/<token> inside the scope', () => {
    expect(streamToken(`${scope}stream/${token}/movie.mp4`, scope)).toBe(token)
    expect(streamToken(`${scope}stream/${token}`, scope)).toBe(token)
    expect(streamToken(`https://example.test/stream/${token}/x`, scope)).toBeNull()
    expect(streamToken(`${scope}stream/xyz/x`, scope)).toBeNull()
    expect(streamToken(`${scope}index.html`, scope)).toBeNull()
  })
})

describe('random-access decryption', () => {
  it('reads any chunk and checks it with its own AAD', async () => {
    const { id, plain, data } = await container(4500)
    const opened = await openContainer(mk, bytesSource(data), { expectedId: id })
    expect(opened.header.chunkCount).toBe(5)
    expect(opened.chunkOffset(3)).toBe(opened.dataOffset + 3 * (1000 + 28))
    expect(await opened.readChunk(4)).toEqual(plain.subarray(4000))
    expect(await opened.readChunk(2)).toEqual(plain.subarray(2000, 3000))
  })

  it('rejects a tampered chunk without returning its plaintext', async () => {
    const { data } = await container(3000)
    const opened0 = await openContainer(mk, bytesSource(data))
    const bad = new Uint8Array(data)
    bad[opened0.chunkOffset(1) + 20] ^= 1
    const opened = await openContainer(mk, bytesSource(bad))
    await expect(opened.readChunk(1)).rejects.toBeInstanceOf(IntegrityError)
    expect(await opened.readChunk(0)).toHaveLength(1000)
  })

  it('a chunk swapped into another position fails (index and last flag in the AAD)', async () => {
    const { data } = await container(3000)
    const o = await openContainer(mk, bytesSource(data))
    const swapped = new Uint8Array(data)
    const len = 1000 + 28
    swapped.set(data.subarray(o.chunkOffset(2), o.chunkOffset(2) + len), o.chunkOffset(1))
    const opened = await openContainer(mk, bytesSource(swapped))
    await expect(opened.readChunk(1)).rejects.toBeInstanceOf(IntegrityError)
  })
})

describe('PlainReader', () => {
  it('returns exact plaintext slices across chunk boundaries', async () => {
    const { plain, data } = await container(10_000)
    const reader = new PlainReader(await openContainer(mk, bytesSource(data)), { prefetch: false })
    for (const [o, l] of [
      [0, 2],
      [999, 2],
      [1500, 3000],
      [9990, 100],
      [0, 10_000],
    ]) {
      expect(await reader.read(o, l)).toEqual(plain.subarray(o, Math.min(10_000, o + l)))
    }
    expect(await reader.read(10_000, 5)).toHaveLength(0)
  })

  it('downloads only the chunks a read needs, keeps a few and prefetches the next', async () => {
    const { data } = await container(10_000)
    const reads: number[] = []
    const source = {
      size: data.length,
      read: async (offset: number, length: number) => {
        reads.push(offset)
        return data.subarray(offset, offset + length)
      },
    }
    const opened = await openContainer(mk, source)
    reads.length = 0
    const reader = new PlainReader(opened, { cacheChunks: 3 })
    await reader.read(5500, 100) // chunk 5, prefetch 6
    await new Promise((r) => setTimeout(r, 0))
    expect(reads).toEqual([opened.chunkOffset(5), opened.chunkOffset(6)])
    await reader.read(6000, 1000) // chunk 6 from cache, prefetch 7
    await new Promise((r) => setTimeout(r, 0))
    expect(reads).toEqual([5, 6, 7].map((i) => opened.chunkOffset(i)))
    await reader.read(5000, 10) // chunk 5 still cached
    await new Promise((r) => setTimeout(r, 0))
    expect(reads).toHaveLength(3)
    reader.close()
    await expect(reader.read(0, 1)).rejects.toThrow('closed')
  })
})

describe('Drive range source', () => {
  async function onDrive(size: number) {
    const drive = new FakeDrive()
    const folder = await drive.createFolder('files', null)
    const c = await container(size)
    const file = await drive.createFile(folder.id, `${c.id}.vdf`, new Blob([c.data]))
    return { drive, file, ...c }
  }

  it('streams a file with Range requests only, never a full download', async () => {
    const { drive, file, plain } = await onDrive(10_000)
    const source = driveSource(() => drive, file.id, file.size, {
      waitForSignIn: () => Promise.reject(new Error('no')),
    })
    const reader = new PlainReader(await openContainer(mk, source), { prefetch: false })
    expect(await reader.read(7000, 10)).toEqual(plain.subarray(7000, 7010))
    expect(drive.downloads).toEqual([])
    // One request for the header area, one for chunk 7.
    expect(drive.ranges.length).toBe(2)
    expect(drive.ranges[0][1]).toBe(0)
  })

  it('waits for a new Google sign-in, then carries on', async () => {
    const { drive, file, plain } = await onDrive(10_000)
    let resume: () => void = () => {}
    let asked = 0
    const source = driveSource(() => drive, file.id, file.size, {
      waitForSignIn: () => {
        asked++
        return new Promise<void>((r) => (resume = r))
      },
    })
    const reader = new PlainReader(await openContainer(mk, source), { prefetch: false })
    drive.authExpired = true
    const pending = reader.read(8500, 10)
    await new Promise((r) => setTimeout(r, 10))
    expect(asked).toBe(1)
    drive.authExpired = false
    resume()
    expect(await pending).toEqual(plain.subarray(8500, 8510))
  })

  it('gives up on an auth error when the player was closed', async () => {
    const { drive, file } = await onDrive(10_000)
    const source = driveSource(() => drive, file.id, file.size, {
      waitForSignIn: () => Promise.reject(new Error('The vault is locked.')),
    })
    const opened = await openContainer(mk, source)
    drive.authExpired = true
    await expect(opened.readChunk(8)).rejects.toThrow('locked')
  })
})

describe('service worker responses', () => {
  function page(plain: Uint8Array, mime = 'video/mp4'): PageLink & { reads: number[][] } {
    const reads: number[][] = []
    return {
      reads,
      async ask<T>(m: WorkerToPage): Promise<T> {
        if (m.type === 'vd-stream-info') {
          return { ok: true, size: plain.length, mime } satisfies InfoReply as T
        }
        reads.push([m.offset, m.length])
        const bytes = plain.slice(m.offset, m.offset + m.length)
        return { ok: true, bytes: bytes.buffer } satisfies ReadReply as T
      },
    }
  }
  const req = (range?: string) => ({
    method: 'GET',
    headers: new Headers(range ? { Range: range } : {}),
  })
  const token = 'b'.repeat(32)

  it('answers a Range request with 206 and the right headers and bytes', async () => {
    const plain = pattern(5000)
    const res = await streamResponse(req('bytes=100-1099'), token, [page(plain)])
    expect(res.status).toBe(206)
    expect(res.headers.get('Content-Range')).toBe('bytes 100-1099/5000')
    expect(res.headers.get('Content-Length')).toBe('1000')
    expect(res.headers.get('Accept-Ranges')).toBe('bytes')
    expect(res.headers.get('Content-Type')).toBe('video/mp4')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(plain.subarray(100, 1100))
  })

  it("answers Safari's first probe (bytes=0-1) and the last bytes", async () => {
    const plain = pattern(5000)
    const probe = await streamResponse(req('bytes=0-1'), token, [page(plain)])
    expect(probe.headers.get('Content-Range')).toBe('bytes 0-1/5000')
    expect(new Uint8Array(await probe.arrayBuffer())).toEqual(plain.subarray(0, 2))
    const tail = await streamResponse(req('bytes=4990-'), token, [page(plain)])
    expect(new Uint8Array(await tail.arrayBuffer())).toEqual(plain.subarray(4990))
  })

  it('without Range sends 200 with the whole file, pulled piece by piece', async () => {
    const plain = pattern(PIECE * 2 + 10)
    const p = page(plain)
    const res = await streamResponse(req(), token, [p])
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Range')).toBeNull()
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(plain)
    expect(p.reads.map((r) => r[1])).toEqual([PIECE, PIECE, 10])
  })

  it('pulls lazily: nothing is read before the player reads', async () => {
    const plain = pattern(PIECE * 3)
    const p = page(plain)
    const res = await streamResponse(req('bytes=0-'), token, [p])
    expect(p.reads).toEqual([])
    const reader = res.body!.getReader()
    await reader.read()
    expect(p.reads.length).toBe(1)
    await reader.cancel()
  })

  it('416 for a range past the end; 404 when no page owns the token', async () => {
    const plain = pattern(100)
    const res = await streamResponse(req('bytes=100-'), token, [page(plain)])
    expect(res.status).toBe(416)
    expect(res.headers.get('Content-Range')).toBe('bytes */100')
    const nobody: PageLink = {
      ask: async <T>() => ({ ok: false, status: 404, error: 'Unknown' }) as T,
    }
    expect((await streamResponse(req('bytes=0-1'), token, [nobody])).status).toBe(404)
  })

  it('a failed read errors the body instead of sending wrong bytes', async () => {
    const failing: PageLink = {
      ask: async <T>(m: WorkerToPage) =>
        (m.type === 'vd-stream-info'
          ? { ok: true, size: 100, mime: 'video/mp4' }
          : { ok: false, status: 500, error: 'Chunk 0 failed authentication' }) as T,
    }
    const res = await streamResponse(req('bytes=0-99'), token, [failing])
    await expect(res.arrayBuffer()).rejects.toThrow()
  })
})
