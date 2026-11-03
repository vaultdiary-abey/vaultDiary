// Settings → Places: saved places (Home, Work…) that new entries nearby are named after.
// They live in settings.vds (encrypted, synced). Deleting one leaves past entries' labels alone.
import { useState } from 'react'
import {
  deletePlace,
  livePlaces,
  PLACE_RADIUS_CHOICES,
  savePlace,
  type SavedPlace,
} from '../../model/settings'
import { coordsLabel } from '../../model/location'
import { Card } from '../components'
import { useController } from '../controllerContext'

function PlaceRow({ place }: { place: SavedPlace }) {
  const c = useController()
  const session = c.session!
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(place.name)
  const update = (patch: Partial<Pick<SavedPlace, 'name' | 'radius'>>) =>
    session.saveSettings(
      savePlace(session.settings, {
        id: place.id,
        name: patch.name ?? place.name,
        lat: place.lat,
        lon: place.lon,
        radius: patch.radius ?? place.radius,
      }).settings,
    )
  const remove = () => {
    if (
      !confirm(
        `Delete the saved place "${place.name}"? Entries already named after it keep their label.`,
      )
    )
      return
    void session.saveSettings(deletePlace(session.settings, place.id))
  }
  return (
    <li className="place-row">
      {editing ? (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault()
            if (!name.trim()) return
            void update({ name }).then(() => setEditing(false))
          }}
        >
          <input
            aria-label="Place name"
            value={name}
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
          <button className="primary small" type="submit" disabled={!name.trim()}>
            Save
          </button>
          <button
            className="ghost small"
            type="button"
            onClick={() => {
              setName(place.name)
              setEditing(false)
            }}
          >
            Cancel
          </button>
        </form>
      ) : (
        <div className="place-main">
          <strong>{place.name}</strong>
          <span className="muted small">{coordsLabel(place.lat, place.lon)}</span>
        </div>
      )}
      <div className="row place-actions">
        <label className="small">
          Within{' '}
          <select
            aria-label={`Radius for ${place.name}`}
            value={place.radius}
            onChange={(e) => void update({ radius: Number(e.target.value) })}
          >
            {[...new Set([...PLACE_RADIUS_CHOICES, place.radius])]
              .sort((a, b) => a - b)
              .map((r) => (
                <option key={r} value={r}>
                  {r >= 1000 ? `${r / 1000} km` : `${r} m`}
                </option>
              ))}
          </select>
        </label>
        {!editing && (
          <button className="ghost small" onClick={() => setEditing(true)}>
            Rename
          </button>
        )}
        <button className="ghost small danger" onClick={remove}>
          Delete
        </button>
      </div>
    </li>
  )
}

export function Places() {
  const c = useController()
  const session = c.session
  if (!session || c.readOnly) return null
  const places = livePlaces(session.settings)
  return (
    <Card>
      <h2 id="places">Places</h2>
      {places.length ? (
        <ul className="place-list">
          {places.map((p) => (
            <PlaceRow key={p.id} place={p} />
          ))}
        </ul>
      ) : (
        <p className="muted small">
          No saved places yet. Open an entry's location and choose "Save this place".
        </p>
      )}
      <p className="hint">
        A new entry written within a place's distance (when the position is accurate to better than
        150 m) is named after it.
      </p>
    </Card>
  )
}
