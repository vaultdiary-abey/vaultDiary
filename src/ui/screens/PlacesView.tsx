// Timeline → Places: every place entries were written at, with how many entries each has,
// the place with the newest entry first. Tapping one shows those entries on the Timeline.
import { formatDay } from '../../lib/dates'
import { placeCounts } from '../../search/filter'
import { useController } from '../controllerContext'
import { href } from '../router'

export function PlacesView() {
  const c = useController()
  const places = placeCounts(c.session?.list() ?? [])
  const pending = c.session?.summaries.size ?? 0
  return (
    <div className="page places-view">
      <p className="small">
        <a href={href({ name: 'timeline', tag: null })}>← Timeline</a>
      </p>
      <h1>Places</h1>
      {places.length === 0 ? (
        <p className="empty">
          No entries with a location yet. New entries for today get one automatically, or tap “Add
          location” on an entry.
        </p>
      ) : (
        <ul className="place-counts">
          {places.map((p) => (
            <li key={p.key}>
              <a className="entry-card" href={href({ name: 'timeline', tag: null, place: p.key })}>
                <div className="entry-card-top">
                  <strong className="entry-card-title">📍 {p.label}</strong>
                  <span className="place-count">
                    {p.count.toLocaleString()} {p.count === 1 ? 'entry' : 'entries'}
                  </span>
                </div>
                <div className="entry-card-meta">
                  <span>Latest: {formatDay(p.latest, 'short')}</span>
                </div>
              </a>
            </li>
          ))}
        </ul>
      )}
      {pending > 0 && (
        <p className="muted small">{pending} entries are still downloading and may add places.</p>
      )}
    </div>
  )
}
