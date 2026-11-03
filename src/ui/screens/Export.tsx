// Settings → Export: Markdown (.zip) or PDF (print view → Save as PDF) for a date range.
// The files are NOT encrypted, so this warns and asks for the passphrase or a passkey first.
import { useState, type FormEvent } from 'react'
import { attachmentBytes, type DateRange } from '../../core/exporter'
import { canTryPasskey } from '../../core/webauthn'
import { formatBytes, saveBlob } from '../../lib/download'
import { today } from '../../lib/dates'
import { Card, ErrorNote, PassphraseInput, ProgressBar, Spinner } from '../components'
import { useController } from '../controllerContext'

type Format = 'markdown' | 'pdf'

function firstEntryDate(dates: string[]): string {
  return dates.reduce((min, d) => (d < min ? d : min), today())
}

export function ExportCard() {
  const c = useController()
  const allDates = (c.session?.list() ?? []).map((i) =>
    i.kind === 'entry' ? i.entry.date : i.summary.date,
  )
  const earliest = firstEntryDate(allDates)
  const [range, setRange] = useState<DateRange>(() => ({ from: earliest, to: today() }))
  const [format, setFormat] = useState<Format>('markdown')
  const [includeLocations, setIncludeLocations] = useState(true)
  const [step, setStep] = useState<'choose' | 'confirm'>('choose')
  const [passphrase, setPassphrase] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const passkeys = canTryPasskey() ? c.passkeysHere() : []

  const valid = range.from <= range.to
  const { entries, pending } = c.exportEntries(range)
  const attachments = new Set(entries.flatMap((e) => e.attachments.map((a) => a.fileId))).size
  const bytes = attachmentBytes(entries)

  const preset = (from: string) => setRange({ from, to: today() })
  const year = today().slice(0, 4)
  const month = today().slice(0, 7)

  const run = async () => {
    setError(null)
    setResult(null)
    try {
      if (format === 'pdf') {
        c.openPrintView(range, { includeLocations })
        return
      }
      setBusy('Decrypting attachments…')
      const out = await c.exportMarkdown(range, (done, total) => setProgress({ done, total }), {
        includeLocations,
      })
      setBusy('Saving…')
      saveBlob(out.zip, out.name)
      setResult(
        out.problems.length
          ? `Exported, but ${out.problems.length} attachment(s) couldn't be included: ${out.problems.join('; ')}`
          : `Exported ${entries.length} entries as ${out.name}.`,
      )
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
      setProgress(null)
      setStep('choose')
    }
  }

  const confirmAndRun = async (secret: { passphrase: string } | { passkey: true }) => {
    setError(null)
    setBusy('Checking…')
    try {
      await c.confirmForExport(secret)
      setPassphrase('')
    } catch (e) {
      setError((e as Error).message)
      setBusy(null)
      return
    }
    await run()
  }

  const submitPassphrase = (e: FormEvent) => {
    e.preventDefault()
    if (passphrase) void confirmAndRun({ passphrase })
  }

  return (
    <Card className="export">
      <h2>Export</h2>
      <p className="muted small">
        Save entries as readable files: Markdown in a .zip (attachments in a files/ folder), or a
        PDF through your browser's Print → Save as PDF.
      </p>
      {step === 'choose' && (
        <div className="stack">
          <div className="chips" role="group" aria-label="Quick ranges">
            <button className="chip" onClick={() => preset(`${month}-01`)}>
              This month
            </button>
            <button className="chip" onClick={() => preset(`${year}-01-01`)}>
              This year
            </button>
            <button className="chip" onClick={() => preset(earliest)}>
              Everything
            </button>
          </div>
          <div className="row date-range">
            <div className="field">
              <label htmlFor="export-from">From</label>
              <input
                id="export-from"
                type="date"
                value={range.from}
                max={range.to}
                onChange={(e) => e.target.value && setRange({ ...range, from: e.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="export-to">To</label>
              <input
                id="export-to"
                type="date"
                value={range.to}
                min={range.from}
                onChange={(e) => e.target.value && setRange({ ...range, to: e.target.value })}
              />
            </div>
          </div>
          <fieldset className="field radio-group">
            <legend>Format</legend>
            <label>
              <input
                type="radio"
                name="export-format"
                checked={format === 'markdown'}
                onChange={() => setFormat('markdown')}
              />{' '}
              Markdown files (.zip)
            </label>
            <label>
              <input
                type="radio"
                name="export-format"
                checked={format === 'pdf'}
                onChange={() => setFormat('pdf')}
              />{' '}
              PDF (print view)
            </label>
          </fieldset>
          <label className="check">
            <input
              type="checkbox"
              checked={includeLocations}
              onChange={(e) => setIncludeLocations(e.target.checked)}
            />{' '}
            Include locations
          </label>
          {!includeLocations && (
            <p className="hint">Place names and coordinates are left out of the export.</p>
          )}
          <p className="small" data-testid="export-summary">
            {valid
              ? `${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}` +
                (attachments
                  ? `, ${attachments} attachment${attachments === 1 ? '' : 's'} (${formatBytes(bytes)})`
                  : '')
              : 'The start date is after the end date.'}
          </p>
          {format === 'pdf' && attachments > 0 && (
            <p className="hint">Photos are printed inline; audio, video and other files by name.</p>
          )}
          {pending > 0 && (
            <p className="hint warn">
              {pending} entries in this range are still downloading. Wait until sync has finished.
            </p>
          )}
          <button
            className="primary"
            disabled={!valid || !entries.length || pending > 0}
            onClick={() => {
              setResult(null)
              setError(null)
              setStep('confirm')
            }}
          >
            Export…
          </button>
        </div>
      )}
      {step === 'confirm' && (
        <div className="stack">
          <div className="note note-warn" role="alert">
            <strong>These files will NOT be encrypted.</strong> Anyone who gets them — on this
            device, in a cloud folder or as an email attachment — can read them. Delete them when
            you no longer need them.
          </div>
          {busy ? (
            <div>
              <Spinner label={busy} />
              {progress && <ProgressBar value={progress.done} max={progress.total || 1} />}
            </div>
          ) : (
            <>
              {passkeys.length > 0 && (
                <button className="primary" onClick={() => void confirmAndRun({ passkey: true })}>
                  Confirm with passkey (Face ID / Touch ID)
                </button>
              )}
              <form className="stack" onSubmit={submitPassphrase}>
                <PassphraseInput
                  id="export-pass"
                  label={passkeys.length ? 'Or type your passphrase' : 'Your passphrase'}
                  value={passphrase}
                  onChange={setPassphrase}
                  autoComplete="current-password"
                />
                <button className="primary" type="submit" disabled={!passphrase}>
                  Confirm and export
                </button>
              </form>
              <button className="ghost" onClick={() => setStep('choose')}>
                Cancel
              </button>
            </>
          )}
        </div>
      )}
      <ErrorNote message={error} onClose={() => setError(null)} />
      {result && <p className="note note-ok">{result}</p>}
    </Card>
  )
}
