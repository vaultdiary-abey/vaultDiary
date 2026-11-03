import type { ListItem } from '../core/session'
import {
  displayTitle,
  excerptOf,
  summaryLocation,
  type Entry,
  type EntrySummary,
} from '../model/entry'

export function itemData(item: ListItem): {
  id: string
  date: string
  createdAt: string
  title: string
  excerpt: string
  mood: Entry['mood']
  attachments: number
  pending: boolean
  /** The location's label, if any. */
  place: string
} {
  if (item.kind === 'entry') {
    const e = item.entry
    return {
      id: e.id,
      date: e.date,
      createdAt: e.createdAt,
      title: displayTitle(e),
      excerpt: excerptOf(e.body, 140),
      mood: e.mood,
      attachments: e.attachments.length,
      pending: false,
      place: summaryLocation(e.location)?.label ?? '',
    }
  }
  const s: EntrySummary = item.summary
  return {
    id: s.id,
    date: s.date,
    createdAt: s.createdAt,
    title: displayTitle({ title: s.title, excerpt: s.excerpt }),
    excerpt: s.excerpt,
    mood: s.mood,
    attachments: s.attachmentCount,
    pending: true,
    place: s.location?.label ?? '',
  }
}
