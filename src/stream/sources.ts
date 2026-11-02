// Where streaming playback reads the encrypted container from: the local encrypted copy (an
// attachment still in the upload queue) or Google Drive, with HTTP Range requests.
import type { ByteSource } from '../crypto/container'
import { AuthError, OfflineError, type DriveClient } from '../drive/types'

/** The first bytes (magic, header length, header) are fetched in one request and kept. */
const HEAD_BYTES = 4096
const OFFLINE_RETRIES = 3

export interface DriveSourceOptions {
  /**
   * Called when Google sign-in has expired. Resolves once the user has signed in again (the
   * read is then retried); rejects if the player was closed meanwhile.
   */
  waitForSignIn: () => Promise<void>
  /** Test hook. */
  sleep?: (ms: number) => Promise<void>
}

export function driveSource(
  drive: () => DriveClient,
  fileId: string,
  size: number,
  options: DriveSourceOptions,
): ByteSource {
  const sleep = options.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)))
  let head: Promise<Uint8Array> | null = null

  const fetchRange = async (start: number, end: number): Promise<Uint8Array> => {
    let offlineTries = 0
    for (;;) {
      try {
        return await drive().downloadRange(fileId, start, end)
      } catch (e) {
        if (e instanceof AuthError) {
          await options.waitForSignIn()
          continue
        }
        if (e instanceof OfflineError && offlineTries < OFFLINE_RETRIES) {
          await sleep(1000 * 2 ** offlineTries++)
          continue
        }
        throw e
      }
    }
  }

  return {
    size,
    async read(offset, length) {
      const end = Math.min(size, offset + length) - 1
      if (end < offset) return new Uint8Array(0)
      const headEnd = Math.min(size, HEAD_BYTES) - 1
      if (end <= headEnd) {
        head ??= fetchRange(0, headEnd).catch((e) => {
          head = null
          throw e
        })
        return (await head).subarray(offset, end + 1)
      }
      return fetchRange(offset, end)
    },
  }
}
