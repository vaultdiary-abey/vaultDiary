// Makes a small JPEG preview on the device: photos scaled to fit 320 px, videos from a frame at
// about 1 s. Returns null when the browser can't decode the file (e.g. HEIC outside Apple).
import { mediaKind } from './kind'

export const THUMB_MAX = 320
const VIDEO_TIMEOUT = 10_000

export function thumbnailable(mime: string, name: string): 'image' | 'video' | null {
  const kind = mediaKind(mime, name)
  return kind === 'image' || kind === 'video' ? kind : null
}

export function fit(w: number, h: number, max = THUMB_MAX): [number, number] {
  const scale = Math.min(1, max / Math.max(w, h))
  return [Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale))]
}

async function toJpeg(
  source: CanvasImageSource,
  w: number,
  h: number,
  max = THUMB_MAX,
  quality = 0.8,
): Promise<Blob | null> {
  if (!w || !h) return null
  const [tw, th] = fit(w, h, max)
  const canvas = document.createElement('canvas')
  canvas.width = tw
  canvas.height = th
  const g = canvas.getContext('2d')
  if (!g) return null
  g.imageSmoothingQuality = 'high'
  g.drawImage(source, 0, 0, tw, th)
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', quality))
  canvas.width = 0
  return blob
}

/**
 * Decodes a photo and re-encodes it as a JPEG whose longest side is at most `max` px. Returns
 * null when this browser can't decode it (e.g. HEIC outside Apple devices).
 */
export async function scaleImageToJpeg(
  blob: Blob,
  max: number,
  quality: number,
): Promise<Blob | null> {
  if (typeof document === 'undefined') return null
  // createImageBitmap applies the photo's EXIF rotation; <img> is the fallback (Safari decodes
  // HEIC there).
  try {
    const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' })
    try {
      return await toJpeg(bitmap, bitmap.width, bitmap.height, max, quality)
    } finally {
      bitmap.close()
    }
  } catch {
    // fall through
  }
  const url = URL.createObjectURL(blob)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    return await toJpeg(img, img.naturalWidth, img.naturalHeight, max, quality)
  } catch {
    return null
  } finally {
    URL.revokeObjectURL(url)
  }
}

function imageThumb(blob: Blob): Promise<Blob | null> {
  return scaleImageToJpeg(blob, THUMB_MAX, 0.8)
}

function once(target: EventTarget, events: string[], ms: number): Promise<string> {
  return new Promise((resolve) => {
    const done = (name: string) => {
      clearTimeout(timer)
      for (const e of events) target.removeEventListener(e, handlers[e])
      resolve(name)
    }
    const handlers: Record<string, () => void> = {}
    for (const e of events) {
      handlers[e] = () => done(e)
      target.addEventListener(e, handlers[e])
    }
    const timer = setTimeout(() => done('timeout'), ms)
  })
}

async function videoThumb(blob: Blob): Promise<Blob | null> {
  const url = URL.createObjectURL(blob)
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.preload = 'auto'
  try {
    video.src = url
    if ((await once(video, ['loadeddata', 'error'], VIDEO_TIMEOUT)) !== 'loadeddata') return null
    const duration = Number.isFinite(video.duration) ? video.duration : 2
    const at = Math.min(1, duration / 2)
    if (at > 0.05) {
      video.currentTime = at
      await once(video, ['seeked', 'error'], VIDEO_TIMEOUT)
    }
    return await toJpeg(video, video.videoWidth, video.videoHeight)
  } catch {
    return null
  } finally {
    video.removeAttribute('src')
    video.load()
    URL.revokeObjectURL(url)
  }
}

export async function makeThumbnail(blob: Blob, kind: 'image' | 'video'): Promise<Blob | null> {
  if (typeof document === 'undefined') return null
  return kind === 'image' ? imageThumb(blob) : videoThumb(blob)
}
