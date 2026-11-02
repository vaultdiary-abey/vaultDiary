// Streaming playback (Phase 3, milestone B): shared between the page and the service worker.
//
// The player points at a same-origin URL inside the service worker's scope:
//   <scope>stream/<token>/<name>
// The service worker answers the media element's Range requests with 206 responses. It never
// sees a key: it asks the page (over a MessageChannel) for plaintext bytes, and the page
// downloads and decrypts only the 4 MiB chunks that cover them.

export const STREAM_PATH = 'stream/'
export const STREAM_PROTOCOL_VERSION = 1

/** page → service worker */
export type PageToWorker =
  | { type: 'vd-stream-ping' }
  /** Tells the worker which page serves a token (saves a search when a request comes in). */
  | { type: 'vd-stream-register'; token: string }
  | { type: 'vd-stream-unregister'; token: string }

/** service worker → page, with a MessagePort for the answer */
export type WorkerToPage =
  | { type: 'vd-stream-info'; token: string }
  | { type: 'vd-stream-read'; token: string; offset: number; length: number }

export type InfoReply =
  { ok: true; size: number; mime: string } | { ok: false; status: number; error: string }

export type ReadReply =
  { ok: true; bytes: ArrayBuffer } | { ok: false; status: number; error: string }

export interface PingReply {
  type: 'vd-stream-pong'
  version: number
}

/** Tokens are 128 random bits, hex. */
export const TOKEN_PATTERN = /^[0-9a-f]{32}$/

/** The token in a stream URL, or null if the URL isn't a stream URL in this scope. */
export function streamToken(url: string, scope: string): string | null {
  if (!url.startsWith(scope + STREAM_PATH)) return null
  const rest = url.slice(scope.length + STREAM_PATH.length).split(/[/?#]/)[0]
  return TOKEN_PATTERN.test(rest) ? rest : null
}

export type ByteRange = { start: number; end: number }

/**
 * Parses an HTTP Range header against a resource size. Returns the (first) range, inclusive,
 * null when there is no usable Range header (send the whole thing), or 'unsatisfiable'.
 */
export function parseRange(
  header: string | null,
  size: number,
): ByteRange | null | 'unsatisfiable' {
  if (!header) return null
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*(?:,|$)/i.exec(header)
  if (!m || (m[1] === '' && m[2] === '')) return null
  if (m[1] === '') {
    // Suffix range: the last n bytes.
    const n = Number(m[2])
    if (n === 0 || size === 0) return 'unsatisfiable'
    return { start: Math.max(0, size - n), end: size - 1 }
  }
  const start = Number(m[1])
  if (start >= size) return 'unsatisfiable'
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
  if (end < start) return 'unsatisfiable'
  return { start, end }
}

/** The chunk indexes [first, last] holding plaintext bytes start…end (inclusive). */
export function chunksFor(range: ByteRange, chunkSize: number): [number, number] {
  return [Math.floor(range.start / chunkSize), Math.floor(range.end / chunkSize)]
}
