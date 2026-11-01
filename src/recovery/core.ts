// Offline recovery: takes the files of a downloaded VaultDiary folder and/or zips (our backup
// zip or Google Drive's "Download" zips), unlocks vault.json and decrypts everything.
// Used by recovery.html; recover.py implements the same steps.
import { fromUtf8, isId, wipe } from '../crypto/bytes'
import {
  blobSource,
  decryptBytes,
  decryptToBlob,
  importMasterKey,
  MAGIC,
  readHeader,
  type ContainerHeader,
} from '../crypto/container'
import { WrongSecretError } from '../crypto/errors'
import {
  parseVault,
  unwrapWithPassphrase,
  unwrapWithRecoveryWords,
  type VaultFile,
} from '../crypto/vault'
import { compareEntriesDesc, parseEntry, type Entry } from '../model/entry'
import { readZip, zipEntryBlob, ZipWriter } from '../lib/zip'
import { attachmentPath, entryPath, entryToMarkdown, orphanPath } from './export'

export interface InputFile {
  path: string
  blob: Blob
}

interface Container {
  path: string
  blob: Blob
  header: ContainerHeader
}

export interface Collected {
  vaults: VaultFile[]
  containers: Container[]
  problems: string[]
}

function isZip(f: InputFile): boolean {
  return /\.zip$/i.test(f.path)
}

async function startsWithMagic(blob: Blob): Promise<boolean> {
  if (blob.size < 4) return false
  const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer())
  return head.every((b, i) => b === MAGIC[i])
}

/** Expands zips and sorts files into vault.json candidates and VDV1 containers. */
export async function collect(files: InputFile[]): Promise<Collected> {
  const out: Collected = { vaults: [], containers: [], problems: [] }
  const queue: InputFile[] = []
  for (const f of files) {
    if (!isZip(f)) {
      queue.push(f)
      continue
    }
    try {
      for (const entry of await readZip(f.blob)) {
        queue.push({ path: `${f.path}/${entry.path}`, blob: await zipEntryBlob(f.blob, entry) })
      }
    } catch (e) {
      out.problems.push(`${f.path}: ${(e as Error).message}`)
    }
  }
  const seenVaults = new Set<string>()
  for (const f of queue) {
    try {
      if (/\.json$/i.test(f.path) && f.blob.size < 1024 * 1024) {
        const vault = parseVault(fromUtf8(new Uint8Array(await f.blob.arrayBuffer())))
        const key = JSON.stringify(vault)
        if (!seenVaults.has(key)) {
          seenVaults.add(key)
          out.vaults.push(vault)
        }
      } else if (await startsWithMagic(f.blob)) {
        const { header } = await readHeader(blobSource(f.blob))
        out.containers.push({ path: f.path, blob: f.blob, header })
      }
    } catch (e) {
      out.problems.push(`${f.path}: ${(e as Error).message}`)
    }
  }
  return out
}

export type Secret = { passphrase: string } | { words: string }

/** Tries every vault.json found (a backup may hold an older one) until one opens. */
export async function unlock(collected: Collected, secret: Secret): Promise<CryptoKey> {
  if (!collected.vaults.length) throw new Error('No vault.json found in what you selected.')
  const ids = new Set(collected.vaults.map((v) => v.vaultId))
  if (ids.size > 1) throw new Error('The selection contains more than one different vault.')
  let lastError: unknown = null
  for (const vault of collected.vaults) {
    try {
      const raw =
        'passphrase' in secret
          ? await unwrapWithPassphrase(vault, secret.passphrase)
          : await unwrapWithRecoveryWords(vault, secret.words)
      try {
        return await importMasterKey(raw)
      } finally {
        wipe(raw)
      }
    } catch (e) {
      if (!(e instanceof WrongSecretError)) throw e
      lastError = e
    }
  }
  throw lastError
}

export interface RecoveryOutput {
  path: string
  blob: Blob
}

export interface RecoveryResult {
  entries: Entry[]
  outputs: RecoveryOutput[]
  problems: string[]
}

export async function decryptAll(
  mk: CryptoKey,
  collected: Collected,
  onProgress?: (done: number, total: number, label: string) => void,
): Promise<RecoveryResult> {
  const problems = [...collected.problems]
  const byId = new Map<string, Entry>()
  const files = new Map<string, Blob>()
  const total = collected.containers.length
  let done = 0
  for (const c of collected.containers) {
    onProgress?.(done, total, c.path)
    try {
      if (c.header.kind === 'entry') {
        const plain = await decryptBytes(mk, new Uint8Array(await c.blob.arrayBuffer()), {
          expectedKind: 'entry',
        })
        const entry = parseEntry(JSON.parse(fromUtf8(plain)), c.header.id)
        const existing = byId.get(entry.id)
        if (!existing || existing.updatedAt < entry.updatedAt) byId.set(entry.id, entry)
      } else if (c.header.kind === 'file') {
        files.set(
          c.header.id,
          await decryptToBlob(mk, blobSource(c.blob), 'application/octet-stream', {
            expectedKind: 'file',
          }),
        )
      }
      // index.vdi only speeds up the app and settings.vds holds app settings (templates);
      // recovery rebuilds everything from entries and files and skips both silently.
    } catch (e) {
      problems.push(`${c.path}: ${(e as Error).message}`)
    }
    done++
  }
  onProgress?.(done, total, '')

  const entries = [...byId.values()].sort(compareEntriesDesc)
  const outputs: RecoveryOutput[] = []
  const named = new Map<string, string>()
  // Oldest entry first so the first reference to a file decides its name, as in recover.py.
  for (const e of [...entries].reverse()) {
    for (const a of e.attachments) {
      if (!named.has(a.fileId)) named.set(a.fileId, attachmentPath(a.fileId, a.name))
    }
  }
  for (const e of entries) {
    const md = entryToMarkdown(e, (id) => files.has(id))
    outputs.push({ path: entryPath(e), blob: new Blob([md], { type: 'text/markdown' }) })
  }
  // Thumbnails (attachments' thumbFileId) are previews the app can remake; they are not exported.
  const thumbs = new Set<string>()
  for (const e of entries) {
    for (const a of e.attachments) if (isId(a.thumbFileId)) thumbs.add(a.thumbFileId)
  }
  for (const [id, blob] of files) {
    if (!named.has(id) && thumbs.has(id)) continue
    outputs.push({ path: named.get(id) ?? orphanPath(id), blob })
  }
  for (const [id, path] of named) {
    if (!files.has(id)) problems.push(`Attachment ${path} is missing from the selected files.`)
  }
  return { entries, outputs, problems }
}

export async function outputsToZip(outputs: RecoveryOutput[]): Promise<Blob> {
  const zip = new ZipWriter()
  for (const o of outputs) await zip.add(`VaultDiary-recovered/${o.path}`, o.blob)
  return zip.finish()
}
