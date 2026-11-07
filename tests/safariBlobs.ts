// Mimics how Safari (WebKit) treats Blobs read from IndexedDB: a Blob you read is backed by a
// file the database owns, and when its record is written again (or deleted) that file goes
// away, so reading the old Blob fails with "NotFoundError: The object can not be found here."
// fake-indexeddb hands out ordinary in-memory Blobs, which never fail like that.
import type { Table } from 'dexie'

const notFound = () => new DOMException('The object can not be found here.', 'NotFoundError')

export interface SafariBlobs {
  /** Number of reads that failed because the record was rewritten after the Blob was read. */
  failedReads: number
}

/** Makes `field` Blobs read from `table` go stale like Safari's once their record is rewritten. */
export function safariBlobs<T>(table: Table<T>, field: string): SafariBlobs {
  const stats: SafariBlobs = { failedReads: 0 }
  const live = new Map<unknown, { dead: boolean }[]>()

  const kill = (key: unknown) => {
    for (const state of live.get(key) ?? []) state.dead = true
    live.delete(key)
  }

  const wrap = (blob: Blob, state: { dead: boolean }): Blob => {
    const slice = blob.slice.bind(blob)
    const arrayBuffer = blob.arrayBuffer.bind(blob)
    blob.slice = (...args: Parameters<Blob['slice']>) => wrap(slice(...args), state)
    blob.arrayBuffer = () => {
      if (!state.dead) return arrayBuffer()
      stats.failedReads++
      return Promise.reject(notFound())
    }
    return blob
  }

  table.hook('reading', (obj) => {
    const rec = obj as Record<string, unknown>
    const blob = rec?.[field]
    if (!(blob instanceof Blob)) return obj
    const key = table.schema.primKey.keyPath
      ? rec[table.schema.primKey.keyPath as string]
      : undefined
    const state = { dead: false }
    live.set(key, [...(live.get(key) ?? []), state])
    // A fresh Blob object per read, like the database hands out.
    return { ...rec, [field]: wrap(blob.slice(0, blob.size, blob.type), state) } as T
  })
  table.hook('creating', (key) => kill(key))
  table.hook('updating', (_mods, key) => kill(key))
  table.hook('deleting', (key) => kill(key))
  return stats
}
