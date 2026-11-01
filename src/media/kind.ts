// What kind of viewer an attachment gets, from its MIME type and file name.

export type MediaKind = 'image' | 'audio' | 'video' | 'pdf' | 'other'

/** Above this, the app warns before decrypting a file into memory (streaming is Phase 3). */
export const LARGE_FILE = 200 * 1024 * 1024

const EXT: Record<string, MediaKind> = {
  jpg: 'image',
  jpeg: 'image',
  png: 'image',
  gif: 'image',
  webp: 'image',
  avif: 'image',
  heic: 'image',
  heif: 'image',
  bmp: 'image',
  svg: 'other', // never rendered inline: SVG can carry scripts and links
  mp3: 'audio',
  m4a: 'audio',
  aac: 'audio',
  wav: 'audio',
  ogg: 'audio',
  oga: 'audio',
  opus: 'audio',
  flac: 'audio',
  mp4: 'video',
  m4v: 'video',
  mov: 'video',
  webm: 'video',
  pdf: 'pdf',
}

export function mediaKind(mime: string, name = ''): MediaKind {
  const type = mime.split(';')[0].trim().toLowerCase()
  if (type === 'image/svg+xml') return 'other'
  if (type === 'application/pdf') return 'pdf'
  if (type.startsWith('image/')) return 'image'
  if (type.startsWith('audio/')) return 'audio'
  if (type.startsWith('video/')) return 'video'
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase()
  return (ext && EXT[ext]) || 'other'
}

/** The MIME type to give the decrypted Blob, so <img>/<video> and downloads behave. */
export function blobType(mime: string, name = ''): string {
  if (mime && mime !== 'application/octet-stream') return mime
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? ''
  const guess: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    heic: 'image/heic',
    heif: 'image/heif',
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    webm: 'video/webm',
    pdf: 'application/pdf',
  }
  return guess[ext] ?? 'application/octet-stream'
}
