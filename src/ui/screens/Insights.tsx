// Writing streaks, a year heatmap of days with entries, mood statistics and the tag list.
import { useEffect, useRef, useState } from 'react'
import { today } from '../../lib/dates'
import { moodStats, streaks, yearGrid, yearsWithEntries, dayOfYearLabel } from '../../model/stats'
import { tagCounts } from '../../model/tags'
import { Card, ErrorNote } from '../components'
import { useController } from '../controllerContext'
import { itemData } from '../itemData'
import { href, navigate } from '../router'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DAYS = ['Mon', '', 'Wed', '', 'Fri', '', '']

function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`
}

function Heatmap({ year, counts }: { year: number; counts: Map<string, number> }) {
  const weeks = yearGrid(year, counts)
  const [focus, setFocus] = useState<{ date: string; count: number } | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  // Start at the most recent weeks (on a phone the year doesn't fit).
  useEffect(() => {
    const el = scroller.current
    if (el) el.scrollLeft = el.scrollWidth
  }, [year])
  let days = 0
  let entries = 0
  for (const [d, n] of counts) {
    if (d.startsWith(String(year))) {
      days++
      entries += n
    }
  }
  // Month labels sit above the first week that contains the 1st of that month.
  const monthAt = weeks.map((w) => {
    const first = w.find((c) => c && c.date.endsWith('-01'))
    return first ? MONTHS[Number(first.date.slice(5, 7)) - 1] : ''
  })
  return (
    <div>
      <p className="muted small">
        {plural(entries, 'entry', 'entries')} on {plural(days, 'day')} in {year}
      </p>
      <div className="heatmap-scroll" ref={scroller}>
        <table className="heatmap" aria-label={`Days with entries in ${year}`}>
          <thead>
            <tr>
              <th />
              {monthAt.map((m, i) => (
                <th key={i} scope="col" className="heatmap-month">
                  {m && <span>{m}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {DAYS.map((label, dow) => (
              <tr key={dow}>
                <th scope="row" className="heatmap-dow">
                  {label}
                </th>
                {weeks.map((w, i) => {
                  const cell = w[dow]
                  if (!cell) return <td key={i} />
                  const text = `${dayOfYearLabel(cell.date)}: ${plural(cell.count, 'entry', 'entries')}`
                  return (
                    <td key={i}>
                      <a
                        href={href({ name: 'day', date: cell.date })}
                        className={`heat heat-${cell.level}`}
                        title={text}
                        aria-label={text}
                        onMouseEnter={() => setFocus(cell)}
                        onFocus={() => setFocus(cell)}
                      />
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="heatmap-foot">
        <span className="small muted" aria-live="polite">
          {focus
            ? `${dayOfYearLabel(focus.date)} · ${plural(focus.count, 'entry', 'entries')}`
            : 'Tap a day to open it.'}
        </span>
        <span className="heat-legend small muted" aria-hidden="true">
          Less <i className="heat heat-0" />
          <i className="heat heat-1" />
          <i className="heat heat-2" />
          <i className="heat heat-3" /> More
        </span>
      </div>
    </div>
  )
}

function MoodBars({
  year,
  items,
}: {
  year: number
  items: { date: string; mood: 1 | 2 | 3 | 4 | 5 | null }[]
}) {
  const s = moodStats(items, `${year}-01-01`, `${year}-12-31`)
  const max = Math.max(1, ...s.counts.map((c) => c.count))
  if (!s.rated) return <p className="muted small">No moods chosen in {year} yet.</p>
  return (
    <div>
      <p className="muted small">
        Average {s.average!.toFixed(1)} of 5 over {plural(s.rated, 'entry', 'entries')}
        {s.unrated ? ` (${s.unrated} without a mood)` : ''}
      </p>
      <table className="mood-bars">
        <tbody>
          {[...s.counts].reverse().map((c) => (
            <tr key={c.mood}>
              <th scope="row">
                <span aria-hidden="true">{c.emoji}</span> {c.label}
              </th>
              <td>
                <span className="bar-track">
                  {c.count > 0 && (
                    <span
                      className="bar"
                      style={{ width: `${(c.count / max) * 100}%` }}
                      title={`${c.label}: ${c.count}`}
                    />
                  )}
                </span>
              </td>
              <td className="num">{c.count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Tags() {
  const c = useController()
  const items = (c.session?.list() ?? []).map((i) => (i.kind === 'entry' ? i.entry : i.summary))
  const tags = tagCounts(items)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const rename = async (tag: string) => {
    const to = prompt(`Rename the tag "${tag}" in every entry to:`, tag)
    if (!to || to.trim() === tag) return
    setError(null)
    try {
      const n = await c.renameTag(tag, to)
      setNote(`Renamed in ${plural(n, 'entry', 'entries')}.`)
    } catch (e) {
      setError((e as Error).message)
    }
  }
  return (
    <Card>
      <h2>Tags</h2>
      {tags.length === 0 ? (
        <p className="muted small">No tags yet. Add them while writing an entry.</p>
      ) : (
        <ul className="tag-list">
          {tags.map((t) => (
            <li key={t.tag}>
              <a href={href({ name: 'timeline', tag: t.tag })} className="tag">
                #{t.tag}
              </a>
              <span className="muted small">{t.count}</span>
              {!c.readOnly && (
                <button className="ghost small" onClick={() => void rename(t.tag)}>
                  Rename
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {note && <p className="note note-ok">{note}</p>}
      <ErrorNote message={error} onClose={() => setError(null)} />
    </Card>
  )
}

export function Insights({ year: requested }: { year: number | null }) {
  const c = useController()
  const list = c.session?.list() ?? []
  const counts = c.session?.dayCounts() ?? new Map<string, number>()
  const todayStr = today()
  const thisYear = Number(todayStr.slice(0, 4))
  const years = yearsWithEntries(counts.keys(), thisYear)
  const year = requested ?? thisYear
  const st = streaks(counts.keys(), todayStr)
  const moods = list.map((i) => {
    const d = itemData(i)
    return { date: d.date, mood: d.mood }
  })
  const wroteToday = counts.has(todayStr)

  return (
    <div className="page insights">
      <h1>Insights</h1>
      <div className="stat-tiles">
        <div className="stat-tile">
          <span className="stat-value">{st.current}</span>
          <span className="stat-label">
            day{st.current === 1 ? '' : 's'} in a row
            {st.current > 0 && !wroteToday ? ' (write today to keep it)' : ''}
          </span>
        </div>
        <div className="stat-tile">
          <span className="stat-value">{st.longest}</span>
          <span className="stat-label">longest streak</span>
        </div>
      </div>
      <Card>
        <div className="row-between">
          <h2>Days with entries</h2>
          <select
            aria-label="Year"
            value={year}
            onChange={(e) => navigate({ name: 'insights', year: Number(e.target.value) })}
          >
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </div>
        <Heatmap year={year} counts={counts} />
      </Card>
      <Card>
        <h2>Mood in {year}</h2>
        <MoodBars year={year} items={moods} />
      </Card>
      <Tags />
    </div>
  )
}
