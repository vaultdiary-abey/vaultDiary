import { useState, type FormEvent } from 'react'
import { passphraseProblem } from '../../crypto/vault'
import { canTryPasskey } from '../../core/webauthn'
import { ErrorNote, PassphraseInput, Spinner } from '../components'
import { useController } from '../controllerContext'

export function Unlock() {
  const c = useController()
  const passkeys = canTryPasskey() ? c.passkeysHere() : []
  const [mode, setMode] = useState<'passkey' | 'passphrase' | 'words'>(
    passkeys.length ? 'passkey' : 'passphrase',
  )
  const [passphrase, setPassphrase] = useState('')
  const [words, setWords] = useState('')

  const passkeyUnlock = async () => {
    // Called straight from the tap: Safari needs the user gesture for WebAuthn.
    const ok = await c.unlockWithPasskey()
    if (!ok) setMode('passphrase')
  }

  if (mode === 'passkey' && passkeys.length) {
    return (
      <main className="gate">
        <div className="logo" aria-hidden="true">
          🔒
        </div>
        <h1>Vault Diary is locked</h1>
        {c.account?.email && <p className="muted">{c.account.email}</p>}
        <ErrorNote message={c.error} onClose={() => c.clearError()} />
        {c.busy ? (
          <Spinner label="Waiting for your passkey…" />
        ) : (
          <button className="primary big" onClick={() => void passkeyUnlock()} autoFocus>
            Unlock with passkey
          </button>
        )}
        <button
          className="link"
          onClick={() => {
            c.clearError()
            setMode('passphrase')
          }}
        >
          Use passphrase
        </button>
      </main>
    )
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (mode === 'passphrase') {
      const ok = await c.unlock(passphrase)
      if (ok) setPassphrase('')
    } else {
      const ok = await c.unlockWithWords(words)
      if (ok) setWords('')
    }
  }

  return (
    <main className="gate">
      <div className="logo" aria-hidden="true">
        🔒
      </div>
      <h1>Vault Diary is locked</h1>
      {c.account?.email && <p className="muted">{c.account.email}</p>}
      <form onSubmit={submit} className="stack">
        {mode === 'passphrase' ? (
          <PassphraseInput
            id="unlock-pass"
            label="Passphrase"
            value={passphrase}
            onChange={setPassphrase}
            autoComplete="current-password"
            autoFocus
          />
        ) : (
          <div className="field">
            <label htmlFor="unlock-words">Your 24 recovery words</label>
            <textarea
              id="unlock-words"
              rows={5}
              value={words}
              onChange={(e) => setWords(e.target.value)}
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              placeholder="word1 word2 word3 …"
            />
            <p className="hint">
              Separate words with spaces or new lines. You'll set a new passphrase next.
            </p>
          </div>
        )}
        <ErrorNote message={c.error} onClose={() => c.clearError()} />
        {c.busy ? (
          <Spinner label="Unlocking…" />
        ) : (
          <button className="primary big" type="submit">
            Unlock
          </button>
        )}
      </form>
      {passkeys.length > 0 && mode === 'passphrase' && (
        <button
          className="link"
          onClick={() => {
            c.clearError()
            setMode('passkey')
          }}
        >
          Unlock with passkey instead
        </button>
      )}
      <button
        className="link"
        onClick={() => {
          c.clearError()
          setMode(mode === 'passphrase' ? 'words' : 'passphrase')
        }}
      >
        {mode === 'passphrase'
          ? 'Forgot your passphrase? Use your recovery words'
          : 'Use your passphrase instead'}
      </button>
    </main>
  )
}

export function ResetPassphrase() {
  const c = useController()
  const [p1, setP1] = useState('')
  const [p2, setP2] = useState('')
  const problem = p1 ? passphraseProblem(p1) : null
  const mismatch = p2 && p1 !== p2

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (passphraseProblem(p1) || p1 !== p2) return
    await c.setNewPassphrase(p1)
  }

  return (
    <main className="gate">
      <h1>Choose a new passphrase</h1>
      <p>
        Your recovery words worked. Set a new passphrase to finish unlocking. Your recovery words
        stay the same.
      </p>
      <form onSubmit={submit} className="stack">
        <PassphraseInput
          id="np1"
          label="New passphrase"
          value={p1}
          onChange={setP1}
          autoComplete="new-password"
          autoFocus
        />
        {problem && <p className="hint warn">{problem}</p>}
        <PassphraseInput
          id="np2"
          label="Repeat it"
          value={p2}
          onChange={setP2}
          autoComplete="new-password"
        />
        {mismatch && <p className="hint warn">The two passphrases don't match.</p>}
        <ErrorNote message={c.error} onClose={() => c.clearError()} />
        {c.busy ? (
          <Spinner label="Saving…" />
        ) : (
          <button className="primary big" type="submit" disabled={!!problem || !p1 || p1 !== p2}>
            Save and unlock
          </button>
        )}
      </form>
      <button className="link" onClick={() => void c.lock()}>
        Cancel
      </button>
    </main>
  )
}
