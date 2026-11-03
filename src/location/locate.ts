// Turning "where am I" into an entry location, entirely on the device: the browser's
// Geolocation API for the position, saved places and the offline city list for the name.
import {
  cityLabel,
  coordsLabel,
  roundCoord,
  type EntryLocation,
  type LocationSource,
} from '../model/location'
import type { SavedPlace } from '../model/settings'
import { distanceM, loadCities, nearestCity, type City } from './cities'

/** Accuracy (metres) a position needs before it's matched to a saved place. */
export const PLACE_MATCH_ACCURACY = 150

export const GEO_OPTIONS: PositionOptions = {
  enableHighAccuracy: true,
  timeout: 10_000,
  maximumAge: 5 * 60_000,
}

export type LocateError = 'denied' | 'timeout' | 'unavailable'

export class LocationError extends Error {
  constructor(readonly reason: LocateError) {
    super(
      reason === 'denied'
        ? 'Location permission is turned off for this site.'
        : reason === 'timeout'
          ? "Couldn't get your location in time."
          : 'Location is not available on this device.',
    )
  }
}

export function geolocationAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'geolocation' in navigator
}

/** The current position, once. */
export function currentPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!geolocationAvailable()) return reject(new LocationError('unavailable'))
    navigator.geolocation.getCurrentPosition(
      resolve,
      (e) =>
        reject(
          new LocationError(
            e.code === e.PERMISSION_DENIED
              ? 'denied'
              : e.code === e.TIMEOUT
                ? 'timeout'
                : 'unavailable',
          ),
        ),
      GEO_OPTIONS,
    )
  })
}

/** Whether the browser already allows location for this site (null if it can't tell). */
export async function permissionState(): Promise<PermissionState | null> {
  try {
    const p = await navigator.permissions?.query({ name: 'geolocation' as PermissionName })
    return p?.state ?? null
  } catch {
    return null
  }
}

/** The nearest live saved place whose radius contains the position, if accurate enough. */
export function matchPlace(
  places: readonly SavedPlace[],
  lat: number,
  lon: number,
  accuracy: number | null,
): SavedPlace | null {
  if (accuracy === null || accuracy >= PLACE_MATCH_ACCURACY) return null
  let best: SavedPlace | null = null
  let bestD = Infinity
  for (const p of places) {
    if (p.deleted) continue
    const d = distanceM(lat, lon, p.lat, p.lon)
    if (d <= p.radius && d < bestD) {
      best = p
      bestD = d
    }
  }
  return best
}

export function cityLocation(c: City, now = new Date()): EntryLocation {
  return {
    lat: c.lat,
    lon: c.lon,
    accuracy: null,
    label: cityLabel(c.name, c.country),
    city: c.name,
    region: c.region,
    country: c.country,
    source: 'city-search',
    capturedAt: now.toISOString(),
  }
}

/**
 * Names a position: a saved place within its radius (source "saved-place"), else the nearest
 * city (source as given), else just the coordinates if the city list can't be loaded.
 */
export async function describePosition(
  pos: { lat: number; lon: number; accuracy: number | null; at?: Date },
  places: readonly SavedPlace[],
  source: LocationSource = 'auto',
  cities: () => Promise<{ name: string; region: string; country: string } | null> = async () =>
    nearestCity(await loadCities(), pos.lat, pos.lon),
): Promise<EntryLocation> {
  const lat = roundCoord(pos.lat)
  const lon = roundCoord(pos.lon)
  const accuracy = pos.accuracy === null ? null : Math.round(pos.accuracy)
  const city = await cities().catch(() => null)
  const place = matchPlace(places, lat, lon, accuracy)
  const base: EntryLocation = {
    lat,
    lon,
    accuracy,
    label: city ? cityLabel(city.name, city.country) : coordsLabel(lat, lon),
    city: city?.name ?? '',
    region: city?.region ?? '',
    country: city?.country ?? '',
    source,
    capturedAt: (pos.at ?? new Date()).toISOString(),
  }
  return place ? { ...base, label: place.name, placeId: place.id, source: 'saved-place' } : base
}

/** Gets the position and names it. */
export async function locateNow(
  places: readonly SavedPlace[],
  source: LocationSource = 'auto',
): Promise<EntryLocation> {
  const p = await currentPosition()
  return describePosition(
    {
      lat: p.coords.latitude,
      lon: p.coords.longitude,
      accuracy: Number.isFinite(p.coords.accuracy) ? p.coords.accuracy : null,
      at: new Date(p.timestamp || Date.now()),
    },
    places,
    source,
  )
}
