import { useEffect, useState } from 'react'
import { formatDay } from '../../lib/dates'
import type { MediaKind } from '../../media/kind'
import { MOODS, type Mood } from '../../model/entry'
import { hasTag, tagCounts } from '../../model/tags'
import {
  activeFilterCount,
  matchesFilters,
  NO_FILTERS,
  placeCounts,
  type Filters,
  type Searchable,
} from '../../search/filter'
import { plainText, snippet } from '../../search/text'
import { useController } from '../controllerContext'
import { EntryCard } from '../EntryCard'
import { itemData } from '../itemData'
import { href } from '../router'
import { VineList, type VineItem } from '../plant/Vine'
import { getTimelinePlant } from '../../core/prefs'
import { plantSentence } from '../../plant/plan'

const PAGE = 50

const KINDS: { value: MediaKind; label: string }[] = [
  { value: 'image', label: 'Photos' },
  { value: 'video', label: 'Videos' },
  { value: 'audio', label: 'Audio' },
  { value: 'pdf', label: 'PDFs' },
  { value: 'other', label: 'Other files' },
]

/** Kept while the app runs, so coming back from an entry shows the same search. */
let remembered: { query: string; filters: Filters; open: boolean } = {
  query: '',
  filters: NO_FILTERS,
  open: false,
}

function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value]
}

function FilterPanel({
  filters,
  onChange,
  allTags,
}: {
  filters: Filters
  onChange: (f: Filters) => void
  allTags: string[]
}) {
  const set = (patch: Partial<Filters>) => onChange({ ...filters, ...patch })
  const freeTags = allTags.filter((t) => !filters.tags.some((s) => hasTag([s], t)))
  return (
    <div className="filter-panel card">
      <div className="filter-row">
        <label className="filter-date">
          From
          <input
            type="date"
            value={filters.from ?? ''}
            onChange={(e) => set({ from: e.target.value || null })}
          />
        </label>
        <label className="filter-date">
          To
          <input
            type="date"
            value={filters.to ?? ''}
            onChange={(e) => set({ to: e.target.value || null })}
          />
        </label>
      </div>
      <fieldset className="filter-group">
        <legend>Tags (all of)</legend>
        <div className="chips">
          {filters.tags.map((t) => (
            <button
              key={t}
              className="chip selected"
              onClick={() => set({ tags: filters.tags.filter((x) => x !== t) })}
              aria-label={`Remove tag filter ${t}`}
            >
              #{t} ✕
            </button>
          ))}
          {freeTags.length > 0 && (
            <select
              aria-label="Add a tag filter"
              value=""
              onChange={(e) => e.target.value && set({ tags: [...filters.tags, e.target.value] })}
            >
              <option value="">+ tag</option>
              {freeTags.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          )}
          {!allTags.length && <span className="muted small">No tags yet.</span>}
        </div>
      </fieldset>
      <fieldset className="filter-group">
        <legend>Mood (any of)</legend>
        <div className="chips">
          {MOODS.map((m) => (
            <button
              key={m.value}
              className={`chip ${filters.moods.includes(m.value) ? 'selected' : ''}`}
              aria-pressed={filters.moods.includes(m.value)}
              onClick={() => set({ moods: toggle<Mood>(filters.moods, m.value) })}
              title={m.label}
            >
              {m.emoji} {m.label}
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset className="filter-group">
        <legend>Attachments</legend>
        <div className="chips">
          <button
            className={`chip ${filters.hasAttachments ? 'selected' : ''}`}
            aria-pressed={filters.hasAttachments}
            onClick={() => set({ hasAttachments: !filters.hasAttachments })}
          >
            Has attachments
          </button>
          {KINDS.map((k) => (
            <button
              key={k.value}
              className={`chip ${filters.kinds.includes(k.value) ? 'selected' : ''}`}
              aria-pressed={filters.kinds.includes(k.value)}
              onClick={() => set({ kinds: toggle(filters.kinds, k.value) })}
            >
              {k.label}
            </button>
          ))}
        </div>
      </fieldset>
      {activeFilterCount(filters) > 0 && (
        <button className="link" onClick={() => onChange(NO_FILTERS)}>
          Clear all filters
        </button>
      )}
    </div>
  )
}

export function Timeline({ tag, place = null }: { tag: string | null; place?: string | null }) {
  const c = useController()
  const linked = !!(tag || place)
  const [limit, setLimit] = useState(PAGE)
  const [query, setQuery] = useState(linked ? '' : remembered.query)
  const [filters, setFilters] = useState<Filters>(
    linked ? { ...NO_FILTERS, tags: tag ? [tag] : [], place } : remembered.filters,
  )
  const [open, setOpen] = useState(linked ? false : remembered.open)
  useEffect(() => {
    remembered = { query, filters, open }
  }, [query, filters, open])

  const all = c.session?.list() ?? []
  const searching = query.trim().length > 0
  const filtering = activeFilterCount(filters) > 0
  const index = c.searchReady
  useEffect(() => {
    if (searching && !index) void c.ensureSearch().catch(() => {})
  }, [c, searching, index])

  const placeLabel = filters.place
    ? (placeCounts(all).find((p) => p.key === filters.place)?.label ?? filters.place)
    : null

  const allTags = tagCounts(all.map((i) => (i.kind === 'entry' ? i.entry : i.summary))).map(
    (t) => t.tag,
  )

  let results: { item: Searchable; terms: string[] }[] | null = null
  if (searching || filtering) {
    const byId = new Map(all.map((i) => [itemData(i).id, i]))
    const base = searching
      ? (index?.search(query) ?? [])
          .map((h) => ({ item: byId.get(h.id), terms: h.terms }))
          .filter((r): r is { item: Searchable; terms: string[] } => !!r.item)
      : all.map((item) => ({ item, terms: [] as string[] }))
    results = base.filter((r) => matchesFilters(r.item, filters))
  }

  const shown = all.slice(0, limit)
  const groups: { date: string; items: typeof shown }[] = []
  for (const item of shown) {
    const date = itemData(item).date
    const last = groups[groups.length - 1]
    if (last && last.date === date) last.items.push(item)
    else groups.push({ date, items: [item] })
  }
  const pendingCount = c.session?.summaries.size ?? 0
  const [plant] = useState(getTimelinePlant)
  const nFilters = activeFilterCount(filters)

  return (
    <div className="page">
      <h1>Timeline</h1>
      <div className="search-bar">
        <input
          type="search"
          placeholder="Search titles, text, tags, places, files"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search entries"
          enterKeyHint="search"
        />
        <button
          className={`ghost ${nFilters ? 'has-filters' : ''}`}
          onClick={() => setOpen(!open)}
          aria-expanded={open}
        >
          Filters{nFilters ? ` (${nFilters})` : ''}
        </button>
      </div>
      <div className="timeline-links">
        <a className="chip" href={href({ name: 'places' })}>
          📍 Places
        </a>
        {placeLabel && (
          <button
            className="chip selected"
            onClick={() => setFilters({ ...filters, place: null })}
            aria-label={`Remove place filter ${placeLabel}`}
          >
            📍 {placeLabel} ✕
          </button>
        )}
      </div>
      {open && <FilterPanel filters={filters} onChange={setFilters} allTags={allTags} />}
      {plant && (
        <p className="muted small plant-sentence" data-testid="plant-sentence">
          {plantSentence(all.map((i) => itemData(i).date))}
        </p>
      )}

      {results ? (
        <section aria-live="polite">
          {searching && !index ? (
            <p className="muted">Preparing search…</p>
          ) : (
            <p className="muted small">
              {results.length} {results.length === 1 ? 'entry' : 'entries'}
              {pendingCount > 0 &&
                ` · ${pendingCount} still downloading (searched by title and summary only)`}
            </p>
          )}
          {(() => {
            const cards = results.slice(0, limit).map(({ item, terms }) => {
              const body = item.kind === 'entry' ? plainText(item.entry.body) : item.summary.excerpt
              return {
                id: itemData(item).id,
                createdAt: itemData(item).createdAt,
                content: (
                  <EntryCard
                    key={itemData(item).id}
                    item={item}
                    showDate
                    snippet={searching ? snippet(body, terms) : null}
                  />
                ),
              }
            })
            return plant ? (
              <VineList
                items={cards}
                allIdsOldestFirst={results.map((r) => itemData(r.item).id).reverse()}
              />
            ) : (
              <div className="entry-list">{cards.map((x) => x.content)}</div>
            )
          })()}
          {results.length > limit && (
            <button className="ghost" onClick={() => setLimit(limit + PAGE)}>
              Show more
            </button>
          )}
        </section>
      ) : (
        <>
          {all.length === 0 && <p className="empty">No entries yet.</p>}
          {plant ? (
            <VineList
              items={shown.map((item, i): VineItem => {
                const d = itemData(item)
                const first = i === 0 || itemData(shown[i - 1]).date !== d.date
                return {
                  id: d.id,
                  createdAt: d.createdAt,
                  content: (
                    <>
                      {first && <h2 className="timeline-date">{formatDay(d.date)}</h2>}
                      <EntryCard item={item} />
                    </>
                  ),
                }
              })}
              allIdsOldestFirst={all.map((i) => itemData(i).id).reverse()}
            />
          ) : (
            groups.map((g) => (
              <section key={g.date} className="timeline-day">
                <h2 className="timeline-date">{formatDay(g.date)}</h2>
                <div className="entry-list">
                  {g.items.map((item) => (
                    <EntryCard key={itemData(item).id} item={item} />
                  ))}
                </div>
              </section>
            ))
          )}
          {all.length > limit && (
            <button className="ghost" onClick={() => setLimit(limit + PAGE)}>
              Show older entries
            </button>
          )}
        </>
      )}
    </div>
  )
}
