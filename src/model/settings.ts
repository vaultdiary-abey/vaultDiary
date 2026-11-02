// settings.vds (kind "settings", FORMAT.md §5.5): app settings that sync between devices,
// encrypted like everything else. Today: entry templates and the writing-prompts switch.
//
// Two devices may change settings before syncing, so the file is merged, never overwritten:
// templates by id (newest updatedAt wins; deletions are kept as tombstones so they don't come
// back), each other setting by its own updatedAt.
import { isId, randomId } from '../crypto/bytes'
import { FormatError } from '../crypto/errors'
import { addTag } from './tags'

export interface Template {
  id: string
  name: string
  /** Title for new entries; empty → the default title (date · Entry n). */
  title: string
  /** Markdown the new entry starts with. */
  body: string
  tags: string[]
  createdAt: string
  updatedAt: string
  /** Tombstone: deleted on some device. */
  deleted?: boolean
  [field: string]: unknown
}

export interface TimedValue<T> {
  value: T
  updatedAt: string
}

export interface Settings {
  v: 1
  templates: Template[]
  showPrompts: TimedValue<boolean>
  [field: string]: unknown
}

const EPOCH = '1970-01-01T00:00:00.000Z'

export function defaultSettings(): Settings {
  return { v: 1, templates: [], showPrompts: { value: true, updatedAt: EPOCH } }
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

function timed<T>(raw: unknown, check: (v: unknown) => v is T, fallback: T): TimedValue<T> {
  const r = raw as Partial<TimedValue<T>> | undefined
  return r && check(r.value)
    ? { value: r.value, updatedAt: str(r.updatedAt, EPOCH) }
    : { value: fallback, updatedAt: EPOCH }
}

/** Validates decrypted settings; unknown fields are kept for newer versions. */
export function parseSettings(raw: unknown): Settings {
  const r = raw as Record<string, unknown>
  if (!r || typeof r !== 'object' || r.v !== 1) throw new FormatError('Unsupported settings file.')
  const templates = (Array.isArray(r.templates) ? r.templates : [])
    .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object' && isId(t.id))
    .map((t) => ({
      ...t,
      id: t.id as string,
      name: str(t.name, 'Template'),
      title: str(t.title),
      body: str(t.body),
      tags: Array.isArray(t.tags) ? t.tags.filter((x): x is string => typeof x === 'string') : [],
      createdAt: str(t.createdAt, EPOCH),
      updatedAt: str(t.updatedAt, EPOCH),
      ...(t.deleted === true ? { deleted: true } : {}),
    }))
  return {
    ...r,
    v: 1,
    templates,
    showPrompts: timed(r.showPrompts, (v): v is boolean => typeof v === 'boolean', true),
  }
}

function newer<T extends { updatedAt: string }>(a: T, b: T): T {
  return b.updatedAt > a.updatedAt ? b : a
}

/** Merges two copies of settings.vds. Commutative, so both devices end up the same. */
export function mergeSettings(a: Settings, b: Settings): Settings {
  const byId = new Map<string, Template>()
  for (const t of [...a.templates, ...b.templates]) {
    const prev = byId.get(t.id)
    byId.set(t.id, prev ? newer(prev, t) : t)
  }
  const templates = [...byId.values()].sort(
    (x, y) => x.createdAt.localeCompare(y.createdAt) || x.id.localeCompare(y.id),
  )
  return { ...a, ...b, v: 1, templates, showPrompts: newer(a.showPrompts, b.showPrompts) }
}

export function liveTemplates(s: Settings): Template[] {
  return s.templates.filter((t) => !t.deleted)
}

export function saveTemplate(
  s: Settings,
  t: Pick<Template, 'name' | 'title' | 'body' | 'tags'> & { id?: string },
  now = new Date(),
): Settings {
  const iso = now.toISOString()
  const existing = t.id ? s.templates.find((x) => x.id === t.id) : undefined
  const tags = t.tags.reduce<string[]>((acc, tag) => addTag(acc, tag), [])
  const next: Template = existing
    ? { ...existing, name: t.name, title: t.title, body: t.body, tags, updatedAt: iso }
    : {
        id: randomId(),
        name: t.name,
        title: t.title,
        body: t.body,
        tags,
        createdAt: iso,
        updatedAt: iso,
      }
  next.name = next.name.trim() || 'Template'
  return {
    ...s,
    templates: existing
      ? s.templates.map((x) => (x.id === next.id ? next : x))
      : [...s.templates, next],
  }
}

export function deleteTemplate(s: Settings, id: string, now = new Date()): Settings {
  return {
    ...s,
    templates: s.templates.map((t) =>
      t.id === id
        ? {
            id: t.id,
            name: '',
            title: '',
            body: '',
            tags: [],
            createdAt: t.createdAt,
            updatedAt: now.toISOString(),
            deleted: true,
          }
        : t,
    ),
  }
}

export function setShowPrompts(s: Settings, value: boolean, now = new Date()): Settings {
  return { ...s, showPrompts: { value, updatedAt: now.toISOString() } }
}
