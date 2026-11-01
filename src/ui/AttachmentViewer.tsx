// Full-screen viewer for one attachment: decrypts it on this device into a Blob, shows it from
// an object URL and revokes the URL on close. Anything the browser can't show gets "Download".
import { useEffect, useRef, useState } from 'react'
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

export function AttachmentViewer({
  attachment,
  onClose,
}: {
  attachment: Attachment
  onClose: () => void
}) {
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
      .then((b) => {
        if (cancelled) return
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
  }, [c, attachment, confirmed])

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
    if (unplayable) {
      body = cantShow(
        kind === 'image'
          ? "This browser can't show this photo (for example HEIC outside Apple devices)."
          : `This browser can't play this ${kind} format.`,
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
