import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { randomBytes, randomId } from '../src/crypto/bytes'
import { importMasterKey } from '../src/crypto/container'
import { newEntry, type Entry, type EntrySummary } from '../src/model/entry'
import { moodStats, streaks, yearGrid } from '../src/model/stats'
import {
  addTag,
  normalizeTag,
  removeTag,
  renameTag,
  suggestTags,
  tagCounts,
  tagKey,
} from '../src/model/tags'
import { matchesFilters, NO_FILTERS, type Searchable } from '../src/search/filter'
import { loadSearchCache, saveSearchCache } from '../src/search/searchCache'
import { SearchIndex } from '../src/search/searchIndex'
import { plainText, snippet } from '../src/search/text'
import { KV, VaultDB } from '../src/storage/db'

const e = (patch: Partial<Entry>): Searchable => ({
  kind: 'entry',
  entry: { ...newEntry(patch.date ?? '2026-10-01'), ...patch },
})

describe('tags', () => {
  it('normalises and compares case- and accent-insensitively', () => {
    expect(normalizeTag('  #Café   time ')).toBe('Café time')
    expect(normalizeTag('#')).toBe('')
    expect(normalizeTag('x'.repeat(100))).toHaveLength(40)
    expect(tagKey('CAFÉ')).toBe(tagKey('cafe'))
    expect(addTag(['Cafe'], 'café')).toEqual(['Cafe'])
    expect(addTag(['a'], ' b ')).toEqual(['a', 'b'])
    expect(removeTag(['Work', 'home'], 'work')).toEqual(['home'])
  })

  it('renames, merging with an existing tag', () => {
    expect(renameTag(['work', 'gym'], 'Work', 'Job')).toEqual(['Job', 'gym'])
    expect(renameTag(['work', 'job'], 'work', 'Job')).toEqual(['Job'])
    expect(renameTag(['gym'], 'work', 'job')).toEqual(['gym'])
  })

  it('counts tags per entry and suggests completions', () => {
    const counts = tagCounts([
      { tags: ['Work', 'gym'] },
      { tags: ['work'] },
      { tags: ['work', 'Work'] },
      { tags: ['travel'] },
    ])
    expect(counts).toEqual([
      { tag: 'work', count: 3 },
      { tag: 'gym', count: 1 },
      { tag: 'travel', count: 1 },
    ])
    expect(suggestTags(counts, 'w', [])).toEqual(['work'])
    expect(suggestTags(counts, 'av', [])).toEqual(['travel'])
    expect(suggestTags(counts, '', ['gym'])).toEqual(['work', 'travel'])
  })
})

describe('streaks and the year heatmap', () => {
  it('counts the current streak up to today (or yesterday) and the longest', () => {
    const days = [
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
      '2026-10-10',
      '2026-10-30',
      '2026-10-31',
    ]
    expect(streaks(days, '2026-10-31')).toEqual({
      current: 2,
      longest: 3,
      longestEnd: '2026-10-03',
    })
    // No entry yet today: yesterday's run still counts.
    expect(streaks(days, '2026-11-01').current).toBe(2)
    expect(streaks(days, '2026-11-02').current).toBe(0)
    expect(streaks([], '2026-11-02')).toEqual({ current: 0, longest: 0, longestEnd: null })
  })

  it('crosses months, years and DST changes', () => {
    const run = ['2025-12-30', '2025-12-31', '2026-01-01', '2026-03-28', '2026-03-29', '2026-03-30']
    expect(streaks(run, '2026-03-30')).toMatchObject({ current: 3, longest: 3 })
  })

  it('lays out a year in Monday-first weeks with levels', () => {
    const grid = yearGrid(
      2026,
      new Map([
        ['2026-01-01', 1],
        ['2026-06-15', 5],
      ]),
    )
    expect(grid.every((w) => w.length === 7)).toBe(true)
    const cells = grid.flat().filter(Boolean)
    expect(cells).toHaveLength(365)
    expect(grid[0][3]).toMatchObject({ date: '2026-01-01', level: 1 }) // a Thursday
    expect(cells.find((c) => c!.date === '2026-06-15')!.level).toBe(3)
  })

  it('mood statistics for a period', () => {
    const items = [
      { date: '2026-01-01', mood: 5 as const },
      { date: '2026-01-02', mood: 3 as const },
      { date: '2026-01-03', mood: null },
      { date: '2025-12-31', mood: 1 as const },
    ]
    const s = moodStats(items, '2026-01-01', '2026-12-31')
    expect(s.rated).toBe(2)
    expect(s.unrated).toBe(1)
    expect(s.average).toBe(4)
    expect(s.counts.find((c) => c.mood === 5)!.count).toBe(1)
  })
})

describe('search', () => {
  const docs = [
    e({
      id: randomId(),
      title: 'Morning run',
      body: 'Ran by the **lake**. Café après.',
      tags: ['Sport'],
    }),
    e({
      id: randomId(),
      title: 'Dinner',
      body: 'Pasta with friends',
      date: '2026-10-05',
      mood: 5,
      attachments: [{ fileId: randomId(), name: 'IMG_lake.jpg', mime: 'image/jpeg', size: 1 }],
    }),
    e({
      id: randomId(),
      title: 'Work',
      body: 'Long meeting about budgets',
      tags: ['work'],
      mood: 2,
    }),
  ]

  it('finds words in titles, bodies, tags and attachment names; prefix, accents, typos', () => {
    const idx = new SearchIndex()
    expect(idx.update(docs)).toBe(3)
    const ids = (q: string) => idx.search(q).map((h) => h.id)
    const id = (i: number) => (docs[i] as { entry: Entry }).entry.id
    expect(ids('lake')).toEqual(expect.arrayContaining([id(0), id(1)])) // body + file name
    expect(ids('cafe')).toEqual([id(0)]) // accent-insensitive
    expect(ids('meet')).toEqual([id(2)]) // prefix
    expect(ids('budgts')).toEqual([id(2)]) // a missing letter
    expect(ids('sport')).toEqual([id(0)]) // tag
    expect(ids('lake pasta')).toEqual([id(1)]) // all words must match
    expect(ids('')).toEqual([])
  })

  it('updates incrementally and survives an encrypted cache round trip', async () => {
    const idx = new SearchIndex()
    idx.update(docs)
    expect(idx.update(docs)).toBe(0)
    const edited = e({ ...(docs[2] as { entry: Entry }).entry, body: 'Quiet day', updatedAt: 'z' })
    expect(idx.update([docs[0], docs[1], edited])).toBe(1)
    expect(idx.search('budgets')).toEqual([])
    expect(idx.update([docs[0]])).toBe(2) // two removed

    const db = new VaultDB(`search-${randomId()}`)
    const mk = await importMasterKey(randomBytes(32))
    await saveSearchCache(db, mk, idx)
    const stored = await db.getKv<Uint8Array>(KV.searchCache)
    expect(Buffer.from(stored!).includes(Buffer.from('lake'))).toBe(false) // encrypted
    expect(Buffer.from(stored!.subarray(0, 4)).toString()).toBe('VDV1')
    const restored = (await loadSearchCache(db, mk))!
    expect(restored.size).toBe(1)
    expect(restored.search('lake').map((h) => h.id)).toEqual([
      (docs[0] as { entry: Entry }).entry.id,
    ])
    expect(restored.update([docs[0]])).toBe(0)
    // Another vault's key can't read it; it is dropped and rebuilt.
    expect(await loadSearchCache(db, await importMasterKey(randomBytes(32)))).toBeNull()
    expect(await db.getKv(KV.searchCache)).toBeUndefined()
  })

  it('indexes summaries of entries still downloading', () => {
    const summary: EntrySummary = {
      id: randomId(),
      date: '2026-01-01',
      createdAt: '',
      updatedAt: 'a',
      title: 'Old trip',
      mood: null,
      tags: ['travel'],
      attachmentCount: 2,
      excerpt: 'Snow in the mountains',
    }
    const idx = new SearchIndex()
    idx.update([{ kind: 'summary', summary }])
    expect(idx.search('mountains').map((h) => h.id)).toEqual([summary.id])
  })

  it('filters by dates, tags, moods and attachments', () => {
    const f = (patch: Partial<typeof NO_FILTERS>) =>
      docs.filter((d) => matchesFilters(d, { ...NO_FILTERS, ...patch }))
    expect(f({ from: '2026-10-02' })).toEqual([docs[1]])
    expect(f({ to: '2026-10-01' })).toHaveLength(2)
    expect(f({ tags: ['WORK'] })).toEqual([docs[2]])
    expect(f({ moods: [5, 4] })).toEqual([docs[1]])
    expect(f({ hasAttachments: true })).toEqual([docs[1]])
    expect(f({ kinds: ['image'] })).toEqual([docs[1]])
    expect(f({ kinds: ['video'] })).toEqual([])
  })

  it('makes plain text and highlighted snippets', () => {
    expect(plainText('# Hi\n\n**bold** [link](http://x) ![pic](a.png)')).toBe('Hi bold link pic')
    const s = snippet('We walked to the lake and swam.', ['lake'])!
    expect(s.parts.filter((p) => p.match).map((p) => p.text)).toEqual(['lake'])
    expect(snippet('nothing here', ['lake'])).toBeNull()
  })
})
