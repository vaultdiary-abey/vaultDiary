// Can this browser play a video? Asking canPlayType about the file's MIME type isn't enough:
// Chrome says "no" to video/quicktime although it plays H.264 .mov files from iPhones. So the
// codec is read from the MP4/MOV header (the sample description in the "moov" box), and the
// browser is asked about that codec. No transcoding: a video that can't play is offered as a
// download, with a plain explanation.

export type VideoCodec = 'hevc' | 'h264' | 'av1' | 'vp9'

const FOURCC: Record<string, VideoCodec> = {
  hvc1: 'hevc',
  hev1: 'hevc',
  avc1: 'h264',
  avc3: 'h264',
  av01: 'av1',
  vp09: 'vp9',
}

const MAX_MOOV = 16 * 1024 * 1024
/** Boxes an MP4/MOV file can start with. */
const TOP_LEVEL = new Set(['ftyp', 'wide', 'free', 'skip', 'mdat', 'moov', 'pdin'])
const MAX_BOXES = 64

type Read = (offset: number, length: number) => Promise<Uint8Array>

function u32(b: Uint8Array, at: number): number {
  return ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0
}

function type(b: Uint8Array, at: number): string {
  return String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3])
}

/**
 * The video codec of an MP4/MOV file, from its sample description, or null if it isn't an
 * MP4/MOV file or the codec isn't one we ask browsers about. Reads only box headers and the
 * "moov" box (wherever it is in the file).
 */
export async function sniffVideoCodec(read: Read, size: number): Promise<VideoCodec | null> {
  let offset = 0
  for (let n = 0; n < MAX_BOXES && offset + 8 <= size; n++) {
    const head = await read(offset, 16)
    if (head.length < 8) return null
    let boxSize = u32(head, 0)
    const boxType = type(head, 4)
    let headerLength = 8
    // Not an MP4/MOV file (e.g. WebM): nothing to check here.
    if (n === 0 && !TOP_LEVEL.has(boxType)) return null
    if (boxSize === 1) {
      if (head.length < 16) return null
      boxSize = u32(head, 8) * 2 ** 32 + u32(head, 12)
      headerLength = 16
    } else if (boxSize === 0) {
      boxSize = size - offset
    }
    if (boxSize < headerLength) return null
    if (boxType === 'moov') {
      const moov = await read(offset, Math.min(boxSize, MAX_MOOV))
      return codecInMoov(moov)
    }
    offset += boxSize
  }
  return null
}

/** Finds the first video sample entry ("hvc1", "avc1", …) inside an "stsd" box. */
export function codecInMoov(moov: Uint8Array): VideoCodec | null {
  for (let i = 4; i + 8 <= moov.length; i++) {
    if (type(moov, i) !== 'stsd') continue
    // stsd: size, "stsd", version/flags (4), entry count (4), then entries (size, fourcc, …)
    const entry = i + 4 + 8
    if (entry + 8 > moov.length) continue
    const codec = FOURCC[type(moov, entry + 4)]
    if (codec) return codec
  }
  return null
}

const PROBES: Record<VideoCodec, string[]> = {
  hevc: ['video/mp4; codecs="hvc1.1.6.L93.B0"', 'video/mp4; codecs="hev1.1.6.L93.B0"'],
  h264: ['video/mp4; codecs="avc1.42E01E"', 'video/mp4; codecs="avc1.640028"'],
  av1: ['video/mp4; codecs="av01.0.05M.08"'],
  vp9: ['video/mp4; codecs="vp09.00.10.08"'],
}

/** Does this browser say it can play this codec? (canPlayType: "" means no.) */
export function browserPlays(codec: VideoCodec): boolean {
  if (typeof document === 'undefined') return true
  const video = document.createElement('video')
  return PROBES[codec].some((t) => video.canPlayType(t) !== '')
}

/** A plain-words explanation for a video this browser can't play. */
export function cantPlayMessage(codec: VideoCodec | null): string {
  if (codec === 'hevc') {
    return (
      "This browser can't play this video. It was recorded in HEVC (H.265), the format " +
      'iPhones use by default, which many browsers on Windows, Android and Linux can’t play. ' +
      'Download it to watch it in another app (for example VLC), or open it on your iPhone or Mac.'
    )
  }
  const name = codec === 'h264' ? 'H.264' : codec === 'av1' ? 'AV1' : codec === 'vp9' ? 'VP9' : ''
  return (
    `This browser can't play this video${name ? ` (${name})` : ''}. ` +
    'Download it to watch it in another app.'
  )
}

/** null = probably playable (or unknown); otherwise the codec this browser can't play. */
export async function unplayableCodec(read: Read, size: number): Promise<VideoCodec | null> {
  try {
    const codec = await sniffVideoCodec(read, size)
    return codec && !browserPlays(codec) ? codec : null
  } catch {
    return null
  }
}
