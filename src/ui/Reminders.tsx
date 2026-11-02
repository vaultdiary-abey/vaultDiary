// Today-view extras: "On this day", the evening writing nudge and the backup reminder.
import { useEffect, useState } from 'react'
import { getNudgeDismissedOn, getNudgeTime, setNudgeDismissedOn } from '../core/prefs'
import { today } from '../lib/dates'
import { localDate } from '../model/entry'
import { backupOverdue, daysSince, onThisDay, shouldNudge } from '../model/reminders'
import { ErrorNote, ProgressBar, Spinner } from './components'
import { useController } from './controllerContext'
import { useBackup, useLastBackup } from './useBackup'
import { itemData } from './itemData'
import { href } from './router'

/** Re-renders every minute, so time-based banners appear without reopening the app. */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000)
    const onVisible = () => document.visibilityState === 'visible' && setNow(new Date())
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])
  return now
}

export function OnThisDay() {
  const c = useController()
  const day = today()
  const groups = onThisDay((c.session?.list() ?? []).map(itemData), day)
  if (!groups.length) return null
  return (
    <section className="card on-this-day" aria-labelledby="otd-title">
      <h2 id="otd-title">On this day</h2>
      {groups.map((g) => (
        <div key={g.year} className="otd-year">
          <h3>
            {g.yearsAgo === 1 ? '1 year ago' : `${g.yearsAgo} years ago`}{' '}
            <span className="muted">· {g.year}</span>
          </h3>
          <ul>
            {[...g.items].reverse().map((item) => (
              <li key={item.id}>
                <a href={href({ name: 'entry', id: item.id, edit: false })}>
                  <strong>{item.title}</strong>
                  {item.excerpt && <span className="muted small"> — {item.excerpt}</span>}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  )
}

export function WritingNudge({ hasEntryToday }: { hasEntryToday: boolean }) {
  const c = useController()
  const now = useNow()
  const [dismissedOn, setDismissed] = useState(getNudgeDismissedOn)
  const day = localDate(now)
  if (
    c.readOnly ||
    !shouldNudge({ now, nudgeTime: getNudgeTime(), hasEntryToday, dismissedOn, today: day })
  ) {
    return null
  }
  return (
    <div className="banner banner-gentle" role="status">
      <span>No entry yet today. A few lines are enough.</span>
      <span className="row">
        <a className="primary small button-like" href={href({ name: 'new', date: null })}>
          Write now
        </a>
        <button
          className="ghost small"
          onClick={() => {
            setNudgeDismissedOn(day)
            setDismissed(day)
          }}
        >
          Not today
        </button>
      </span>
    </div>
  )
}

export function BackupProgress({ progress }: { progress: { done: number; total: number } }) {
  return (
    <div>
      <Spinner label={`Downloading ${progress.done} of ${progress.total} files…`} />
      <ProgressBar value={progress.done} max={progress.total} />
    </div>
  )
}

/** "Back up now" banner when the last encrypted backup is more than 30 days old. */
export function BackupReminder() {
  const c = useController()
  const now = useNow()
  const last = useLastBackup()
  const { progress, error, setError, run } = useBackup()
  // Until the first sync of this visit, settings.vds (with the date of a backup made on another
  // device) may not have arrived yet; don't nag on stale information.
  const settled = c.settingsSettled
  if (
    !progress &&
    !error &&
    (!settled ||
      !backupOverdue({ lastBackupAt: last, vaultCreatedAt: c.vault?.createdAt ?? null, now }))
  ) {
    return null
  }
  return (
    <div className="banner banner-action banner-backup" role="status">
      {progress ? (
        <BackupProgress progress={progress} />
      ) : (
        <>
          <span>
            {last
              ? `Your last encrypted backup was ${daysSince(last, now)} days ago.`
              : "You haven't made an encrypted backup yet."}{' '}
            Keep a copy outside Google Drive.
          </span>
          <button className="primary small" onClick={() => void run()} disabled={!c.online}>
            Back up now
          </button>
        </>
      )}
      <ErrorNote message={error} onClose={() => setError(null)} />
    </div>
  )
}
