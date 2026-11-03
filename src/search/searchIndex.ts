// On-device full-text search (MiniSearch, bundled) over titles, bodies, tags and attachment
// names. Kept up to date incrementally as entries change; can be saved to and restored from an
// encrypted local cache (see searchCache.ts) so a large diary doesn't have to be re-indexed on
// every unlock.
import MiniSearch from 'minisearch'
import { excerptOf } from '../model/entry'
import { locationLabel, parseLocation } from '../model/location'
import type { Searchable } from './filter'
import { normalizeTerm, plainText, tokenize } from './text'

const FIELDS = ['title', 'body', 'tags', 'files', 'place'] as const
/** 2: locations (revision 4) are indexed too. */
export const INDEX_VERSION = 2

interface Doc {
  id: string
  title: string
  body: string
  tags: string
  files: string
  place: string
}

function options() {
  return {
    idField: 'id',
    fields: [...FIELDS],
    tokenize,
    processTerm: (t: string) => normalizeTerm(t) || null,
    searchOptions: {
      boost: { title: 3, tags: 3, files: 2, place: 2 },
      prefix: true,
      fuzzy: (term: string) => (term.length >= 5 ? 0.2 : false),
      combineWith: 'AND' as const,
    },
  }
}

/** A location's label, city, region and country, as searchable text. */
function placeText(raw: unknown): string {
  const l = parseLocation(raw)
  return l ? [locationLabel(l), l.city, l.region, l.country].join(' ') : ''
}

export function docFor(item: Searchable): Doc {
  if (item.kind === 'entry') {
    const e = item.entry
    return {
      id: e.id,
      title: e.title,
      body: plainText(e.body),
      tags: e.tags.join(' '),
      files: e.attachments.map((a) => a.name).join(' '),
      place: placeText(e.location),
    }
  }
  const s = item.summary
  return {
    id: s.id,
    title: s.title,
    body: excerptOf(s.excerpt),
    tags: s.tags.join(' '),
    files: '',
    place: s.location ? [s.location.label, s.location.city, s.location.country].join(' ') : '',
  }
}

/** What an item's indexed version depends on (summaries are indexed until downloaded). */
export function versionOf(item: Searchable): string {
  return item.kind === 'entry' ? `e:${item.entry.updatedAt}` : `s:${item.summary.updatedAt}`
}

export interface SearchHit {
  id: string
  score: number
  /** Normalised query words that matched, for highlighting. */
  terms: string[]
}

export class SearchIndex {
  private mini: MiniSearch<Doc>
  /** id → version that is in the index. */
  private versions = new Map<string, string>()

  constructor() {
    this.mini = new MiniSearch<Doc>(options())
  }

  get size(): number {
    return this.versions.size
  }

  /** Brings the index in line with `items`; returns how many documents changed. */
  update(items: Iterable<Searchable>): number {
    const seen = new Set<string>()
    let changed = 0
    for (const item of items) {
      const id = item.kind === 'entry' ? item.entry.id : item.summary.id
      seen.add(id)
      const v = versionOf(item)
      if (this.versions.get(id) === v) continue
      if (this.versions.has(id)) this.mini.discard(id)
      this.mini.add(docFor(item))
      this.versions.set(id, v)
      changed++
    }
    for (const id of [...this.versions.keys()]) {
      if (!seen.has(id)) {
        this.mini.discard(id)
        this.versions.delete(id)
        changed++
      }
    }
    return changed
  }

  search(query: string): SearchHit[] {
    if (!query.trim()) return []
    const terms = tokenize(query).map(normalizeTerm).filter(Boolean)
    return this.mini.search(query).map((r) => ({
      id: String(r.id),
      score: r.score,
      terms: [...new Set([...terms, ...r.terms])],
    }))
  }

  toJSON(): { v: number; versions: [string, string][]; index: unknown } {
    return { v: INDEX_VERSION, versions: [...this.versions], index: this.mini.toJSON() }
  }

  static fromJSON(data: unknown): SearchIndex | null {
    const d = data as ReturnType<SearchIndex['toJSON']>
    if (!d || d.v !== INDEX_VERSION || !Array.isArray(d.versions)) return null
    try {
      const idx = new SearchIndex()
      idx.mini = MiniSearch.loadJS<Doc>(d.index as never, options())
      idx.versions = new Map(d.versions)
      return idx
    } catch {
      return null
    }
  }
}
