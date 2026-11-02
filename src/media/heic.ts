// HEIC photos (the iPhone's default format). Safari can decode them; most other browsers can't.
// Where a browser can, the app also makes a JPEG "viewing copy" (FORMAT.md revision 3,
// attachment field viewCopyFileId) so other browsers can show the photo. The original is
// always kept.
import { fromBase64 } from '../crypto/bytes'
import { scaleImageToJpeg } from './thumbnail'

/** Longest side of a viewing copy, and its JPEG quality. */
export const VIEW_COPY_MAX = 4096
export const VIEW_COPY_QUALITY = 0.9

export function isHeic(mime: string, name = ''): boolean {
  const type = mime.split(';')[0].trim().toLowerCase()
  if (type === 'image/heic' || type === 'image/heif') return true
  if (type.startsWith('image/heic-') || type.startsWith('image/heif-')) return true
  return /\.(heic|heif)$/i.test(name)
}

/** A 16×16 HEIC image (467 bytes) used to find out whether this browser can decode HEIC. */
const PROBE =
  'AAAAHGZ0eXBoZWljAAAAAG1pZjFoZWljbWlhZgAAAXxtZXRhAAAAAAAAACFoZGxyAAAAAAAAAABwaWN0AAAAAAAAAAAAAAAAAAAAACJpbG9jAAAAAERAAAEAAQAAAAABoAABAAAAAAAAADMAAAAjaWluZgAAAAAAAQAAABVpbmZlAgAAAAABAABodmMxAAAAAA5waXRtAAAAAAABAAAA/GlwcnAAAADcaXBjbwAAAHVodmNDAQNwAAAAkAAAAAAAHvAA/P34+AAADwNgAAEAGEABDAH//wNwAAADAJAAAAMAAAMAHroCQGEAAQApQgEBA3AAAAMAkAAAAwAAAwAeoCCBBZbqrprm4CGgwIAAAAyAAAADAIRiAAEABkQBwXPBiQAAABNjb2xybmNseAABAA0ABoAAAAAUaXNwZQAAAAAAAABAAAAAQAAAAChjbGFwAAAAEAAAAAEAAAAQAAAAAf///9AAAAAC////0AAAAAIAAAAQcGl4aQAAAAADCAgIAAAAGGlwbWEAAAAAAAAAAQABBYECAwWEAAAAO21kYXQAAAAvKAGvEyFkY0D4EPdmoWCFf+ork/4G7HpzshHQwNIggJtASJNdUAsWEICHdqVW3Pg='

let probe: Promise<boolean> | null = null

/** Can this browser decode HEIC photos? Checked once per page load, without any download. */
export function canDecodeHeic(): Promise<boolean> {
  probe ??= (async () => {
    if (typeof document === 'undefined') return false
    const blob = new Blob([fromBase64(PROBE)], { type: 'image/heic' })
    try {
      const bitmap = await createImageBitmap(blob)
      const ok = bitmap.width === 16
      bitmap.close()
      if (ok) return true
    } catch {
      // try <img>
    }
    const url = URL.createObjectURL(blob)
    try {
      const img = new Image()
      img.src = url
      await img.decode()
      return img.naturalWidth === 16
    } catch {
      return false
    } finally {
      URL.revokeObjectURL(url)
    }
  })()
  return probe
}

/** A JPEG viewing copy of a HEIC photo, or null when this browser can't decode it. */
export function makeViewCopy(heic: Blob): Promise<Blob | null> {
  return scaleImageToJpeg(heic, VIEW_COPY_MAX, VIEW_COPY_QUALITY)
}

/** File name of a viewing copy in exports: "IMG_0042.HEIC" → "IMG_0042-view.jpg". */
export function viewCopyName(name: string): string {
  return `${name.replace(/\.[^.]*$/, '') || 'photo'}-view.jpg`
}
