import { formatBytes } from '../../lib/download'
import { ProgressBar } from '../components'
import { useController } from '../controllerContext'

/** Upload queue with progress. Names come from decrypted entries (the queue stores none). */
export function UploadsList() {
  const c = useController()
  const items = c.uploads.items()
  if (!items.length) return null
  const names = new Map<string, string>()
  for (const e of c.session?.entries.values() ?? []) {
    for (const a of e.attachments) names.set(a.fileId, a.name)
  }
  return (
    <div className="uploads">
      <h3>Uploads ({items.length})</h3>
      <ul>
        {items.map((u) => (
          <li key={u.fileId}>
            <div className="row-between">
              <span className="attachment-name">{names.get(u.fileId) ?? 'Encrypted file'}</span>
              <span className="muted small">
                {formatBytes(u.uploaded)} / {formatBytes(u.size)}
              </span>
            </div>
            <ProgressBar value={u.uploaded} max={u.size} />
            {u.active ? (
              <p className="hint">Uploading…</p>
            ) : (
              u.lastError && (
                <p className="hint">
                  {u.lastError}
                  {u.attempts > 0 &&
                    ` · attempt ${u.attempts}, next try ${new Date(u.nextAttemptAt).toLocaleTimeString()}`}{' '}
                  <button className="link small-link" onClick={() => void c.uploads.retryNow()}>
                    Retry now
                  </button>
                </p>
              )
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
