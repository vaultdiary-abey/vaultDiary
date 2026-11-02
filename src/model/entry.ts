import { isId, randomId } from '../crypto/bytes'
import { FormatError } from '../crypto/errors'

export interface Attachment {
  fileId: string
  name: string
  mime: string
  size: number
  /** files/<id>.vdf holding a small JPEG preview (FORMAT.md revision 2). Optional. */
  thumbFileId?: string
  /** Fields written by newer versions are kept unchanged. */
  [field: string]: unknown
}

/** 1 = awful … 5 = great, or null when not set. */
export type Mood = 1 | 2 | 3 | 4 | 5

export interface Entry {
  id: string
  /** Calendar day the entry belongs to, in the writer's local time zone. */
  date: string
  createdAt: string
  updatedAt: string
  title: string
  /** Markdown. */
  body: string
  tags: string[]
  mood: Mood | null
  attachments: Attachment[]
}

export const MOODS: { value: Mood; emoji: string; label: string }[] = [
  { value: 1, emoji: '😞', label: 'Awful' },
  { value: 2, emoji: '🙁', label: 'Bad' },
  { value: 3, emoji: '😐', label: 'Okay' },
  { value: 4, emoji: '🙂', label: 'Good' },
  { value: 5, emoji: '😄', label: 'Great' },
]

export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export function localDate(d: Date = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function newEntry(date: string = localDate(), now: Date = new Date()): Entry {
  const iso = now.toISOString()
  return {
    id: randomId(),
    date,
    createdAt: iso,
    updatedAt: iso,
    title: '',
    body: '',
    tags: [],
    mood: null,
    attachments: [],
  }
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

/** Validates decrypted entry JSON. Unknown fields are kept so newer versions don't lose data. */
export function parseEntry(raw: unknown, expectedId?: string): Entry {
  const r = raw as Record<string, unknown>
  if (!r || typeof r !== 'object') throw new FormatError('Entry is not an object.')
  if (!isId(r.id)) throw new FormatError('Entry has an invalid id.')
  if (expectedId && r.id !== expectedId) throw new FormatError('Entry id does not match its file.')
  if (typeof r.date !== 'string' || !DATE_PATTERN.test(r.date)) {
    throw new FormatError('Entry has an invalid date.')
  }
  const mood = r.mood
  const attachments = Array.isArray(r.attachments) ? r.attachments : []
  return {
    ...r,
    id: r.id,
    date: r.date,
    createdAt: str(r.createdAt),
    updatedAt: str(r.updatedAt),
    title: str(r.title),
    body: str(r.body),
    tags: Array.isArray(r.tags) ? r.tags.filter((t): t is string => typeof t === 'string') : [],
    mood: typeof mood === 'number' && [1, 2, 3, 4, 5].includes(mood) ? (mood as Mood) : null,
    attachments: attachments
      .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object' && isId(a.fileId))
      .map((a) => ({
        ...a,
        fileId: a.fileId as string,
        name: str(a.name, 'file'),
        mime: str(a.mime, 'application/octet-stream'),
        size: typeof a.size === 'number' ? a.size : 0,
      })),
  }
}

/** Sort newest first: by date, then by creation time. */
export function compareEntriesDesc(a: Entry | EntrySummary, b: Entry | EntrySummary): number {
  if (a.date !== b.date) return a.date < b.date ? 1 : -1
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1
  return a.id < b.id ? 1 : -1
}

export function displayTitle(e: { title: string; body?: string; excerpt?: string }): string {
  if (e.title.trim()) return e.title.trim()
  const text = (e.body ?? e.excerpt ?? '').replace(/[#>*_`~[\]()!-]/g, ' ').trim()
  const firstLine = text.split('\n').find((l) => l.trim()) ?? ''
  return Array.from(firstLine.trim()).slice(0, 60).join('').trim() || 'Untitled'
}

export function excerptOf(body: string, length = 160): string {
  const plain = body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~|-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return plain.length > length ? plain.slice(0, length - 1) + '…' : plain
}

export interface EntrySummary {
  id: string
  date: string
  createdAt: string
  updatedAt: string
  title: string
  mood: Mood | null
  tags: string[]
  attachmentCount: number
  excerpt: string
}

export function summarise(e: Entry): EntrySummary {
  return {
    id: e.id,
    date: e.date,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
    title: e.title,
    mood: e.mood,
    tags: e.tags,
    attachmentCount: e.attachments.length,
    excerpt: excerptOf(e.body),
  }
}

export interface IndexFile {
  v: 1
  generatedAt: string
  entries: EntrySummary[]
}

export function buildIndex(entries: Iterable<Entry>): IndexFile {
  return {
    v: 1,
    generatedAt: new Date().toISOString(),
    entries: [...entries].map(summarise).sort(compareEntriesDesc),
  }
}

export function parseIndex(raw: unknown): IndexFile {
  const r = raw as Partial<IndexFile>
  if (!r || r.v !== 1 || !Array.isArray(r.entries)) throw new FormatError('Invalid index file.')
  return {
    v: 1,
    generatedAt: str(r.generatedAt),
    entries: r.entries.filter((e) => isId(e?.id) && DATE_PATTERN.test(str(e?.date))),
  }
}

/** The copy of a locally edited entry that lost a sync race. Drive's version keeps the id. */
export function conflictCopy(local: Entry, now: Date = new Date()): Entry {
  return {
    ...local,
    id: randomId(),
    title: `${local.title.trim() || displayTitle(local)} (conflict copy)`,
    updatedAt: now.toISOString(),
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const keys = Object.keys(value as object).sort()
    return `{${keys
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function withoutThumbs(e: Entry): unknown {
  return {
    ...e,
    updatedAt: undefined,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    attachments: e.attachments.map(({ thumbFileId, ...a }) => a),
  }
}

/**
 * Two devices may each add a thumbnail to the same old attachment (the background job runs on
 * every device). If two versions of an entry differ only in thumbFileId, they are merged instead
 * of making a conflict copy: Drive's thumbnails win, and this device's fill the gaps. Returns
 * null when the versions differ in anything else. `dropped` are this device's thumbnail files
 * that are no longer used.
 */
export function mergeThumbnailsOnly(
  local: Entry,
  remote: Entry,
): { merged: Entry; changed: boolean; dropped: string[] } | null {
  if (canonical(withoutThumbs(local)) !== canonical(withoutThumbs(remote))) return null
  let changed = false
  const attachments = remote.attachments.map((r, i) => {
    const mine = local.attachments[i]?.thumbFileId
    if (!isId(r.thumbFileId) && isId(mine)) {
      changed = true
      return { ...r, thumbFileId: mine }
    }
    return r
  })
  const kept = new Set(attachments.map((a) => a.thumbFileId).filter(isId))
  const dropped = local.attachments
    .map((a) => a.thumbFileId)
    .filter(isId)
    .filter((t) => !kept.has(t))
  return { merged: { ...remote, attachments }, changed, dropped }
}

/**
 * Title for an entry saved without one: its date and its place among that day's entries,
 * e.g. "2 Nov 2026 · Entry 2".
 */
export function defaultTitle(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number)
  const day = new Date(y, m - 1, d).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
  return `${day} · Entry ${n}`
}
