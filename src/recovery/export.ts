// Plain-text export layout shared by recovery.html. recover.py implements the same rules and a
// test checks both produce byte-identical files from the committed fixture.
import { isId } from '../crypto/bytes'
import { compareEntriesDesc, displayTitle, type Entry } from '../model/entry'
import { locationFrontMatter } from '../model/location'

export function slugify(title: string): string {
  const ascii = title
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '')
    .toLowerCase()
  const slug = ascii
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/g, '')
  return slug || 'untitled'
}

export function safeFileName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '_').replace(/^[\s.]+|[\s.]+$/g, '')
  const limited = Array.from(cleaned).slice(0, 120).join('')
  return limited || 'file'
}

export function entryPath(e: Entry): string {
  return `entries/${e.date}/${slugify(displayTitle(e))}-${e.id.slice(0, 8)}.md`
}

export function attachmentPath(fileId: string, name: string): string {
  return `files/${fileId.slice(0, 8)}-${safeFileName(name)}`
}

/**
 * A HEIC photo's JPEG viewing copy (FORMAT.md revision 3) is exported next to the original:
 * files/<id8>-IMG_0042.HEIC → files/<id8>-IMG_0042-view.jpg (id8 of the original).
 */
export function viewCopyPath(fileId: string, name: string): string {
  return `files/${fileId.slice(0, 8)}-${safeFileName(name.replace(/\.[^.]*$/, ''))}-view.jpg`
}

export function orphanPath(fileId: string): string {
  return `files/${fileId.slice(0, 8)}-unreferenced.bin`
}

export function entryToMarkdown(e: Entry, available: (fileId: string) => boolean): string {
  const lines = [
    '---',
    `id: ${e.id}`,
    `date: ${e.date}`,
    `title: ${JSON.stringify(e.title)}`,
    `created: ${e.createdAt}`,
    `updated: ${e.updatedAt}`,
    `mood: ${e.mood ?? 'null'}`,
    `tags: ${JSON.stringify(e.tags)}`,
    // Revision 4: where it was written, when the entry has a location.
    ...locationFrontMatter(e.location),
    '---',
    '',
    `# ${displayTitle(e)}`,
    '',
  ]
  if (e.body) lines.push(e.body.replace(/\r\n/g, '\n'), '')
  if (e.attachments.length) {
    lines.push('## Attachments', '')
    for (const a of e.attachments) {
      const note = available(a.fileId) ? `${a.size} bytes` : 'missing from this copy'
      lines.push(
        `- [${a.name.replace(/[[\]]/g, '')}](<../../${attachmentPath(a.fileId, a.name)}>) (${note})`,
      )
      if (isId(a.viewCopyFileId) && available(a.viewCopyFileId)) {
        lines.push(`  - [Viewing copy (JPEG)](<../../${viewCopyPath(a.fileId, a.name)}>)`)
      }
    }
    lines.push('')
  }
  return lines.join('\n')
}

export interface RecoveryOutput {
  path: string
  blob: Blob
}

/**
 * Turns decrypted entries and attachment files into the plain-text export layout: one Markdown
 * file per entry under entries/<date>/ and the attachments under files/. Used by recovery.html
 * and by the app's Markdown export (Settings → Export). Files that no entry references are
 * written as …-unreferenced.bin, except thumbnails, which are previews and not exported.
 * Missing attachments are reported in `problems`.
 */
export function buildOutputs(
  entries: Entry[],
  files: Map<string, Blob>,
  problems: string[],
): RecoveryOutput[] {
  const sorted = [...entries].sort(compareEntriesDesc)
  const outputs: RecoveryOutput[] = []
  const named = new Map<string, string>()
  // Oldest entry first so the first reference to a file decides its name, as in recover.py.
  for (const e of [...sorted].reverse()) {
    for (const a of e.attachments) {
      if (!named.has(a.fileId)) named.set(a.fileId, attachmentPath(a.fileId, a.name))
    }
  }
  // Viewing copies of HEIC photos are exported next to their original.
  const viewCopies = new Map<string, string>()
  for (const e of [...sorted].reverse()) {
    for (const a of e.attachments) {
      if (isId(a.viewCopyFileId) && !viewCopies.has(a.viewCopyFileId)) {
        viewCopies.set(a.viewCopyFileId, viewCopyPath(a.fileId, a.name))
      }
    }
  }
  for (const e of sorted) {
    const md = entryToMarkdown(e, (id) => files.has(id))
    outputs.push({ path: entryPath(e), blob: new Blob([md], { type: 'text/markdown' }) })
  }
  // Thumbnails (attachments' thumbFileId) are previews the app can remake; they are not exported.
  const thumbs = new Set<string>()
  for (const e of sorted) {
    for (const a of e.attachments) if (isId(a.thumbFileId)) thumbs.add(a.thumbFileId)
  }
  for (const [id, blob] of files) {
    if (!named.has(id) && !viewCopies.has(id) && thumbs.has(id)) continue
    outputs.push({ path: named.get(id) ?? viewCopies.get(id) ?? orphanPath(id), blob })
  }
  for (const [id, path] of named) {
    if (!files.has(id)) problems.push(`Attachment ${path} is missing from the selected files.`)
  }
  return outputs
}
