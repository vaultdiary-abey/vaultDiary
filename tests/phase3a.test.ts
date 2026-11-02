import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  attachmentBytes,
  buildMarkdownExport,
  entriesInRange,
  exportFolderName,
} from '../src/core/exporter'
import type { ListItem } from '../src/core/session'
import { readZip, zipEntryBlob } from '../src/lib/zip'
import { newEntry, type Entry, type EntrySummary } from '../src/model/entry'
import {
  backupOverdue,
  isOnThisDay,
  onThisDay,
  parseClock,
  shouldNudge,
} from '../src/model/reminders'
import { defaultSettings, mergeSettings, parseSettings, setLastBackup } from '../src/model/settings'
import { collect, decryptAll, unlock } from '../src/recovery/core'
import { attachmentPath, viewCopyPath } from '../src/recovery/export'
import { FIXTURE, SECRETS, walk } from './fixtureFiles'

describe('On this day', () => {
  it('matches the same day and month in earlier years only', () => {
    expect(isOnThisDay('2025-11-02', '2026-11-02')).toBe(true)
    expect(isOnThisDay('2019-11-02', '2026-11-02')).toBe(true)
    expect(isOnThisDay('2026-11-02', '2026-11-02')).toBe(false)
    expect(isOnThisDay('2027-11-02', '2026-11-02')).toBe(false)
    expect(isOnThisDay('2025-11-03', '2026-11-02')).toBe(false)
  })

  it('shows 29 February on 28 February in years without it', () => {
    expect(isOnThisDay('2024-02-29', '2025-02-28')).toBe(true)
    expect(isOnThisDay('2024-02-29', '2028-02-28')).toBe(false) // 2028 has a 29th
    expect(isOnThisDay('2024-02-29', '2028-02-29')).toBe(true)
    expect(isOnThisDay('2024-02-28', '2025-02-28')).toBe(true)
  })

  it('groups by year, newest first, and is empty when nothing matches', () => {
    const items = [
      { id: 'a', date: '2024-11-02' },
      { id: 'b', date: '2025-11-02' },
      { id: 'c', date: '2024-11-02' },
      { id: 'd', date: '2026-11-02' },
      { id: 'e', date: '2025-10-02' },
    ]
    const groups = onThisDay(items, '2026-11-02')
    expect(groups.map((g) => [g.year, g.yearsAgo, g.items.map((i) => i.id)])).toEqual([
      [2025, 1, ['b']],
      [2024, 2, ['a', 'c']],
    ])
    expect(onThisDay(items, '2026-11-05')).toEqual([])
  })
})

describe('writing nudge', () => {
  const at = (h: number, m = 0) => new Date(2026, 10, 2, h, m)
  const base = { nudgeTime: '20:00', hasEntryToday: false, dismissedOn: null, today: '2026-11-02' }

  it('parses HH:MM', () => {
    expect(parseClock('20:00')).toBe(1200)
    expect(parseClock('07:05')).toBe(425)
    expect(parseClock('off')).toBeNull()
    expect(parseClock('24:00')).toBeNull()
  })

  it('shows after the chosen time when there is no entry today', () => {
    expect(shouldNudge({ ...base, now: at(19, 59) })).toBe(false)
    expect(shouldNudge({ ...base, now: at(20, 0) })).toBe(true)
    expect(shouldNudge({ ...base, now: at(23, 30) })).toBe(true)
  })

  it('stays away when written, dismissed today, or turned off', () => {
    expect(shouldNudge({ ...base, now: at(21), hasEntryToday: true })).toBe(false)
    expect(shouldNudge({ ...base, now: at(21), dismissedOn: '2026-11-02' })).toBe(false)
    expect(shouldNudge({ ...base, now: at(21), dismissedOn: '2026-11-01' })).toBe(true)
    expect(shouldNudge({ ...base, now: at(21), nudgeTime: 'off' })).toBe(false)
  })
})

describe('backup reminder', () => {
  const now = new Date('2026-11-02T12:00:00Z')
  it('is due more than 30 days after the last backup', () => {
    const v = { vaultCreatedAt: '2025-01-01T00:00:00Z', now }
    expect(backupOverdue({ ...v, lastBackupAt: '2026-10-10T12:00:00Z' })).toBe(false)
    expect(backupOverdue({ ...v, lastBackupAt: '2026-10-03T12:00:00Z' })).toBe(false) // 30 days
    expect(backupOverdue({ ...v, lastBackupAt: '2026-10-02T11:00:00Z' })).toBe(true)
  })
  it('counts from vault creation when there was never a backup', () => {
    expect(backupOverdue({ lastBackupAt: null, vaultCreatedAt: '2026-10-30T00:00:00Z', now })).toBe(
      false,
    )
    expect(backupOverdue({ lastBackupAt: null, vaultCreatedAt: '2026-09-01T00:00:00Z', now })).toBe(
      true,
    )
    expect(backupOverdue({ lastBackupAt: null, vaultCreatedAt: null, now })).toBe(false)
  })
})

describe('settings.vds lastBackup (Phase 3, optional)', () => {
  it('is missing in older files and defaults to null', () => {
    const s = parseSettings({ v: 1, templates: [] })
    expect(s.lastBackup).toEqual({ value: null, updatedAt: '1970-01-01T00:00:00.000Z' })
  })

  it('ignores invalid values', () => {
    const s = parseSettings({ v: 1, lastBackup: { value: 'yesterday', updatedAt: 'x' } })
    expect(s.lastBackup.value).toBeNull()
  })

  it('round-trips and merges to the newest backup, commutatively', () => {
    const a = setLastBackup(defaultSettings(), new Date('2026-10-01T00:00:00Z'))
    const b = setLastBackup(defaultSettings(), new Date('2026-11-01T00:00:00Z'))
    expect(parseSettings(JSON.parse(JSON.stringify(a))).lastBackup).toEqual(a.lastBackup)
    expect(mergeSettings(a, b).lastBackup.value).toBe('2026-11-01T00:00:00.000Z')
    expect(mergeSettings(b, a).lastBackup.value).toBe('2026-11-01T00:00:00.000Z')
    // A device that never made a backup doesn't erase another device's.
    expect(mergeSettings(b, defaultSettings()).lastBackup.value).toBe('2026-11-01T00:00:00.000Z')
  })
})

describe('export', () => {
  const entry = (date: string, attachments: Entry['attachments'] = []): Entry => ({
    ...newEntry(date, new Date(`${date}T10:00:00Z`)),
    title: `Entry ${date}`,
    attachments,
  })
  const summary = (date: string): EntrySummary => ({
    id: 'f'.repeat(32),
    date,
    createdAt: `${date}T10:00:00Z`,
    updatedAt: `${date}T10:00:00Z`,
    title: 'Not here yet',
    mood: null,
    tags: [],
    attachmentCount: 0,
    excerpt: '',
  })

  it('selects entries in an inclusive range, oldest first, and counts downloads pending', () => {
    const items: ListItem[] = [
      { kind: 'entry', entry: entry('2026-03-05') },
      { kind: 'entry', entry: entry('2026-01-15') },
      { kind: 'entry', entry: entry('2025-12-31') },
      { kind: 'summary', summary: summary('2026-02-01') },
      { kind: 'summary', summary: summary('2024-02-01') },
    ]
    const r = entriesInRange(items, { from: '2026-01-01', to: '2026-03-05' })
    expect(r.entries.map((e) => e.date)).toEqual(['2026-01-15', '2026-03-05'])
    expect(r.pending).toBe(1)
  })

  it('counts each attachment once', () => {
    const a = { fileId: 'a'.repeat(32), name: 'x', mime: 'image/jpeg', size: 10 }
    const b = { fileId: 'b'.repeat(32), name: 'y', mime: 'image/jpeg', size: 5 }
    expect(attachmentBytes([entry('2026-01-01', [a, b]), entry('2026-01-02', [a])])).toBe(15)
  })

  it('names the folder after the range', () => {
    expect(exportFolderName({ from: '2026-01-01', to: '2026-01-31' })).toBe(
      'VaultDiary-export-2026-01-01-to-2026-01-31',
    )
    expect(exportFolderName({ from: '2026-01-01', to: '2026-01-01' })).toBe(
      'VaultDiary-export-2026-01-01',
    )
  })

  it('Markdown export of the fixture matches the recovery tools byte for byte', async () => {
    const inputs = [...walk(join(FIXTURE, 'VaultDiary'))].map(([path, data]) => ({
      path: `VaultDiary/${path}`,
      blob: new Blob([new Uint8Array(data)]),
    }))
    const collected = await collect(inputs)
    const mk = await unlock(collected, { passphrase: SECRETS.passphrase })
    const recovered = await decryptAll(mk, collected)
    const files = new Map<string, Blob>()
    for (const o of recovered.outputs) files.set(o.path, o.blob)
    // Where recovery put each file id (attachments by their name, viewing copies next to them).
    const paths = new Map<string, string>()
    for (const e of recovered.entries) {
      for (const a of e.attachments) {
        paths.set(a.fileId, attachmentPath(a.fileId, a.name))
        if (a.viewCopyFileId) paths.set(a.viewCopyFileId, viewCopyPath(a.fileId, a.name))
      }
    }
    const pathOf = (fileId: string) => paths.get(fileId)!

    const range = { from: '2000-01-01', to: '2100-01-01' }
    const { zip, problems } = await buildMarkdownExport(recovered.entries, range, async (a) =>
      files.get(pathOf(a.fileId))!,
    )
    expect(problems).toEqual([])
    const root = exportFolderName(range)
    const expected = walk(join(FIXTURE, 'expected'))
    const got = new Map<string, Buffer>()
    for (const e of await readZip(zip)) {
      expect(e.path.startsWith(`${root}/`)).toBe(true)
      got.set(
        e.path.slice(root.length + 1),
        Buffer.from(await (await zipEntryBlob(zip, e)).arrayBuffer()),
      )
    }
    // Everything referenced by an entry is exported exactly as recovery exports it; files no
    // entry references (only recovery sees those) are not part of an export.
    const referenced = [...expected.keys()].filter((p) => !p.endsWith('-unreferenced.bin'))
    expect([...got.keys()].sort()).toEqual(referenced.sort())
    for (const p of referenced) expect(got.get(p)!.equals(expected.get(p)!), p).toBe(true)
  })

  it('carries on when an attachment cannot be fetched and lists it as missing', async () => {
    const a = { fileId: 'a'.repeat(32), name: 'gone.jpg', mime: 'image/jpeg', size: 3 }
    const range = { from: '2026-01-01', to: '2026-01-01' }
    const { zip, problems } = await buildMarkdownExport([entry('2026-01-01', [a])], range, () =>
      Promise.reject(new Error('offline')),
    )
    expect(problems).toEqual(['gone.jpg: offline'])
    const [md] = await readZip(zip)
    const text = await (await zipEntryBlob(zip, md)).text()
    expect(text).toContain('missing from this copy')
  })
})

describe('fixture uses the Phase 3 settings field', () => {
  it('settings.vds in the committed fixture carries lastBackup', async () => {
    const { readFileSync } = await import('node:fs')
    const { decryptJson } = await import('../src/crypto/container')
    const inputs = [...walk(join(FIXTURE, 'VaultDiary'))].map(([path, data]) => ({
      path: `VaultDiary/${path}`,
      blob: new Blob([new Uint8Array(data)]),
    }))
    const mk = await unlock(await collect(inputs), { passphrase: SECRETS.passphrase })
    const raw = readFileSync(join(FIXTURE, 'VaultDiary', 'settings.vds'))
    const s = parseSettings(
      await decryptJson(mk, new Uint8Array(raw), { expectedKind: 'settings' }),
    )
    expect(s.lastBackup.value).toBe('2026-03-06T08:00:00.000Z')
  })
})
