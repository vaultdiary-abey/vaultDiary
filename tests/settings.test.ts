import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { randomBytes } from '../src/crypto/bytes'
import { importMasterKey } from '../src/crypto/container'
import { VaultSession } from '../src/core/session'
import { FakeDrive } from '../src/drive/fake'
import { createVaultFolder, type VaultLocation } from '../src/drive/vaultFolder'
import { defaultTitle } from '../src/model/entry'
import { PROMPTS, promptFor } from '../src/model/prompts'
import {
  defaultSettings,
  deleteTemplate,
  liveTemplates,
  mergeSettings,
  parseSettings,
  saveTemplate,
  setShowPrompts,
} from '../src/model/settings'
import { KV, VaultDB } from '../src/storage/db'
import { SyncEngine } from '../src/sync/sync'

const at = (s: number) => new Date(Date.UTC(2026, 10, 1, 0, 0, s))

describe('settings.vds model', () => {
  it('saves, edits and deletes templates', () => {
    let s = saveTemplate(defaultSettings(), {
      name: ' Gratitude ',
      title: '',
      body: '- ',
      tags: ['#thanks', 'Thanks'],
    })
    const [t] = liveTemplates(s)
    expect(t).toMatchObject({ name: 'Gratitude', tags: ['thanks'] })
    s = saveTemplate(s, { ...t, body: '1. ' })
    expect(liveTemplates(s)[0].body).toBe('1. ')
    s = deleteTemplate(s, t.id)
    expect(liveTemplates(s)).toEqual([])
    expect(s.templates[0].deleted).toBe(true)
  })

  it('merges two devices: templates by id, newest wins, deletions stick; commutative', () => {
    const base = saveTemplate(
      defaultSettings(),
      { name: 'Daily', title: '', body: 'x', tags: [] },
      at(1),
    )
    const id = base.templates[0].id
    const a = saveTemplate(
      saveTemplate(base, { id, name: 'Daily', title: '', body: 'edited on A', tags: [] }, at(5)),
      { name: 'Workout', title: 'Gym', body: '', tags: [] },
      at(6),
    )
    const b = setShowPrompts(deleteTemplate(base, id, at(3)), false, at(4))
    const ab = mergeSettings(a, b)
    expect(ab).toEqual(mergeSettings(b, a))
    expect(liveTemplates(ab).map((t) => [t.name, t.body])).toEqual([
      ['Daily', 'edited on A'], // edit (t=5) newer than delete (t=3)
      ['Workout', ''],
    ])
    expect(ab.showPrompts.value).toBe(false)
    const later = deleteTemplate(ab, id, at(9))
    expect(liveTemplates(mergeSettings(later, a)).map((t) => t.name)).toEqual(['Workout'])
  })

  it('parses defensively and keeps unknown fields', () => {
    const s = parseSettings({
      v: 1,
      templates: [{ id: 'bad' }, { id: 'a'.repeat(32), name: 3, x: 1 }],
      future: true,
    })
    expect(s.templates).toHaveLength(1)
    expect(s.templates[0]).toMatchObject({ name: 'Template', x: 1 })
    expect(s.future).toBe(true)
    expect(s.showPrompts.value).toBe(true)
    expect(() => parseSettings({ v: 2 })).toThrow()
  })
})

describe('prompts and default titles', () => {
  it('rotates one prompt per day and steps with an offset', () => {
    expect(promptFor('2026-11-02')).not.toBe(promptFor('2026-11-03'))
    expect(promptFor('2026-11-02', 1)).toBe(promptFor('2026-11-03'))
    expect(promptFor('2026-11-02', PROMPTS.length)).toBe(promptFor('2026-11-02'))
    expect(promptFor('2026-11-02', -1)).toBe(promptFor('2026-11-01'))
  })

  it('makes a title from the date and the entry number', () => {
    expect(defaultTitle('2026-11-02', 2)).toMatch(/2026 · Entry 2$/)
  })
})

describe('settings.vds sync between devices', () => {
  let drive: FakeDrive
  let location: VaultLocation
  let mk: CryptoKey
  let n = 0
  beforeEach(async () => {
    drive = new FakeDrive()
    location = (await createVaultFolder(drive)).location
    mk = await importMasterKey(randomBytes(32))
  })
  async function device() {
    const db = new VaultDB(`settings-${++n}`)
    await db.setKv(
      KV.vaultJson,
      JSON.stringify({ format: 'vaultdiary-vault', v: 1, vaultId: 'a'.repeat(32), wrappers: [] }),
    )
    if (![...drive.files.values()].some((f) => f.name === 'vault.json'))
      await db.setKv(KV.vaultDirty, true)
    const session = await VaultSession.open(db, mk)
    const sync = new SyncEngine({
      db,
      session,
      getDrive: () => drive,
      getLocation: () => location,
      readOnly: false,
    })
    return { db, session, sync }
  }

  it('templates made on two devices offline both end up everywhere; settings.vds is encrypted', async () => {
    const a = await device()
    await a.sync.sync()
    const b = await device()
    await b.sync.sync()
    await a.session.saveSettings(
      saveTemplate(a.session.settings, {
        name: 'From A',
        title: '',
        body: 'secret body A',
        tags: [],
      }),
    )
    await b.session.saveSettings(
      saveTemplate(b.session.settings, { name: 'From B', title: '', body: '', tags: [] }),
    )
    await b.session.saveSettings(setShowPrompts(b.session.settings, false))
    await a.sync.sync()
    await b.sync.sync()
    await a.sync.sync()
    for (const d of [a, b]) {
      expect(
        liveTemplates(d.session.settings)
          .map((t) => t.name)
          .sort(),
      ).toEqual(['From A', 'From B'])
      expect(d.session.settings.showPrompts.value).toBe(false)
      expect(await d.db.getKv(KV.settingsDirty)).toBe(false)
    }
    const files = [...drive.files.values()].filter((f) => f.name === 'settings.vds' && !f.trashed)
    expect(files).toHaveLength(1)
    expect(Buffer.from(files[0].data.subarray(0, 4)).toString()).toBe('VDV1')
    expect(Buffer.from(files[0].data).includes(Buffer.from('secret body'))).toBe(false)
    // A third device starting fresh gets them.
    const c = await device()
    await c.sync.sync()
    expect(liveTemplates(c.session.settings)).toHaveLength(2)
  })
})
