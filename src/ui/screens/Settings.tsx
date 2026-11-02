import { useState, type FormEvent } from 'react'
import type { StorageReport } from '../../core/controller'
import {
  AUTO_LOCK_CHOICES,
  getAutoLockMinutes,
  getMaxVideoMinutes,
  MAX_VIDEO_CHOICES,
  setMaxVideoMinutes,
  getTheme,
  setAutoLockMinutes,
  setTheme,
  type Theme,
} from '../../core/prefs'
import { passphraseProblem } from '../../crypto/vault'
import { formatBytes, saveBlob } from '../../lib/download'
import { localDate } from '../../model/entry'
import { Card, ErrorNote, PassphraseInput, ProgressBar, Spinner } from '../components'
import { useController } from '../controllerContext'
import { liveTemplates, setShowPrompts } from '../../model/settings'
import { href } from '../router'
import { Passkeys } from './Passkeys'
import { UploadsList } from './UploadsList'

function Preferences() {
  const [minutes, setMinutes] = useState(getAutoLockMinutes)
  const [theme, setThemeState] = useState<Theme>(getTheme)
  const [maxVideo, setMaxVideo] = useState(getMaxVideoMinutes)
  return (
    <Card>
      <h2>This device</h2>
      <div className="field">
        <label htmlFor="autolock">Lock after being idle for</label>
        <select
          id="autolock"
          value={minutes}
          onChange={(e) => {
            const n = Number(e.target.value)
            setMinutes(n)
            setAutoLockMinutes(n)
          }}
        >
          {AUTO_LOCK_CHOICES.map((n) => (
            <option key={n} value={n}>
              {n} {n === 1 ? 'minute' : 'minutes'}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="theme">Theme</label>
        <select
          id="theme"
          value={theme}
          onChange={(e) => {
            const t = e.target.value as Theme
            setThemeState(t)
            setTheme(t)
          }}
        >
          <option value="system">Match system</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="maxvideo">Longest video to record</label>
        <select
          id="maxvideo"
          value={maxVideo}
          onChange={(e) => {
            const n = Number(e.target.value)
            setMaxVideo(n)
            setMaxVideoMinutes(n)
          }}
        >
          {MAX_VIDEO_CHOICES.map((n) => (
            <option key={n} value={n}>
              {n} {n === 1 ? 'minute' : 'minutes'}
            </option>
          ))}
        </select>
        <p className="hint">
          Recording stops by itself at this length. Video is roughly 20 MB a minute.
        </p>
      </div>
    </Card>
  )
}

function ChangePassphrase() {
  const c = useController()
  const [current, setCurrent] = useState('')
  const [p1, setP1] = useState('')
  const [p2, setP2] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const problem = p1 ? passphraseProblem(p1) : null

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (problem || p1 !== p2) return
    setBusy(true)
    setError(null)
    setDone(false)
    try {
      await c.changePassphrase(current, p1)
      setCurrent('')
      setP1('')
      setP2('')
      setDone(true)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <h2>Change passphrase</h2>
      <p className="muted small">
        Only the key wrapper in vault.json changes; your entries are not re-encrypted. Your recovery
        words and passkeys keep working.
      </p>
      <form className="stack" onSubmit={submit}>
        <PassphraseInput
          id="cp0"
          label="Current passphrase"
          value={current}
          onChange={setCurrent}
          autoComplete="current-password"
        />
        <PassphraseInput
          id="cp1"
          label="New passphrase"
          value={p1}
          onChange={setP1}
          autoComplete="new-password"
        />
        {problem && <p className="hint warn">{problem}</p>}
        <PassphraseInput
          id="cp2"
          label="Repeat new passphrase"
          value={p2}
          onChange={setP2}
          autoComplete="new-password"
        />
        {p2 && p1 !== p2 && <p className="hint warn">The two passphrases don't match.</p>}
        <ErrorNote message={error} onClose={() => setError(null)} />
        {done && (
          <p className="note note-ok">
            Passphrase changed. Other devices pick it up when they sync.
          </p>
        )}
        {busy ? (
          <Spinner label="Re-wrapping your key…" />
        ) : (
          <button
            className="primary"
            type="submit"
            disabled={!current || !p1 || !!problem || p1 !== p2}
          >
            Change passphrase
          </button>
        )}
      </form>
    </Card>
  )
}

function Storage() {
  const c = useController()
  const [report, setReport] = useState<StorageReport | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const check = async () => {
    setBusy(true)
    setError(null)
    try {
      setReport(await c.storageReport())
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card>
      <h2>Storage</h2>
      {report && (
        <dl className="facts">
          <dt>Vault in Google Drive</dt>
          <dd>
            {formatBytes(report.driveBytes)} ({report.entryCount} entries, {report.fileCount} files)
          </dd>
          {report.quotaUsage !== null && (
            <>
              <dt>Your whole Google storage</dt>
              <dd>
                {formatBytes(report.quotaUsage)}
                {report.quotaLimit ? ` of ${formatBytes(report.quotaLimit)}` : ''}
              </dd>
            </>
          )}
          {report.localBytes !== null && (
            <>
              <dt>Offline copy on this device</dt>
              <dd>{formatBytes(report.localBytes)}</dd>
            </>
          )}
        </dl>
      )}
      <ErrorNote message={error} onClose={() => setError(null)} />
      {busy ? (
        <Spinner label="Checking…" />
      ) : (
        <button className="ghost" onClick={() => void check()}>
          {report ? 'Check again' : 'Check storage used'}
        </button>
      )}
    </Card>
  )
}

function Backup() {
  const c = useController()
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const run = async () => {
    setError(null)
    setProgress({ done: 0, total: 1 })
    try {
      const zip = await c.backup((done, total) => setProgress({ done, total }))
      saveBlob(zip, `VaultDiary-backup-${localDate()}.zip`)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setProgress(null)
    }
  }
  return (
    <Card>
      <h2>Backup and recovery</h2>
      <p className="muted small">
        The backup is a zip of your whole vault exactly as stored in Drive — still encrypted,
        including vault.json. Open it later with the recovery tool, your passphrase or recovery
        words.
      </p>
      {progress ? (
        <div>
          <Spinner label={`Downloading ${progress.done} of ${progress.total} files…`} />
          <ProgressBar value={progress.done} max={progress.total} />
        </div>
      ) : (
        <button className="primary" onClick={() => void run()} disabled={!c.online}>
          Download encrypted backup (.zip)
        </button>
      )}
      <ErrorNote message={error} onClose={() => setError(null)} />
      <p>
        <a href="./recovery.html" download>
          Download the offline recovery tool (recovery.html)
        </a>
      </p>
    </Card>
  )
}

function Writing() {
  const c = useController()
  const session = c.session
  if (!session || c.readOnly) return null
  const n = liveTemplates(session.settings).length
  return (
    <Card>
      <h2>Templates and prompts</h2>
      <p className="small">
        {n ? `${n} template${n === 1 ? '' : 's'}.` : 'No templates yet.'}{' '}
        <a href={href({ name: 'templates', edit: null })}>Manage templates</a>
      </p>
      <label className="check">
        <input
          type="checkbox"
          checked={session.settings.showPrompts.value}
          onChange={(e) =>
            void session.saveSettings(setShowPrompts(session.settings, e.target.checked))
          }
        />
        Show a writing prompt on the Today page
      </label>
      <p className="hint">Templates and this choice sync to your other devices, encrypted.</p>
    </Card>
  )
}

function SyncDetails() {
  const c = useController()
  const s = c.sync?.status
  if (!s) return null
  return (
    <Card>
      <h2>Sync</h2>
      <dl className="facts">
        <dt>Google account</dt>
        <dd>{c.account?.email ?? 'Unknown'}</dd>
        <dt>Last synced</dt>
        <dd>
          {s.lastSyncedAt ? new Date(s.lastSyncedAt).toLocaleString() : 'Not yet on this visit'}
        </dd>
        <dt>Entries waiting to upload</dt>
        <dd>{s.pendingEntries}</dd>
      </dl>
      {s.error && <ErrorNote message={s.error} />}
      {s.problems.length > 0 && (
        <details>
          <summary>{s.problems.length} problem(s) during the last sync</summary>
          <ul className="small">
            {s.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </details>
      )}
      <UploadsList />
      <button className="ghost" onClick={() => c.syncNow()} disabled={!c.online}>
        Sync now
      </button>
    </Card>
  )
}

function DangerZone() {
  const c = useController()
  const forget = async () => {
    const pending = (c.sync?.status.pendingEntries ?? 0) + c.uploads.items().length
    const warning = pending
      ? `${pending} change(s) have not reached Google Drive yet and will be LOST. `
      : ''
    if (
      !confirm(
        `${warning}Remove the vault from this browser? Your Google Drive copy is not touched.`,
      )
    )
      return
    await c.forgetDevice()
  }
  return (
    <Card>
      <h2>Remove from this device</h2>
      <p className="muted small">
        Deletes the offline copy from this browser and signs out of Google. Your diary stays in
        Google Drive.
      </p>
      <button className="ghost danger" onClick={() => void forget()}>
        Remove vault from this device
      </button>
    </Card>
  )
}

export function Settings() {
  const c = useController()
  return (
    <div className="page settings">
      <h1>Settings</h1>
      {c.readOnly && <p className="note">This is a read-only build: editing is turned off.</p>}
      <Preferences />
      <Writing />
      <SyncDetails />
      <Passkeys />
      {!c.readOnly && <ChangePassphrase />}
      <Storage />
      <Backup />
      <DangerZone />
      <p className="muted small center">Vault Diary · format VDV1 · no analytics, no trackers</p>
    </div>
  )
}
