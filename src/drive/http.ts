// Google Drive REST v3 over fetch. Scope: drive.file (only files this app created).
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

const API = 'https://www.googleapis.com/drive/v3'
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3'
const FIELDS = 'id,name,size,md5Checksum,modifiedTime,mimeType,appProperties'

/**
 * Every request has a deadline: a request that never settles (iOS Safari sometimes leaves one
 * hanging after the app was in the background) would otherwise stall sync or the upload queue
 * until the app restarts. Uploads and downloads are cut off only when no bytes move for a while.
 */
const REQUEST_TIMEOUT = 45_000
const STALL_TIMEOUT = 60_000

const timedOut = () => new OfflineError('Google Drive did not answer in time.')

interface RawFile {
  id: string
  name: string
  size?: string
  md5Checksum?: string
  modifiedTime: string
  mimeType: string
  appProperties?: Record<string, string>
}

function toFile(raw: RawFile): DriveFile {
  return {
    id: raw.id,
    name: raw.name,
    size: raw.size ? Number(raw.size) : 0,
    md5: raw.md5Checksum ?? null,
    modifiedTime: raw.modifiedTime,
    mimeType: raw.mimeType,
    appProperties: raw.appProperties,
  }
}

function quote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

export class HttpDrive implements DriveClient {
  private readonly getToken: () => string | null
  private readonly onAuthExpired: () => void

  constructor(getToken: () => string | null, onAuthExpired: () => void) {
    this.getToken = getToken
    this.onAuthExpired = onAuthExpired
  }

  private async request(
    url: string,
    init: RequestInit = {},
    timeout = REQUEST_TIMEOUT,
  ): Promise<Response> {
    const token = this.getToken()
    if (!token) throw new AuthError()
    let res: Response
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    try {
      res = await fetch(url, {
        ...init,
        headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}` },
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      })
    } catch {
      throw controller.signal.aborted ? timedOut() : new OfflineError()
    } finally {
      clearTimeout(timer)
    }
    if (res.status === 401) {
      this.onAuthExpired()
      throw new AuthError()
    }
    return res
  }

  private async json<T>(url: string, init: RequestInit = {}, timeout?: number): Promise<T> {
    const res = await this.request(url, init, timeout)
    if (!res.ok) throw await this.error(res)
    return (await res.json()) as T
  }

  private async error(res: Response): Promise<DriveError> {
    let message = `Google Drive error ${res.status}`
    try {
      const body = (await res.json()) as { error?: { message?: string } }
      if (body.error?.message) message += `: ${body.error.message}`
    } catch {
      // not JSON
    }
    return new DriveError(res.status, message)
  }

  async about(): Promise<About> {
    const r = await this.json<{
      user?: { emailAddress?: string; displayName?: string }
      storageQuota?: { usage?: string; limit?: string }
    }>(`${API}/about?fields=user(emailAddress,displayName),storageQuota(usage,limit)`)
    return {
      email: r.user?.emailAddress ?? null,
      name: r.user?.displayName ?? null,
      usage: r.storageQuota?.usage ? Number(r.storageQuota.usage) : null,
      limit: r.storageQuota?.limit ? Number(r.storageQuota.limit) : null,
    }
  }

  private async query(q: string): Promise<DriveFile[]> {
    const out: DriveFile[] = []
    let pageToken: string | undefined
    do {
      const params = new URLSearchParams({
        q,
        fields: `nextPageToken,files(${FIELDS})`,
        pageSize: '1000',
        spaces: 'drive',
        orderBy: 'createdTime',
      })
      if (pageToken) params.set('pageToken', pageToken)
      const r = await this.json<{ files: RawFile[]; nextPageToken?: string }>(
        `${API}/files?${params}`,
      )
      out.push(...r.files.map(toFile))
      pageToken = r.nextPageToken
    } while (pageToken)
    return out
  }

  findFolders(query: { appProperty?: [string, string]; name?: string }): Promise<DriveFile[]> {
    const parts = [`mimeType=${quote(FOLDER_MIME)}`, 'trashed=false']
    if (query.appProperty) {
      const [k, v] = query.appProperty
      parts.push(`appProperties has { key=${quote(k)} and value=${quote(v)} }`)
    }
    if (query.name) parts.push(`name=${quote(query.name)}`)
    return this.query(parts.join(' and '))
  }

  async createFolder(
    name: string,
    parentId: string | null,
    appProperties?: Record<string, string>,
  ): Promise<DriveFile> {
    const raw = await this.json<RawFile>(`${API}/files?fields=${FIELDS}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        mimeType: FOLDER_MIME,
        parents: parentId ? [parentId] : undefined,
        appProperties,
      }),
    })
    return toFile(raw)
  }

  list(parentId: string): Promise<DriveFile[]> {
    return this.query(`${quote(parentId)} in parents and trashed=false`)
  }

  findByName(parentId: string, name: string): Promise<DriveFile[]> {
    return this.query(`${quote(parentId)} in parents and name=${quote(name)} and trashed=false`)
  }

  async createFile(parentId: string, name: string, data: Blob): Promise<DriveFile> {
    const boundary = `vd${crypto.randomUUID().replace(/-/g, '')}`
    const meta = JSON.stringify({ name, parents: [parentId], mimeType: 'application/octet-stream' })
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`,
      `--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`,
      data,
      `\r\n--${boundary}--`,
    ])
    const raw = await this.json<RawFile>(
      `${UPLOAD}/files?uploadType=multipart&fields=${FIELDS}`,
      {
        method: 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body,
      },
      120_000,
    )
    return toFile(raw)
  }

  async updateFile(fileId: string, data: Blob): Promise<DriveFile> {
    const raw = await this.json<RawFile>(
      `${UPLOAD}/files/${encodeURIComponent(fileId)}?uploadType=media&fields=${FIELDS}`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/octet-stream' }, body: data },
      120_000,
    )
    return toFile(raw)
  }

  async download(fileId: string, onProgress?: (done: number, total: number) => void) {
    const res = await this.request(
      `${API}/files/${encodeURIComponent(fileId)}?alt=media`,
      {},
      60_000,
    )
    if (!res.ok) throw await this.error(res)
    const total = Number(res.headers.get('Content-Length') ?? 0)
    if (!res.body || !onProgress) return res.blob()
    const reader = res.body.getReader()
    const parts: BlobPart[] = []
    let done = 0
    const read = () =>
      new Promise<ReadableStreamReadResult<Uint8Array<ArrayBuffer>>>((resolve, reject) => {
        const timer = setTimeout(() => {
          void reader.cancel().catch(() => {})
          reject(timedOut())
        }, STALL_TIMEOUT)
        reader.read().then(
          (r) => {
            clearTimeout(timer)
            resolve(r)
          },
          (e) => {
            clearTimeout(timer)
            reject(e)
          },
        )
      })
    try {
      for (;;) {
        const { value, done: finished } = await read()
        if (finished) break
        parts.push(value)
        done += value.length
        onProgress(done, total)
      }
    } catch (e) {
      if (e instanceof OfflineError) throw e
      throw new OfflineError('The download was interrupted.')
    }
    return new Blob(parts)
  }

  async trash(fileId: string): Promise<void> {
    const res = await this.request(`${API}/files/${encodeURIComponent(fileId)}?fields=id`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trashed: true }),
    })
    if (!res.ok && res.status !== 404) throw await this.error(res)
  }

  async startResumable(parentId: string, name: string, size: number): Promise<string> {
    const res = await this.request(`${UPLOAD}/files?uploadType=resumable&fields=${FIELDS}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': 'application/octet-stream',
        'X-Upload-Content-Length': String(size),
      },
      body: JSON.stringify({ name, parents: [parentId], mimeType: 'application/octet-stream' }),
    })
    if (!res.ok) throw await this.error(res)
    const location = res.headers.get('Location')
    if (!location) throw new DriveError(0, 'Drive did not return an upload session.')
    return location
  }

  private async resumableResult(res: Response, fallbackOffset: number): Promise<ResumableStatus> {
    if (res.status === 200 || res.status === 201) {
      return { done: true, file: toFile((await res.json()) as RawFile) }
    }
    if (res.status === 308) {
      const range = res.headers.get('Range')
      const match = range && /bytes=0-(\d+)/.exec(range)
      return { done: false, nextOffset: match ? Number(match[1]) + 1 : fallbackOffset }
    }
    throw await this.error(res)
  }

  /**
   * One slice of a resumable upload. XMLHttpRequest instead of fetch: it reports upload progress,
   * so a stalled upload is noticed (no bytes sent for STALL_TIMEOUT) and the UI can show
   * progress within the slice.
   */
  putSlice(
    sessionUrl: string,
    slice: Blob,
    start: number,
    total: number,
    onProgress?: (sentInSlice: number) => void,
  ): Promise<ResumableStatus> {
    const token = this.getToken()
    if (!token) return Promise.reject(new AuthError())
    const end = start + slice.size - 1
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      let stall: ReturnType<typeof setTimeout>
      const arm = () => {
        clearTimeout(stall)
        stall = setTimeout(() => {
          xhr.abort()
          reject(timedOut())
        }, STALL_TIMEOUT)
      }
      xhr.open('PUT', sessionUrl)
      xhr.setRequestHeader('Authorization', `Bearer ${token}`)
      xhr.setRequestHeader('Content-Range', `bytes ${start}-${end}/${total}`)
      xhr.upload.onprogress = (e) => {
        arm()
        onProgress?.(e.loaded)
      }
      xhr.onerror = () => {
        clearTimeout(stall)
        reject(new OfflineError())
      }
      xhr.onload = () => {
        clearTimeout(stall)
        if (xhr.status === 401) {
          this.onAuthExpired()
          reject(new AuthError())
          return
        }
        const headers = new Headers()
        const range = xhr.getResponseHeader('Range')
        if (range) headers.set('Range', range)
        const res = new Response(xhr.status === 308 ? null : xhr.responseText, {
          status: xhr.status,
          headers,
        })
        this.resumableResult(res, end + 1).then(resolve, reject)
      }
      arm()
      xhr.send(slice)
    })
  }

  async queryResumable(sessionUrl: string, total: number) {
    const res = await this.request(sessionUrl, {
      method: 'PUT',
      headers: { 'Content-Range': `bytes */${total}` },
    })
    return this.resumableResult(res, 0)
  }
}
