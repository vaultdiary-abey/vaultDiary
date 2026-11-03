// Search filters, applied to entries (and to summaries of entries still downloading).
import { mediaKind, type MediaKind } from '../media/kind'
import type { Entry, EntrySummary, Mood } from '../model/entry'
import { hasTag } from '../model/tags'
import { placeKey } from '../model/location'
import { summaryLocation } from '../model/entry'

export interface Filters {
  /** Inclusive YYYY-MM-DD bounds. */
  from: string | null
  to: string | null
  /** The entry must have all of these. */
  tags: string[]
  /** Any of these moods. */
  moods: Mood[]
  hasAttachments: boolean
  /** Any attachment of one of these kinds. */
  kinds: MediaKind[]
  /** Entries at this place (placeKey of the location's label), from the Places view. */
  place: string | null
}

export const NO_FILTERS: Filters = {
  from: null,
  to: null,
  tags: [],
  moods: [],
  hasAttachments: false,
  kinds: [],
  place: null,
}

export function activeFilterCount(f: Filters): number {
  return (
    (f.from || f.to ? 1 : 0) +
    f.tags.length +
    (f.moods.length ? 1 : 0) +
    (f.hasAttachments ? 1 : 0) +
    (f.kinds.length ? 1 : 0) +
    (f.place ? 1 : 0)
  )
}

export type Searchable =
  { kind: 'entry'; entry: Entry } | { kind: 'summary'; summary: EntrySummary }

export function matchesFilters(item: Searchable, f: Filters): boolean {
  const d = item.kind === 'entry' ? item.entry : item.summary
  if (f.from && d.date < f.from) return false
  if (f.to && d.date > f.to) return false
  if (f.tags.some((t) => !hasTag(d.tags, t))) return false
  if (f.moods.length && (d.mood === null || !f.moods.includes(d.mood))) return false
  if (f.place && placeOf(item) !== f.place) return false
  const count = item.kind === 'entry' ? item.entry.attachments.length : item.summary.attachmentCount
  if (f.hasAttachments && count === 0) return false
  if (f.kinds.length) {
    // Attachment types are only known once the entry itself is downloaded.
    if (item.kind !== 'entry') return false
    if (!item.entry.attachments.some((a) => f.kinds.includes(mediaKind(a.mime, a.name))))
      return false
  }
  return true
}

/** The place key of an entry's (or summary's) location, or '' when it has none. */
export function placeOf(item: Searchable): string {
  const label =
    item.kind === 'entry'
      ? (summaryLocation(item.entry.location)?.label ?? '')
      : (item.summary.location?.label ?? '')
  return label ? placeKey(label) : ''
}

/** Places with how many entries each has, the one with the newest entry first. */
export function placeCounts(
  items: readonly Searchable[],
): { key: string; label: string; count: number; latest: string; country: string }[] {
  const byKey = new Map<
    string,
    { key: string; label: string; count: number; latest: string; country: string }
  >()
  for (const item of items) {
    const d = item.kind === 'entry' ? item.entry : item.summary
    const loc = item.kind === 'entry' ? summaryLocation(item.entry.location) : item.summary.location
    if (!loc?.label) continue
    const key = placeKey(loc.label)
    const stamp = `${d.date}\u0000${d.createdAt}`
    const prev = byKey.get(key)
    if (!prev)
      byKey.set(key, { key, label: loc.label, count: 1, latest: stamp, country: loc.country })
    else {
      prev.count++
      if (stamp > prev.latest)
        Object.assign(prev, { latest: stamp, label: loc.label, country: loc.country })
    }
  }
  return [...byKey.values()]
    .sort((a, b) =>
      a.latest < b.latest ? 1 : a.latest > b.latest ? -1 : a.key.localeCompare(b.key),
    )
    .map((p) => ({ ...p, latest: p.latest.split('\u0000')[0] }))
}
