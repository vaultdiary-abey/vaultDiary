# Security notes

Vault Diary has no server. The website is static files; your diary lives encrypted in your own
Google Drive; only your devices ever hold the key. The file format is in [FORMAT.md](FORMAT.md),
the summary table in [README.md](README.md#how-it-protects-your-diary).

## Keys and secrets

- The master key (MK) is 256 random bits made on your device. While the diary is unlocked it is a
  **non-extractable** WebCrypto key in memory. Locking (button, auto-lock, closing the app)
  drops it.
- The raw MK bytes exist only briefly: right after a passphrase or recovery-word unwrap (to
  import the key, to set a new passphrase after a recovery-word unlock, or to wrap it for a new
  passkey). Those buffers are overwritten as soon as they are used; an unfinished "Add passkey"
  is cancelled (and its copy wiped) on lock or after 5 minutes. JavaScript can't guarantee the
  engine kept no other copy.
- `vault.json` holds only wrapped keys (passphrase/Argon2id, recovery words/HKDF, passkeys/PRF).
  The Google sign-in token is kept in memory only.

## Passkeys (WebAuthn PRF)

Passkey unlock uses the WebAuthn **PRF extension**: the authenticator (Apple Passwords / iCloud
Keychain, Google Password Manager, …) derives a 32-byte secret from the passkey's private secret
and a random 32-byte `prfSalt` stored in `vault.json`. That secret, through HKDF-SHA256, unwraps
the master key. See FORMAT.md §3.3.

What this does and doesn't rely on:

- **No server checks the assertion.** There is nobody to verify the WebAuthn signature or
  challenge; the app ignores them. The security of passkey unlock rests entirely on the PRF
  secret, which the authenticator only releases **after user verification** (Face ID, Touch ID,
  fingerprint, device PIN or password), with `userVerification: "required"`. Someone with
  `vault.json` but not the passkey (and your face/fingerprint/device PIN) can't compute it.
- The PRF secret is bound to the site (the WebAuthn rpId = `location.hostname`), so another
  website can't obtain it, even with the same `prfSalt`.
- A passkey is only as strong as the account that syncs it (your Apple ID or Google account)
  and the device screen lock. Anyone who can unlock your phone and use its passkeys can open
  the diary on that phone, just as they could if the diary were unlocked.
- Passkeys are an extra way in, never the only one. The passphrase and the 24 recovery words
  always keep working, and the recovery tools only use those.
- A new passkey slot is saved only after a test unwrap with a freshly obtained PRF output
  succeeds. Removing a slot removes it from `vault.json` (and, where the browser supports it,
  tells the password manager the passkey is no longer used). A removed slot can't be revived
  by another device's sync (FORMAT.md §3.4). Until a device has synced, its cached
  `vault.json` may still contain a slot removed elsewhere.
- Passkeys used from another device through the QR-code (hybrid) flow may not return a PRF
  result. The app then asks for the passphrase.

## Photos, recordings and the device

- Viewers decrypt an attachment on the device into memory (a Blob) and show it from a `blob:`
  URL that is revoked when the viewer closes. Files over 200 MB ask first. SVG is never
  rendered inline (it can carry scripts).
- **Streaming playback** (audio and video, Phase 3): the player loads a same-origin URL
  `stream/<random token>/<name>` that the app's service worker answers. The service worker has
  no keys. For each byte range the player asks for, it asks the page over a `MessageChannel`;
  the page downloads only the needed chunks from Drive with HTTP Range requests (or reads the
  local encrypted copy), checks and decrypts them with the file key (the same AES-GCM tag and
  AAD checks as a full decryption: index and last-chunk flag), and hands back the plaintext
  bytes. A chunk that fails its check is never played. The page keeps at most 4 decrypted
  chunks (16 MiB) plus one fetched ahead, in memory only; closing the player or locking drops
  them and makes the stream URL answer 404. The service worker holds plaintext only for the
  piece in flight and sends `Cache-Control: no-store`; nothing is put in a cache. Tokens are
  128 random bits and only work while their page has them open. When streaming isn't
  available (no service worker yet, or a browser that bypasses it for media), the viewer falls
  back to full decryption.
- PDFs are drawn by pdf.js, bundled with the app. Its worker, fonts, cmaps and wasm decoders
  are served from the app's own origin; pdf.js 6 contains no `eval`/`new Function`, so the CSP
  still has no `'unsafe-eval'`.
- Thumbnails are made on the device and encrypted like any file. Decrypted thumbnails are kept
  in memory only and dropped on lock; IndexedDB caches only the encrypted `.vdf`.
- Camera and microphone are used only while the record sheet is open (the browser asks for
  permission; Firebase sends `Permissions-Policy: camera=(self), microphone=(self)`). Nothing is
  streamed anywhere.
- A recording is saved to IndexedDB every second so a crash doesn't lose it. Each piece is
  encrypted (AES-256-GCM) with a per-recording key that is itself wrapped by the master key, so
  IndexedDB never holds plaintext media. What is stored in the clear: the recording's kind,
  MIME type, start time, length, size and the entry it belongs to. The per-recording key stays in
  memory while recording, so the last pieces are still saved (encrypted) if the diary locks
  mid-recording. Kept or discarded recordings are deleted from IndexedDB at once.

## Templates and settings

Templates and the writing-prompt switch are stored in `settings.vds`, encrypted like every entry
(container kind `"settings"`), and synced through Drive. Writing prompts are built into the app;
nothing is fetched.

## Search

Search runs on the device. The full-text index (MiniSearch, bundled) lives in memory while the
diary is unlocked and is dropped on lock. To avoid re-indexing a large diary on every unlock, a
copy is kept in IndexedDB, encrypted with the master key in the vault's own container format
(`kind: "cache"`). It never leaves the device and is deleted with "Remove vault from this
device". Search terms are never sent anywhere.

## HEIC photos and videos that can't play

- When a HEIC photo is added on a browser that can decode it, the app also makes a JPEG viewing
  copy on the device (canvas re-encode, quality 0.9, at most 4096 px) and encrypts it like any
  file. The original is never changed or removed. Whether a browser can decode HEIC is checked
  with a tiny HEIC image built into the app; nothing is fetched.
- "Make viewing copies for older photos" decrypts originals on the device one at a time and
  pauses while the upload queue catches up; it keeps no plaintext.
- Videos are never transcoded. To say "this browser can't play this video" in plain words, the
  app reads the codec name from the decrypted MP4/MOV header on the device.

## Reminders and export

- "On this day", the writing nudge and the backup reminder are worked out on the device from
  the unlocked diary. The nudge time is a per-device preference (localStorage). The date of the
  last encrypted backup is stored encrypted in `settings.vds` so every device knows it. Nothing
  is sent anywhere and no notifications are used.
- **Export writes plaintext.** Markdown export (.zip) and the PDF print view decrypt entries and
  attachments for the chosen dates. The app warns first and asks again for the passphrase or a
  passkey (the master key is unwrapped as a check and wiped at once); a confirmation allows one
  export within 5 minutes and is dropped on lock. The decrypted files are handed to the browser
  as a download or to the print dialog. Where they end up (Downloads, iCloud Drive, a printer)
  is outside the app's control: delete them when done. The print view's decrypted photos are
  `blob:` URLs, revoked when it closes or the diary locks.

The browser isolates storage, service workers, installed apps and passkeys **per origin**
(scheme + host + port):

- `https://vaultdiary-abey.github.io` (GitHub Pages, path `/vaultDiary/`) and
  `https://<project>.web.app` (Firebase) are separate origins. Each has its own offline copy,
  its own installed app and its own passkeys. The vault in Google Drive is shared, because both
  use the same OAuth client.
- The repository moved from a personal account to the `vaultdiary-abey` organisation. The old
  `<user>.github.io` origin is not redirected and shares nothing with the new one. The new
  origin `vaultdiary-abey.github.io` is the organisation's own: other repositories of that
  organisation published with Pages would share the origin (and so its storage) with the
  diary, so the organisation should host nothing else on GitHub Pages. Firebase gives the app
  an origin of its own.
- Nothing in the code hard-codes a domain. WebAuthn uses `location.hostname` as the rpId, and a
  test fails if an app domain appears in the source.

## Content Security Policy and network

- Strict CSP (`csp.mjs`, also sent as a header by Firebase). The only third parties are Google
  sign-in and the Drive API. No analytics, fonts or CDNs; all libraries are bundled.
- WebAuthn calls are handled by the browser and the password manager; the app makes no network
  request for them.
- `recovery.html` has a CSP that forbids all network access.

## Updates

A new deployment does not take over silently: the app shows "A new version of Vault Diary is
available — Reload", so an old copy doesn't keep running unnoticed. Reloading saves open
editors first.

## Reporting a problem

Please open a private security advisory on the GitHub repository rather than a public issue.
