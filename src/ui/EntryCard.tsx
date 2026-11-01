import { MOODS } from '../model/entry'
import type { ListItem } from '../core/session'
import { itemData } from './itemData'
import { formatTime } from '../lib/dates'
import { href } from './router'
import { Thumb } from './Thumb'

export function EntryCard({ item, showDate = false }: { item: ListItem; showDate?: boolean }) {
  const d = itemData(item)
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
      {d.excerpt && d.excerpt !== d.title && <p className="entry-card-excerpt">{d.excerpt}</p>}
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
