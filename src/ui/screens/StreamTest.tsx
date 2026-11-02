// #/stream-test — checks whether streaming playback works in this browser (Phase 3 B): that
// the media element's requests go through the service worker, that Range requests are
// answered and that seeking to the middle and the end works. Works locked (a file from this
// device) or unlocked (an attachment streamed from Google Drive, the real path).
import { useEffect, useRef, useState } from 'react'
import { randomId } from '../../crypto/bytes'
import { blobSource, encryptToBlob, openContainer } from '../../crypto/container'
import { formatBytes } from '../../lib/download'
import { blobType, mediaKind } from '../../media/kind'
import type { Attachment } from '../../model/entry'
import type { ByteProvider, OpenStream, StreamEvent } from '../../stream/host'
import { PlainReader } from '../../stream/plainReader'
import { Card, ErrorNote, Spinner } from '../components'
import { useController } from '../controllerContext'
import { href } from '../router'

/** Encrypting a local file in memory first is limited to this size (phones have little RAM). */
const ENCRYPT_LIMIT = 300 * 1024 * 1024

interface Counters {
  info: number
  reads: number
  bytes: number
  errors: number
}

function standalone(): string {
  const nav = navigator as Navigator & { standalone?: boolean }
  if (nav.standalone || matchMedia('(display-mode: standalone)').matches) return 'installed app'
  return 'browser tab'
}

export function StreamTest() {
  const c = useController()
  const [swControls] = useState(() => !!navigator.serviceWorker?.controller)
  const [swAnswers, setSwAnswers] = useState<boolean | null>(null)
  const [stream, setStream] = useState<{ open: OpenStream; mime: string; name: string } | null>(
    null,
  )
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [encrypt, setEncrypt] = useState(true)
  const [counters, setCounters] = useState<Counters>({ info: 0, reads: 0, bytes: 0, errors: 0 })
  const [log, setLog] = useState<string[]>([])
  const [checks, setChecks] = useState<Record<string, string>>({})
  const media = useRef<HTMLVideoElement & HTMLAudioElement>(null)

  const note = (line: string) =>
    setLog((l) => [...l.slice(-79), `${new Date().toLocaleTimeString()}  ${line}`])
  const check = (name: string, result: string) => setChecks((x) => ({ ...x, [name]: result }))

  useEffect(() => {
    void c.streamingAvailable().then(setSwAnswers)
    const stop = c.streams.watch((e: StreamEvent) => {
      setCounters((n) => ({
        info: n.info + (e.kind === 'info' ? 1 : 0),
        reads: n.reads + (e.kind === 'read' ? 1 : 0),
        bytes: n.bytes + (e.kind === 'read' ? (e.length ?? 0) : 0),
        errors: n.errors + (e.kind === 'error' ? 1 : 0),
      }))
      if (e.kind === 'read') note(`read ${e.offset}–${(e.offset ?? 0) + (e.length ?? 0) - 1}`)
      if (e.kind === 'error') note(`error: ${e.message}`)
    })
    return stop
  }, [c])

  useEffect(() => () => stream?.open.close(), [stream])

  const reset = () => {
    stream?.open.close()
    setStream(null)
    setCounters({ info: 0, reads: 0, bytes: 0, errors: 0 })
    setLog([])
    setChecks({})
    setError(null)
  }

  const playFile = async (file: File) => {
    reset()
    const mime = blobType(file.type, file.name)
    try {
      let provider: ByteProvider
      if (encrypt && file.size <= ENCRYPT_LIMIT) {
        setBusy('Encrypting a copy in memory…')
        // A throwaway key: this test never touches the diary.
        const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
          'encrypt',
          'decrypt',
        ])
        const encrypted = await encryptToBlob(key, {
          id: randomId(),
          kind: 'file',
          source: blobSource(file),
        })
        provider = new PlainReader(await openContainer(key, blobSource(encrypted)))
        note(`encrypted ${formatBytes(file.size)} in 4 MiB chunks`)
      } else {
        provider = {
          size: file.size,
          read: async (o, l) => new Uint8Array(await file.slice(o, o + l).arrayBuffer()),
        }
        note('playing the file as it is (no encryption)')
      }
      const open = await c.streams.open(provider, mime, file.name)
      note(`stream URL ${new URL(open.url).pathname}`)
      setStream({ open, mime, name: file.name })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const playAttachment = async (a: Attachment) => {
    reset()
    setBusy('Opening from Google Drive…')
    try {
      const open = await c.openStream(a)
      note(`streaming ${a.name} (${formatBytes(a.size)}) from Drive`)
      setStream({ open, mime: blobType(a.mime, a.name), name: a.name })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const seek = (label: string, to: (d: number) => number) => {
    const el = media.current
    if (!el || !Number.isFinite(el.duration)) return
    const target = Math.max(0, to(el.duration))
    const started = performance.now()
    note(`seek to ${target.toFixed(1)} s (${label})`)
    el.currentTime = target
    const done = () => {
      el.removeEventListener('seeked', done)
      check(label, `ok in ${Math.round(performance.now() - started)} ms`)
      void el.play().catch(() => {})
    }
    el.addEventListener('seeked', done)
  }

  const attachments = c.session
    ? [...c.session.entries.values()]
        .flatMap((e) => e.attachments)
        .filter((a) => ['video', 'audio'].includes(mediaKind(a.mime, a.name)))
        .sort((a, b) => b.size - a.size)
        .slice(0, 20)
    : []

  let verdict: string
  if (!swControls) {
    verdict =
      'No service worker controls this page yet. Reload the page once (not a hard reload) and try again.'
  } else if (swAnswers === false) {
    verdict = 'The service worker does not answer. Reload the page to get the latest version.'
  } else if (!stream) {
    verdict = 'Choose a video to start.'
  } else if (checks.error && counters.reads === 0 && counters.info === 0) {
    verdict =
      'FAILED: the player’s requests did not reach the service worker, so streaming is not possible in this browser.'
  } else if (checks.error) {
    verdict = `FAILED: the player reported an error after ${counters.reads} read(s).`
  } else if (checks.metadata && counters.reads > 0) {
    verdict = `Streaming works: ${counters.reads} read(s) answered through the service worker.`
  } else {
    verdict = 'Waiting for the player…'
  }

  const kind = stream ? mediaKind(stream.mime, stream.name) : null
  const report = [
    `Vault Diary streaming test`,
    `Browser: ${navigator.userAgent}`,
    `Mode: ${standalone()}`,
    `Service worker controls page: ${swControls ? 'yes' : 'no'}; answers: ${swAnswers ?? '?'}`,
    stream && `File: ${stream.name} (${stream.mime})`,
    `Requests reaching the app: ${counters.info} info, ${counters.reads} reads, ${formatBytes(counters.bytes)}, ${counters.errors} errors`,
    ...Object.entries(checks).map(([k, v]) => `${k}: ${v}`),
    `Result: ${verdict}`,
  ]
    .filter(Boolean)
    .join('\n')

  return (
    <div className="page stream-test">
      <p>
        <a href={c.session ? href({ name: 'settings' }) : '#/'}>‹ Back</a>
      </p>
      <h1>Streaming test</h1>
      <p className="muted small">
        Checks that this browser can play a large video without decrypting all of it first. Nothing
        is uploaded; a file you choose here stays on this device.
      </p>
      <Card>
        <p className="note" data-testid="stream-verdict">
          {verdict}
        </p>
        <div className="field">
          <label htmlFor="st-file">A video or audio file from this device</label>
          <input
            id="st-file"
            type="file"
            accept="video/*,audio/*"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void playFile(f)
              e.target.value = ''
            }}
            disabled={!!busy}
          />
          <label className="check">
            <input
              type="checkbox"
              checked={encrypt}
              onChange={(e) => setEncrypt(e.target.checked)}
            />{' '}
            Encrypt it first, like a real attachment (files up to 300 MB)
          </label>
        </div>
        {attachments.length > 0 && (
          <div className="field">
            <span className="label">Or an attachment from your diary (streamed from Drive)</span>
            <ul className="stream-test-list">
              {attachments.map((a) => (
                <li key={a.fileId}>
                  <button className="link" onClick={() => void playAttachment(a)} disabled={!!busy}>
                    {a.name}
                  </button>{' '}
                  <span className="muted small">{formatBytes(a.size)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {busy && <Spinner label={busy} />}
        <ErrorNote message={error} onClose={() => setError(null)} />
      </Card>
      {stream && (
        <Card>
          {kind === 'audio' ? (
            <audio
              ref={media}
              className="viewer-audio"
              src={stream.open.url}
              controls
              preload="metadata"
              onLoadedMetadata={(e) => {
                check('metadata', `duration ${e.currentTarget.duration.toFixed(1)} s`)
              }}
              onError={(e) => check('error', `media error ${e.currentTarget.error?.code ?? '?'}`)}
            />
          ) : (
            <video
              ref={media}
              className="viewer-media"
              src={stream.open.url}
              controls
              playsInline
              preload="metadata"
              onLoadedMetadata={(e) => {
                check('metadata', `duration ${e.currentTarget.duration.toFixed(1)} s`)
              }}
              onPlaying={() => note('playing')}
              onWaiting={() => note('waiting for data')}
              onError={(e) => check('error', `media error ${e.currentTarget.error?.code ?? '?'}`)}
            />
          )}
          <div className="row wrap">
            <button className="ghost small" onClick={() => seek('seek to start', () => 0)}>
              Start
            </button>
            <button className="ghost small" onClick={() => seek('seek to middle', (d) => d / 2)}>
              Middle
            </button>
            <button className="ghost small" onClick={() => seek('seek to end', (d) => d - 5)}>
              Last 5 s
            </button>
          </div>
        </Card>
      )}
      <Card>
        <h2>Report</h2>
        <pre className="stream-report" data-testid="stream-report">
          {report}
        </pre>
        <details>
          <summary>Request log ({log.length})</summary>
          <pre className="stream-report">{log.join('\n')}</pre>
        </details>
      </Card>
    </div>
  )
}
