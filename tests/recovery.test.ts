import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fromBase64, randomBytes, randomId, utf8 } from '../src/crypto/bytes'
import { encryptBytes } from '../src/crypto/container'
import { WrongSecretError } from '../src/crypto/errors'
import { passkeyWrappers, unwrapWithPasskey } from '../src/crypto/passkey'
import { createVault, parseVault, unwrapWithPassphrase } from '../src/crypto/vault'
import { crc32, ZipWriter } from '../src/lib/zip'
import { newEntry, type Entry } from '../src/model/entry'
import { collect, decryptAll, outputsToZip, unlock, type InputFile } from '../src/recovery/core'
import { attachmentPath, entryPath, entryToMarkdown } from '../src/recovery/export'
import { FIXTURE, SECRETS, walk } from './fixtureFiles'

function fixtureInputs(): InputFile[] {
  return [...walk(join(FIXTURE, 'VaultDiary'))].map(([path, data]) => ({
    path: `VaultDiary/${path}`,
    blob: new Blob([new Uint8Array(data)]),
  }))
}

async function outputsAsMap(outputs: { path: string; blob: Blob }[]) {
  const out = new Map<string, Buffer>()
  for (const o of outputs) out.set(o.path, Buffer.from(await o.blob.arrayBuffer()))
  return out
}

/** A zip with deflated members, like Google Drive's "Download folder" zips. */
async function deflateZip(files: InputFile[]): Promise<Blob> {
  const parts: BlobPart[] = []
  const central: Uint8Array<ArrayBuffer>[] = []
  let offset = 0
  for (const f of files) {
    const raw = new Uint8Array(await f.blob.arrayBuffer())
    const comp = new Uint8Array(
      await new Response(
        f.blob.stream().pipeThrough(new CompressionStream('deflate-raw')),
      ).arrayBuffer(),
    )
    const name = utf8(f.path)
    const crc = crc32(raw)
    const local = new Uint8Array(30 + name.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)
    lv.setUint16(8, 8, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, comp.length, true)
    lv.setUint32(22, raw.length, true)
    lv.setUint16(26, name.length, true)
    local.set(name, 30)
    const cd = new Uint8Array(46 + name.length)
    const cv = new DataView(cd.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(10, 8, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, comp.length, true)
    cv.setUint32(24, raw.length, true)
    cv.setUint16(28, name.length, true)
    cv.setUint32(42, offset, true)
    cd.set(name, 46)
    parts.push(local, comp)
    central.push(cd)
    offset += local.length + comp.length
  }
  const size = central.reduce((n, c) => n + c.length, 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, files.length, true)
  ev.setUint16(10, files.length, true)
  ev.setUint32(12, size, true)
  ev.setUint32(16, offset, true)
  return new Blob([...parts, ...central, end])
}

describe('recovery core (used by recovery.html) on the committed fixture', () => {
  const expected = walk(join(FIXTURE, 'expected'))

  it('recovers a folder with the passphrase', async () => {
    const collected = await collect(fixtureInputs())
    const mk = await unlock(collected, { passphrase: SECRETS.passphrase })
    const result = await decryptAll(mk, collected)
    expect(result.problems).toEqual([])
    expect(await outputsAsMap(result.outputs)).toEqual(expected)
  })

  it('recovers with the recovery words', async () => {
    const collected = await collect(fixtureInputs())
    const mk = await unlock(collected, { words: SECRETS.recoveryWords })
    expect(await outputsAsMap((await decryptAll(mk, collected)).outputs)).toEqual(expected)
  })

  it('recovers from our backup zip and from a Drive-style deflate zip', async () => {
    const backup = new ZipWriter()
    for (const f of fixtureInputs()) await backup.add(f.path, f.blob)
    for (const zip of [backup.finish(), await deflateZip(fixtureInputs())]) {
      const collected = await collect([{ path: 'download.zip', blob: zip }])
      const mk = await unlock(collected, { passphrase: SECRETS.passphrase })
      const result = await decryptAll(mk, collected)
      expect(result.problems).toEqual([])
      expect(await outputsAsMap(result.outputs)).toEqual(expected)
    }
  })

  it('the fixture has a passkey slot that opens the same master key', async () => {
    const vault = parseVault(readFileSync(join(FIXTURE, 'VaultDiary', 'vault.json'), 'utf8'))
    const [slot] = passkeyWrappers(vault)
    expect(slot).toBeTruthy()
    const viaPasskey = await unwrapWithPasskey(vault, slot, fromBase64(SECRETS.passkeyPrfOutput))
    expect(viaPasskey).toEqual(await unwrapWithPassphrase(vault, SECRETS.passphrase))
  })

  it('skips a settings.vds container silently (FORMAT.md revision 2)', async () => {
    const collected0 = await collect(fixtureInputs())
    const mk = await unlock(collected0, { passphrase: SECRETS.passphrase })
    const id = randomId()
    const settings = await encryptBytes(mk, id, 'settings', utf8('{"templates":[]}'))
    const inputs = [
      ...fixtureInputs(),
      { path: 'VaultDiary/settings.vds', blob: new Blob([settings]) },
    ]
    const collected = await collect(inputs)
    const result = await decryptAll(mk, collected)
    expect(result.problems).toEqual([])
    expect(await outputsAsMap(result.outputs)).toEqual(expected)

    // recover.py too
    const root = mkdtempSync(join(tmpdir(), 'vd-settings-'))
    cpSync(join(FIXTURE, 'VaultDiary'), join(root, 'VaultDiary'), { recursive: true })
    writeFileSync(join(root, 'VaultDiary', 'settings.vds'), settings)
    const out = join(root, 'out')
    execFileSync('python3', ['recovery/recover.py', join(root, 'VaultDiary'), '-o', out], {
      env: { ...process.env, VAULTDIARY_PASSPHRASE: SECRETS.passphrase },
      stdio: 'pipe',
    })
    expect(walk(out)).toEqual(expected)
  })

  it('reports wrong secrets cleanly', async () => {
    const collected = await collect(fixtureInputs())
    await expect(unlock(collected, { passphrase: 'nope nope nope' })).rejects.toThrow(
      WrongSecretError,
    )
    await expect(unlock(collected, { words: 'abandon '.repeat(23) + 'art' })).rejects.toThrow(
      /do not belong/,
    )
  })

  it('reports damaged files and still recovers the rest', async () => {
    const inputs = fixtureInputs()
    const victim = inputs.find((f) => f.path.endsWith('.vde'))!
    const bytes = new Uint8Array(await victim.blob.arrayBuffer())
    bytes[bytes.length - 3] ^= 1
    victim.blob = new Blob([bytes])
    const collected = await collect(inputs)
    const result = await decryptAll(await unlock(collected, SECRETS), collected)
    expect(result.entries).toHaveLength(3)
    expect(result.problems.join('\n')).toMatch(/failed authentication/)
    const zip = await outputsToZip(result.outputs)
    expect(zip.size).toBeGreaterThan(0)
  })
})

describe('cross-check: recover.py decrypts a vault written by the app', () => {
  it('matches the committed fixture expectations', () => {
    const out = mkdtempSync(join(tmpdir(), 'vd-py-'))
    execFileSync(
      'python3',
      ['recovery/recover.py', join(FIXTURE, 'VaultDiary'), '-o', out, '--force'],
      {
        env: { ...process.env, VAULTDIARY_PASSPHRASE: SECRETS.passphrase },
        stdio: 'pipe',
      },
    )
    expect(walk(out)).toEqual(walk(join(FIXTURE, 'expected')))
  })

  it('decrypts a freshly written vault with default 4 MiB chunks (4 MiB + 1 attachment)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vd-fresh-'))
    const vaultDir = join(root, 'VaultDiary')
    const write = (path: string, data: Uint8Array | string) => {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, data)
    }
    const { vault, mk, recoveryWords } = await createVault('fresh passphrase here')
    write(join(vaultDir, 'vault.json'), JSON.stringify(vault))
    const big = randomBytes(4 * 1024 * 1024 + 1)
    const fileId = randomId()
    write(join(vaultDir, 'files', `${fileId}.vdf`), await encryptBytes(mk, fileId, 'file', big))
    const entry: Entry = {
      ...newEntry('2026-10-26'),
      title: 'Ünïcode ✓ title',
      body: 'Body with *markdown*',
      mood: 5,
      attachments: [
        { fileId, name: 'big file.bin', mime: 'application/octet-stream', size: big.length },
      ],
    }
    write(
      join(vaultDir, 'entries', `${entry.id}.vde`),
      await encryptBytes(mk, entry.id, 'entry', utf8(JSON.stringify(entry))),
    )

    const out = join(root, 'out')
    execFileSync('python3', ['recovery/recover.py', vaultDir, '-o', out, '--words'], {
      env: { ...process.env, VAULTDIARY_WORDS: recoveryWords.join(' ') },
      stdio: 'pipe',
    })
    const got = walk(out)
    expect(got.get(entryPath(entry))?.toString('utf8')).toBe(entryToMarkdown(entry, () => true))
    expect(got.get(attachmentPath(fileId, 'big file.bin'))?.equals(Buffer.from(big))).toBe(true)
  })
})
