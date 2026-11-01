import { useState, type ReactNode } from 'react'
import { useController } from './controllerContext'

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="spinner-row" role="status">
      <span className="spinner" aria-hidden="true" />
      {label && <span>{label}</span>}
    </div>
  )
}

export function ErrorNote({ message, onClose }: { message: string | null; onClose?: () => void }) {
  if (!message) return null
  return (
    <div className="note note-error" role="alert">
      <span>{message}</span>
      {onClose && (
        <button className="link" onClick={onClose} aria-label="Dismiss">
          ✕
        </button>
      )}
    </div>
  )
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`card ${className}`}>{children}</section>
}

export function PassphraseInput(props: {
  id: string
  label: string
  value: string
  onChange: (v: string) => void
  autoComplete: 'current-password' | 'new-password'
  autoFocus?: boolean
}) {
  const [show, setShow] = useState(false)
  return (
    <div className="field">
      <label htmlFor={props.id}>{props.label}</label>
      <div className="input-row">
        <input
          id={props.id}
          type={show ? 'text' : 'password'}
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
          autoComplete={props.autoComplete}
          autoFocus={props.autoFocus}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
        <button type="button" className="ghost small" onClick={() => setShow((s) => !s)}>
          {show ? 'Hide' : 'Show'}
        </button>
      </div>
    </div>
  )
}

export function ProgressBar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0
  return (
    <div
      className="progress"
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className="progress-fill" style={{ width: `${pct}%` }} />
    </div>
  )
}

/** "Update available — reload", shown when a new version of the app has been deployed. */
export function UpdateBanner({ top = false }: { top?: boolean }) {
  const c = useController()
  const [busy, setBusy] = useState(false)
  if (!c.updateAvailable) return null
  return (
    <div className={`banner banner-action${top ? ' banner-top' : ''}`} role="status">
      <span>A new version of Vault Diary is available.</span>
      <button
        className="primary small"
        disabled={busy}
        onClick={() => {
          setBusy(true)
          void c.applyUpdate().finally(() => setBusy(false))
        }}
      >
        {busy ? 'Reloading…' : 'Reload'}
      </button>
    </div>
  )
}
