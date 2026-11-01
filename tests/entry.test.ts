import { describe, expect, it } from 'vitest'
import { randomId } from '../src/crypto/bytes'
import { parseEntry } from '../src/model/entry'

describe('parseEntry', () => {
  const id = randomId()
  const fileId = randomId()
  const raw = {
    id,
    date: '2026-11-01',
    createdAt: '2026-11-01T08:00:00.000Z',
    updatedAt: '2026-11-01T08:00:00.000Z',
    title: 'Newer writer',
    body: 'text',
    tags: ['a'],
    mood: 3,
    location: { lat: 1, lon: 2 },
    attachments: [
      {
        fileId,
        name: 'clip.mp4',
        mime: 'video/mp4',
        size: 10,
        thumbFileId: randomId(),
        durationMs: 1234,
      },
    ],
  }

  it('keeps unknown entry and attachment fields so newer versions lose nothing', () => {
    const e = parseEntry(JSON.parse(JSON.stringify(raw)), id)
    expect(e).toEqual(raw)
    expect(JSON.parse(JSON.stringify(e))).toEqual(raw)
  })

  it('still normalises known fields', () => {
    const e = parseEntry(
      { ...raw, mood: 9, tags: ['x', 4], attachments: [{ fileId, size: 'big', extra: 1 }, {}] },
      id,
    )
    expect(e.mood).toBeNull()
    expect(e.tags).toEqual(['x'])
    expect(e.attachments).toEqual([
      { fileId, name: 'file', mime: 'application/octet-stream', size: 0, extra: 1 },
    ])
  })
})
