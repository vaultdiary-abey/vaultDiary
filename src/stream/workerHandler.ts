// Service-worker side of streaming playback: answers a media element's request for
// <scope>stream/<token>/… with 200/206 responses whose bytes come from the page that owns the
// token. The worker holds no keys and keeps no plaintext beyond the piece in flight.
import { parseRange, type InfoReply, type ReadReply, type WorkerToPage } from './protocol'

/** Bytes asked from the page per message (the page decrypts whole 4 MiB chunks anyway). */
export const PIECE = 1024 * 1024
/** Finding the page that owns a token must be quick; reads may wait (e.g. Google sign-in). */
const INFO_TIMEOUT = 10_000

export interface PageLink {
  ask<T>(message: WorkerToPage, timeout?: number): Promise<T>
}

/** Sends a message to a page (window client) and waits for the answer on a MessageChannel. */
export function linkTo(client: { postMessage(m: unknown, t: Transferable[]): void }): PageLink {
  return {
    ask<T>(message: WorkerToPage, timeout?: number) {
      return new Promise<T>((resolve, reject) => {
        const channel = new MessageChannel()
        const timer =
          timeout === undefined
            ? null
            : setTimeout(() => {
                channel.port1.close()
                reject(new Error('The page did not answer.'))
              }, timeout)
        channel.port1.onmessage = (e) => {
          if (timer) clearTimeout(timer)
          channel.port1.close()
          resolve(e.data as T)
        }
        client.postMessage(message, [channel.port2])
      })
    },
  }
}

function textResponse(status: number, text: string, headers: Record<string, string> = {}) {
  return new Response(text, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    },
  })
}

/**
 * Finds the page serving `token` among `candidates` (the one it registered with first) and
 * returns its link and the file's size and type, or null.
 */
export async function findOwner(
  token: string,
  candidates: PageLink[],
): Promise<{ link: PageLink; info: Extract<InfoReply, { ok: true }> } | null> {
  for (const link of candidates) {
    try {
      const info = await link.ask<InfoReply>({ type: 'vd-stream-info', token }, INFO_TIMEOUT)
      if (info.ok) return { link, info }
    } catch {
      // try the next one
    }
  }
  return null
}

/** Builds the response for one media request. */
export async function streamResponse(
  request: { headers: { get(name: string): string | null }; method: string },
  token: string,
  candidates: PageLink[],
): Promise<Response> {
  const owner = await findOwner(token, candidates)
  if (!owner) return textResponse(404, 'This player has been closed.')
  const { link, info } = owner
  const size = info.size
  const range = parseRange(request.headers.get('Range'), size)
  if (range === 'unsatisfiable') {
    return textResponse(416, 'Range not satisfiable', { 'Content-Range': `bytes */${size}` })
  }
  const start = range ? range.start : 0
  const end = range ? range.end : size - 1
  const length = size === 0 ? 0 : end - start + 1
  const headers: Record<string, string> = {
    'Content-Type': info.mime || 'application/octet-stream',
    'Content-Length': String(length),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  }
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`
  if (request.method === 'HEAD' || length === 0) {
    return new Response(null, { status: range ? 206 : 200, headers })
  }

  let next = start
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (next > end) {
          controller.close()
          return
        }
        const want = Math.min(PIECE, end - next + 1)
        const reply = await link
          .ask<ReadReply>({ type: 'vd-stream-read', token, offset: next, length: want })
          .catch((e: Error): ReadReply => ({ ok: false, status: 500, error: e.message }))
        if (!reply.ok || reply.bytes.byteLength === 0) {
          controller.error(new Error(reply.ok ? 'No data.' : reply.error))
          return
        }
        next += reply.bytes.byteLength
        controller.enqueue(new Uint8Array(reply.bytes))
        if (next > end) controller.close()
      },
    },
    // Pull only when the media element reads: no read-ahead in the worker.
    { highWaterMark: 0 },
  )
  return new Response(body, { status: range ? 206 : 200, headers })
}
