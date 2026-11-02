// Plain-text exports (Settings → Export). These files are NOT encrypted; the UI warns and asks
// for the passphrase or a passkey first (Controller.confirmForExport).
//
// The Markdown export uses the recovery tools' layout and code (src/recovery/export.ts), so an
// export and a recovery of the same entries produce the same files.
import { ZipWriter } from '../lib/zip'
import { compareEntriesDesc, type Attachment, type Entry } from '../model/entry'
import { buildOutputs } from '../recovery/export'
import type { ListItem } from './session'

export interface DateRange {
  /** yyyy-MM-dd, inclusive. */
  from: string
  /** yyyy-MM-dd, inclusive. */
  to: string
}

/** The zip writer has no ZIP64. */
export const MAX_EXPORT_BYTES = 4 * 1024 * 1024 * 1024 - 64 * 1024 * 1024

export function inRange(date: string, range: DateRange): boolean {
  return date >= range.from && date <= range.to
}

/**
 * Entries in the range, oldest first, and how many in the range are still downloading (only
 * known from the index, so they can't be exported yet).
 */
export function entriesInRange(
  items: readonly ListItem[],
  range: DateRange,
): { entries: Entry[]; pending: number } {
  const entries: Entry[] = []
  let pending = 0
  for (const item of items) {
    const date = item.kind === 'entry' ? item.entry.date : item.summary.date
    if (!inRange(date, range)) continue
    if (item.kind === 'entry') entries.push(item.entry)
    else pending++
  }
  entries.sort((a, b) => -compareEntriesDesc(a, b))
  return { entries, pending }
}

/** Plaintext bytes of all attachments (each file counted once). */
export function attachmentBytes(entries: readonly Entry[]): number {
  const seen = new Map<string, number>()
  for (const e of entries) for (const a of e.attachments) seen.set(a.fileId, a.size)
  let total = 0
  for (const n of seen.values()) total += n
  return total
}

export function exportFolderName(range: DateRange): string {
  return range.from === range.to
    ? `VaultDiary-export-${range.from}`
    : `VaultDiary-export-${range.from}-to-${range.to}`
}

export interface MarkdownExportResult {
  zip: Blob
  problems: string[]
}

/**
 * A .zip of entries as Markdown files (entries/<date>/…md) with attachments in files/.
 * `getFile` returns an attachment's decrypted bytes; one that can't be fetched is listed as
 * "missing from this copy" and reported, and the export carries on.
 */
export async function buildMarkdownExport(
  entries: readonly Entry[],
  range: DateRange,
  getFile: (attachment: Attachment) => Promise<Blob>,
  onProgress?: (done: number, total: number) => void,
): Promise<MarkdownExportResult> {
  if (attachmentBytes(entries) > MAX_EXPORT_BYTES) {
    throw new Error(
      'These entries have more than 4 GB of attachments, which is more than one export can ' +
        'hold. Choose a shorter date range.',
    )
  }
  const problems: string[] = []
  const files = new Map<string, Blob>()
  const wanted = new Map<string, Attachment>()
  for (const e of entries) for (const a of e.attachments) wanted.set(a.fileId, a)
  let done = 0
  onProgress?.(done, wanted.size)
  for (const a of wanted.values()) {
    try {
      files.set(a.fileId, await getFile(a))
    } catch (e) {
      problems.push(`${a.name}: ${(e as Error).message}`)
    }
    onProgress?.(++done, wanted.size)
  }
  const outputs = buildOutputs([...entries], files, [])
  const zip = new ZipWriter()
  const root = exportFolderName(range)
  for (const o of outputs) await zip.add(`${root}/${o.path}`, o.blob)
  return { zip: zip.finish(), problems }
}
