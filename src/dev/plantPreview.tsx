/* eslint-disable react-refresh/only-export-components -- a standalone dev page, not a module */
// DEV ONLY: a preview of the Timeline plant with sample entries. Served by `npm run dev` at
// /plant-preview.html; it is not an input of the production build, so it never ships.
//   ?n=0|1|5|30|300  &theme=light|dark  &accent=ink|sage|clay|graphite  &dots=off  &motion=off
import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { hash32, plantSentence, rng } from '../plant/plan'
import { VineList, type VineItem } from '../ui/plant/Vine'
import { resetVineMemory } from '../ui/plant/motion'
import '../styles.css'

const params = new URLSearchParams(location.search)
const n = Number(params.get('n') ?? 30)
const theme = params.get('theme')
const accent = params.get('accent')
if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme
if (accent && accent !== 'ink') document.documentElement.dataset.accent = accent
if (params.get('dots') === 'off') document.documentElement.dataset.dots = 'off'

const TITLES = [
  'Morning walk',
  'Coffee with Sam',
  'Rainy afternoon',
  'Long day at work',
  'Garden notes',
  'A quiet Sunday',
  'Bus ride home',
  'Dinner at Mum’s',
  'First swim of the year',
  'Library visit',
]
const TEXT =
  'The light came in sideways through the blinds and I made tea before anyone else woke. ' +
  'Wrote a list of things to do and did almost none of them, which felt right for a day like this.'
const PLACES = ['Home', 'Woodlands, Singapore', 'Work', 'Paris, France', 'Mum’s house']

interface Sample {
  id: string
  date: string
  createdAt: string
  title: string
  excerpt: string
  place: string | null
  tags: string[]
  thumbs: number
}

function samples(count: number): Sample[] {
  const out: Sample[] = []
  const day = new Date(Date.UTC(2026, 10, 3))
  for (let i = 0; i < count; i++) {
    const r = rng(hash32(`sample-${i}`))
    const id = (hash32(`id-${i}`).toString(16) + hash32(`id2-${i}`).toString(16)).padEnd(32, '0')
    // Mostly one entry a day, sometimes two on the same day, sometimes a gap.
    if (i > 0) day.setUTCDate(day.getUTCDate() - (r() < 0.2 ? 0 : 1 + Math.floor(r() * 2)))
    const date = day.toISOString().slice(0, 10)
    const len = r()
    out.push({
      id,
      date,
      createdAt: `${date}T${String(8 + (i % 12)).padStart(2, '0')}:15:00.000Z`,
      title: TITLES[i % TITLES.length],
      excerpt: len < 0.3 ? '' : len < 0.7 ? TEXT.slice(0, 70) : TEXT,
      place: r() < 0.55 ? PLACES[Math.floor(r() * PLACES.length)] : null,
      tags: r() < 0.25 ? ['family', 'walks'] : [],
      thumbs: r() < 0.2 ? 1 + Math.floor(r() * 3) : 0,
    })
  }
  return out
}

function Card({ s }: { s: Sample }) {
  return (
    <a className="entry-card" href="#" onClick={(e) => e.preventDefault()}>
      <div className="entry-card-top">
        <strong className="entry-card-title">{s.title}</strong>
      </div>
      {s.excerpt && <p className="entry-card-excerpt">{s.excerpt}</p>}
      {s.tags.length > 0 && (
        <div className="tag-line">
          {s.tags.map((t) => (
            <span key={t} className="tag">
              #{t}
            </span>
          ))}
        </div>
      )}
      {s.thumbs > 0 && (
        <div className="thumb-strip">
          {Array.from({ length: s.thumbs }, (_, i) => (
            <span key={i} className="thumb thumb-more" />
          ))}
        </div>
      )}
      {s.place && (
        <div className="entry-card-place">
          <span className="loc-chip">
            <span aria-hidden="true">📍</span> {s.place}
          </span>
        </div>
      )}
      <div className="entry-card-meta">
        <span>{s.createdAt.slice(11, 16)}</span>
      </div>
    </a>
  )
}

function Preview() {
  const [list, setList] = useState(() => samples(n))
  const [key, setKey] = useState(0)
  const [plant, setPlant] = useState(params.get('plant') !== 'off')
  const all = [...list].sort((a, b) =>
    a.date === b.date ? (a.createdAt < b.createdAt ? 1 : -1) : a.date < b.date ? 1 : -1,
  )
  const items: VineItem[] = all.map((s, i) => ({
    id: s.id,
    createdAt: s.createdAt,
    content: (
      <>
        {(i === 0 || all[i - 1].date !== s.date) && <h2 className="timeline-date">{s.date}</h2>}
        <Card s={s} />
      </>
    ),
  }))
  const add = () => {
    const now = new Date()
    const id = (hash32(`new-${now.getTime()}`).toString(16) + 'f'.repeat(24)).slice(0, 32)
    setList([
      ...list,
      {
        id,
        date: all[0]?.date ?? '2026-11-03',
        createdAt: now.toISOString(),
        title: 'Just written',
        excerpt: TEXT.slice(0, 60),
        place: 'Home',
        tags: [],
        thumbs: 0,
      },
    ])
  }
  return (
    <main className="content">
      <div className="page">
        <h1>Timeline</h1>
        <div className="row" style={{ marginTop: 0 }}>
          <button className="ghost small" onClick={add}>
            Add entry (grow)
          </button>
          <button
            className="ghost small"
            onClick={() => {
              resetVineMemory()
              setKey(key + 1)
            }}
          >
            Replay draw-in
          </button>
          <label className="check small">
            <input type="checkbox" checked={plant} onChange={(e) => setPlant(e.target.checked)} />{' '}
            Plant
          </label>
        </div>
        {plant && (
          <p className="muted small plant-sentence">{plantSentence(list.map((s) => s.date))}</p>
        )}
        {plant ? (
          <VineList
            key={key}
            items={items}
            allIdsOldestFirst={[...all].reverse().map((s) => s.id)}
            animate={params.get('motion') !== 'off'}
          />
        ) : (
          <div className="entry-list">
            {all.map((s) => (
              <Card key={s.id} s={s} />
            ))}
          </div>
        )}
      </div>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Preview />
  </StrictMode>,
)
