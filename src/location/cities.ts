// The offline city list (GeoNames cities with 1,000+ people, CC BY 4.0; built by
// scripts/build-cities.mjs). It turns coordinates into a place name and powers "Search a city"
// without any network service: the file is part of the app, downloaded from the app's own origin
// the first time it's needed and then kept in IndexedDB (it's public data, not diary content).
import { normalizeTerm } from '../search/text'

export interface CityDB {
  count: number
  names: string[]
  /** Accent- and case-folded names (and ASCII names) for search. */
  folded: string[]
  ascii: string[]
  region: Uint16Array
  country: Uint16Array
  /** Degrees × 10⁴. */
  lat: Int32Array
  lon: Int32Array
  countries: string[]
  regions: string[]
  /** 1°×1° cells → city indexes. */
  grid: Map<number, number[]>
}

export interface City {
  index: number
  name: string
  region: string
  country: string
  lat: number
  lon: number
}

const cell = (lat: number, lon: number) => (Math.floor(lat) + 90) * 361 + (Math.floor(lon) + 180)

export function parseCities(text: string): CityDB {
  const lines = text.split('\n')
  const head = lines[0] ?? ''
  if (!head.startsWith('#VDCITIES 1 ')) throw new Error('Unknown city list format.')
  const countries = (lines[1] ?? '').split('|')
  const regions = (lines[2] ?? '').split('|')
  const rows = lines.slice(3).filter(Boolean)
  const n = rows.length
  const db: CityDB = {
    count: n,
    names: new Array(n),
    folded: new Array(n),
    ascii: new Array(n),
    region: new Uint16Array(n),
    country: new Uint16Array(n),
    lat: new Int32Array(n),
    lon: new Int32Array(n),
    countries,
    regions,
    grid: new Map(),
  }
  for (let i = 0; i < n; i++) {
    const f = rows[i].split('|')
    db.names[i] = f[0]
    db.folded[i] = normalizeTerm(f[0])
    db.ascii[i] = f[1] ? normalizeTerm(f[1]) : ''
    db.region[i] = Number(f[2]) || 0
    db.country[i] = Number(f[3]) || 0
    const lat = (db.lat[i] = Number(f[4]) || 0)
    const lon = (db.lon[i] = Number(f[5]) || 0)
    const key = cell(lat / 1e4, lon / 1e4)
    const list = db.grid.get(key)
    if (list) list.push(i)
    else db.grid.set(key, [i])
  }
  return db
}

export function cityAt(db: CityDB, i: number): City {
  return {
    index: i,
    name: db.names[i],
    region: db.regions[db.region[i]] ?? '',
    country: db.countries[db.country[i]] ?? '',
    lat: db.lat[i] / 1e4,
    lon: db.lon[i] / 1e4,
  }
}

/** Great-circle distance in metres. */
export function distanceM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180
  const dLat = (lat2 - lat1) * r
  const dLon = (lon2 - lon1) * r
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(a)))
}

/** The nearest city to a position, searching outwards cell by cell (null if none within ~2,000 km). */
export function nearestCity(
  db: CityDB,
  lat: number,
  lon: number,
): (City & { distance: number }) | null {
  let best = -1
  let bestD = Infinity
  const la = Math.floor(lat)
  const lo = Math.floor(lon)
  for (let ring = 0; ring <= 20; ring++) {
    for (let dy = -ring; dy <= ring; dy++) {
      for (let dx = -ring; dx <= ring; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue
        const y = la + dy
        if (y < -90 || y > 90) continue
        const x = ((lo + dx + 180 + 360) % 360) - 180
        for (const i of db.grid.get(cell(y, x)) ?? []) {
          const d = distanceM(lat, lon, db.lat[i] / 1e4, db.lon[i] / 1e4)
          if (d < bestD) {
            bestD = d
            best = i
          }
        }
      }
    }
    // Everything outside this ring is at least `ring` degrees of latitude away (≈111 km each),
    // or, east–west, `ring` degrees of longitude (shorter towards the poles).
    const reach =
      ring * 111_000 * Math.max(0.05, Math.cos((Math.abs(lat) + ring) * (Math.PI / 180)))
    if (best >= 0 && bestD <= reach) break
  }
  return best < 0 ? null : { ...cityAt(db, best), distance: bestD }
}

/**
 * Cities whose name starts with the query (then those containing it), most populous first.
 * "paris, fr" narrows by country (or region) name.
 */
export function searchCities(db: CityDB, query: string, limit = 8): City[] {
  const [namePart, ...rest] = query.split(',')
  const q = normalizeTerm(namePart.trim())
  const where = normalizeTerm(rest.join(',').trim())
  if (!q) return []
  const placeOk = (i: number) =>
    !where ||
    normalizeTerm(db.countries[db.country[i]] ?? '').startsWith(where) ||
    normalizeTerm(db.regions[db.region[i]] ?? '').startsWith(where)
  const starts: number[] = []
  const contains: number[] = []
  for (let i = 0; i < db.count && starts.length < limit; i++) {
    const f = db.folded[i]
    const a = db.ascii[i]
    if (f.startsWith(q) || (a && a.startsWith(q))) {
      if (placeOk(i)) starts.push(i)
    } else if (contains.length < limit && q.length >= 3 && (f.includes(q) || a.includes(q))) {
      if (placeOk(i)) contains.push(i)
    }
  }
  return [...starts, ...contains].slice(0, limit).map((i) => cityAt(db, i))
}

// --- loading and caching

const DB_NAME = 'vd-geo'
const STORE = 'files'

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function cached(url: string): Promise<string | null> {
  try {
    const db = await idb()
    return await new Promise<string | null>((resolve) => {
      const req = db.transaction(STORE).objectStore(STORE).get('cities')
      req.onsuccess = () => {
        const v = req.result as { url: string; text: string } | undefined
        resolve(v && v.url === url ? v.text : null)
      }
      req.onerror = () => resolve(null)
    }).finally(() => db.close())
  } catch {
    return null
  }
}

async function store(url: string, text: string): Promise<void> {
  try {
    const db = await idb()
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put({ url, text }, 'cities')
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
    })
    db.close()
  } catch {
    // Not cached: it is downloaded again next time.
  }
}

/** Removes the cached city list (Settings → Remove from this device). */
export async function forgetCities(): Promise<void> {
  loading = null
  try {
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(DB_NAME)
      req.onsuccess = req.onerror = req.onblocked = () => resolve()
    })
  } catch {
    // ignore
  }
}

let loading: Promise<CityDB> | null = null

/** Loads the city list once per visit: from IndexedDB, else from the app's own origin. */
export function loadCities(): Promise<CityDB> {
  loading ??= (async () => {
    const { default: url } = await import('./cities.txt?url')
    let text = await cached(url)
    if (!text) {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`Couldn't load the place names (${res.status}).`)
      text = await res.text()
      await store(url, text)
    }
    return parseCities(text)
  })().catch((e) => {
    loading = null
    throw e
  })
  return loading
}
