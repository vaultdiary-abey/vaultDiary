import type { ReactNode } from 'react'
import { UpdateBanner } from './components'
import { useController } from './controllerContext'
import { href, type Route } from './router'

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

function Banners() {
  const c = useController()
  const s = c.sync?.status
  const needsAuth = c.online && (!c.auth.hasToken() || s?.state === 'needs-auth')
  return (
    <>
      <UpdateBanner />
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
  { route: { name: 'timeline' }, label: 'Timeline', icon: '☰', match: ['timeline'] },
  { route: { name: 'calendar', month: null }, label: 'Calendar', icon: '▦', match: ['calendar'] },
  { route: { name: 'settings' }, label: 'Settings', icon: '⚙', match: ['settings'] },
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
