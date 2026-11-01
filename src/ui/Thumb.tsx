import { useEffect, useState } from 'react'
import { isId } from '../crypto/bytes'
import { mediaKind } from '../media/kind'
import type { Attachment } from '../model/entry'
import { useController } from './controllerContext'

const ICONS = { image: '🖼️', video: '🎞️', audio: '🎵', pdf: '📄', other: '📎' } as const

/** An attachment's thumbnail, or a generic icon for its kind when it has none (yet). */
export function Thumb({ attachment, large = false }: { attachment: Attachment; large?: boolean }) {
  const c = useController()
  const id = isId(attachment.thumbFileId) ? attachment.thumbFileId : null
  const [loaded, setLoaded] = useState<{ id: string; url: string } | null>(null)
  useEffect(() => {
    if (!id) return
    let live = true
    void c.thumbnailUrl(id).then((url) => {
      if (live && url) setLoaded({ id, url })
    })
    return () => {
      live = false
    }
  }, [c, id])
  const kind = mediaKind(attachment.mime, attachment.name)
  const cls = `thumb${large ? ' thumb-large' : ''}`
  if (id && loaded?.id === id) {
    return (
      <span className={`${cls} thumb-img`} data-kind={kind}>
        <img src={loaded.url} alt="" draggable={false} />
      </span>
    )
  }
  return (
    <span className={`${cls} thumb-icon`} aria-hidden="true" data-kind={kind}>
      {ICONS[kind]}
    </span>
  )
}
