import { useState } from 'react'
import { addDays, formatDay, today } from '../../lib/dates'
import { promptFor } from '../../model/prompts'
import { liveTemplates, setShowPrompts } from '../../model/settings'
import { useController } from '../controllerContext'
import { EntryCard } from '../EntryCard'
import { itemData } from '../itemData'
import { href } from '../router'
import { BackupReminder, OnThisDay, WritingNudge } from '../Reminders'

export function DayView({ date }: { date: string | null }) {
  const c = useController()
  const day = date ?? today()
  const items = (c.session?.list() ?? []).filter((i) => itemData(i).date === day).reverse()
  const isToday = day === today()
  const [promptOffset, setPromptOffset] = useState(0)
  const settings = c.session?.settings
  const templates = settings ? liveTemplates(settings) : []
  const showPrompt = isToday && !c.readOnly && !!settings?.showPrompts.value
  return (
    <div className="page">
      <div className="day-nav">
        <a
          className="ghost small"
          href={href({ name: 'day', date: addDays(day, -1) })}
          aria-label="Previous day"
        >
          ‹
        </a>
        <div className="day-title">
          <h1>{isToday ? 'Today' : formatDay(day, 'short')}</h1>
          {isToday && <p className="muted">{formatDay(day)}</p>}
        </div>
        <a
          className="ghost small"
          href={href({ name: 'day', date: addDays(day, 1) })}
          aria-label="Next day"
        >
          ›
        </a>
      </div>
      {isToday && <WritingNudge hasEntryToday={items.length > 0} />}
      {isToday && <BackupReminder />}
      {!isToday && (
        <p className="center">
          <a href={href({ name: 'day', date: null })}>Back to today</a>
        </p>
      )}
      {showPrompt && (
        <section className="card prompt-card" aria-label="Writing prompt">
          <p className="prompt-text">{promptFor(day, promptOffset)}</p>
          <div className="row">
            <a
              className="ghost small button-like"
              href={href({ name: 'new', date: null, prompt: promptOffset })}
            >
              Write about this
            </a>
            <button className="ghost small" onClick={() => setPromptOffset(promptOffset + 1)}>
              Another
            </button>
            <button
              className="link small-link"
              onClick={() => {
                if (c.session)
                  void c.session.saveSettings(setShowPrompts(c.session.settings, false))
              }}
            >
              Hide prompts
            </button>
          </div>
        </section>
      )}
      {items.length === 0 && (
        <p className="empty">
          {isToday ? 'Nothing written today yet.' : 'No entries on this day.'}
        </p>
      )}
      <div className="entry-list">
        {items.map((item) => (
          <EntryCard key={itemData(item).id} item={item} />
        ))}
      </div>
      {isToday && <OnThisDay />}
      {!c.readOnly && templates.length > 0 && (
        <div className="template-picker">
          <span className="muted small">Start from a template:</span>
          <div className="chips">
            {templates.map((t) => (
              <a
                key={t.id}
                className="chip"
                href={href({ name: 'new', date: isToday ? null : day, template: t.id })}
              >
                {t.name}
              </a>
            ))}
          </div>
        </div>
      )}
      {!c.readOnly && (
        <a className="primary big fab" href={href({ name: 'new', date: isToday ? null : day })}>
          + New entry
        </a>
      )}
    </div>
  )
}
