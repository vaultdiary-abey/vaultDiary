export interface DriveFile {
  id: string
  name: string
  size: number
  /** Content checksum; changes whenever the bytes change. */
  md5: string | null
  modifiedTime: string
  mimeType: string
  appProperties?: Record<string, string>
}

export type ResumableStatus = { done: true; file: DriveFile } | { done: false; nextOffset: number }

export interface About {
  email: string | null
  name: string | null
  usage: number | null
  limit: number | null
}

/** The subset of Drive v3 the app uses. Implemented by HttpDrive and FakeDrive. */
export interface DriveClient {
  about(): Promise<About>
  findFolders(query: { appProperty?: [string, string]; name?: string }): Promise<DriveFile[]>
  createFolder(
    name: string,
    parentId: string | null,
    appProperties?: Record<string, string>,
  ): Promise<DriveFile>
  /** All non-trashed children of a folder (every page). */
  list(parentId: string): Promise<DriveFile[]>
  findByName(parentId: string, name: string): Promise<DriveFile[]>
  /** One-request multipart upload, for small files (entries, index, vault.json). */
  createFile(parentId: string, name: string, data: Blob): Promise<DriveFile>
  updateFile(fileId: string, data: Blob): Promise<DriveFile>
  download(fileId: string, onProgress?: (done: number, total: number) => void): Promise<Blob>
  /** Bytes start…end (inclusive) of a file, with an HTTP Range request (streaming playback). */
  downloadRange(fileId: string, start: number, end: number): Promise<Uint8Array<ArrayBuffer>>
  /** Moves to Drive's trash (recoverable there for 30 days). */
  trash(fileId: string): Promise<void>
  startResumable(parentId: string, name: string, size: number): Promise<string>
  putSlice(
    sessionUrl: string,
    slice: Blob,
    start: number,
    total: number,
    onProgress?: (sentInSlice: number) => void,
  ): Promise<ResumableStatus>
  queryResumable(sessionUrl: string, total: number): Promise<ResumableStatus>
}

/** No valid Google token: the user must tap "Continue" to sign in again. */
export class AuthError extends Error {
  constructor(message = 'Google sign-in has expired.') {
    super(message)
    this.name = 'AuthError'
  }
}

/** The request never reached Google (offline, DNS, CORS, aborted). */
export class OfflineError extends Error {
  constructor(message = 'You appear to be offline.') {
    super(message)
    this.name = 'OfflineError'
  }
}

export class DriveError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'DriveError'
    this.status = status
  }
  get retryable(): boolean {
    return this.status === 429 || this.status === 403 || this.status >= 500
  }
}

export const FOLDER_MIME = 'application/vnd.google-apps.folder'
/** Drive requires resumable slices to be multiples of 256 KiB (except the last). */
export const UPLOAD_SLICE = 8 * 1024 * 1024
