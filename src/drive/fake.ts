// In-memory Google Drive used by tests and by `npm run dev:fake`. Never part of a production build.
import { toHex } from '../crypto/bytes'
import {
  AuthError,
  DriveError,
  FOLDER_MIME,
  OfflineError,
  type About,
  type DriveClient,
  type DriveFile,
  type ResumableStatus,
} from './types'

export interface FakeFile {
  id: string
  name: string
  parent: string | null
  mimeType: string
  data: Uint8Array
  md5: string | null
  modifiedTime: string
  trashed: boolean
  appProperties?: Record<string, string>
}

interface Session {
  parent: string
  name: string
  total: number
  received: Uint8Array[]
  receivedBytes: number
}

let counter = 0

async function checksum(data: Uint8Array): Promise<string> {
  // Stand-in for md5Checksum: any content hash works for change detection.
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(data))
  return toHex(new Uint8Array(digest)).slice(0, 32)
}

export class FakeDrive implements DriveClient {
  files = new Map<string, FakeFile>()
  sessions = new Map<string, Session>()
  offline = false
  authExpired = false
  /** Called after every change (dev mode persists the fake Drive in IndexedDB). */
  onChange?: () => void
  /** Test hook: throw OfflineError on the Nth upload slice. */
  failSliceAt: number | null = null
  /** Test hook: the next slice upload never answers (like a request iOS leaves hanging). */
  hangNext = false
  slicesPut = 0
  requests = 0
  /** Whole-file downloads made, by file id. */
  downloads: string[] = []
  /** Range downloads made (streaming playback), as [fileId, start, end]. */
  ranges: [string, number, number][] = []

  private check() {
    this.requests++
    if (this.offline) throw new OfflineError()
    if (this.authExpired) throw new AuthError()
  }

  private meta(f: FakeFile): DriveFile {
    return {
      id: f.id,
      name: f.name,
      size: f.data.length,
      md5: f.md5,
      modifiedTime: f.modifiedTime,
      mimeType: f.mimeType,
      appProperties: f.appProperties,
    }
  }

  private changed() {
    this.onChange?.()
  }

  private get(id: string): FakeFile {
    const f = this.files.get(id)
    if (!f || f.trashed) throw new DriveError(404, `File not found: ${id}`)
    return f
  }

  async about(): Promise<About> {
    this.check()
    let usage = 0
    for (const f of this.files.values()) usage += f.data.length
    return { email: 'fake.user@example.com', name: 'Fake User', usage, limit: 15e9 }
  }

  async findFolders(query: { appProperty?: [string, string]; name?: string }) {
    this.check()
    return [...this.files.values()]
      .filter(
        (f) =>
          !f.trashed &&
          f.mimeType === FOLDER_MIME &&
          (!query.name || f.name === query.name) &&
          (!query.appProperty || f.appProperties?.[query.appProperty[0]] === query.appProperty[1]),
      )
      .map((f) => this.meta(f))
  }

  async createFolder(
    name: string,
    parentId: string | null,
    appProperties?: Record<string, string>,
  ) {
    this.check()
    const f: FakeFile = {
      id: `fake${++counter}${Date.now().toString(36)}`,
      name,
      parent: parentId,
      mimeType: FOLDER_MIME,
      data: new Uint8Array(0),
      md5: null,
      modifiedTime: new Date().toISOString(),
      trashed: false,
      appProperties,
    }
    this.files.set(f.id, f)
    this.changed()
    return this.meta(f)
  }

  async list(parentId: string) {
    this.check()
    return [...this.files.values()]
      .filter((f) => !f.trashed && f.parent === parentId)
      .map((f) => this.meta(f))
  }

  async findByName(parentId: string, name: string) {
    return (await this.list(parentId)).filter((f) => f.name === name)
  }

  private async put(parent: string, name: string, data: Uint8Array): Promise<DriveFile> {
    const f: FakeFile = {
      id: `fake${++counter}${Date.now().toString(36)}`,
      name,
      parent,
      mimeType: 'application/octet-stream',
      data,
      md5: await checksum(data),
      modifiedTime: new Date().toISOString(),
      trashed: false,
    }
    this.files.set(f.id, f)
    this.changed()
    return this.meta(f)
  }

  async createFile(parentId: string, name: string, data: Blob) {
    this.check()
    return this.put(parentId, name, new Uint8Array(await data.arrayBuffer()))
  }

  async updateFile(fileId: string, data: Blob) {
    this.check()
    const f = this.get(fileId)
    f.data = new Uint8Array(await data.arrayBuffer())
    f.md5 = await checksum(f.data)
    f.modifiedTime = new Date().toISOString()
    this.changed()
    return this.meta(f)
  }

  async download(fileId: string, onProgress?: (done: number, total: number) => void) {
    this.check()
    const f = this.get(fileId)
    this.downloads.push(fileId)
    onProgress?.(f.data.length, f.data.length)
    return new Blob([new Uint8Array(f.data)])
  }

  async downloadRange(fileId: string, start: number, end: number) {
    this.check()
    const f = this.get(fileId)
    if (start < 0 || end < start || start >= f.data.length) {
      throw new DriveError(416, 'Range not satisfiable')
    }
    this.ranges.push([fileId, start, end])
    return new Uint8Array(f.data.slice(start, end + 1))
  }

  async trash(fileId: string) {
    this.check()
    const f = this.files.get(fileId)
    if (f) f.trashed = true
    this.changed()
  }

  async startResumable(parentId: string, name: string, size: number) {
    this.check()
    const url = `https://fake.invalid/upload/${++counter}`
    this.sessions.set(url, { parent: parentId, name, total: size, received: [], receivedBytes: 0 })
    return url
  }

  private session(url: string): Session {
    const s = this.sessions.get(url)
    if (!s) throw new DriveError(404, 'Upload session expired.')
    return s
  }

  private async finishIfDone(url: string, s: Session): Promise<ResumableStatus> {
    if (s.receivedBytes < s.total) return { done: false, nextOffset: s.receivedBytes }
    const data = new Uint8Array(s.total)
    let o = 0
    for (const part of s.received) {
      data.set(part, o)
      o += part.length
    }
    this.sessions.delete(url)
    return { done: true, file: await this.put(s.parent, s.name, data) }
  }

  async putSlice(
    url: string,
    slice: Blob,
    start: number,
    total: number,
    onProgress?: (sent: number) => void,
  ) {
    if (this.hangNext) {
      this.hangNext = false
      return new Promise<never>(() => {})
    }
    onProgress?.(slice.size)
    this.check()
    const s = this.session(url)
    if (total !== s.total || start !== s.receivedBytes) {
      throw new DriveError(400, 'Content-Range does not match the session.')
    }
    if (start + slice.size < total && slice.size % (256 * 1024) !== 0) {
      throw new DriveError(400, 'Slices must be multiples of 256 KiB.')
    }
    this.slicesPut++
    if (this.failSliceAt !== null && this.slicesPut === this.failSliceAt) {
      throw new OfflineError('Simulated network drop.')
    }
    s.received.push(new Uint8Array(await slice.arrayBuffer()))
    s.receivedBytes += slice.size
    return this.finishIfDone(url, s)
  }

  async queryResumable(url: string) {
    this.check()
    const s = this.session(url)
    return this.finishIfDone(url, s)
  }

  /** Test helper: plaintext view of the folder tree. */
  pathOf(id: string): string {
    const f = this.files.get(id)
    if (!f) return ''
    return f.parent ? `${this.pathOf(f.parent)}/${f.name}` : f.name
  }
}
