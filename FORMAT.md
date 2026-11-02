# Vault Diary file format, version 1 (revision 3)

This document is the complete description of what Vault Diary stores. Anyone with this document,
the files, and the passphrase or the 24 recovery words can decrypt everything without the app.
`recovery/recover.py` is a reference implementation in about 500 lines of Python.

All cryptography is standard: **AES-256-GCM** (128-bit tag, 96-bit IV), **Argon2id** (v1.3),
**HKDF-SHA256**, **BIP39** English word encoding. Nothing is home-made.

## 1. Folder layout

The app creates a normal, visible folder in the user's Google Drive:

```
VaultDiary/
  vault.json              master key, wrapped once per unlock method (plain JSON)
  index.vdi               encrypted index of entry summaries (optional, rebuildable)
  settings.vds            encrypted app settings, e.g. templates (revision 2, optional)
  entries/<id>.vde        one encrypted diary entry each
  files/<id>.vdf          one encrypted attachment each
```

- `<id>` is 128 random bits written as 32 lowercase hex characters (`[0-9a-f]{32}`). Ids carry no
  information. File names, sizes rounded up to whole chunks, and timestamps are the only things
  Google can see.
- The Drive folder also carries the app property `vaultdiary=root` so the app can find it even if
  it is renamed or moved. Recovery tools do not need this.
- Tools must identify files by their **contents** (the `VDV1` magic and the header's `kind` and
  `id`), not by name: Drive may rename duplicates (`abc (1).vde`) and zips may nest folders.
- If two files claim the same entry id, the one whose decrypted `updatedAt` is later wins.

## 2. Keys

```
MK  (master key)      256 random bits, generated once at setup. Never stored unwrapped.
FK  (file key)        256 random bits, one per encrypted file, stored wrapped by MK in its header.
KEK (key-encryption)  derived from a passphrase or the recovery key; wraps MK in vault.json.
```

Changing the passphrase only replaces the passphrase wrapper in `vault.json`. MK, every file key
and every encrypted file stay exactly the same.

## 3. vault.json

```json
{
  "format": "vaultdiary-vault",
  "v": 1,
  "vaultId": "3f2c…32 hex…",
  "createdAt": "2026-10-26T04:00:00.000Z",
  "updatedAt": "2026-10-26T04:00:00.000Z",
  "wrappers": [
    {
      "type": "passphrase",
      "kdf": {
        "name": "argon2id",
        "version": 19,
        "memoryKiB": 65536,
        "iterations": 3,
        "parallelism": 1,
        "salt": "<base64, 16 bytes>"
      },
      "iv": "<base64, 12 bytes>",
      "ct": "<base64, 48 bytes = 32-byte MK + 16-byte tag>",
      "updatedAt": "2026-11-01T09:00:00.000Z"
    },
    {
      "type": "recovery",
      "kdf": {
        "name": "hkdf-sha256",
        "salt": "<base64, 16 bytes>",
        "info": "VaultDiary v1 recovery key"
      },
      "iv": "<base64, 12 bytes>",
      "ct": "<base64, 48 bytes>"
    }
  ]
}
```

Base64 is standard RFC 4648 with `+/` and `=` padding, except where a field is marked
**base64url** (RFC 4648 §5, `-_`, no padding).

`wrappers` may hold any number of passkey wrappers (§3.3) and wrapper types a reader doesn't
know. Readers must ignore wrapper types they do not understand, and writers must keep them (and
any unknown fields) unchanged. There is exactly one `passphrase` and one `recovery` wrapper.

### 3.1 Passphrase wrapper

```
password = UTF-8( NFC-normalise(passphrase) )
KEK      = Argon2id(password, salt, m = memoryKiB, t = iterations, p = parallelism,
                    version 0x13, output length 32 bytes)
MK       = AES-256-GCM-Decrypt(key = KEK, iv, ct, AAD = ASCII "VDV1/mk/<vaultId>/passphrase")
```

`updatedAt` (revision 2, optional) is when this passphrase was set. When two devices changed the
passphrase before syncing, the newer one wins (§3.4). If it is missing (Phase 1 vaults), the
vault's own `updatedAt` stands in for it.

The app writes m = 65536 KiB (64 MiB), t = 3, p = 1. Readers accept 8192 ≤ m ≤ 1048576,
1 ≤ t ≤ 32, 1 ≤ p ≤ 16 and refuse anything else (protects against a hostile vault.json).

### 3.2 Recovery wrapper

The recovery key is 256 random bits, shown once as 24 BIP39 English words: the 256 bits followed by
the first 8 bits of SHA-256(recovery key) are split into 24 groups of 11 bits, each indexing the
standard 2048-word list (big-endian, most significant bit first). Every word is uniquely
identified by its first four letters.

```
KEK = HKDF-SHA256(IKM = recovery key (32 bytes), salt, info = UTF-8(info), length 32)
MK  = AES-256-GCM-Decrypt(key = KEK, iv, ct, AAD = ASCII "VDV1/mk/<vaultId>/recovery")
```

This is plain BIP39 entropy encoding only; there is no BIP39 PBKDF2 "seed" step.

### 3.3 Passkey wrapper (revision 2)

A passkey (WebAuthn credential with the PRF extension, e.g. Face ID / Touch ID with iCloud
Keychain, or Google Password Manager) can also unlock the vault. There can be several; each has
its own wrapper and removing one never affects the others.

```json
{
  "type": "webauthn-prf",
  "id": "<32 hex: slot id>",
  "label": "iPhone Face ID",
  "provider": "icloud-keychain",
  "rpId": "vaultdiary-abey.github.io",
  "credentialId": "<base64url: WebAuthn credential id>",
  "prfSalt": "<base64url, 32 bytes>",
  "iv": "<base64, 12 bytes>",
  "ct": "<base64, 48 bytes>",
  "createdAt": "2026-11-01T09:00:00.000Z"
}
```

```
P   = WebAuthn PRF output of the credential for input prfSalt (extensions.prf.eval.first),
      32 bytes, returned only after user verification
KEK = HKDF-SHA256(IKM = P, salt = prfSalt, info = UTF-8("VaultDiary passkey wrap v1"), length 32)
MK  = AES-256-GCM-Decrypt(key = KEK, iv, ct, AAD = ASCII "VDV1/mk/<vaultId>/webauthn-prf/<id>")
```

- `rpId` is the WebAuthn relying-party id the passkey was made for (the app's
  `location.hostname`). A passkey only works on that site, so the GitHub Pages and Firebase
  addresses each need their own.
- `provider` (e.g. `icloud-keychain`, `google-password-manager`, `unknown`) and `label` are only
  for display.
- The PRF output can only be obtained from the authenticator, so recovery tools can't use this
  wrapper. They open the vault with the passphrase or the recovery words; passkeys are only a
  convenience.

### 3.4 Merging vault.json between devices (revision 2)

`vault.json` can change on several devices (a passkey added on each, a passphrase changed on
another). A writer never overwrites Drive's copy with its own. It records its changes as
operations and, before uploading, downloads Drive's copy and re-applies them on top:

- wrappers that have an `id` (passkeys) are matched by `id`; adding one replaces a wrapper with
  the same `id`;
- a wrapper is removed only if that removal was made on this device;
- of two passphrase wrappers, the one with the newest `updatedAt` wins;
- everything else in Drive's copy is kept as it is. `updatedAt` of the file becomes the time of
  the merge.

## 4. Encrypted container (`.vde`, `.vdf`, `.vdi`)

Every encrypted file uses the same container:

| Offset | Length | Content                                           |
| ------ | ------ | ------------------------------------------------- |
| 0      | 4      | magic bytes `56 44 56 31` (ASCII `VDV1`)          |
| 4      | 4      | header length `H`, unsigned 32-bit **big-endian** |
| 8      | H      | header, UTF-8 JSON object (2 ≤ H ≤ 65536)         |
| 8 + H  | …      | chunk 0, chunk 1, … chunk N−1, nothing after      |

### 4.1 Header

```json
{
  "v": 1,
  "kind": "entry",
  "id": "9b1d…32 hex…",
  "alg": "A256GCM",
  "chunkSize": 4194304,
  "chunkCount": 1,
  "size": 1234,
  "key": { "iv": "<base64, 12 bytes>", "ct": "<base64, 48 bytes>" }
}
```

| Field        | Meaning                                                                                            |
| ------------ | -------------------------------------------------------------------------------------------------- |
| `v`          | format version, always `1`                                                                         |
| `kind`       | `"entry"` (`.vde`), `"file"` (`.vdf`), `"index"` (`.vdi`) or `"settings"` (`.vds`, revision 2)     |
| `id`         | the file's id; equals the `<id>` in its file name when written by the app                          |
| `alg`        | always `"A256GCM"`                                                                                 |
| `chunkSize`  | plaintext bytes per chunk; the app always writes 4 MiB (4194304). Readers must accept 1 … 67108864 |
| `chunkCount` | `max(1, ceil(size / chunkSize))`, must match exactly                                               |
| `size`       | total plaintext length in bytes                                                                    |
| `key`        | the file key wrapped by MK (below)                                                                 |

Key order and whitespace in the header are not significant. Unknown extra fields must be ignored.

### 4.2 File key

```
FK = AES-256-GCM-Decrypt(key = MK, iv = key.iv, ct = key.ct,
                         AAD = ASCII "VDV1/filekey/<kind>/<id>")
```

Because `kind` and `id` are in the AAD, an attacker can't relabel a file or move its key to
another file.

### 4.3 Chunks

The plaintext is split into chunks of `chunkSize` bytes; the last chunk holds the remainder
(`size − (chunkCount − 1) × chunkSize` bytes, which is 0 for an empty file — an empty file still
has exactly one chunk). Each chunk is stored as:

```
IV (12 random bytes, fresh per chunk) | AES-256-GCM ciphertext | 16-byte tag
```

with

```
AAD(i) = ASCII "VDV1/chunk/<id>/<i>/<last>"     i = 0-based decimal index, last = "1" or "0"
```

So a chunk of `n` plaintext bytes occupies `n + 28` bytes, and the total file length must be
exactly `8 + H + size + 28 × chunkCount`. Readers must reject:

- a wrong magic, header length, version, algorithm, kind, id or count (format error);
- a file shorter or longer than that exact length (truncated / trailing data);
- any chunk whose tag fails (tampered, reordered — the index is in the AAD — or truncated:
  dropping the last chunk and editing the header fails because the new last chunk was encrypted
  with `last = 0`);
- a header `id` that differs from the expected id, when the expected id is known.

Readers must not output any plaintext of a chunk whose tag failed. Streaming readers that write
earlier chunks to disk must delete the partial output when a later chunk fails.

Random access (informative): chunk `i` starts at byte `8 + H + i × (chunkSize + 28)` and is
`chunkSize + 28` bytes long (the last one `size − (chunkCount − 1) × chunkSize + 28`), so a
reader can fetch and check any chunk on its own, e.g. with an HTTP Range request. The app
streams audio and video this way; the format is unchanged.

## 5. Plaintext payloads

All payloads are UTF-8 JSON. All metadata lives inside the ciphertext.

### 5.1 Entry (`kind: "entry"`)

```json
{
  "id": "9b1d…",
  "date": "2026-10-26",
  "createdAt": "2026-10-26T07:15:00.000Z",
  "updatedAt": "2026-10-26T07:20:41.512Z",
  "title": "Morning walk",
  "body": "Markdown **text**",
  "tags": [],
  "mood": 4,
  "attachments": [
    { "fileId": "51c0…", "name": "IMG_0042.jpg", "mime": "image/jpeg", "size": 2311420 }
  ]
}
```

- `id` must equal the header `id`.
- `date` is the calendar day `YYYY-MM-DD` in the writer's local time zone.
- `createdAt`, `updatedAt` are ISO 8601 UTC timestamps.
- `body` is Markdown (CommonMark/GFM).
- `tags` is an array of strings (empty in Phase 1). Tags are free text without a leading `#`,
  at most 40 characters; the app treats tags that differ only in case or accents as the same
  tag.
- `mood` is an integer 1 (awful) … 5 (great), or `null`.
- `attachments[].fileId` is the id of a `files/<fileId>.vdf` container; `name`, `mime` and `size`
  are the original file's name, MIME type and byte length. `mime` may carry parameters, e.g.
  `video/webm;codecs=vp9,opus` for a video recorded in the app.
- `attachments[].thumbFileId` (revision 2, optional) is the id of another `files/<id>.vdf`
  container holding a small JPEG preview of a photo or video (longest side at most 320 px). It is
  an ordinary `kind: "file"` container. Recovery tools don't export thumbnails: the original is
  there. A missing or unreadable thumbnail is not an error; the app makes a new one.
- `attachments[].viewCopyFileId` (revision 3, optional) is the id of another `files/<id>.vdf`
  container holding a JPEG **viewing copy** of a HEIC/HEIF photo (quality 0.9, longest side at
  most 4096 px), for browsers that can't show HEIC. It is an ordinary `kind: "file"` container.
  The original is always kept. Recovery tools export it next to the original as
  `files/<first 8 hex of the original's fileId>-<original name without its extension>-view.jpg`
  and the entry's Markdown links it under the attachment. A missing viewing copy is not an
  error.
- Readers must keep fields they don't know, in the entry and in each attachment. A writer that
  re-saves an entry it read must write unknown fields back unchanged.

A **conflict copy** is an ordinary entry with a new id and " (conflict copy)" appended to the
title. It is created when the same entry was edited on two devices before they synced.

### 5.2 Attachment (`kind: "file"`)

The raw bytes of the original file. Name and type are stored in the entry that references it.
Thumbnails (§5.1, `thumbFileId`) and viewing copies (`viewCopyFileId`, revision 3) are stored
the same way and contain a JPEG.

When two versions of an entry differ only in their attachments' `thumbFileId` or
`viewCopyFileId` (two devices made them for the same attachment), writers merge them instead of
making a conflict copy: Drive's are kept, and the other version's fill attachments that have
none.

### 5.3 Index (`kind: "index"`)

```json
{
  "v": 1,
  "generatedAt": "2026-10-26T07:21:00.000Z",
  "entries": [
    {
      "id": "9b1d…",
      "date": "2026-10-26",
      "createdAt": "…",
      "updatedAt": "…",
      "title": "Morning walk",
      "mood": 4,
      "tags": [],
      "attachmentCount": 1,
      "excerpt": "First 160 characters of the body as plain text…"
    }
  ]
}
```

The index only speeds up the first load on a new device. It can always be rebuilt from the
entries and may be stale or missing; recovery tools ignore it. Its container `id` is random.

### 5.4 Local-only containers (`kind: "cache"`, revision 2)

The app may keep data derived from the diary in the browser's IndexedDB using this same
container format with `kind: "cache"`, for example the search index. These containers are
never written to Drive or into backups, contain nothing that isn't in the entries, and are
skipped by readers.

### 5.5 Settings (`kind: "settings"`, revision 2)

`settings.vds` in the folder root holds settings that sync between devices. Its container `id`
is random (a new one on every write, like the index). Payload:

```json
{
  "v": 1,
  "templates": [
    {
      "id": "7c1e…32 hex…",
      "name": "Gratitude",
      "title": "",
      "body": "## Three good things\n1. \n2. \n3. ",
      "tags": ["gratitude"],
      "createdAt": "2026-11-02T09:00:00.000Z",
      "updatedAt": "2026-11-02T09:00:00.000Z"
    },
    {
      "id": "…",
      "name": "",
      "title": "",
      "body": "",
      "tags": [],
      "createdAt": "…",
      "updatedAt": "…",
      "deleted": true
    }
  ],
  "showPrompts": { "value": true, "updatedAt": "2026-11-02T09:00:00.000Z" },
  "lastBackup": { "value": "2026-11-02T09:30:00.000Z", "updatedAt": "2026-11-02T09:30:00.000Z" }
}
```

- A template's `title` is used for new entries; empty means the app's default title (the
  entry's date and its number among that day's entries, e.g. "2 Nov 2026 · Entry 2").
- `deleted: true` is a tombstone, so a deletion isn't undone by another device's older copy.
- Merging two copies: templates by `id`, the newer `updatedAt` wins; `showPrompts` and
  `lastBackup` likewise. Unknown fields are kept.
- `lastBackup` (revision 3, optional): when an encrypted backup zip (§6) was last made on any
  device, as an ISO 8601 UTC time, or `null`. Missing means never. The app uses it for its
  backup reminder only.
- Recovery tools skip `settings.vds`: it holds no diary content. Readers written before revision
  2 report it as one "unknown file kind" problem and recover everything else normally.

## 6. Backup zip

The app's "Encrypted backup" is a standard zip (stored, no compression, UTF-8 names) containing
`VaultDiary/vault.json`, `VaultDiary/index.vdi`, `VaultDiary/entries/*.vde` and
`VaultDiary/files/*.vdf` exactly as they are on Drive. It contains no plaintext.

## 7. Versioning

A future incompatible change will use a new magic (`VDV2`) and/or `v: 2`. Version 1 readers must
refuse those rather than guess.

Compatible additions don't change `v`. They are listed here as revisions; every addition is
optional, and a vault using them still opens with any version 1 reader using the passphrase or
recovery words.

### Changelog

- **Revision 1** (Phase 1): everything above except what is marked revision 2.
- **Revision 2** (Phase 2):
  - `webauthn-prf` passkey wrappers in `vault.json` (§3.3), previously only reserved.
  - Optional `updatedAt` on the passphrase wrapper (§3.1) and the merge rules (§3.4).
  - Container kind `"settings"` (`settings.vds`, §5.5) with entry templates and the
    writing-prompt switch; updated recovery tools skip it silently.
  - Readers keep unknown entry and attachment fields (§5.1).
  - Optional attachment field `thumbFileId` (§5.1): a JPEG preview in its own `.vdf`. Updated
    recovery tools skip thumbnail files; older ones export them as `…-unreferenced.bin`.
  - In-app recordings are ordinary attachments; their `mime` may include codec parameters.
  - Tags are now used (§5.1). Local-only container kind `"cache"` (§5.4), never on Drive.
- **Revision 3** (Phase 3):
  - Optional `lastBackup` in `settings.vds` (§5.5). Recovery tools skip `settings.vds` as before.
  - Optional attachment field `viewCopyFileId` (§5.1, §5.2): a JPEG viewing copy of a HEIC photo
    in its own `.vdf`. Updated recovery tools export it as `…-view.jpg` next to the original;
    older ones export it as `…-unreferenced.bin` (nothing is lost either way).
  - No change to the container: audio and video are streamed by reading single chunks
    (§4.3, random access).
