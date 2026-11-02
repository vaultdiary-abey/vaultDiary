// Full-screen viewer for one attachment. Audio and video stream through the service worker
// (only the chunks being played are downloaded and decrypted, Phase 3 B); everything else, and
// audio/video when streaming isn't available, is decrypted on this device into a Blob, shown
// from an object URL and revoked on close. Anything the browser can't show gets "Download".
import { useCallback, useEffect, useRef, useState } from 'react'
import type { OpenStream } from '../stream/host'
import { isId } from '../crypto/bytes'
import { canDecodeHeic, isHeic } from '../media/heic'
import { cantPlayMessage, unplayableCodec } from '../media/videoCodec'
import { formatBytes, saveBlob } from '../lib/download'
import { LARGE_FILE, mediaKind } from '../media/kind'
import type { PDFDocumentProxy } from '../media/pdf'
import type { Attachment } from '../model/entry'
import { ErrorNote, ProgressBar, Spinner } from './components'
import { useController } from './controllerContext'

function PdfView({ blob }: { blob: Blob }) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    let task: { destroy(): Promise<void> } | null = null
    void (async () => {
      try {
        const { openPdf } = await import('../media/pdf')
        const loading = openPdf(new Uint8Array(await blob.arrayBuffer()))
        task = loading
        if (cancelled) return void loading.destroy()
        const opened = await loading.promise
        if (!cancelled) setDoc(opened)
      } catch (e) {
        if (!cancelled) setError(`This PDF can't be shown here: ${(e as Error).message}`)
      }
    })()
    return () => {
      cancelled = true
      void task?.destroy()
    }
  }, [blob])
  if (error) return <p className="viewer-message">{error}</p>
  if (!doc) return <Spinner label="Opening PDF…" />
  return (
    <div className="pdf-pages">
      {Array.from({ length: doc.numPages }, (_, i) => (
        <PdfPage key={i} doc={doc} page={i + 1} />
      ))}
    </div>
  )
}

function PdfPage({ doc, page }: { doc: PDFDocumentProxy; page: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const [state, setState] = useState<'waiting' | 'done' | 'error'>('waiting')
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    let started = false
    const render = () => {
      if (started) return
      started = true
      const width = Math.min(canvas.parentElement?.clientWidth ?? 600, 900)
      void import('../media/pdf')
        .then(({ renderPage }) => renderPage(doc, page, canvas, width))
        .then(
          () => setState('done'),
          () => setState('error'),
        )
    }
    // Render pages as they scroll into view, so long PDFs open quickly.
    const io = new IntersectionObserver((items) => {
      if (items.some((i) => i.isIntersecting)) {
        io.disconnect()
        render()
      }
    })
    io.observe(canvas)
    return () => io.disconnect()
  }, [doc, page])
  return (
    <div className={`pdf-page ${state}`} aria-label={`Page ${page}`}>
      <canvas ref={ref} />
      {state === 'error' && <p className="viewer-message">Page {page} couldn't be drawn.</p>}
    </div>
  )
}

/** Decrypts the whole file into memory (with a warning above 200 MB). */
function FullViewer({ attachment, onClose }: { attachment: Attachment; onClose: () => void }) {
  const c = useController()
  const kind = mediaKind(attachment.mime, attachment.name)
  const large = attachment.size > LARGE_FILE
  const [confirmed, setConfirmed] = useState(!large && kind !== 'other')
  const [blob, setBlob] = useState<Blob | null>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(
    confirmed ? { done: 0, total: attachment.size } : null,
  )
  const [error, setError] = useState<string | null>(null)
  const [unplayable, setUnplayable] = useState(false)
  /** A video codec this browser can't play (read from the file's header). */
  const [badCodec, setBadCodec] = useState<string | null>(null)
  const [downloading, setDownloading] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    if (!confirmed) return
    let cancelled = false
    let objectUrl: string | null = null
    c.attachmentBlob(attachment, (done, total) => !cancelled && setProgress({ done, total }))
      .then(async (b) => {
        if (cancelled) return
        const bad =
          kind === 'video'
            ? await unplayableCodec(
                async (at, n) => new Uint8Array(await b.slice(at, at + n).arrayBuffer()),
                b.size,
              )
            : null
        if (cancelled) return
        if (bad) setBadCodec(cantPlayMessage(bad))
        objectUrl = URL.createObjectURL(b)
        setBlob(b)
        setUrl(objectUrl)
      })
      .catch((e: Error) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setProgress(null))
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [c, attachment, confirmed, kind])

  const download = async () => {
    if (blob) {
      saveBlob(blob, attachment.name)
      return
    }
    setDownloading(true)
    setError(null)
    try {
      saveBlob(
        await c.attachmentBlob(attachment, (done, total) => setProgress({ done, total })),
        attachment.name,
      )
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setDownloading(false)
      setProgress(null)
    }
  }

  const cantShow = (what: string) => (
    <div className="viewer-message">
      <p>{what}</p>
      <button className="primary" onClick={() => void download()}>
        Download
      </button>
    </div>
  )

  let body = null
  if (!confirmed) {
    body = (
      <div className="viewer-message">
        {kind === 'other' ? (
          <p>This kind of file can't be shown in the app.</p>
        ) : (
          <p>
            This file is {formatBytes(attachment.size)}. Opening it here decrypts all of it into
            memory, which may be slow or fail on a phone.
          </p>
        )}
        <div className="row center-row">
          <button className="primary" onClick={() => void download()} disabled={downloading}>
            {kind === 'other' ? 'Download' : 'Download instead'}
          </button>
          {kind !== 'other' && (
            <button
              className="ghost"
              onClick={() => {
                setProgress({ done: 0, total: attachment.size })
                setConfirmed(true)
              }}
            >
              Open anyway
            </button>
          )}
        </div>
      </div>
    )
  } else if (url && blob) {
    if (badCodec) {
      body = cantShow(badCodec)
    } else if (unplayable) {
      body = cantShow(
        kind === 'image'
          ? "This browser can't show this photo (for example HEIC outside Apple devices)."
          : kind === 'video'
            ? cantPlayMessage(null)
            : "This browser can't play this audio format. Download it to play it in another app.",
      )
    } else if (kind === 'image') {
      body = (
        <img
          className="viewer-media"
          src={url}
          alt={attachment.name}
          onError={() => setUnplayable(true)}
        />
      )
    } else if (kind === 'video') {
      body = (
        <video
          className="viewer-media"
          src={url}
          controls
          playsInline
          autoPlay
          onError={() => setUnplayable(true)}
        />
      )
    } else if (kind === 'audio') {
      body = (
        <audio
          className="viewer-audio"
          src={url}
          controls
          autoPlay
          onError={() => setUnplayable(true)}
        />
      )
    } else if (kind === 'pdf') {
      body = <PdfView blob={blob} />
    }
  }

  return (
    <div className="viewer" role="dialog" aria-modal="true" aria-label={attachment.name}>
      <header className="viewer-bar">
        <button className="ghost small" onClick={onClose} aria-label="Close">
          ✕ Close
        </button>
        <span className="viewer-title" title={attachment.name}>
          {attachment.name}
        </span>
        <button
          className="ghost small"
          onClick={() => void download()}
          disabled={downloading || (!!progress && !blob)}
        >
          Download
        </button>
      </header>
      <div className="viewer-body">
        {progress && (
          <div className="viewer-message">
            <Spinner label={downloading ? 'Preparing download…' : 'Decrypting…'} />
            <ProgressBar value={progress.done} max={progress.total || 1} />
          </div>
        )}
        <ErrorNote message={error} onClose={() => setError(null)} />
        {body}
      </div>
    </div>
  )
}

/** "Google sign-in has expired — Continue" for a stream waiting on Drive. */
function SignInBar({ onContinue }: { onContinue: () => void }) {
  return (
    <div className="banner banner-action viewer-signin" role="status">
      <span>Google sign-in has expired. Playback is paused.</span>
      <button className="primary small" onClick={onContinue}>
        Continue
      </button>
    </div>
  )
}

/**
 * Streams audio or video: the player asks for byte ranges, the service worker asks this page,
 * and the page downloads and decrypts only the chunks needed. Calls `onFallback` when
 * streaming can't be used, so the full-decrypt viewer takes over.
 */
function StreamViewer({
  attachment,
  kind,
  onClose,
  onFallback,
}: {
  attachment: Attachment
  kind: 'audio' | 'video'
  onClose: () => void
  onFallback: () => void
}) {
  const c = useController()
  const [stream, setStream] = useState<OpenStream | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [cantPlay, setCantPlay] = useState<string | null>(null)
  const [download, setDownload] = useState<{ done: number; total: number } | null>(null)
  const media = useRef<HTMLVideoElement & HTMLAudioElement>(null)
  const resumeAfterSignIn = useRef(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    let live = true
    let opened: OpenStream | null = null
    void (async () => {
      try {
        if (!(await c.streamingAvailable())) {
          if (live) onFallback()
          return
        }
        const o = await c.openStream(attachment)
        opened = o
        if (!live) return o.close()
        // A video codec this browser can't play (e.g. HEVC): say so instead of a black box.
        const bad =
          kind === 'video'
            ? await unplayableCodec((at, n) => o.reader.read(at, n), o.reader.size)
            : null
        if (!live) return
        if (bad) {
          o.close()
          setCantPlay(cantPlayMessage(bad))
        } else setStream(o)
      } catch {
        // The header couldn't be read (offline, missing, damaged): the full viewer shows why.
        if (live) onFallback()
      }
    })()
    return () => {
      live = false
      // Drops the decrypted chunks kept for this player.
      opened?.close()
    }
  }, [c, attachment, kind, onFallback])

  // Google sign-in expired while a chunk was needed: pause and offer Continue.
  const needsSignIn = c.streamNeedsSignIn
  useEffect(() => {
    const el = media.current
    if (needsSignIn && el && !el.paused) {
      resumeAfterSignIn.current = true
      el.pause()
    }
  }, [needsSignIn])

  const continueAfterSignIn = async () => {
    await c.signIn()
    if (resumeAfterSignIn.current) {
      resumeAfterSignIn.current = false
      void media.current?.play().catch(() => {})
    }
  }

  const onMediaError = () => {
    const stats = stream ? c.streams.stats(stream.token) : null
    if (!stats || (stats.info === 0 && stats.reads === 0)) {
      // The browser didn't route the player through the service worker.
      c.markStreamingUnavailable()
      onFallback()
    } else if (stats.lastError) {
      setError(`This ${kind} couldn't be played: ${stats.lastError}`)
    } else {
      setCantPlay(
        kind === 'video'
          ? cantPlayMessage(null)
          : "This browser can't play this audio format. Download it to play it in another app.",
      )
    }
  }

  const save = async () => {
    setDownload({ done: 0, total: attachment.size })
    setError(null)
    try {
      saveBlob(
        await c.attachmentBlob(attachment, (done, total) => setDownload({ done, total })),
        attachment.name,
      )
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setDownload(null)
    }
  }

  let body = null
  if (download) {
    body = (
      <div className="viewer-message">
        <Spinner label="Preparing download…" />
        <ProgressBar value={download.done} max={download.total || 1} />
      </div>
    )
  } else if (cantPlay) {
    body = (
      <div className="viewer-message">
        <p>{cantPlay}</p>
        <button className="primary" onClick={() => void save()}>
          Download
        </button>
      </div>
    )
  } else if (!stream) {
    body = (
      <div className="viewer-message">
        <Spinner label="Opening…" />
      </div>
    )
  }

  return (
    <div className="viewer" role="dialog" aria-modal="true" aria-label={attachment.name}>
      <header className="viewer-bar">
        <button className="ghost small" onClick={onClose} aria-label="Close">
          ✕ Close
        </button>
        <span className="viewer-title" title={attachment.name}>
          {attachment.name}
        </span>
        <button className="ghost small" onClick={() => void save()} disabled={!!download}>
          Download
        </button>
      </header>
      <div className="viewer-body" data-streaming={stream ? 'yes' : 'no'}>
        {needsSignIn && <SignInBar onContinue={() => void continueAfterSignIn()} />}
        <ErrorNote message={error} onClose={() => setError(null)} />
        {body}
        {stream && !cantPlay && !download && kind === 'video' && (
          <video
            ref={media}
            className="viewer-media"
            src={stream.url}
            controls
            playsInline
            autoPlay
            preload="metadata"
            onError={onMediaError}
          />
        )}
        {stream && !cantPlay && !download && kind === 'audio' && (
          <audio
            ref={media}
            className="viewer-audio"
            src={stream.url}
            controls
            autoPlay
            preload="metadata"
            onError={onMediaError}
          />
        )}
      </div>
    </div>
  )
}

/**
 * HEIC photos: browsers that can decode HEIC (Safari) show the original. Others show the JPEG
 * viewing copy when there is one, or else the thumbnail and a Download button.
 */
function HeicViewer({
  attachment,
  onClose,
  onOriginal,
}: {
  attachment: Attachment
  onClose: () => void
  onOriginal: () => void
}) {
  const c = useController()
  const [shown, setShown] = useState<
    | { kind: 'probing' }
    | { kind: 'copy'; url: string }
    /** No viewing copy shown: `problem` says why when there is one but it couldn't load. */
    | { kind: 'thumb'; url: string | null; problem: string | null }
  >({ kind: 'probing' })
  const [attempt, setAttempt] = useState(0)
  const [download, setDownload] = useState<{ done: number; total: number } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    let live = true
    let copyUrl: string | null = null
    void (async () => {
      if (await canDecodeHeic()) {
        if (live) onOriginal()
        return
      }
      let problem: string | null = null
      if (isId(attachment.viewCopyFileId)) {
        try {
          const jpeg = await c.viewCopyBlob(attachment)
          if (!live) return
          copyUrl = URL.createObjectURL(jpeg)
          setShown({ kind: 'copy', url: copyUrl })
          return
        } catch (e) {
          // e.g. Google sign-in needed after reopening the app, or offline
          problem = (e as Error).message
        }
      }
      const thumb = isId(attachment.thumbFileId)
        ? await c.thumbnailUrl(attachment.thumbFileId)
        : null
      if (live) setShown({ kind: 'thumb', url: thumb, problem })
    })()
    return () => {
      live = false
      if (copyUrl) URL.revokeObjectURL(copyUrl)
    }
  }, [c, attachment, onOriginal, attempt])

  const retry = async () => {
    if (!c.auth.hasToken()) await c.signIn()
    setShown({ kind: 'probing' })
    setAttempt((n) => n + 1)
  }

  const save = async () => {
    setDownload({ done: 0, total: attachment.size })
    setError(null)
    try {
      saveBlob(
        await c.attachmentBlob(attachment, (done, total) => setDownload({ done, total })),
        attachment.name,
      )
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setDownload(null)
    }
  }

  let body
  if (download) {
    body = (
      <div className="viewer-message">
        <Spinner label="Preparing download…" />
        <ProgressBar value={download.done} max={download.total || 1} />
      </div>
    )
  } else if (shown.kind === 'probing') {
    body = (
      <div className="viewer-message">
        <Spinner label="Opening…" />
      </div>
    )
  } else if (shown.kind === 'copy') {
    body = (
      <>
        <img className="viewer-media" src={shown.url} alt={attachment.name} data-viewcopy="yes" />
        <p className="viewer-caption">
          Viewing copy (JPEG) — this browser can't show HEIC. Download saves the original.
        </p>
      </>
    )
  } else if (shown.problem) {
    body = (
      <div className="viewer-message">
        {shown.url && <img className="viewer-thumb" src={shown.url} alt="" />}
        <p>This browser can't show HEIC photos, and the viewing copy couldn't be loaded.</p>
        <p className="muted small">{shown.problem}</p>
        <div className="row center-row">
          <button className="primary" onClick={() => void retry()}>
            Try again
          </button>
          <button className="ghost" onClick={() => void save()}>
            Download
          </button>
        </div>
      </div>
    )
  } else {
    body = (
      <div className="viewer-message">
        {shown.url && <img className="viewer-thumb" src={shown.url} alt="" />}
        <p>
          This browser can't show HEIC photos, and this one has no viewing copy yet. Download it, or
          open Settings on your iPhone and make viewing copies for older photos.
        </p>
        <button className="primary" onClick={() => void save()}>
          Download
        </button>
      </div>
    )
  }

  return (
    <div className="viewer" role="dialog" aria-modal="true" aria-label={attachment.name}>
      <header className="viewer-bar">
        <button className="ghost small" onClick={onClose} aria-label="Close">
          ✕ Close
        </button>
        <span className="viewer-title" title={attachment.name}>
          {attachment.name}
        </span>
        <button className="ghost small" onClick={() => void save()} disabled={!!download}>
          Download
        </button>
      </header>
      <div className="viewer-body">
        <ErrorNote message={error} onClose={() => setError(null)} />
        {body}
      </div>
    </div>
  )
}

export function AttachmentViewer({
  attachment,
  onClose,
}: {
  attachment: Attachment
  onClose: () => void
}) {
  const kind = mediaKind(attachment.mime, attachment.name)
  const heic = kind === 'image' && isHeic(attachment.mime, attachment.name)
  const [full, setFull] = useState(kind !== 'audio' && kind !== 'video' && !heic)
  const fallback = useCallback(() => setFull(true), [])
  if (heic && !full) {
    return <HeicViewer attachment={attachment} onClose={onClose} onOriginal={fallback} />
  }
  if (full || (kind !== 'audio' && kind !== 'video')) {
    return <FullViewer attachment={attachment} onClose={onClose} />
  }
  return (
    <StreamViewer attachment={attachment} kind={kind} onClose={onClose} onFallback={fallback} />
  )
}
