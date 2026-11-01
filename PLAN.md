# Vault Diary — Phase 1 plan

Phase 1 only. Phase 2 (search, tags UI, thumbnails, media players, passkeys) is out of scope.

## Build order (one or more commits each)

1. Scaffold: Vite + React + TS, lint/format/test tooling, this plan.
2. Crypto core (`src/crypto/`): byte helpers, BIP39, VDV1 container (chunked AES-256-GCM),
   vault.json (MK wrapped by Argon2id passphrase key and HKDF recovery key). Tests.
3. `FORMAT.md` documenting the exact on-disk format.
4. Python `recovery/recover.py` + committed fixture vault written by the app's own code, and a
   cross-check test.
5. Drive layer: GIS token client, Drive REST v3 client (`drive.file`), resumable uploads, an
   in-memory fake Drive for tests and for `npm run dev:fake`.
6. Local store (Dexie), upload queue with backoff, sync engine with conflict copies. Tests with
   fake-indexeddb + fake Drive.
7. UI: sign-in, setup (passphrase, 24 words, confirm 3 words, printable sheet), unlock (passphrase or
   recovery words), forced passphrase reset, Today / day view, editor with autosave and attachments,
   timeline, month calendar, settings (auto-lock, change passphrase, storage, backup zip), themes,
   auto-lock, READ_ONLY flag.
8. PWA + strict CSP.
9. `recovery/recovery.html` single offline file (built by `scripts/build-recovery.mjs`).
10. GitHub Action (build once, deploy to Firebase Hosting and GitHub Pages), `SETUP.md`,
    `TESTPLAN.md`, README.

## Assumptions and decisions

- **Google sign-in script.** The spec asks for the Google Identity Services token client, which is
  only available as Google's hosted script (`https://accounts.google.com/gsi/client`). That is the
  one third-party script the app loads, only when the user taps "Sign in" / "Continue", and the CSP
  allows nothing else. No analytics, fonts or CDNs.
- **One build, two hosts.** Vite `base: './'` and hash routing so the identical `dist/` works at
  the Firebase root and at the GitHub Pages sub-path (`/vaultDiary/`).
- **READ_ONLY** is a build-time flag (`VITE_READ_ONLY=true`). Because the Action builds once, it
  applies to both hosts; it is read from the repository variable `READ_ONLY`.
- **CSP** is delivered as a `<meta>` tag (both hosts) and additionally as an HTTP header on
  Firebase (which also adds `frame-ancestors`, which a meta tag can't). Dev server has no CSP
  (Vite's HMR needs inline scripts).
- **IDs** are 128-bit random values written as 32 lowercase hex characters.
- **Header** carries `id` and `kind` in addition to the fields in the spec, so a file can be
  verified against its name and AAD can be rebuilt by recovery tools without the file name.
- **Empty files** still have exactly one (empty) chunk so truncation to zero chunks is detected.
- **AAD strings** are ASCII text (`VDV1/chunk/<id>/<index>/<last>`), easy to reproduce in Python.
- **Recovery HKDF** uses a random 16-byte salt stored in vault.json and a fixed `info` string.
- **Passphrase** is NFC-normalised UTF-8; minimum 10 characters.
- **MK in memory** is a non-extractable WebCrypto key. Changing the passphrase therefore asks for
  the current passphrase (or happens right after a recovery-word unlock, while the raw key is
  briefly available). JavaScript cannot guarantee memory is zeroed; we drop references and zero
  the byte arrays we own.
- **Offline unlock** uses a cached copy of vault.json in IndexedDB, so the app opens and works
  offline after the first sign-in.
- **Change detection** on Drive uses each file's `md5Checksum` (every write re-encrypts with new IVs,
  so content changes always change the checksum).
- **Conflicts**: if an entry changed both locally and on Drive since the last sync, Drive's version
  keeps the id and the local version is saved as a new entry titled "… (conflict copy)". A local
  delete against a remote edit keeps the remote edit.
- **Index** (`index.vdi`) holds entry summaries (no bodies). A new device shows the timeline from it
  immediately, then downloads every entry into the offline cache.
- **Attachments** are encrypted on the device into a Blob stored in the IndexedDB upload queue, then
  uploaded with Drive resumable uploads in 8 MiB slices (Drive requires multiples of 256 KiB).
- **Upload queue keeps running while locked** (it only holds ciphertext), as long as the Google
  token is valid.
- **Tags** stay in the entry format (always `[]` for now); there is no tags UI (Phase 2).
- **Mood** is a simple 5-step picker.
- **Backup zip** uses the "store" method (ciphertext doesn't compress) and no ZIP64, so a single
  backup is limited to 4 GiB / 65 535 files; the app says so if exceeded.
- **Recovery tools** accept a folder, a backup zip, or Google Drive's own "Download folder" zips
  (deflate, possibly split into several zips), and identify files by extension and header id, not by
  file name.
- **Fixture**: the committed sample vault uses the app's real code and KDF parameters. One attachment
  is written with a 64 KiB chunk size (the header carries the chunk size) to keep the repo small
  while still testing multi-chunk decryption in Python; the 4 MiB boundaries are covered by Vitest.

# Phase 2 plan

Four milestones, each merged and tagged (`phase2-A` …) after review. Format additions are
"revision 2" in FORMAT.md; nothing changes `v`.

- **A. Passkey unlock** — WebAuthn PRF wrappers in vault.json, vault.json merge on push,
  unknown entry/attachment fields kept, "Update available — reload", setup docs for the
  `vaultdiary-abey` organisation, SECURITY.md.
- **B. Media and recording** — viewers (photo, audio, video, PDF via bundled pdf.js), in-app
  recording with crash-safe IndexedDB chunks, on-device thumbnails as `.vdf` (`thumbFileId`).
- **C. Search, tags, mood, streaks** — on-device full-text search, filters, tag management,
  streaks and a year heatmap.
- **D. Templates and polish** — templates in `settings.vds` (kind `"settings"`), writing prompts.

Decisions for A:

- Add-passkey is three taps (passphrase → create → confirm). Each WebAuthn call gets its own tap
  because Safari only allows them from a user gesture.
- The passphrase wrapper gets an optional `updatedAt` so "newest passphrase wins" can be decided;
  for Phase 1 wrappers the vault's `updatedAt` stands in.
- Local vault.json changes are stored as pending operations in IndexedDB (`vaultOps`) and
  re-applied to Drive's copy before each push.
- The provider and default label come from the authenticator's AAGUID when it is a known one,
  otherwise from the device type. They are display-only.

Decisions for B:

- pdf.js 6.4.299 bundled and lazy-loaded. pdf.js 6 no longer has the `isEvalSupported` option
  because it has no eval code at all (checked in the bundled files).
- Recording format: MP4 on Apple browsers, WebM on Chrome/Android/Firefox. Chrome can record
  MP4 too, but only emits data when the recording stops, which defeats crash safety.
- In-progress recordings are encrypted in IndexedDB with a per-recording key wrapped by MK
  (local only, not part of FORMAT.md).
- Photos from the in-app camera are JPEG stills from the live camera stream (so it works the
  same on every device); "Attach files" still offers the camera roll and the native camera.
- Max length: a "Longest video" setting (default 5 min); voice notes are capped at 60 min.
- Thumbnails: JPEG, longest side 320 px. Entries that differ only in `thumbFileId` merge instead of
  becoming conflict copies (the background job runs on every device).
- `npm run build:e2e`: a production build in mode "e2e" with the fake Drive, so e2e tests run with
  the real CSP and service worker. CI checks the fake Drive is not in `dist/`.
