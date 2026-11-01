import { useEffect, useState, type FormEvent } from 'react'
import { passkeySupport, type PasskeySupport } from '../../core/webauthn'
import { passkeyWrappers } from '../../crypto/passkey'
import { Card, ErrorNote, PassphraseInput, Spinner } from '../components'
import { useController } from '../controllerContext'

function formatDate(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString()
}

function AddPasskey() {
  const c = useController()
  const setup = c.passkeySetup
  const [open, setOpen] = useState(false)
  const [passphrase, setPassphrase] = useState('')
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const run = async (what: string, action: () => Promise<void>) => {
    setBusy(what)
    setError(null)
    try {
      await action()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const cancel = () => {
    c.cancelAddPasskey()
    setOpen(false)
    setPassphrase('')
    setError(null)
  }

  if (!open && !setup) {
    return (
      <>
        {done && <p className="note note-ok">{done}</p>}
        <button
          className="primary"
          onClick={() => {
            setDone(null)
            setOpen(true)
          }}
        >
          Add passkey
        </button>
      </>
    )
  }

  if (!setup) {
    const submit = (e: FormEvent) => {
      e.preventDefault()
      void run('Checking your passphrase…', async () => {
        await c.beginAddPasskey(passphrase)
        setPassphrase('')
      })
    }
    return (
      <form className="stack" onSubmit={submit}>
        <p className="small">Step 1 of 3 · Confirm it's you</p>
        <PassphraseInput
          id="pk-pass"
          label="Your passphrase"
          value={passphrase}
          onChange={setPassphrase}
          autoComplete="current-password"
          autoFocus
        />
        <ErrorNote message={error} onClose={() => setError(null)} />
        {busy ? (
          <Spinner label={busy} />
        ) : (
          <div className="row">
            <button className="primary" type="submit" disabled={!passphrase}>
              Continue
            </button>
            <button className="ghost" type="button" onClick={cancel}>
              Cancel
            </button>
          </div>
        )}
      </form>
    )
  }

  if (setup.step === 'create') {
    return (
      <div className="stack">
        <p className="small">Step 2 of 3 · Create the passkey</p>
        <p className="muted small">
          Your phone or browser asks where to save it (for example Apple Passwords / iCloud Keychain
          or Google Password Manager) and checks your face, fingerprint or screen lock.
        </p>
        <ErrorNote message={error} onClose={() => setError(null)} />
        {busy ? (
          <Spinner label={busy} />
        ) : (
          <div className="row">
            <button
              className="primary"
              onClick={() =>
                void run('Waiting for your passkey…', async () => {
                  await c.createPasskeyCredential()
                })
              }
            >
              Create passkey
            </button>
            <button className="ghost" onClick={cancel}>
              Cancel
            </button>
          </div>
        )}
      </div>
    )
  }

  const finish = (e: FormEvent) => {
    e.preventDefault()
    const name = label.trim() || setup.created.defaultLabel
    void run('Waiting for your passkey…', async () => {
      await c.finishAddPasskey(name)
      setOpen(false)
      setLabel('')
      setDone(`"${name}" can now unlock your diary at this address.`)
    })
  }
  return (
    <form className="stack" onSubmit={finish}>
      <p className="small">Step 3 of 3 · Name it and confirm</p>
      <div className="field">
        <label htmlFor="pk-label">Name</label>
        <input
          id="pk-label"
          value={label}
          placeholder={setup.created.defaultLabel}
          onChange={(e) => setLabel(e.target.value)}
          maxLength={60}
        />
      </div>
      <p className="muted small">
        Use the passkey once more so the diary key can be locked to it. It's saved only if that
        works.
      </p>
      <ErrorNote message={error} onClose={() => setError(null)} />
      {busy ? (
        <Spinner label={busy} />
      ) : (
        <div className="row">
          <button className="primary" type="submit">
            Confirm with passkey
          </button>
          <button className="ghost" type="button" onClick={cancel}>
            Cancel
          </button>
        </div>
      )}
    </form>
  )
}

export function Passkeys() {
  const c = useController()
  const [support, setSupport] = useState<PasskeySupport | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    void passkeySupport().then(setSupport)
  }, [])
  const host = location.hostname
  const slots = passkeyWrappers(c.vault)

  const remove = async (id: string, label: string) => {
    if (!confirm(`Remove the passkey "${label}"? Your passphrase and recovery words still work.`))
      return
    setError(null)
    try {
      await c.removePasskey(id)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <Card>
      <h2>Passkeys</h2>
      <p className="muted small">
        Unlock with Face ID, Touch ID or your screen lock instead of typing your passphrase. Your
        passphrase and recovery words always keep working.
      </p>
      {slots.length > 0 ? (
        <ul className="passkey-list">
          {slots.map((w) => (
            <li key={w.id}>
              <div>
                <strong>{w.label}</strong>
                <span className="muted small">
                  {' '}
                  · added {formatDate(w.createdAt)}
                  {w.rpId !== host && <> · other site ({w.rpId})</>}
                </span>
              </div>
              {!c.readOnly && (
                <button className="ghost small danger" onClick={() => void remove(w.id, w.label)}>
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="small">No passkeys yet.</p>
      )}
      <ErrorNote message={error} onClose={() => setError(null)} />
      {!c.readOnly &&
        (support === null ? null : support.available ? (
          <AddPasskey />
        ) : (
          <p className="note">{support.reason}</p>
        ))}
      <details className="small">
        <summary>Good to know</summary>
        <ul>
          <li>
            A passkey belongs to one app address. The GitHub Pages and Firebase addresses each need
            their own passkey; passkeys for the other one are shown as "other site".
          </li>
          <li>
            Use a passkey stored on the device in your hand. Signing in with a phone through a QR
            code may not hand over the secret needed to unlock, and then you'll be asked for your
            passphrase.
          </li>
          <li>
            Removing a passkey here only stops it unlocking this diary. You can also delete it in
            your password manager.
          </li>
        </ul>
      </details>
    </Card>
  )
}
