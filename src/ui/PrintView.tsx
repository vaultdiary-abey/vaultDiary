// PDF export: a clean, printable page of entries (titles, dates, text, photos inline; audio,
// video and other files listed by name). The user saves it with the browser's Print → Save as
// PDF; no PDF library is involved. Decrypted photos live in memory as blob: URLs and are
// revoked when the view closes or the diary locks.
import { useEffect, useState } from 'react'
import type { DateRange } from '../core/exporter'
import { formatBytes } from '../lib/download'
import { formatDay, formatTime } from '../lib/dates'
import { renderMarkdown } from '../lib/markdown'
import { LARGE_FILE, mediaKind } from '../media/kind'
import { scaleImageToJpeg } from '../media/thumbnail'
import { displayTitle, MOODS, type Attachment, type Entry } from '../model/entry'
import { ProgressBar, Spinner } from './components'
import { useController } from './controllerContext'

/** Photos are printed at most this wide/high (keeps memory low on phones; ~300 dpi on A5). */
const PRINT_MAX = 1600

const ICONS = { image: '🖼️', video: '🎞️', audio: '🎵', pdf: '📄', other: '📎' } as const

function AttachmentLine({ a, missing }: { a: Attachment; missing?: boolean }) {
  const kind = mediaKind(a.mime, a.name)
  return (
    <li>
      <span aria-hidden="true">{ICONS[kind]}</span> {a.name}{' '}
      <span className="muted">
        ({formatBytes(a.size)}
        {missing ? ', not included' : ''})
      </span>
    </li>
  )
}

function PrintEntry({ entry, images }: { entry: Entry; images: Map<string, string> }) {
  const mood = MOODS.find((m) => m.value === entry.mood)
  const photos = entry.attachments.filter((a) => images.has(a.fileId))
  const listed = entry.attachments.filter((a) => !images.has(a.fileId))
  return (
    <article className="print-entry">
      <header>
        <p className="print-date">
          {formatDay(entry.date)}
          {entry.createdAt && ` · ${formatTime(entry.createdAt)}`}
          {mood && ` · ${mood.emoji} ${mood.label}`}
        </p>
        <h2>{displayTitle(entry)}</h2>
        {entry.tags.length > 0 && (
          <p className="print-tags">{entry.tags.map((t) => `#${t}`).join('  ')}</p>
        )}
      </header>
      {entry.body && (
        <div
          className="markdown"
          // Sanitised by DOMPurify in renderMarkdown.
          dangerouslySetInnerHTML={{ __html: renderMarkdown(entry.body) }}
        />
      )}
      {photos.map((a) => (
        <figure key={a.fileId} className="print-photo">
          <img src={images.get(a.fileId)} alt={a.name} />
          <figcaption>{a.name}</figcaption>
        </figure>
      ))}
      {listed.length > 0 && (
        <ul className="print-files">
          {listed.map((a) => (
            <AttachmentLine key={a.fileId} a={a} missing={mediaKind(a.mime, a.name) === 'image'} />
          ))}
        </ul>
      )}
    </article>
  )
}

export function PrintView({ range }: { range: DateRange }) {
  const c = useController()
  const [entries] = useState(() => c.exportEntries(range).entries)
  const [images, setImages] = useState<Map<string, string> | null>(null)
  const [progress, setProgress] = useState({ done: 0, total: 0 })

  useEffect(() => {
    let cancelled = false
    const urls: string[] = []
    void (async () => {
      const photos = entries.flatMap((e) =>
        e.attachments.filter((a) => mediaKind(a.mime, a.name) === 'image'),
      )
      const map = new Map<string, string>()
      setProgress({ done: 0, total: photos.length })
      let done = 0
      for (const a of photos) {
        if (cancelled) return
        const url = await printableImage(a).catch(() => null)
        if (url && !cancelled) map.set(a.fileId, url)
        setProgress({ done: ++done, total: photos.length })
      }
      if (!cancelled) setImages(map)
    })()
    /** A blob: URL of the photo scaled for print, or of its thumbnail as a fallback. */
    async function printableImage(a: Attachment): Promise<string | null> {
      if (a.size <= LARGE_FILE) {
        const scaled = await scaleImageToJpeg(await c.attachmentBlob(a), PRINT_MAX, 0.85).catch(
          () => null,
        )
        if (scaled) {
          const url = URL.createObjectURL(scaled)
          urls.push(url)
          return url
        }
      }
      // The browser can't decode it (e.g. HEIC outside Apple devices): print the thumbnail.
      // Its URL belongs to the thumbnail cache, which revokes it on lock.
      return a.thumbFileId ? c.thumbnailUrl(a.thumbFileId) : null
    }
    return () => {
      cancelled = true
      for (const u of urls) URL.revokeObjectURL(u)
    }
  }, [c, entries])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && c.closePrintView()
    window.addEventListener('keydown', onKey)
    document.body.classList.add('printing-export')
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.classList.remove('printing-export')
    }
  }, [c])

  const title =
    range.from === range.to
      ? formatDay(range.from)
      : `${formatDay(range.from, 'short')} – ${formatDay(range.to, 'short')}`

  return (
    <div className="print-view">
      <div className="print-toolbar no-print" role="toolbar">
        <button className="ghost small" onClick={() => c.closePrintView()}>
          ✕ Close
        </button>
        <span className="muted small">Not encrypted — close when done</span>
        <button className="primary small" disabled={!images} onClick={() => window.print()}>
          Print / Save as PDF
        </button>
      </div>
      {!images ? (
        <div className="viewer-message no-print">
          <Spinner label={`Preparing photos ${progress.done} of ${progress.total}…`} />
          <ProgressBar value={progress.done} max={progress.total || 1} />
        </div>
      ) : (
        <div className="print-doc">
          <header className="print-cover">
            <h1>Vault Diary</h1>
            <p>{title}</p>
            <p className="muted">
              {entries.length} {entries.length === 1 ? 'entry' : 'entries'}
            </p>
          </header>
          {entries.map((e) => (
            <PrintEntry key={e.id} entry={e} images={images} />
          ))}
        </div>
      )}
    </div>
  )
}
