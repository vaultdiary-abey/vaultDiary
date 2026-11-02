import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { it } from 'vitest'
import { randomBytes, randomId, toBase64, utf8, wipe } from '../src/crypto/bytes'
import { bytesSource, encryptBytes, encryptContainer } from '../src/crypto/container'
import { makePasskeyWrapper } from '../src/crypto/passkey'
import { createVault, unwrapWithPassphrase } from '../src/crypto/vault'
import { buildIndex, type Entry } from '../src/model/entry'
import { attachmentPath, entryPath, entryToMarkdown, orphanPath } from '../src/recovery/export'

const ROOT = 'tests/fixtures/sample-vault'
const PASSPHRASE = 'fixture passphrase do not use'

function write(path: string, data: Uint8Array | string) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, data)
}

function pseudoRandom(size: number, seed: number): Uint8Array {
  const out = new Uint8Array(size)
  let x = seed
  for (let i = 0; i < size; i++) {
    x = (x * 1103515245 + 12345) >>> 0
    out[i] = x >>> 24
  }
  return out
}

it('writes the sample vault fixture', async () => {
  rmSync(ROOT, { recursive: true, force: true })
  const { vault, mk, recoveryWords } = await createVault(PASSPHRASE)
  // Phase 2: a passkey slot, with a stand-in PRF output (a real one comes from the authenticator).
  const passkeyPrfOutput = randomBytes(32)
  const rawMk = await unwrapWithPassphrase(vault, PASSPHRASE)
  vault.wrappers.push(
    await makePasskeyWrapper(vault.vaultId, rawMk, {
      label: 'Fixture passkey',
      provider: 'icloud-keychain',
      rpId: 'vaultdiary-abey.github.io',
      credentialId: randomBytes(20),
      prfSalt: randomBytes(32),
      prfOutput: passkeyPrfOutput,
    }),
  )
  wipe(rawMk)

  const files = [
    { fileId: randomId(), name: 'hello.txt', mime: 'text/plain', data: utf8('Hello, vault!\n') },
    {
      fileId: randomId(),
      name: 'empty.bin',
      mime: 'application/octet-stream',
      data: new Uint8Array(0),
    },
    // 64 KiB chunks keep the repo small while still exercising multi-chunk files (4 chunks).
    {
      fileId: randomId(),
      name: 'résumé 2026.pdf',
      mime: 'application/pdf',
      data: pseudoRandom(200_000, 7),
      chunkSize: 65536,
    },
    {
      fileId: randomId(),
      name: 'unreferenced',
      mime: 'application/octet-stream',
      data: utf8('orphan'),
    },
    // Phase 2: a photo and an in-app recording, each with a thumbnail (its own .vdf).
    {
      fileId: randomId(),
      name: 'IMG_0042.jpg',
      mime: 'image/jpeg',
      data: pseudoRandom(30_000, 11),
    },
    {
      fileId: randomId(),
      name: 'Video 2026-03-05 06.01.02.webm',
      mime: 'video/webm;codecs=vp9,opus',
      data: pseudoRandom(50_000, 13),
    },
  ]
  // Thumbnails are opaque to recovery (it skips them), so stand-in bytes are enough here.
  const thumbs = [
    { fileId: randomId(), data: pseudoRandom(2_000, 17) },
    { fileId: randomId(), data: pseudoRandom(2_500, 19) },
  ]
  const att = (i: number) => ({
    fileId: files[i].fileId,
    name: files[i].name,
    mime: files[i].mime,
    size: files[i].data.length,
  })

  const entries: Entry[] = [
    {
      id: randomId(),
      date: '2026-01-15',
      createdAt: '2026-01-15T08:00:00.000Z',
      updatedAt: '2026-01-15T08:30:00.000Z',
      title: 'First day',
      body: '## Morning\n\nCafé ☕ — naïve façade.\n\n- one\n- two\n\n**bold** and _italic_.',
      tags: ['Café', 'first days'],
      mood: 4,
      attachments: [att(0), att(1)],
    },
    {
      id: randomId(),
      date: '2026-01-15',
      createdAt: '2026-01-15T20:00:00.000Z',
      updatedAt: '2026-01-15T20:00:00.000Z',
      title: '',
      body: 'Second entry the same day\nline two',
      tags: [],
      mood: null,
      attachments: [],
    },
    {
      id: randomId(),
      date: '2026-03-01',
      createdAt: '2026-03-01T10:00:00.000Z',
      updatedAt: '2026-03-02T11:00:00.000Z',
      title: 'Photos & things: <test>',
      body: '```js\nconsole.log("code")\n```\n\nA [link](https://example.com).',
      tags: [],
      mood: 2,
      attachments: [att(2)],
    },
    {
      id: randomId(),
      date: '2026-03-05',
      createdAt: '2026-03-05T06:00:00.000Z',
      updatedAt: '2026-03-05T06:00:00.000Z',
      title: '🌧️ Rainy day',
      body: '',
      tags: ['weather'],
      mood: 3,
      attachments: [
        { ...att(4), thumbFileId: thumbs[0].fileId },
        // durationMs stands for a field a later version might add: readers keep it.
        { ...att(5), thumbFileId: thumbs[1].fileId, durationMs: 62_000 },
      ],
    },
  ]

  const dir = join(ROOT, 'VaultDiary')
  write(join(dir, 'vault.json'), JSON.stringify(vault, null, 2) + '\n')
  for (const e of entries) {
    write(
      join(dir, 'entries', `${e.id}.vde`),
      await encryptBytes(mk, e.id, 'entry', utf8(JSON.stringify(e))),
    )
  }
  for (const f of [...files, ...thumbs.map((t) => ({ ...t, chunkSize: undefined }))]) {
    const parts: Uint8Array[] = []
    for await (const p of encryptContainer(mk, {
      id: f.fileId,
      kind: 'file',
      source: bytesSource(f.data),
      chunkSize: f.chunkSize,
    })) {
      parts.push(p)
    }
    write(join(dir, 'files', `${f.fileId}.vdf`), Buffer.concat(parts))
  }
  const indexId = randomId()
  write(
    join(dir, 'index.vdi'),
    await encryptBytes(mk, indexId, 'index', utf8(JSON.stringify(buildIndex(entries)))),
  )

  // What recovery must produce, built from the plaintext (not by decrypting the fixture).
  const exp = join(ROOT, 'expected')
  for (const e of entries)
    write(
      join(exp, entryPath(e)),
      entryToMarkdown(e, () => true),
    )
  files.forEach((f, i) =>
    write(join(exp, i === 3 ? orphanPath(f.fileId) : attachmentPath(f.fileId, f.name)), f.data),
  )
  // Thumbnails are not exported.

  write(
    join(ROOT, 'secrets.json'),
    JSON.stringify(
      {
        note: 'Test fixture only. Never use these secrets for a real vault.',
        passphrase: PASSPHRASE,
        recoveryWords: recoveryWords.join(' '),
        passkeyPrfOutput: toBase64(passkeyPrfOutput),
      },
      null,
      2,
    ) + '\n',
  )
})
