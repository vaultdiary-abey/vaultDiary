// Search filters, applied to entries (and to summaries of entries still downloading).
import { mediaKind, type MediaKind } from '../media/kind'
import type { Entry, EntrySummary, Mood } from '../model/entry'
import { hasTag } from '../model/tags'

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
}

export const NO_FILTERS: Filters = {
  from: null,
  to: null,
  tags: [],
  moods: [],
  hasAttachments: false,
  kinds: [],
}

export function activeFilterCount(f: Filters): number {
  return (
    (f.from || f.to ? 1 : 0) +
    f.tags.length +
    (f.moods.length ? 1 : 0) +
    (f.hasAttachments ? 1 : 0) +
    (f.kinds.length ? 1 : 0)
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
