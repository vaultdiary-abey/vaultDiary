// Page side of streaming playback. The page owns the keys: it answers the service worker's
// "info" and "read" messages for the streams it opened, with plaintext from a PlainReader
// (or any other byte provider). Closing a stream, or the diary locking, drops its chunks.
import { randomId } from '../crypto/bytes'
import {
  STREAM_PATH,
  STREAM_PROTOCOL_VERSION,
  type InfoReply,
  type PageToWorker,
  type PingReply,
  type ReadReply,
  type WorkerToPage,
} from './protocol'

export interface ByteProvider {
  readonly size: number
  read(offset: number, length: number): Promise<Uint8Array>
  close?(): void
}

export interface OpenStream {
  token: string
  url: string
  close(): void
}

export interface StreamEvent {
  token: string
  kind: 'info' | 'read' | 'error'
  offset?: number
  length?: number
  message?: string
}

function errorStatus(e: unknown): number {
  const name = (e as Error)?.name
  return name === 'AuthError' ? 401 : name === 'OfflineError' ? 503 : 500
}

/** A safe last path segment, so the URL ends in the file's name and extension. */
function urlName(name: string): string {
  const cleaned = name.replace(/[^\w.-]+/g, '_').replace(/^[._]+/, '')
  return encodeURIComponent(cleaned.slice(-80) || 'media')
}

export interface StreamStats {
  /** Requests from the service worker that reached this page. */
  info: number
  reads: number
  errors: number
  lastError: string | null
}

export class StreamHost {
  private streams = new Map<string, { provider: ByteProvider; mime: string; stats: StreamStats }>()
  private listening = false
  private onEvent: (e: StreamEvent) => void = () => {}

  /** Diagnostics (the streaming test page) watch every request served. Returns "stop". */
  watch(listener: (e: StreamEvent) => void): () => void {
    this.onEvent = listener
    return () => {
      if (this.onEvent === listener) this.onEvent = () => {}
    }
  }

  private get sw(): ServiceWorkerContainer | null {
    return typeof navigator !== 'undefined' && 'serviceWorker' in navigator
      ? navigator.serviceWorker
      : null
  }

  private listen() {
    if (this.listening || !this.sw) return
    this.listening = true
    this.sw.addEventListener('message', (event: MessageEvent) => {
      const data = event.data as WorkerToPage | undefined
      const port = event.ports[0]
      if (!port || !data || typeof data !== 'object') return
      if (data.type === 'vd-stream-info') void this.answerInfo(data.token, port)
      else if (data.type === 'vd-stream-read') void this.answerRead(data, port)
    })
  }

  private async answerInfo(token: string, port: MessagePort) {
    const s = this.streams.get(token)
    const reply: InfoReply = s
      ? { ok: true, size: s.provider.size, mime: s.mime }
      : { ok: false, status: 404, error: 'Unknown stream.' }
    if (s) {
      s.stats.info++
      this.onEvent({ token, kind: 'info' })
    }
    port.postMessage(reply)
  }

  private async answerRead(
    msg: Extract<WorkerToPage, { type: 'vd-stream-read' }>,
    port: MessagePort,
  ) {
    const s = this.streams.get(msg.token)
    let reply: ReadReply
    if (!s) reply = { ok: false, status: 404, error: 'Unknown stream.' }
    else {
      try {
        const bytes = await s.provider.read(msg.offset, msg.length)
        const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
        reply = { ok: true, bytes: buffer as ArrayBuffer }
        s.stats.reads++
        this.onEvent({ token: msg.token, kind: 'read', offset: msg.offset, length: bytes.length })
      } catch (e) {
        reply = { ok: false, status: errorStatus(e), error: (e as Error).message }
        s.stats.errors++
        s.stats.lastError = (e as Error).message
        this.onEvent({ token: msg.token, kind: 'error', message: (e as Error).message })
      }
    }
    port.postMessage(reply, reply.ok ? [reply.bytes] : [])
  }

  /**
   * Is streaming possible right now? A service worker must control this page (not the case on
   * the very first visit or after a hard reload) and answer our ping.
   */
  async available(timeout = 1500): Promise<boolean> {
    const controller = this.sw?.controller
    if (!controller) return false
    return new Promise<boolean>((resolve) => {
      const channel = new MessageChannel()
      const timer = setTimeout(() => resolve(false), timeout)
      channel.port1.onmessage = (e) => {
        clearTimeout(timer)
        const reply = e.data as PingReply
        resolve(reply?.type === 'vd-stream-pong' && reply.version === STREAM_PROTOCOL_VERSION)
      }
      const ping: PageToWorker = { type: 'vd-stream-ping' }
      controller.postMessage(ping, [channel.port2])
    })
  }

  /** Makes a same-origin URL that plays `provider`'s bytes through the service worker. */
  async open(provider: ByteProvider, mime: string, name: string): Promise<OpenStream> {
    this.listen()
    const registration = await this.sw?.ready
    if (!registration) throw new Error('Streaming needs the service worker.')
    const token = randomId()
    this.streams.set(token, {
      provider,
      mime,
      stats: { info: 0, reads: 0, errors: 0, lastError: null },
    })
    const register: PageToWorker = { type: 'vd-stream-register', token }
    this.sw?.controller?.postMessage(register)
    const url = `${registration.scope}${STREAM_PATH}${token}/${urlName(name)}`
    return { token, url, close: () => this.close(token) }
  }

  /** What reached this page for a stream so far (null once it is closed). */
  stats(token: string): StreamStats | null {
    const s = this.streams.get(token)
    return s ? { ...s.stats } : null
  }

  close(token: string): void {
    const s = this.streams.get(token)
    if (!s) return
    this.streams.delete(token)
    s.provider.close?.()
    const msg: PageToWorker = { type: 'vd-stream-unregister', token }
    this.sw?.controller?.postMessage(msg)
  }

  /** On lock: every stream stops and its decrypted chunks are dropped. */
  closeAll(): void {
    for (const token of [...this.streams.keys()]) this.close(token)
  }

  get openCount(): number {
    return this.streams.size
  }
}
