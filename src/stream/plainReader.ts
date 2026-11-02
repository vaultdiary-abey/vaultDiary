// Random-access plaintext reads from an encrypted container, for streaming playback. Only the
// chunks that cover a read are downloaded and decrypted. The last few decrypted chunks stay in
// memory and the next one is fetched ahead, so steady playback rarely waits.
import type { OpenedContainer } from '../crypto/container'

export interface PlainReaderOptions {
  /** Decrypted chunks kept in memory (4 MiB each). */
  cacheChunks?: number
  /** Fetch the chunk after the one just read. */
  prefetch?: boolean
}

export class PlainReader {
  private readonly container: OpenedContainer
  private readonly cacheChunks: number
  private readonly prefetchNext: boolean
  /** Decrypted chunks, least recently used first. */
  private cache = new Map<number, Promise<Uint8Array<ArrayBuffer>>>()
  private closed = false
  /** Chunks downloaded and decrypted so far (for the diagnostics page and tests). */
  fetched = 0

  constructor(container: OpenedContainer, options: PlainReaderOptions = {}) {
    this.container = container
    this.cacheChunks = Math.max(2, options.cacheChunks ?? 4)
    this.prefetchNext = options.prefetch ?? true
  }

  get size(): number {
    return this.container.header.size
  }

  get chunkSize(): number {
    return this.container.header.chunkSize
  }

  private chunk(index: number): Promise<Uint8Array<ArrayBuffer>> {
    if (this.closed) return Promise.reject(new Error('The player was closed.'))
    let p = this.cache.get(index)
    if (p) {
      // Most recently used goes last.
      this.cache.delete(index)
      this.cache.set(index, p)
      return p
    }
    this.fetched++
    p = this.container.readChunk(index)
    this.cache.set(index, p)
    // A failed read is not kept: the next attempt (e.g. after signing in again) retries.
    p.catch(() => {
      if (this.cache.get(index) === p) this.cache.delete(index)
    })
    while (this.cache.size > this.cacheChunks) {
      const oldest = this.cache.keys().next().value as number
      this.cache.delete(oldest)
    }
    return p
  }

  /** Plaintext bytes offset … offset+length−1 (clamped to the file). */
  async read(offset: number, length: number): Promise<Uint8Array<ArrayBuffer>> {
    const end = Math.min(this.size, offset + length)
    if (offset < 0 || offset >= end) return new Uint8Array(0)
    const first = Math.floor(offset / this.chunkSize)
    const last = Math.floor((end - 1) / this.chunkSize)
    const out = new Uint8Array(end - offset)
    for (let i = first; i <= last; i++) {
      const plain = await this.chunk(i)
      const chunkStart = i * this.chunkSize
      const from = Math.max(offset, chunkStart) - chunkStart
      const to = Math.min(end, chunkStart + plain.length) - chunkStart
      out.set(plain.subarray(from, to), chunkStart + from - offset)
    }
    if (this.prefetchNext && last + 1 < this.container.header.chunkCount) {
      void this.chunk(last + 1).catch(() => {})
    }
    return out
  }

  /** Drops every decrypted chunk; later reads fail. */
  close(): void {
    this.closed = true
    this.cache.clear()
  }
}
