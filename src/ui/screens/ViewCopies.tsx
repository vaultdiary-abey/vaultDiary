// Settings → "Make viewing copies for older photos" (HEIC → JPEG, Phase 3 C).
import { useEffect, useState } from 'react'
import { canDecodeHeic } from '../../media/heic'
import { Card, Spinner } from '../components'
import { useController } from '../controllerContext'

export function ViewCopies() {
  const c = useController()
  const job = c.viewCopyJob
  const [canDecode, setCanDecode] = useState<boolean | null>(null)
  const [pending, setPending] = useState<number | null>(null)
  const status = job?.status
  const running = !!status?.running

  useEffect(() => {
    void canDecodeHeic().then(setCanDecode)
  }, [])
  useEffect(() => {
    if (!running) void job?.pending().then(setPending)
  }, [job, running])

  if (!job || c.readOnly) return null
  const downloading = c.session?.summaries.size ?? 0
  return (
    <Card className="view-copies">
      <h2>Photos from iPhone (HEIC)</h2>
      <p className="muted small">
        Most browsers other than Safari can't show HEIC photos. When you add one on a device that
        can (such as your iPhone), the app also stores a JPEG viewing copy, encrypted like
        everything else. The original is always kept.
      </p>
      {canDecode === false ? (
        <p className="hint" data-testid="viewcopy-status">
          This browser can't read HEIC photos. To make viewing copies for older photos, open
          Settings on your iPhone (Safari or the installed app).
        </p>
      ) : running && status ? (
        <div data-testid="viewcopy-status">
          <Spinner
            label={
              status.waitingForUploads
                ? 'Waiting for uploads to catch up…'
                : `Making viewing copies… ${status.made} done, ${status.remaining} to go`
            }
          />
          <button className="ghost" onClick={() => job.stop()}>
            Stop
          </button>
        </div>
      ) : (
        <>
          <p className="small" data-testid="viewcopy-status">
            {status && (status.made || status.failed || status.skipped)
              ? `Made ${status.made} viewing ${status.made === 1 ? 'copy' : 'copies'}` +
                (status.failed ? `, ${status.failed} photo(s) couldn't be read` : '') +
                (status.skipped ? `, ${status.skipped} skipped (offline or being edited)` : '') +
                '. '
              : ''}
            {pending === null
              ? ''
              : pending === 0
                ? 'Every HEIC photo has a viewing copy.'
                : `${pending} HEIC photo${pending === 1 ? '' : 's'} without a viewing copy.`}
            {downloading > 0 && ` ${downloading} entries are still downloading.`}
          </p>
          <button
            className="primary"
            disabled={!canDecode || !pending || !c.online}
            onClick={async () => {
              // After the app was reopened, Google needs a new sign-in first (from the tap).
              if (!c.auth.hasToken()) await c.signIn()
              await job.start()
            }}
          >
            Make viewing copies for older photos
          </button>
        </>
      )}
    </Card>
  )
}
