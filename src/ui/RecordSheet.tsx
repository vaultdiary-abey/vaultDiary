// Record a voice note or a video, or take a photo, on the entry screen:
//   ready → record (live timer and size) → preview → re-take or keep.
// Recordings are saved encrypted to IndexedDB every second while they run (RecordingStore),
// so a crash or a lock doesn't lose them; they are offered for recovery on the next unlock.
import { useCallback, useEffect, useRef, useState } from 'react'
import { AUDIO_MAX_MINUTES, getMaxVideoMinutes } from '../core/prefs'
import { formatBytes } from '../lib/download'
import {
  capturePhoto,
  mediaErrorMessage,
  openStream,
  recordingName,
  startRecording,
  stopStream,
  type ActiveRecording,
} from '../media/recorder'
import { ErrorNote, Spinner } from './components'
import { useController } from './controllerContext'

export type RecordMode = 'audio' | 'video' | 'photo'

type Stage = 'opening' | 'ready' | 'recording' | 'saving' | 'review' | 'error'

function clock(ms: number): string {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function photoName(at = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `Photo ${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())} ${p(at.getHours())}.${p(at.getMinutes())}.${p(at.getSeconds())}.jpg`
}

export function RecordSheet(props: {
  mode: RecordMode
  entry: { id: string; date: string }
  onKeep: (file: File) => Promise<void>
  onClose: () => void
}) {
  const { mode, entry, onKeep, onClose } = props
  const c = useController()
  const [stage, setStage] = useState<Stage>('opening')
  const [error, setError] = useState<string | null>(null)
  const [facing, setFacing] = useState<'user' | 'environment'>(
    mode === 'photo' ? 'environment' : 'user',
  )
  const [elapsed, setElapsed] = useState(0)
  const [bytes, setBytes] = useState(0)
  const [notice, setNotice] = useState<string | null>(null)
  const [review, setReview] = useState<{ blob: Blob; url: string; name: string } | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const activeRef = useRef<ActiveRecording | null>(null)
  const recIdRef = useRef<string | null>(null)
  const reviewRef = useRef(review)
  useEffect(() => {
    reviewRef.current = review
  }, [review])

  const maxMinutes = mode === 'video' ? getMaxVideoMinutes() : AUDIO_MAX_MINUTES
  const what = mode === 'audio' ? 'microphone' : 'camera'

  const closeStream = () => {
    stopStream(streamRef.current)
    streamRef.current = null
  }

  const open = useCallback(
    async (facingMode: 'user' | 'environment') => {
      closeStream()
      setStage('opening')
      setError(null)
      try {
        const stream = await openStream(mode, facingMode)
        streamRef.current = stream
        if (videoRef.current) videoRef.current.srcObject = stream
        setStage('ready')
      } catch (e) {
        setError(mediaErrorMessage(e, mode === 'video' ? 'camera and microphone' : what))
        setStage('error')
      }
    },
    [mode, what],
  )

  useEffect(() => {
    let cancelled = false
    openStream(mode, facing).then(
      (stream) => {
        if (cancelled) return stopStream(stream)
        streamRef.current = stream
        setStage('ready')
      },
      (e) => {
        if (cancelled) return
        setError(mediaErrorMessage(e, mode === 'video' ? 'camera and microphone' : what))
        setStage('error')
      },
    )
    // Leaving the sheet (or the vault locking) stops everything. A recording that was running is
    // left in the store and offered for recovery after the next unlock.
    return () => {
      cancelled = true
      void activeRef.current?.stop()
      activeRef.current = null
      closeStream()
      if (reviewRef.current) URL.revokeObjectURL(reviewRef.current.url)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const v = videoRef.current
    if (v && streamRef.current && v.srcObject !== streamRef.current) {
      v.srcObject = streamRef.current
    }
  })

  const start = async () => {
    const stream = streamRef.current
    const session = c.session
    if (!stream || !session) return
    setError(null)
    setNotice(null)
    setElapsed(0)
    setBytes(0)
    try {
      activeRef.current = await startRecording({
        kind: mode === 'audio' ? 'audio' : 'video',
        stream,
        store: c.recordings,
        mk: session.key,
        entry,
        maxMs: maxMinutes * 60_000,
        onProgress: (ms, b) => {
          setElapsed(ms)
          setBytes(b)
          c.noteActivity()
        },
        onAutoStop: () => {
          setNotice(`Stopped at the ${maxMinutes}-minute limit (Settings → Longest video).`)
          void finish()
        },
        onError: (m) => setError(m),
      })
      setStage('recording')
    } catch (e) {
      setError(mediaErrorMessage(e, what))
    }
  }

  const finish = async () => {
    const active = activeRef.current
    const session = c.session
    if (!active || !session) return
    activeRef.current = null
    setStage('saving')
    try {
      await active.stop()
      closeStream()
      const blob = await c.recordings.assemble(session.key, active.id)
      const name = recordingName(mode === 'audio' ? 'audio' : 'video', active.mime)
      setReview({ blob, url: URL.createObjectURL(blob), name })
      recIdRef.current = active.id
      setStage('review')
    } catch (e) {
      setError((e as Error).message)
      setStage('error')
    }
  }
  const snap = async () => {
    if (!videoRef.current) return
    try {
      const blob = await capturePhoto(videoRef.current)
      closeStream()
      setReview({ blob, url: URL.createObjectURL(blob), name: photoName() })
      setStage('review')
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const dropReview = async () => {
    if (review) URL.revokeObjectURL(review.url)
    setReview(null)
    if (recIdRef.current) await c.recordings.discard(recIdRef.current)
    recIdRef.current = null
  }

  const retake = async () => {
    await dropReview()
    await open(facing)
  }

  const keep = async () => {
    if (!review) return
    setStage('saving')
    try {
      const file = new File([review.blob], review.name, {
        type: review.blob.type || (mode === 'photo' ? 'image/jpeg' : ''),
      })
      await onKeep(file)
      await dropReview()
      onClose()
    } catch (e) {
      setError((e as Error).message)
      setStage('review')
    }
  }

  const cancel = async () => {
    if (stage === 'recording' && !confirm('Stop and throw away this recording?')) return
    const active = activeRef.current
    activeRef.current = null
    if (active) {
      await active.stop()
      await c.recordings.discard(active.id)
    }
    await dropReview()
    closeStream()
    onClose()
  }

  const flip = () => {
    const next = facing === 'user' ? 'environment' : 'user'
    setFacing(next)
    void open(next)
  }

  const title = mode === 'audio' ? 'Voice note' : mode === 'video' ? 'Video' : 'Photo'
  const live =
    mode !== 'audio' && (stage === 'ready' || stage === 'recording' || stage === 'opening')

  return (
    <div className="viewer recorder" role="dialog" aria-modal="true" aria-label={title}>
      <header className="viewer-bar">
        <button className="ghost small" onClick={() => void cancel()}>
          Cancel
        </button>
        <span className="viewer-title">{title}</span>
        {mode !== 'audio' && (stage === 'ready' || stage === 'opening') ? (
          <button className="ghost small" onClick={flip} aria-label="Switch camera">
            ⟲ Flip
          </button>
        ) : (
          <span className="bar-spacer" />
        )}
      </header>
      <div className="viewer-body">
        {live && (
          <video
            ref={videoRef}
            className="viewer-media viewfinder"
            autoPlay
            muted
            playsInline
            data-facing={facing}
          />
        )}
        {mode === 'audio' && (stage === 'ready' || stage === 'recording') && (
          <div className={`mic ${stage === 'recording' ? 'on' : ''}`} aria-hidden="true">
            🎙
          </div>
        )}
        {stage === 'opening' && <Spinner label={`Opening the ${what}…`} />}
        {stage === 'saving' && <Spinner label="Saving…" />}
        {stage === 'review' && review && (
          <>
            {mode === 'photo' ? (
              <img className="viewer-media" src={review.url} alt="The photo you just took" />
            ) : mode === 'video' ? (
              <video className="viewer-media" src={review.url} controls playsInline />
            ) : (
              <audio className="viewer-audio" src={review.url} controls />
            )}
            <p className="small">
              {review.name} · {formatBytes(review.blob.size)}
            </p>
          </>
        )}
        {notice && <p className="note">{notice}</p>}
        <ErrorNote message={error} onClose={() => setError(null)} />
      </div>
      <footer className="recorder-bar">
        {stage === 'recording' && (
          <p className="rec-status" aria-live="polite">
            <span className="rec-dot" aria-hidden="true" /> {clock(elapsed)} / {maxMinutes}:00 ·{' '}
            {formatBytes(bytes)}
          </p>
        )}
        {stage === 'ready' &&
          (mode === 'photo' ? (
            <button className="primary big" onClick={() => void snap()}>
              Take photo
            </button>
          ) : (
            <button className="primary big" onClick={() => void start()}>
              ● Record
            </button>
          ))}
        {stage === 'recording' && (
          <button className="primary big danger-fill" onClick={() => void finish()}>
            ■ Stop
          </button>
        )}
        {stage === 'review' && (
          <div className="row center-row">
            <button className="ghost" onClick={() => void retake()}>
              Re-take
            </button>
            <button className="primary" onClick={() => void keep()}>
              Keep
            </button>
          </div>
        )}
        {stage === 'error' && (
          <button className="ghost" onClick={() => void open(facing)}>
            Try again
          </button>
        )}
      </footer>
    </div>
  )
}
