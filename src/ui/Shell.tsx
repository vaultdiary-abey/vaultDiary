import type { ReactNode } from 'react'
import { useState } from 'react'
import { formatBytes } from '../lib/download'
import { UpdateBanner } from './components'
import { useController } from './controllerContext'
import { href, navigate, type Route } from './router'

function SyncBadge() {
  const c = useController()
  const s = c.sync?.status
  const uploads = c.uploads.items().length
  let label = 'Synced'
  let tone = 'ok'
  if (!c.online) {
    label = 'Offline'
    tone = 'warn'
  } else if (!s || s.state === 'needs-auth') {
    label = 'Not connected'
    tone = 'warn'
  } else if (s.state === 'syncing') {
    label = s.downloading ? `Syncing ${s.downloading.done}/${s.downloading.total}` : 'Syncing…'
    tone = 'busy'
  } else if (s.state === 'error') {
    label = 'Sync error'
    tone = 'error'
  } else if (s.pendingEntries || uploads) {
    label = `${s.pendingEntries + uploads} to upload`
    tone = 'busy'
  }
  return (
    <a className={`badge badge-${tone}`} href={href({ name: 'settings' })} title="Sync status">
      {label}
    </a>
  )
}

/** Offers to recover a recording left over from a crash, a closed tab or a lock. */
function RecordingRecovery() {
  const c = useController()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const rec = c.pendingRecordings[0]
  if (!rec || c.readOnly) return null
  const secs = Math.round(rec.durationMs / 1000)
  const what = rec.kind === 'audio' ? 'voice note' : 'video'
  const recover = async () => {
    setBusy(true)
    setError(null)
    try {
      const entryId = await c.recoverRecording(rec.id)
      navigate({ name: 'entry', id: entryId, edit: false })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const discard = async () => {
    if (!confirm(`Throw away this unfinished ${what}? It can't be recovered afterwards.`)) return
    await c.discardRecording(rec.id)
  }
  return (
    <div className="banner banner-action" role="status">
      <span>
        An unfinished {what} from {new Date(rec.startedAt).toLocaleString()} (
        {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, '0')}, {formatBytes(rec.bytes)})
        wasn't saved.{error && ` ${error}`}
      </span>
      <span className="row">
        <button className="primary small" onClick={() => void recover()} disabled={busy}>
          {busy ? 'Recovering…' : 'Recover'}
        </button>
        <button className="ghost small" onClick={() => void discard()} disabled={busy}>
          Discard
        </button>
      </span>
    </div>
  )
}

function Banners() {
  const c = useController()
  const s = c.sync?.status
  const needsAuth = c.online && (!c.auth.hasToken() || s?.state === 'needs-auth')
  return (
    <>
      <UpdateBanner />
      <RecordingRecovery />
      {c.readOnly && (
        <div className="banner">Read-only copy: you can read and download, not edit.</div>
      )}
      {!c.online && (
        <div className="banner">
          You're offline. Changes are saved on this device and sync later.
        </div>
      )}
      {needsAuth && (
        <div className="banner banner-action">
          <span>Google Drive needs you to sign in again to sync.</span>
          <button
            className="primary small"
            onClick={() => void c.signIn()}
            disabled={!c.auth.ready}
          >
            Continue
          </button>
        </div>
      )}
      {c.error && (
        <div className="banner banner-error" role="alert">
          <span>{c.error}</span>
          <button className="link" onClick={() => c.clearError()} aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}
    </>
  )
}

const TABS: { route: Route; label: string; icon: string; match: Route['name'][] }[] = [
  { route: { name: 'day', date: null }, label: 'Today', icon: '✎', match: ['day', 'entry', 'new'] },
  { route: { name: 'timeline', tag: null }, label: 'Timeline', icon: '☰', match: ['timeline'] },
  { route: { name: 'calendar', month: null }, label: 'Calendar', icon: '▦', match: ['calendar'] },
  { route: { name: 'insights', year: null }, label: 'Insights', icon: '✦', match: ['insights'] },
  { route: { name: 'settings' }, label: 'Settings', icon: '⚙', match: ['settings', 'templates'] },
]

export function Shell({ route, children }: { route: Route; children: ReactNode }) {
  const c = useController()
  return (
    <div className="shell">
      <header className="topbar">
        <a className="brand" href={href({ name: 'day', date: null })}>
          Vault Diary
        </a>
        <div className="topbar-actions">
          <SyncBadge />
          <button className="ghost small" onClick={() => void c.lock()} aria-label="Lock now">
            🔒 Lock
          </button>
        </div>
      </header>
      <Banners />
      <main className="content">{children}</main>
      <nav className="tabbar" aria-label="Main">
        {TABS.map((t) => (
          <a
            key={t.label}
            href={href(t.route)}
            className={t.match.includes(route.name) ? 'active' : ''}
            aria-current={t.match.includes(route.name) ? 'page' : undefined}
          >
            <span aria-hidden="true">{t.icon}</span>
            {t.label}
          </a>
        ))}
      </nav>
    </div>
  )
}
