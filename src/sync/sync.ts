// Two-way sync of entries between IndexedDB and Drive.
//
// Change detection uses Drive's md5Checksum: every save re-encrypts with fresh IVs, so any edit
// changes it. When an entry changed on both sides since the last sync, Drive's version keeps the
// id and this device's version becomes a new "(conflict copy)" entry. Nothing is ever dropped.
import { Emitter } from '../core/emitter'
import type { VaultSession } from '../core/session'
import { randomId, utf8 } from '../crypto/bytes'
import { encryptBytes } from '../crypto/container'
import { parseVault } from '../crypto/vault'
import { applyVaultOps, mergeVault, stripSeq, type PendingVaultOp } from '../crypto/vaultMerge'
import {
  AuthError,
  DriveError,
  OfflineError,
  type DriveClient,
  type DriveFile,
} from '../drive/types'
import { INDEX_FILE, VAULT_FILE, type VaultLocation } from '../drive/vaultFolder'
import { buildIndex, conflictCopy, mergeThumbnailsOnly, type Entry } from '../model/entry'
import { KV, type EntryRecord, type VaultDB } from '../storage/db'

export type SyncState = 'idle' | 'syncing' | 'offline' | 'needs-auth' | 'error'

export interface SyncStatus {
  state: SyncState
  lastSyncedAt: number | null
  error: string | null
  problems: string[]
  pendingEntries: number
  downloading: { done: number; total: number } | null
}

export interface SyncDeps {
  db: VaultDB
  session: VaultSession
  getDrive: () => DriveClient | null
  getLocation: () => VaultLocation | null
  readOnly: boolean
  /** Called when another device changed vault.json (e.g. a new passphrase). */
  onVaultChanged?: (json: string) => void
}

const ENTRY_NAME = /^([0-9a-f]{32})\.vde$/

async function blobBytes(blob: Blob): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await blob.arrayBuffer())
}

async function runLimited<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length)
  let next = 0
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++
      results[i] = await tasks[i]()
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker))
  return results
}

export class SyncEngine extends Emitter {
  private readonly deps: SyncDeps
  private running: Promise<void> | null = null
  private again = false
  status: SyncStatus = {
    state: 'idle',
    lastSyncedAt: null,
    error: null,
    problems: [],
    pendingEntries: 0,
    downloading: null,
  }

  constructor(deps: SyncDeps) {
    super()
    this.deps = deps
  }

  private set(patch: Partial<SyncStatus>) {
    this.status = { ...this.status, ...patch }
    this.emit()
  }

  async refreshPending(): Promise<void> {
    this.set({ pendingEntries: await this.deps.db.entries.where('dirty').equals(1).count() })
  }

  /** Runs a sync; if one is already running, runs once more after it. */
  sync(): Promise<void> {
    if (this.running) {
      this.again = true
      return this.running
    }
    this.running = (async () => {
      try {
        do {
          this.again = false
          await this.run()
        } while (this.again && this.status.state === 'idle')
      } finally {
        this.running = null
      }
    })()
    return this.running
  }

  private async run(): Promise<void> {
    const { db, session, getDrive, getLocation, readOnly } = this.deps
    const drive = getDrive()
    const location = getLocation()
    if (!drive || !location) {
      this.set({ state: 'needs-auth' })
      return
    }
    if (session.locked) return
    this.set({ state: 'syncing', error: null, problems: [] })
    const problems: string[] = []
    try {
      const rootFiles = await drive.list(location.rootId)
      const newest = (name: string) =>
        rootFiles
          .filter((f) => f.name === name)
          .sort((a, b) => (a.modifiedTime < b.modifiedTime ? 1 : -1))[0] ?? null
      const vaultRemote = newest(VAULT_FILE)
      const vaultPending = await db.getKv<boolean>(KV.vaultDirty)
      if (!vaultRemote && !vaultPending) {
        problems.push(
          'vault.json was missing from the VaultDiary folder in Google Drive; this device restored it.',
        )
        if (!readOnly) await db.setKv(KV.vaultDirty, true)
      }
      await this.syncVault(drive, location, vaultRemote, problems)
      if (!readOnly) await this.processDeletes(drive, location)
      const indexRemote = newest(INDEX_FILE)
      const pulled = await this.pull(
        drive,
        location,
        indexRemote,
        problems,
        !vaultRemote && !vaultPending,
      )
      const pushed = readOnly ? 0 : await this.push(drive, location, problems)
      if (!readOnly && pulled.complete && (pulled.changed || pushed > 0 || !indexRemote)) {
        await this.writeIndex(drive, location, indexRemote)
      }
      const now = Date.now()
      await db.setKv(KV.lastSyncedAt, now)
      this.set({ state: 'idle', lastSyncedAt: now, problems, downloading: null })
    } catch (e) {
      if (e instanceof AuthError) this.set({ state: 'needs-auth', downloading: null, problems })
      else if (e instanceof OfflineError)
        this.set({ state: 'offline', downloading: null, problems })
      else this.set({ state: 'error', error: (e as Error).message, downloading: null, problems })
    } finally {
      await this.refreshPending()
    }
  }

  private async syncVault(
    drive: DriveClient,
    location: VaultLocation,
    remote: DriveFile | null,
    problems: string[],
  ) {
    const { db, readOnly } = this.deps
    const json = await db.getKv<string>(KV.vaultJson)
    if (!json) return
    if (!readOnly && (await db.getKv<boolean>(KV.vaultDirty))) {
      await this.pushVault(drive, location, remote, json, problems)
      return
    }
    if (remote && remote.md5 !== (await db.getKv<string>(KV.vaultMd5))) {
      const text = await (await drive.download(remote.id)).text()
      const current = parseVault(json)
      const incoming = parseVault(text)
      if (incoming.vaultId !== current.vaultId) {
        throw new Error('vault.json on Drive belongs to a different vault than this device.')
      }
      await db.setKv(KV.vaultJson, text)
      await db.setKv(KV.vaultDriveId, remote.id)
      await db.setKv(KV.vaultMd5, remote.md5)
      if (text !== json) this.deps.onVaultChanged?.(text)
    }
  }

  /**
   * Never overwrites Drive's vault.json: downloads it, re-applies this device's pending changes
   * on top (see vaultMerge.ts) and uploads the result.
   */
  private async pushVault(
    drive: DriveClient,
    location: VaultLocation,
    remote: DriveFile | null,
    json: string,
    problems: string[],
  ) {
    const { db } = this.deps
    const local = parseVault(json)
    const ops = (await db.getKv<PendingVaultOp[]>(KV.vaultOps)) ?? []
    let merged = local
    if (remote) {
      const result = mergeVault(
        await (await drive.download(remote.id)).text(),
        local,
        stripSeq(ops),
      )
      merged = result.vault
      problems.push(...result.notes)
    }
    const text = JSON.stringify(merged, null, 2)
    const blob = new Blob([text], { type: 'application/json' })
    const file = remote
      ? await drive.updateFile(remote.id, blob)
      : await drive.createFile(location.rootId, VAULT_FILE, blob)
    const pushedSeq = ops.reduce((max, o) => Math.max(max, o.seq), -1)
    const finalText = await db.transaction('rw', db.kv, async () => {
      // Changes made while we were uploading stay pending and are applied on top locally.
      const remaining = ((await db.getKv<PendingVaultOp[]>(KV.vaultOps)) ?? []).filter(
        (o) => o.seq > pushedSeq,
      )
      const finalText = remaining.length
        ? JSON.stringify(applyVaultOps(merged, stripSeq(remaining)).vault, null, 2)
        : text
      await db.setKv(KV.vaultJson, finalText)
      await db.setKv(KV.vaultOps, remaining)
      await db.setKv(KV.vaultDriveId, file.id)
      await db.setKv(KV.vaultMd5, file.md5)
      await db.setKv(KV.vaultDirty, remaining.length > 0)
      return finalText
    })
    if (finalText !== json) this.deps.onVaultChanged?.(finalText)
  }

  private async processDeletes(drive: DriveClient, location: VaultLocation) {
    const { db } = this.deps
    for (const d of await db.deletes.toArray()) {
      const [folder, name] = d.path.split('/')
      const parent = folder === 'files' ? location.filesId : location.entriesId
      for (const f of await drive.findByName(parent, name)) await drive.trash(f.id)
      await db.deletes.delete(d.path)
    }
  }

  private async pull(
    drive: DriveClient,
    location: VaultLocation,
    indexRemote: DriveFile | null,
    problems: string[],
    suspicious: boolean,
  ): Promise<{ changed: boolean; complete: boolean }> {
    const { db, session } = this.deps
    const remote = new Map<string, DriveFile>()
    for (const f of await drive.list(location.entriesId)) {
      const m = ENTRY_NAME.exec(f.name)
      if (!m) continue
      const prev = remote.get(m[1])
      // Duplicate names can appear after an interrupted upload; the newest wins.
      if (!prev || prev.modifiedTime < f.modifiedTime) remote.set(m[1], f)
    }
    const records = new Map((await db.entries.toArray()).map((r) => [r.id, r]))

    const missing = [...remote.keys()].filter((id) => !records.has(id))
    if (missing.length && indexRemote && indexRemote.md5 !== (await db.getKv(KV.indexMd5))) {
      try {
        const data = await blobBytes(await drive.download(indexRemote.id))
        const summaries = await session.decryptIndex(data)
        await db.setKv(KV.indexData, data)
        await db.setKv(KV.indexMd5, indexRemote.md5)
        session.setSummaries(summaries.filter((s) => remote.has(s.id)))
      } catch (e) {
        if (e instanceof AuthError || e instanceof OfflineError) throw e
        problems.push(`index.vdi: ${(e as Error).message}`)
      }
    }
    for (const id of [...session.summaries.keys()]) {
      if (!remote.has(id)) session.summaries.delete(id)
    }

    const tasks: (() => Promise<boolean>)[] = []
    for (const [id, file] of remote) {
      const rec = records.get(id)
      if (rec && rec.driveId === file.id && rec.remoteMd5 === file.md5) continue
      tasks.push(async () => {
        try {
          return await this.reconcile(drive, id, file)
        } catch (e) {
          if (e instanceof AuthError || e instanceof OfflineError) throw e
          problems.push(`Entry ${id}: ${(e as Error).message}`)
          return false
        } finally {
          const d = this.status.downloading
          if (d) this.set({ downloading: { ...d, done: d.done + 1 } })
        }
      })
    }
    this.set({ downloading: tasks.length ? { done: 0, total: tasks.length } : null })
    const results = await runLimited(tasks, 4)
    let changed = results.some(Boolean)

    const synced = [...records.values()].filter((r) => r.driveId)
    const vanished = synced.filter((r) => !remote.has(r.id))
    // If the folder was trashed or emptied, Drive simply lists nothing. Never let that wipe the
    // offline copy: mass disappearances are reported instead of applied.
    const massVanish = vanished.length >= 5 && vanished.length > synced.length / 2
    if (vanished.length && (suspicious || massVanish)) {
      problems.push(
        `${vanished.length} entries disappeared from Google Drive at once, so this device kept its ` +
          'copies. If the VaultDiary folder was moved to the trash, restore it in drive.google.com.',
      )
    } else {
      for (const rec of vanished) changed = (await this.remoteDeleted(rec.id)) || changed
    }
    const allLocal = [...remote.keys()].every((id) => session.entries.has(id))
    if (allLocal && session.summaries.size === 0) await db.deleteKv(KV.indexData)
    session.changed()
    return { changed, complete: allLocal && !(vanished.length && (suspicious || massVanish)) }
  }

  private async localEntry(rec: EntryRecord): Promise<Entry | null> {
    if (rec.deleted) return null
    return this.deps.session.decryptEntry(rec.data, rec.id)
  }

  /** Applies a remote version that differs from what this device last saw. */
  private async reconcile(drive: DriveClient, id: string, file: DriveFile): Promise<boolean> {
    const { db, session } = this.deps
    const data = await blobBytes(await drive.download(file.id))
    const remote = await session.decryptEntry(data, id)
    const rec = await db.entries.get(id)
    const local = rec ? await this.localEntry(rec) : null
    const remoteRecord = (base?: EntryRecord): EntryRecord => ({
      id,
      data,
      rev: base?.rev ?? 0,
      dirty: 0,
      deleted: 0,
      driveId: file.id,
      remoteMd5: file.md5,
      syncedUpdatedAt: remote.updatedAt,
      pushingUpdatedAt: null,
    })

    let write: EntryRecord[] = []
    let apply: Entry[] = []
    let thumbMerge: ReturnType<typeof mergeThumbnailsOnly> = null
    if (!rec) {
      write = [remoteRecord()]
      apply = [remote]
    } else if (local && local.updatedAt === remote.updatedAt) {
      // Same version on both sides (e.g. our upload went through but the reply was lost).
      write = [
        {
          ...rec,
          driveId: file.id,
          remoteMd5: file.md5,
          syncedUpdatedAt: remote.updatedAt,
          pushingUpdatedAt: null,
          dirty: 0,
        },
      ]
    } else if (!rec.dirty) {
      write = [remoteRecord(rec)]
      apply = [remote]
    } else if (
      remote.updatedAt === rec.syncedUpdatedAt ||
      remote.updatedAt === rec.pushingUpdatedAt
    ) {
      // Drive holds a version we already know about; our newer local edit wins.
      write = [{ ...rec, driveId: file.id, remoteMd5: file.md5, syncedUpdatedAt: remote.updatedAt }]
    } else if (rec.deleted || !local) {
      // Deleted here but edited elsewhere: keep the edit.
      write = [remoteRecord(rec)]
      apply = [remote]
    } else if ((thumbMerge = mergeThumbnailsOnly(local, remote))) {
      // Both sides only added thumbnails: merge them instead of making a conflict copy.
      const { merged, changed } = thumbMerge
      if (!changed) {
        write = [remoteRecord(rec)]
        apply = [remote]
      } else {
        const next = { ...merged, updatedAt: new Date().toISOString() }
        write = [
          {
            ...remoteRecord(rec),
            data: await session.encryptEntry(next),
            dirty: 1,
          },
        ]
        apply = [next]
      }
    } else {
      const copy = conflictCopy(local)
      write = [
        remoteRecord(rec),
        {
          id: copy.id,
          data: await session.encryptEntry(copy),
          rev: 1,
          dirty: 1,
          deleted: 0,
          driveId: null,
          remoteMd5: null,
          syncedUpdatedAt: null,
          pushingUpdatedAt: null,
        },
      ]
      apply = [remote, copy]
    }

    const committed = await db.transaction('rw', db.entries, async () => {
      const fresh = await db.entries.get(id)
      if ((fresh?.rev ?? null) !== (rec?.rev ?? null)) return false
      await db.entries.bulkPut(write)
      return true
    })
    if (!committed) {
      this.again = true // edited while we were downloading; look again next round
      return false
    }
    for (const e of apply) session.applyRemote(e)
    // This device's thumbnails that lost to Drive's are deleted.
    for (const id of thumbMerge?.dropped ?? []) await session.releaseFile(id)
    return apply.length > 0
  }

  private async remoteDeleted(id: string): Promise<boolean> {
    const { db, session } = this.deps
    return db.transaction('rw', db.entries, async () => {
      const rec = await db.entries.get(id)
      if (!rec) return false
      if (rec.dirty && !rec.deleted) {
        // Edited here but deleted elsewhere: keep the edit by uploading it as a new file.
        await db.entries.put({
          ...rec,
          driveId: null,
          remoteMd5: null,
          syncedUpdatedAt: null,
          pushingUpdatedAt: null,
        })
        return false
      }
      await db.entries.delete(id)
      session.forget(id)
      return true
    })
  }

  private async push(drive: DriveClient, location: VaultLocation, problems: string[]) {
    const { db, session } = this.deps
    let pushed = 0
    for (const rec of await db.entries.where('dirty').equals(1).toArray()) {
      if (session.locked) break
      try {
        if (rec.deleted) {
          if (rec.driveId) await drive.trash(rec.driveId)
          await db.transaction('rw', db.entries, async () => {
            const fresh = await db.entries.get(rec.id)
            if (fresh && fresh.rev === rec.rev) await db.entries.delete(rec.id)
          })
          pushed++
          continue
        }
        const entry = await session.decryptEntry(rec.data, rec.id)
        await db.entries.update(rec.id, { pushingUpdatedAt: entry.updatedAt })
        const blob = new Blob([rec.data])
        let file: DriveFile
        try {
          file = rec.driveId
            ? await drive.updateFile(rec.driveId, blob)
            : await drive.createFile(location.entriesId, `${rec.id}.vde`, blob)
        } catch (e) {
          if (!(e instanceof DriveError && e.status === 404)) throw e
          file = await drive.createFile(location.entriesId, `${rec.id}.vde`, blob)
        }
        await db.transaction('rw', db.entries, async () => {
          const fresh = await db.entries.get(rec.id)
          if (!fresh) return
          await db.entries.put({
            ...fresh,
            driveId: file.id,
            remoteMd5: file.md5,
            syncedUpdatedAt: entry.updatedAt,
            pushingUpdatedAt: null,
            dirty: fresh.rev === rec.rev ? 0 : 1,
          })
        })
        pushed++
      } catch (e) {
        if (e instanceof AuthError || e instanceof OfflineError) throw e
        problems.push(`Uploading entry ${rec.id}: ${(e as Error).message}`)
      }
    }
    return pushed
  }

  private async writeIndex(drive: DriveClient, location: VaultLocation, remote: DriveFile | null) {
    const { db, session } = this.deps
    const index = buildIndex(session.entries.values())
    const data = await encryptBytes(session.key, randomId(), 'index', utf8(JSON.stringify(index)))
    const blob = new Blob([data])
    const file = remote
      ? await drive.updateFile(remote.id, blob)
      : await drive.createFile(location.rootId, INDEX_FILE, blob)
    await db.setKv(KV.indexMd5, file.md5)
  }
}
