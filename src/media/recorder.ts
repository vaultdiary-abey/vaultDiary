// In-app recording with MediaRecorder: picks a format the browser can record, saves every
// timeslice to the encrypted RecordingStore as it goes, and enforces a maximum length.
import type { RecordingStore, RecordingWriter } from './recordingStore'

export type RecordKind = 'audio' | 'video'

/**
 * Formats, best first. Apple browsers (Safari on iPhone and Mac, and every iOS browser) record
 * MP4 (H.264/AAC), which plays everywhere. Chrome, Android and Firefox record WebM: Chrome can
 * also record MP4, but its MP4 recorder emits no data until the recording stops, which would
 * defeat saving it as it goes (crash safety). The chosen type is stored with the attachment.
 */
const MP4_VIDEO = ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4']
const WEBM_VIDEO = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
const MP4_AUDIO = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4']
const WEBM_AUDIO = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']

export function isAppleWebKit(
  ua: string = typeof navigator === 'undefined' ? '' : navigator.userAgent,
) {
  if (/iPhone|iPad|iPod/.test(ua)) return true // every iOS browser is WebKit
  return /Safari/.test(ua) && /AppleWebKit/.test(ua) && !/Chrome|Chromium|Edg|OPR|Android/.test(ua)
}

export function mimeCandidates(kind: RecordKind, apple: boolean): string[] {
  const [mp4, webm] = kind === 'video' ? [MP4_VIDEO, WEBM_VIDEO] : [MP4_AUDIO, WEBM_AUDIO]
  return apple ? [...mp4, ...webm] : [...webm, ...mp4]
}

export function pickMimeType(
  kind: RecordKind,
  isTypeSupported: (t: string) => boolean = (t) =>
    typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t),
  apple: boolean = isAppleWebKit(),
): string | null {
  return mimeCandidates(kind, apple).find((t) => isTypeSupported(t)) ?? null
}

export function extensionFor(mime: string, kind: RecordKind): string {
  const type = mime.split(';')[0].trim()
  if (type.endsWith('/mp4')) return kind === 'audio' ? 'm4a' : 'mp4'
  if (type.endsWith('/webm')) return 'webm'
  if (type.endsWith('/ogg')) return 'ogg'
  return kind === 'audio' ? 'm4a' : 'mp4'
}

export function recordingName(kind: RecordKind, mime: string, at: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  const stamp = `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())} ${p(at.getHours())}.${p(at.getMinutes())}.${p(at.getSeconds())}`
  return `${kind === 'audio' ? 'Voice note' : 'Video'} ${stamp}.${extensionFor(mime, kind)}`
}

export function canRecord(): boolean {
  return (
    typeof MediaRecorder !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia
  )
}

/** A user-facing message for getUserMedia / MediaRecorder failures. */
export function mediaErrorMessage(e: unknown, what: string): string {
  const name = (e as { name?: string })?.name
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return `Access to the ${what} was blocked. Allow it for this site in the browser's settings, then try again.`
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return `No ${what} was found on this device.`
  }
  if (name === 'NotReadableError') return `The ${what} is in use by another app.`
  return (e as Error)?.message || `Could not use the ${what}.`
}

export async function openStream(
  kind: RecordKind | 'photo',
  facingMode: 'user' | 'environment',
): Promise<MediaStream> {
  const video = { facingMode, width: { ideal: 1280 }, height: { ideal: 720 } }
  return navigator.mediaDevices.getUserMedia(
    kind === 'audio'
      ? { audio: true }
      : kind === 'photo'
        ? { video: { ...video, width: { ideal: 1920 }, height: { ideal: 1080 } } }
        : { video, audio: true },
  )
}

export function stopStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((t) => t.stop())
}

const TIMESLICE = 1000

export interface ActiveRecording {
  readonly id: string
  readonly mime: string
  /** Stops recording; resolves when everything is stored. */
  stop(): Promise<void>
}

export async function startRecording(options: {
  kind: RecordKind
  stream: MediaStream
  store: RecordingStore
  mk: CryptoKey
  entry: { id: string; date: string }
  maxMs: number
  onProgress: (elapsedMs: number, bytes: number) => void
  onAutoStop: () => void
  onError: (message: string) => void
}): Promise<ActiveRecording> {
  const { kind, stream, store } = options
  const preferred = pickMimeType(kind)
  const recorder = preferred
    ? new MediaRecorder(stream, {
        mimeType: preferred,
        videoBitsPerSecond: kind === 'video' ? 2_500_000 : undefined,
        audioBitsPerSecond: 128_000,
      })
    : new MediaRecorder(stream)
  // Some browsers only report the final type once recording has started.
  const mimeOf = () =>
    recorder.mimeType || preferred || (kind === 'audio' ? 'audio/mp4' : 'video/mp4')
  let writer: RecordingWriter | null = null
  const started = performance.now()
  let bytes = 0
  let stopping: Promise<void> | null = null
  const elapsed = () => performance.now() - started

  const ticker = setInterval(() => {
    options.onProgress(elapsed(), bytes)
    if (elapsed() >= options.maxMs && !stopping) {
      void active.stop()
      options.onAutoStop()
    }
  }, 250)

  const pending: Promise<void>[] = []
  recorder.ondataavailable = (e) => {
    if (!e.data || e.data.size === 0) return
    const ms = elapsed()
    bytes += e.data.size
    const p = (async () => {
      writer ??= await store.create(options.mk, {
        kind,
        mime: mimeOf(),
        entryId: options.entry.id,
        entryDate: options.entry.date,
      })
      await writer.append(new Uint8Array(await e.data.arrayBuffer()), ms)
    })().catch((err: Error) => options.onError(`Could not save the recording: ${err.message}`))
    pending.push(p)
  }
  recorder.onerror = (e) =>
    options.onError(`Recording failed: ${(e as unknown as { error?: Error }).error?.message ?? ''}`)

  // Create the stored record up front so even a very short recording can be recovered.
  writer = await store.create(options.mk, {
    kind,
    mime: preferred ?? (kind === 'audio' ? 'audio/mp4' : 'video/mp4'),
    entryId: options.entry.id,
    entryDate: options.entry.date,
  })
  const id = writer.id
  recorder.start(TIMESLICE)
  await store.setMime(id, mimeOf())

  const active: ActiveRecording = {
    id,
    get mime() {
      return mimeOf()
    },
    stop() {
      stopping ??= (async () => {
        clearInterval(ticker)
        if (recorder.state !== 'inactive') {
          await new Promise<void>((resolve) => {
            recorder.addEventListener('stop', () => resolve(), { once: true })
            recorder.stop()
          })
        }
        await Promise.all(pending)
        await writer?.flushed()
        options.onProgress(elapsed(), bytes)
      })()
      return stopping
    },
  }
  return active
}

/** Takes a still photo from a live camera stream as a JPEG. */
export async function capturePhoto(video: HTMLVideoElement): Promise<Blob> {
  if (!video.videoWidth) {
    // Tapped before the first frame arrived: wait for it briefly.
    await new Promise<void>((resolve) => {
      const done = () => resolve()
      video.addEventListener('loadeddata', done, { once: true })
      setTimeout(done, 3000)
    })
  }
  const w = video.videoWidth
  const h = video.videoHeight
  if (!w || !h) throw new Error('The camera is not ready yet. Try again in a moment.')
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  canvas.getContext('2d')!.drawImage(video, 0, 0, w, h)
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.92))
  canvas.width = 0
  if (!blob) throw new Error('Could not take the photo.')
  return blob
}
