import { MOODS } from '../model/entry'
import type { Snippet } from '../search/text'
import type { ListItem } from '../core/session'
import { itemData } from './itemData'
import { formatTime } from '../lib/dates'
import { href } from './router'
import { Thumb } from './Thumb'

export function EntryCard({
  item,
  showDate = false,
  snippet = null,
}: {
  item: ListItem
  showDate?: boolean
  /** A search hit's context, with the matching words marked. */
  snippet?: Snippet | null
}) {
  const d = itemData(item)
  const tags = item.kind === 'entry' ? item.entry.tags : item.summary.tags
  const mood = MOODS.find((m) => m.value === d.mood)
  return (
    <a
      className={`entry-card ${d.pending ? 'pending' : ''}`}
      href={href({ name: 'entry', id: d.id, edit: false })}
    >
      <div className="entry-card-top">
        <strong className="entry-card-title">{d.title}</strong>
        {mood && (
          <span className="mood" title={mood.label}>
            {mood.emoji}
          </span>
        )}
      </div>
      {snippet ? (
        <p className="entry-card-excerpt">
          {snippet.before}
          {snippet.parts.map((p, i) => (p.match ? <mark key={i}>{p.text}</mark> : p.text))}
          {snippet.after}
        </p>
      ) : (
        d.excerpt && d.excerpt !== d.title && <p className="entry-card-excerpt">{d.excerpt}</p>
      )}
      {tags.length > 0 && (
        <div className="tag-line">
          {tags.map((t) => (
            <span key={t} className="tag">
              #{t}
            </span>
          ))}
        </div>
      )}
      {item.kind === 'entry' && item.entry.attachments.length > 0 && (
        <div className="thumb-strip">
          {item.entry.attachments.slice(0, 4).map((a) => (
            <Thumb key={a.fileId} attachment={a} />
          ))}
          {item.entry.attachments.length > 4 && (
            <span className="thumb thumb-more">+{item.entry.attachments.length - 4}</span>
          )}
        </div>
      )}
      <div className="entry-card-meta">
        {showDate ? <span>{d.date}</span> : <span>{formatTime(d.createdAt)}</span>}
        {d.attachments > 0 && <span>📎 {d.attachments}</span>}
        {d.pending && <span>Downloading…</span>}
      </div>
    </a>
  )
}
