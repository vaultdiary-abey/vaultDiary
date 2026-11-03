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

/** A named place (Home, Work…) that new entries near it are labelled with (revision 4). */
export interface SavedPlace {
  id: string
  name: string
  lat: number
  lon: number
  /** Entries within this many metres get the place's name. */
  radius: number
  createdAt: string
  updatedAt: string
  /** Tombstone: deleted on some device. */
  deleted?: boolean
  [field: string]: unknown
}

export const DEFAULT_PLACE_RADIUS = 150
export const PLACE_RADIUS_CHOICES = [50, 100, 150, 250, 500, 1000] as const

export interface TimedValue<T> {
  value: T
  updatedAt: string
}

export interface Settings {
  v: 1
  templates: Template[]
  showPrompts: TimedValue<boolean>
  /**
   * When an encrypted backup .zip was last made on any device (Phase 3, optional in the file).
   * value is an ISO time or null; merged like other settings, by updatedAt.
   */
  lastBackup: TimedValue<string | null>
  /** Add the current location to new entries for today (revision 4, default on). */
  addLocation: TimedValue<boolean>
  /** Saved places (revision 4), merged by id like templates. */
  places: SavedPlace[]
  [field: string]: unknown
}

const EPOCH = '1970-01-01T00:00:00.000Z'

export function defaultSettings(): Settings {
  return {
    v: 1,
    templates: [],
    showPrompts: { value: true, updatedAt: EPOCH },
    lastBackup: { value: null, updatedAt: EPOCH },
    addLocation: { value: true, updatedAt: EPOCH },
    places: [],
  }
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
  const places = (Array.isArray(r.places) ? r.places : [])
    .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object' && isId(p.id))
    .map((p): SavedPlace | null => {
      const lat = p.lat
      const lon = p.lon
      const deleted = p.deleted === true
      const ok =
        typeof lat === 'number' &&
        typeof lon === 'number' &&
        Math.abs(lat) <= 90 &&
        Math.abs(lon) <= 180
      if (!ok && !deleted) return null
      const radius = typeof p.radius === 'number' && p.radius > 0 ? p.radius : DEFAULT_PLACE_RADIUS
      return {
        ...p,
        id: p.id as string,
        name: str(p.name, 'Place'),
        lat: ok ? (lat as number) : 0,
        lon: ok ? (lon as number) : 0,
        radius,
        createdAt: str(p.createdAt, EPOCH),
        updatedAt: str(p.updatedAt, EPOCH),
        ...(deleted ? { deleted: true } : {}),
      }
    })
    .filter((p): p is SavedPlace => p !== null)
  return {
    ...r,
    v: 1,
    templates,
    showPrompts: timed(r.showPrompts, (v): v is boolean => typeof v === 'boolean', true),
    lastBackup: timed(r.lastBackup, isIsoOrNull, null),
    addLocation: timed(r.addLocation, (v): v is boolean => typeof v === 'boolean', true),
    places,
  }
}

function isIsoOrNull(v: unknown): v is string | null {
  return v === null || (typeof v === 'string' && !Number.isNaN(Date.parse(v)))
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
  const placesById = new Map<string, SavedPlace>()
  for (const p of [...a.places, ...b.places]) {
    const prev = placesById.get(p.id)
    placesById.set(p.id, prev ? newer(prev, p) : p)
  }
  const places = [...placesById.values()].sort(
    (x, y) => x.createdAt.localeCompare(y.createdAt) || x.id.localeCompare(y.id),
  )
  return {
    ...a,
    ...b,
    v: 1,
    templates,
    showPrompts: newer(a.showPrompts, b.showPrompts),
    lastBackup: newer(a.lastBackup, b.lastBackup),
    addLocation: newer(a.addLocation, b.addLocation),
    places,
  }
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

export function setLastBackup(s: Settings, now = new Date()): Settings {
  const iso = now.toISOString()
  return { ...s, lastBackup: { value: iso, updatedAt: iso } }
}

export function setAddLocation(s: Settings, value: boolean, now = new Date()): Settings {
  return { ...s, addLocation: { value, updatedAt: now.toISOString() } }
}

export function livePlaces(s: Settings): SavedPlace[] {
  return s.places.filter((p) => !p.deleted)
}

/** Adds a place, or changes one (name, radius). Returns the new settings and the place. */
export function savePlace(
  s: Settings,
  p: Pick<SavedPlace, 'name' | 'lat' | 'lon'> & { id?: string; radius?: number },
  now = new Date(),
): { settings: Settings; place: SavedPlace } {
  const iso = now.toISOString()
  const existing = p.id ? s.places.find((x) => x.id === p.id && !x.deleted) : undefined
  const name = p.name.trim() || 'Place'
  const place: SavedPlace = existing
    ? {
        ...existing,
        name,
        lat: p.lat,
        lon: p.lon,
        radius: p.radius ?? existing.radius,
        updatedAt: iso,
      }
    : {
        id: randomId(),
        name,
        lat: p.lat,
        lon: p.lon,
        radius: p.radius ?? DEFAULT_PLACE_RADIUS,
        createdAt: iso,
        updatedAt: iso,
      }
  return {
    settings: {
      ...s,
      places: existing
        ? s.places.map((x) => (x.id === place.id ? place : x))
        : [...s.places, place],
    },
    place,
  }
}

/** Deletes a saved place. Entries already labelled with it keep their label. */
export function deletePlace(s: Settings, id: string, now = new Date()): Settings {
  return {
    ...s,
    places: s.places.map((p) =>
      p.id === id
        ? {
            id: p.id,
            name: '',
            lat: 0,
            lon: 0,
            radius: p.radius,
            createdAt: p.createdAt,
            updatedAt: now.toISOString(),
            deleted: true,
          }
        : p,
    ),
  }
}
