// The location chip under an entry's date, and the sheet that edits it: use the current
// location, search the offline city list, type a name, save the place, or remove it.
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { loadCities, searchCities, type City } from '../location/cities'
import { cityLocation, LocationError, locateNow } from '../location/locate'
import {
  coordsLabel,
  hasCoords,
  locationLabel,
  parseLocation,
  roundCoord,
  type EntryLocation,
} from '../model/location'
import { DEFAULT_PLACE_RADIUS, livePlaces, savePlace } from '../model/settings'
import { getLocationOffReason, getLocationState, setLocationState } from '../core/prefs'
import { useController } from './controllerContext'

export const IPHONE_LOCATION_HELP =
  'To turn it back on on an iPhone: open Settings → Privacy & Security → Location Services, ' +
  'make sure it is on and that Safari Websites is set to "While Using the App". Then, in ' +
  'Safari, open this site, tap the "aA" button → Website Settings → Location → Allow (this ' +
  'also covers the app installed on your Home Screen). Finally choose "Try again" in Vault ' +
  "Diary's Settings."

export function LocationChip({
  location,
  onEdit,
  busy = false,
}: {
  location: unknown
  /** Opens the editor; without it the chip is display-only. */
  onEdit?: () => void
  busy?: boolean
}) {
  const loc = parseLocation(location)
  const label = loc ? locationLabel(loc) : ''
  if (busy && !loc) {
    return (
      <span className="loc-chip loc-chip-busy" aria-live="polite">
        <span aria-hidden="true">📍</span> Finding location…
      </span>
    )
  }
  if (!onEdit) {
    return loc ? (
      <span className="loc-chip" data-testid="location-chip">
        <span aria-hidden="true">📍</span> {label}
      </span>
    ) : null
  }
  return (
    <button
      type="button"
      className={`loc-chip ${loc ? '' : 'loc-chip-empty'}`}
      onClick={onEdit}
      aria-label={loc ? `Location: ${label}. Change location` : 'Add location'}
      data-testid="location-chip"
    >
      <span aria-hidden="true">📍</span> {loc ? label : 'Add location'}
    </button>
  )
}

function parseCoords(text: string): { lat: number; lon: number } | null | 'bad' {
  const t = text.trim()
  if (!t) return null
  const m = /^(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)$/.exec(t)
  if (!m) return 'bad'
  const lat = Number(m[1])
  const lon = Number(m[2])
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return 'bad'
  return { lat: roundCoord(lat), lon: roundCoord(lon) }
}

/** Editor for an entry's location. Never touches the entry's date. */
export function LocationSheet({
  location,
  onChange,
  onClose,
}: {
  location: unknown
  onChange: (next: EntryLocation | null) => void | Promise<void>
  onClose: () => void
}) {
  const c = useController()
  const session = c.session
  const current = parseLocation(location)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<City[]>([])
  const [citiesState, setCitiesState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [name, setName] = useState(current?.source === 'manual' ? current.label : '')
  const [coords, setCoords] = useState(hasCoords(current) ? `${current.lat}, ${current.lon}` : '')
  const [placeName, setPlaceName] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [help, setHelp] = useState(false)
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    dialogRef.current?.focus()
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Search the offline city list as you type (it loads on first use).
  const searchSeq = useRef(0)
  const search = (q: string) => {
    setQuery(q)
    const seq = ++searchSeq.current
    if (!q.trim()) {
      setResults([])
      return
    }
    setCitiesState((s) => (s === 'ready' ? s : 'loading'))
    loadCities()
      .then((db) => {
        if (seq !== searchSeq.current) return
        setCitiesState('ready')
        setResults(searchCities(db, q))
      })
      .catch(() => seq === searchSeq.current && setCitiesState('error'))
  }

  const apply = async (next: EntryLocation | null) => {
    setError(null)
    try {
      await onChange(next)
      onClose()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const takeCurrent = async () => {
    setError(null)
    setHelp(false)
    setBusy('Finding your location…')
    try {
      const loc = await locateNow(session ? livePlaces(session.settings) : [])
      // Choosing it here is an answer to "may the app use your location?".
      setLocationState('asked')
      await apply(loc)
    } catch (e) {
      if (e instanceof LocationError) {
        if (e.reason === 'denied') setLocationState('off', 'denied')
        setHelp(e.reason === 'denied')
        setError(e.message)
      } else setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const saveName = (e: FormEvent) => {
    e.preventDefault()
    const label = name.trim()
    const parsed = parseCoords(coords)
    if (parsed === 'bad') {
      setError(
        'Coordinates look like "1.4380, 103.7880" (latitude, longitude), or leave them empty.',
      )
      return
    }
    if (!label) return
    const keep =
      parsed &&
      current &&
      hasCoords(current) &&
      current.lat === parsed.lat &&
      current.lon === parsed.lon
    void apply({
      lat: parsed?.lat ?? null,
      lon: parsed?.lon ?? null,
      accuracy: keep ? current.accuracy : null,
      label,
      city: keep ? current.city : '',
      region: keep ? current.region : '',
      country: keep ? current.country : '',
      source: 'manual',
      capturedAt: new Date().toISOString(),
    })
  }

  const saveAsPlace = async (e: FormEvent) => {
    e.preventDefault()
    if (!session || !current || !hasCoords(current) || !placeName.trim()) return
    setError(null)
    try {
      const { settings, place } = savePlace(session.settings, {
        name: placeName,
        lat: current.lat,
        lon: current.lon,
      })
      await session.saveSettings(settings)
      await apply({ ...current, label: place.name, placeId: place.id, source: 'saved-place' })
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const offReason = getLocationState() === 'off' ? getLocationOffReason() : null

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        className="sheet loc-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Location"
        tabIndex={-1}
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-head">
          <h2>Location</h2>
          <button className="ghost small" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {current ? (
          <div className="loc-current">
            <strong>📍 {locationLabel(current)}</strong>
            <span className="muted small">
              {[current.city, current.region, current.country].filter(Boolean).join(' · ')}
              {hasCoords(current) && (
                <>
                  {current.city ? ' · ' : ''}
                  {coordsLabel(current.lat, current.lon)}
                  {current.accuracy !== null && ` (±${current.accuracy} m)`}
                </>
              )}
            </span>
          </div>
        ) : (
          <p className="muted small">No location for this entry.</p>
        )}

        <section className="loc-section">
          {busy ? (
            <p className="muted" aria-live="polite">
              {busy}
            </p>
          ) : (
            <button className="ghost loc-wide" onClick={() => void takeCurrent()}>
              Use current location
            </button>
          )}
          {offReason && !help && (
            <p className="hint">Location is off on this device; this asks the browser again.</p>
          )}
          {help && <p className="hint warn">{IPHONE_LOCATION_HELP}</p>}
        </section>

        <section className="loc-section">
          <label htmlFor="loc-search">Search a city</label>
          <input
            id="loc-search"
            type="search"
            placeholder="e.g. Woodlands or Paris, France"
            value={query}
            onChange={(e) => search(e.target.value)}
            autoComplete="off"
            enterKeyHint="search"
          />
          {citiesState === 'loading' && <p className="muted small">Loading place names…</p>}
          {citiesState === 'error' && (
            <p className="hint warn">
              The place-name list couldn't be loaded. It's part of the app, so try again when you're
              online.
            </p>
          )}
          {results.length > 0 && (
            <ul className="loc-results" role="listbox" aria-label="Cities">
              {results.map((r) => (
                <li key={r.index}>
                  <button
                    type="button"
                    role="option"
                    aria-selected="false"
                    onClick={() => void apply(cityLocation(r))}
                  >
                    <strong>{r.name}</strong>
                    <span className="muted small">
                      {[r.region, r.country].filter(Boolean).join(', ')}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {citiesState === 'ready' && query.trim() && !results.length && (
            <p className="muted small">No city by that name. You can type a custom name below.</p>
          )}
        </section>

        <form className="loc-section" onSubmit={saveName}>
          <label htmlFor="loc-name">Type a custom name</label>
          <input
            id="loc-name"
            placeholder="e.g. Grandma's garden"
            value={name}
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
          />
          <label htmlFor="loc-coords" className="small">
            Coordinates (optional)
          </label>
          <input
            id="loc-coords"
            inputMode="decimal"
            placeholder="latitude, longitude"
            value={coords}
            onChange={(e) => setCoords(e.target.value)}
          />
          <button className="primary" type="submit" disabled={!name.trim()}>
            Use this name
          </button>
        </form>

        {session && !c.readOnly && current && hasCoords(current) && (
          <form className="loc-section" onSubmit={(e) => void saveAsPlace(e)}>
            <label htmlFor="loc-place">Save this place</label>
            <input
              id="loc-place"
              placeholder="Home, Work, Mum's house…"
              value={placeName}
              maxLength={60}
              onChange={(e) => setPlaceName(e.target.value)}
            />
            <p className="hint">
              New entries written within {DEFAULT_PLACE_RADIUS} m of here get this name. Saved
              places are encrypted with your settings.
            </p>
            <button className="ghost" type="submit" disabled={!placeName.trim()}>
              Save place
            </button>
          </form>
        )}

        {current && (
          <section className="loc-section">
            <button className="ghost danger loc-wide" onClick={() => void apply(null)}>
              Remove location
            </button>
          </section>
        )}
        {error && (
          <p className="note note-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  )
}
