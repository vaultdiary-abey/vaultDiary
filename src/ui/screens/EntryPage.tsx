import { useCallback, useEffect, useRef, useState } from 'react'
import type { VaultSession } from '../../core/session'
import { formatBytes, saveBlob } from '../../lib/download'
import { formatDay, formatTime, today } from '../../lib/dates'
import { renderMarkdown } from '../../lib/markdown'
import {
  defaultTitle,
  displayTitle,
  MOODS,
  newEntry,
  type Attachment,
  type Entry,
} from '../../model/entry'
import { promptFor } from '../../model/prompts'
import { defaultSettings, liveTemplates } from '../../model/settings'
import { canRecord } from '../../media/recorder'
import { AttachmentViewer } from '../AttachmentViewer'
import { RecordSheet, type RecordMode } from '../RecordSheet'
import { Thumb } from '../Thumb'
import { TagEditor } from '../TagEditor'
import { tagCounts } from '../../model/tags'
import { ErrorNote, ProgressBar } from '../components'
import { useController } from '../controllerContext'
import { href, navigate } from '../router'
import { LocationChip, LocationSheet } from '../Location'
import {
  geolocationAvailable,
  LocationError,
  locateNow,
  permissionState,
} from '../../location/locate'
import { getLocationState, setLocationState } from '../../core/prefs'
import { livePlaces } from '../../model/settings'
import type { EntryLocation } from '../../model/location'

const AUTOSAVE_DELAY = 800

/** Unsaved new entries, so creating one doesn't remount the editor when its URL changes. */
const drafts = new Map<string, Entry>()

export function NewEntry({
  date,
  template,
  prompt,
}: {
  date: string | null
  template?: string | null
  prompt?: number | null
}) {
  const c = useController()
  useEffect(() => {
    const day = date ?? today()
    const draft = newEntry(day)
    const t = template
      ? liveTemplates(c.session?.settings ?? defaultSettings()).find((x) => x.id === template)
      : undefined
    if (t) {
      draft.title = t.title
      draft.body = t.body
      draft.tags = [...t.tags]
    } else if (prompt !== null && prompt !== undefined) {
      draft.body = `> ${promptFor(day, prompt)}\n\n`
    }
    drafts.set(draft.id, draft)
    navigate({ name: 'entry', id: draft.id, edit: true }, true)
  }, [c, date, template, prompt])
  return null
}

/** An entry's place among its day's entries (by creation time), for the default title. */
function entryNumberIn(session: VaultSession, e: Entry): number {
  const earlier = (x: { id: string; date: string; createdAt: string }) =>
    x.date === e.date && x.id !== e.id && x.createdAt <= e.createdAt
  return (
    [...session.entries.values()].filter(earlier).length +
    [...session.summaries.values()].filter(earlier).length +
    1
  )
}

function isBlank(e: Entry): boolean {
  return !e.title.trim() && !e.body.trim() && e.attachments.length === 0 && e.mood === null
}

export function EntryPage({ id, edit }: { id: string; edit: boolean }) {
  const c = useController()
  const session = c.session
  const entry = session?.entries.get(id) ?? drafts.get(id)
  const summary = session?.summaries.get(id)

  if (!entry) {
    return (
      <div className="page">
        {summary ? (
          <p className="empty">This entry is still downloading from Google Drive…</p>
        ) : (
          <p className="empty">This entry doesn't exist (it may have been deleted).</p>
        )}
        <p className="center">
          <a href={href({ name: 'day', date: null })}>Back to today</a>
        </p>
      </div>
    )
  }
  if (edit && !c.readOnly) return <Editor initial={entry} isDraft={drafts.has(id)} />
  return <EntryView entry={entry} />
}

function useAttachmentDownload() {
  const c = useController()
  const [progress, setProgress] = useState<Record<string, number>>({})
  const [error, setError] = useState<string | null>(null)
  const download = async (a: Attachment) => {
    setError(null)
    setProgress((p) => ({ ...p, [a.fileId]: 0 }))
    try {
      const blob = await c.attachmentBlob(a, (done, total) =>
        setProgress((p) => ({ ...p, [a.fileId]: total ? done / total : 0 })),
      )
      saveBlob(blob, a.name)
    } catch (e) {
      setError(`${a.name}: ${(e as Error).message}`)
    } finally {
      setProgress((p) => {
        const next = { ...p }
        delete next[a.fileId]
        return next
      })
    }
  }
  return { download, progress, error, clearError: () => setError(null) }
}

function UploadState({ fileId }: { fileId: string }) {
  const c = useController()
  const item = c.uploads.items().find((u) => u.fileId === fileId)
  if (!item) return null
  if (item.active) {
    return (
      <span className="upload-state">
        Uploading {Math.round((item.uploaded / item.size) * 100)}%
        <ProgressBar value={item.uploaded} max={item.size} />
      </span>
    )
  }
  const why = !c.online ? 'offline' : c.uploads.blocked === 'auth' ? 'needs sign-in' : 'queued'
  return <span className="upload-state muted">Waiting to upload ({why})</span>
}

function AttachmentList(props: { attachments: Attachment[]; onRemove?: (a: Attachment) => void }) {
  const { download, progress, error, clearError } = useAttachmentDownload()
  const [viewing, setViewing] = useState<Attachment | null>(null)
  if (!props.attachments.length) return null
  return (
    <div className="attachments">
      {viewing && <AttachmentViewer attachment={viewing} onClose={() => setViewing(null)} />}
      <ul>
        {props.attachments.map((a) => (
          <li key={a.fileId}>
            <button className="thumb-button" onClick={() => setViewing(a)} tabIndex={-1}>
              <Thumb attachment={a} large />
            </button>
            <div className="attachment-main">
              <button
                className="attachment-name link"
                onClick={() => setViewing(a)}
                aria-label={`Open ${a.name}`}
              >
                {a.name}
              </button>
              <span className="muted small">{formatBytes(a.size)}</span>
              <UploadState fileId={a.fileId} />
            </div>
            <div className="attachment-actions">
              {a.fileId in progress ? (
                <ProgressBar value={progress[a.fileId]} max={1} />
              ) : (
                <button className="ghost small" onClick={() => void download(a)}>
                  Download
                </button>
              )}
              {props.onRemove && (
                <button className="ghost small danger" onClick={() => props.onRemove?.(a)}>
                  Remove
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      <ErrorNote message={error} onClose={clearError} />
    </div>
  )
}

function EntryView({ entry }: { entry: Entry }) {
  const c = useController()
  const [locOpen, setLocOpen] = useState(false)
  const mood = MOODS.find((m) => m.value === entry.mood)
  /** Changing the place of a saved entry; its date stays as it is. */
  const setLocation = async (location: EntryLocation | null) => {
    const session = c.session
    const stored = session?.entries.get(entry.id)
    if (!session || !stored) return
    const next: Entry = { ...stored, updatedAt: new Date().toISOString() }
    if (location) next.location = location
    else delete next.location
    await session.save(next)
  }
  const remove = async () => {
    if (!confirm('Delete this entry and its attachments? This cannot be undone in the app.')) return
    await c.session?.remove(entry.id)
    navigate({ name: 'day', date: entry.date }, true)
  }
  return (
    <article className="page entry-view">
      <p className="muted">
        <a href={href({ name: 'day', date: entry.date })}>{formatDay(entry.date)}</a> ·{' '}
        {formatTime(entry.createdAt)}
        {mood && (
          <span className="mood" title={mood.label}>
            {' '}
            {mood.emoji}
          </span>
        )}
      </p>
      <div className="loc-line">
        <LocationChip
          location={entry.location}
          onEdit={c.readOnly ? undefined : () => setLocOpen(true)}
        />
      </div>
      {locOpen && (
        <LocationSheet
          location={entry.location}
          onChange={setLocation}
          onClose={() => setLocOpen(false)}
        />
      )}
      <h1>{displayTitle(entry)}</h1>
      {entry.tags.length > 0 && (
        <div className="tag-line">
          {entry.tags.map((t) => (
            <a key={t} className="tag" href={href({ name: 'timeline', tag: t })}>
              #{t}
            </a>
          ))}
        </div>
      )}
      <div
        className="markdown"
        // Sanitised by DOMPurify in renderMarkdown.
        dangerouslySetInnerHTML={{ __html: renderMarkdown(entry.body) }}
      />
      <AttachmentList attachments={entry.attachments} />
      {!c.readOnly && (
        <div className="row">
          <a className="primary" href={href({ name: 'entry', id: entry.id, edit: true })}>
            Edit
          </a>
          <button className="ghost danger" onClick={() => void remove()}>
            Delete
          </button>
        </div>
      )}
    </article>
  )
}

type SaveState = 'saved' | 'pending' | 'saving' | 'error' | 'new'

function Editor({ initial, isDraft }: { initial: Entry; isDraft: boolean }) {
  const c = useController()
  const session = c.session!
  const [draft, setDraft] = useState(initial)
  const [tab, setTab] = useState<'write' | 'preview'>('write')
  const [state, setState] = useState<SaveState>(isDraft ? 'new' : 'saved')
  const [error, setError] = useState<string | null>(null)
  const [encrypting, setEncrypting] = useState<{ name: string; done: number; total: number }[]>([])
  const [recording, setRecording] = useState<RecordMode | null>(null)
  const [knownTags] = useState(() =>
    tagCounts((c.session?.list() ?? []).map((i) => (i.kind === 'entry' ? i.entry : i.summary))),
  )
  const draftRef = useRef(initial)
  const dirtyRef = useRef(false)
  const savedOnceRef = useRef(!isDraft)
  const baseRef = useRef(initial.updatedAt)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const savingRef = useRef<Promise<void>>(Promise.resolve())
  const mountedRef = useRef(true)
  const [locOpen, setLocOpen] = useState(false)
  const [locating, setLocating] = useState(false)
  const [askLocation, setAskLocation] = useState(false)

  const save = useCallback(async () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    const run = async () => {
      if (!dirtyRef.current || session.locked) return
      const current = draftRef.current
      if (!savedOnceRef.current && isBlank(current)) return
      dirtyRef.current = false
      const toSave = { ...current, updatedAt: new Date().toISOString() }
      // No title: save it as "<date> · Entry n" (n = its place among that day's entries).
      if (!toSave.title.trim()) {
        toSave.title = defaultTitle(toSave.date, entryNumberIn(session, toSave))
        draftRef.current = { ...draftRef.current, title: toSave.title }
        setDraft(draftRef.current)
      }
      setState('saving')
      try {
        await session.save(toSave)
        baseRef.current = toSave.updatedAt
        savedOnceRef.current = true
        drafts.delete(toSave.id)
        setState(dirtyRef.current ? 'pending' : 'saved')
      } catch (e) {
        dirtyRef.current = true
        setState('error')
        setError(`Could not save: ${(e as Error).message}`)
      }
    }
    savingRef.current = savingRef.current.then(run)
    return savingRef.current
  }, [session])

  const entryNumber = (e: Entry) => entryNumberIn(session, e)

  const update = (patch: Partial<Entry>) => {
    const next = { ...draftRef.current, ...patch }
    draftRef.current = next
    dirtyRef.current = true
    setDraft(next)
    setState('pending')
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => void save(), AUTOSAVE_DELAY)
  }

  /** Sets the location without touching the save state of an entry that is still blank. */
  const setLocation = (location: EntryLocation | null) => {
    const next = { ...draftRef.current }
    if (location) next.location = location
    else delete next.location
    if (!savedOnceRef.current && isBlank(next)) {
      draftRef.current = next
      setDraft(next)
      return
    }
    draftRef.current = next
    dirtyRef.current = true
    setDraft(next)
    setState('pending')
    void save()
  }

  // A new entry for today gets the current location once, in the background: writing and
  // saving never wait for it. Past dates and existing entries are left alone.
  const runAutoLocation = useCallback(async () => {
    setLocating(true)
    try {
      const loc = await locateNow(livePlaces(session.settings))
      setLocationState('asked')
      const id = initial.id
      if (mountedRef.current) {
        const d = draftRef.current
        if (!d.location && d.date === today()) setLocation(loc)
        return
      }
      // The editor was closed before the position arrived: add it to the saved entry.
      const stored = session.entries.get(id)
      if (stored && !stored.location && stored.date === today() && !session.locked) {
        await session.save({ ...stored, location: loc, updatedAt: new Date().toISOString() })
      }
    } catch (e) {
      // Denied or timed out: leave it empty and don't ask again (Settings shows "Location off").
      if (e instanceof LocationError) setLocationState('off', e.reason)
    } finally {
      if (mountedRef.current) setLocating(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, initial.id])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    if (!isDraft || initial.location || initial.date !== today()) return
    if (!session.settings.addLocation.value || !geolocationAvailable()) return
    const state = getLocationState()
    if (state === 'off') return
    let live = true
    void (async () => {
      if (state === 'asked') return void runAutoLocation()
      // First time on this device: explain in one sentence before the browser asks.
      const perm = await permissionState()
      if (!live) return
      if (perm === 'granted') void runAutoLocation()
      else if (perm === 'denied') setLocationState('off', 'denied')
      else setAskLocation(true)
    })()
    return () => {
      live = false
    }
    // Only when the editor opens for a new entry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The background thumbnail job leaves this entry alone while it is being edited.
  useEffect(() => c.registerEditing(initial.id), [c, initial.id])

  // Save when leaving the page, hiding the app, or locking.
  useEffect(() => {
    const unregister = c.registerFlush(save)
    const onHide = () => {
      if (document.visibilityState === 'hidden') void save()
    }
    document.addEventListener('visibilitychange', onHide)
    window.addEventListener('pagehide', onHide)
    return () => {
      unregister()
      document.removeEventListener('visibilitychange', onHide)
      window.removeEventListener('pagehide', onHide)
      void save()
    }
  }, [c, save])

  // Another device changed this entry and we have no unsaved typing: show their version.
  const stored = session.entries.get(initial.id)
  useEffect(() => {
    if (stored && stored.updatedAt !== baseRef.current && !dirtyRef.current) {
      baseRef.current = stored.updatedAt
      draftRef.current = stored
      setDraft(stored)
    }
  }, [stored])

  const addFiles = async (files: FileList | null) => {
    if (!files?.length) return
    setError(null)
    const list = [...files]
    setEncrypting(list.map((f) => ({ name: f.name, done: 0, total: f.size })))
    for (const [i, file] of list.entries()) {
      try {
        const att = await c.attachFile(file, (done, total) =>
          setEncrypting((cur) => cur.map((x, j) => (j === i ? { ...x, done, total } : x))),
        )
        update({ attachments: [...draftRef.current.attachments, att] })
        await save()
      } catch (e) {
        setError(`${file.name}: ${(e as Error).message}`)
      }
    }
    setEncrypting([])
  }

  /** A kept recording or photo: encrypted on the device and queued like any attachment. */
  const keepRecording = async (file: File) => {
    const att = await c.attachFile(file)
    update({ attachments: [...draftRef.current.attachments, att] })
    await save()
  }

  const removeAttachment = async (a: Attachment) => {
    if (!confirm(`Remove ${a.name} from this entry?`)) return
    update({ attachments: draftRef.current.attachments.filter((x) => x.fileId !== a.fileId) })
    await save()
    await session.releaseAttachment(a)
  }

  const remove = async () => {
    if (!savedOnceRef.current) {
      drafts.delete(draft.id)
      dirtyRef.current = false
      navigate({ name: 'day', date: draft.date }, true)
      return
    }
    if (!confirm('Delete this entry and its attachments? This cannot be undone in the app.')) return
    dirtyRef.current = false
    await savingRef.current
    await session.remove(draft.id)
    navigate({ name: 'day', date: draft.date }, true)
  }

  const done = async () => {
    await save()
    if (savedOnceRef.current) navigate({ name: 'entry', id: draft.id, edit: false }, true)
    else navigate({ name: 'day', date: draft.date }, true)
  }

  const status =
    state === 'new'
      ? 'Start typing — saves automatically'
      : state === 'pending' || state === 'saving'
        ? 'Saving…'
        : state === 'error'
          ? 'Not saved'
          : c.sync?.status.pendingEntries
            ? 'Saved on this device'
            : 'Saved'

  return (
    <div className="page editor">
      <div className="editor-bar">
        <span className={`save-state ${state}`} aria-live="polite">
          {status}
        </span>
        <button className="primary small" onClick={() => void done()}>
          Done
        </button>
      </div>
      <input
        className="title-input"
        // Shown greyed out; used as the title if you leave it empty.
        placeholder={defaultTitle(draft.date, entryNumber(draft))}
        value={draft.title}
        onChange={(e) => update({ title: e.target.value })}
        aria-label="Title"
      />
      <div className="editor-meta">
        <input
          type="date"
          value={draft.date}
          onChange={(e) => e.target.value && update({ date: e.target.value })}
          aria-label="Date"
        />
        <div className="mood-picker" role="radiogroup" aria-label="Mood">
          {MOODS.map((m) => (
            <button
              key={m.value}
              role="radio"
              aria-checked={draft.mood === m.value}
              className={draft.mood === m.value ? 'selected' : ''}
              title={m.label}
              onClick={() => update({ mood: draft.mood === m.value ? null : m.value })}
            >
              {m.emoji}
            </button>
          ))}
        </div>
      </div>
      <div className="loc-line">
        <LocationChip location={draft.location} busy={locating} onEdit={() => setLocOpen(true)} />
      </div>
      {askLocation && (
        <div className="note loc-ask" role="status">
          <p>
            Vault Diary can note where you write each new entry; the place is stored only inside
            your encrypted entry, never sent anywhere.
          </p>
          <div className="row">
            <button
              className="primary small"
              onClick={() => {
                setAskLocation(false)
                setLocationState('asked')
                void runAutoLocation()
              }}
            >
              Add my location
            </button>
            <button
              className="ghost small"
              onClick={() => {
                setAskLocation(false)
                setLocationState('off', 'declined')
              }}
            >
              Not now
            </button>
          </div>
        </div>
      )}
      {locOpen && (
        <LocationSheet
          location={draft.location}
          onChange={(l) => setLocation(l)}
          onClose={() => setLocOpen(false)}
        />
      )}
      <TagEditor tags={draft.tags} known={knownTags} onChange={(tags) => update({ tags })} />
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'write'} onClick={() => setTab('write')}>
          Write
        </button>
        <button role="tab" aria-selected={tab === 'preview'} onClick={() => setTab('preview')}>
          Preview
        </button>
      </div>
      {tab === 'write' ? (
        <textarea
          className="body-input"
          placeholder="What happened today? Markdown works: **bold**, _italic_, - lists, # headings"
          value={draft.body}
          onChange={(e) => update({ body: e.target.value })}
          aria-label="Entry text"
          autoFocus={isDraft}
        />
      ) : (
        <div
          className="markdown preview"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(draft.body) }}
        />
      )}
      <AttachmentList attachments={draft.attachments} onRemove={(a) => void removeAttachment(a)} />
      {encrypting.map((x) => (
        <div key={x.name} className="encrypting">
          <span>Encrypting {x.name}…</span>
          <ProgressBar value={x.done} max={x.total} />
        </div>
      ))}
      <ErrorNote message={error} onClose={() => setError(null)} />
      {recording && (
        <RecordSheet
          mode={recording}
          entry={{ id: draft.id, date: draft.date }}
          onKeep={keepRecording}
          onClose={() => setRecording(null)}
        />
      )}
      {canRecord() && (
        <div className="row record-buttons">
          <button className="ghost" onClick={() => setRecording('audio')}>
            🎙 Voice note
          </button>
          <button className="ghost" onClick={() => setRecording('video')}>
            🎥 Video
          </button>
          <button className="ghost" onClick={() => setRecording('photo')}>
            📷 Photo
          </button>
        </div>
      )}
      <div className="row">
        <label className="ghost button-like">
          Attach files
          <input
            type="file"
            multiple
            hidden
            onChange={(e) => {
              void addFiles(e.target.files)
              e.target.value = ''
            }}
          />
        </label>
        <button className="ghost danger" onClick={() => void remove()}>
          {state === 'new' ? 'Discard' : 'Delete entry'}
        </button>
      </div>
    </div>
  )
}
