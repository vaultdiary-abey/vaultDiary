import { describe, expect, it } from 'vitest'
import { blobType, mediaKind } from '../src/media/kind'

describe('media kinds', () => {
  it('picks a viewer from the MIME type, then the file name', () => {
    expect(mediaKind('image/jpeg')).toBe('image')
    expect(mediaKind('image/heic', 'IMG_1.HEIC')).toBe('image')
    expect(mediaKind('video/mp4;codecs=avc1,mp4a')).toBe('video')
    expect(mediaKind('audio/webm;codecs=opus')).toBe('audio')
    expect(mediaKind('application/pdf')).toBe('pdf')
    expect(mediaKind('application/octet-stream', 'scan.PDF')).toBe('pdf')
    expect(mediaKind('', 'voice.m4a')).toBe('audio')
    expect(mediaKind('', 'clip.MOV')).toBe('video')
    expect(mediaKind('application/zip', 'a.zip')).toBe('other')
  })

  it('never renders SVG inline (it can carry scripts)', () => {
    expect(mediaKind('image/svg+xml', 'x.svg')).toBe('other')
    expect(mediaKind('', 'x.svg')).toBe('other')
  })

  it('gives decrypted blobs a usable type', () => {
    expect(blobType('video/webm')).toBe('video/webm')
    expect(blobType('application/octet-stream', 'a.heic')).toBe('image/heic')
    expect(blobType('', 'b.mov')).toBe('video/quicktime')
    expect(blobType('', 'c.xyz')).toBe('application/octet-stream')
  })
})
