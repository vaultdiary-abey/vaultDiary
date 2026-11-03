// Where an entry was written (FORMAT.md §5.1 `location`, revision 4). Optional; stored only
// inside the encrypted entry. Text-only locations (a typed name, no coordinates) are allowed.
import { normalizeTerm } from '../search/text'

export const LOCATION_SOURCES = ['auto', 'manual', 'saved-place', 'city-search'] as const
export type LocationSource = (typeof LOCATION_SOURCES)[number]

export interface EntryLocation {
  /** Latitude/longitude in degrees (WGS 84), or both null for a typed name only. */
  lat: number | null
  lon: number | null
  /** Accuracy radius in metres, when known. */
  accuracy: number | null
  /** What the app shows, e.g. "Home" or "Woodlands, Singapore". */
  label: string
  /** The saved place this was matched to (source "saved-place"). */
  placeId?: string
  city: string
  region: string
  country: string
  source: LocationSource
  /** ISO 8601 UTC time the position was taken or the location was chosen. */
  capturedAt: string
  /** Fields written by newer versions are kept unchanged. */
  [field: string]: unknown
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function finite(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** Coordinates rounded to 6 decimals (about 11 cm), as the app stores them. */
export function roundCoord(n: number): number {
  return Math.floor(n * 1e6 + 0.5) / 1e6
}

/**
 * Validates a decrypted `location`. Returns null when it holds nothing usable (no label and no
 * coordinates). Recovery tools (recover.py `parse_location`) follow the same rules.
 */
export function parseLocation(raw: unknown): EntryLocation | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  let lat = finite(r.lat)
  let lon = finite(r.lon)
  if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    lat = null
    lon = null
  }
  const label = str(r.label)
  if (!label && lat === null) return null
  const accuracy = finite(r.accuracy)
  const source = LOCATION_SOURCES.includes(r.source as LocationSource)
    ? (r.source as LocationSource)
    : 'manual'
  const out: EntryLocation = {
    ...r,
    lat,
    lon,
    accuracy: accuracy !== null && accuracy >= 0 ? accuracy : null,
    label,
    city: str(r.city),
    region: str(r.region),
    country: str(r.country),
    source,
    capturedAt: typeof r.capturedAt === 'string' ? r.capturedAt : '',
  }
  if (typeof r.placeId === 'string' && r.placeId) out.placeId = r.placeId
  else delete out.placeId
  return out
}

export function hasCoords(l: EntryLocation | null | undefined): l is EntryLocation & {
  lat: number
  lon: number
} {
  return !!l && l.lat !== null && l.lon !== null
}

/** "Woodlands, Singapore"; just "Singapore" when the city and country are the same. */
export function cityLabel(city: string, country: string): string {
  if (!city) return country
  if (!country || normalizeTerm(city) === normalizeTerm(country)) return city
  return `${city}, ${country}`
}

/** "1.4380, 103.7880": shown when no place name is known. */
export function coordsLabel(lat: number, lon: number): string {
  return `${lat.toFixed(4)}, ${lon.toFixed(4)}`
}

/** The name shown for a location: its label, else its city, else its coordinates. */
export function locationLabel(l: EntryLocation): string {
  if (l.label) return l.label
  const c = cityLabel(l.city, l.country)
  if (c) return c
  return hasCoords(l) ? coordsLabel(l.lat, l.lon) : ''
}

/** Key that groups entries by place in the Places view (case and accents ignored). */
export function placeKey(label: string): string {
  return normalizeTerm(label.trim()).replace(/\s+/g, ' ')
}

/**
 * A number with at most 6 decimals, written the same way by every tool (no exponent, no
 * trailing zeros): 1.438, -0.000001, 103. recover.py `plain_number` matches it exactly.
 */
export function plainNumber(n: number): string {
  const k = Math.floor(n * 1e6 + 0.5)
  const sign = k < 0 ? '-' : ''
  const abs = String(Math.abs(k)).padStart(7, '0')
  const int = abs.slice(0, -6)
  const frac = abs.slice(-6).replace(/0+$/, '')
  return `${sign}${int}${frac ? `.${frac}` : ''}`
}

/** Front-matter lines for the Markdown export and recovery (label, city, country, lat, lon). */
export function locationFrontMatter(raw: unknown): string[] {
  const l = parseLocation(raw)
  if (!l) return []
  return [
    'location:',
    `  label: ${JSON.stringify(l.label)}`,
    `  city: ${JSON.stringify(l.city)}`,
    `  country: ${JSON.stringify(l.country)}`,
    `  lat: ${l.lat === null ? 'null' : plainNumber(l.lat)}`,
    `  lon: ${l.lon === null ? 'null' : plainNumber(l.lon)}`,
  ]
}
