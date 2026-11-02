# Vault Diary

A private, end-to-end encrypted diary that runs entirely in your browser and stores everything in
**your own Google Drive**. There is no server: the site is static files, and only you hold the key.

- Phone-first installable web app (PWA), works offline, light and dark themes.
- Entries in Markdown, any number per day, autosave, mood, attachments of any type and size.
- Photo, audio, video and PDF viewers (large videos stream: only the part being played is
  downloaded and decrypted); iPhone (HEIC) photos get a JPEG viewing copy so every browser
  can show them; record voice notes, videos and photos in the app;
  thumbnails on the timeline.
- On-device search with filters, tags, writing streaks, a year heatmap and mood stats.
- Entry templates (synced, encrypted), daily writing prompts, automatic titles.
- "On this day", an optional evening writing nudge, a monthly backup reminder, and export to
  Markdown (.zip) or PDF (print view).
- Timeline, month calendar, conflict-safe sync between devices.
- Unlock with a passphrase, a passkey (Face ID, Touch ID, Apple or Google passkeys) or, if you
  forget the passphrase, with 24 recovery words.
- Two independent offline recovery tools: [`recovery/recovery.html`](recovery/) and
  [`recovery/recover.py`](recovery/recover.py).
- No analytics, no trackers, no third-party scripts except Google's own sign-in library, and a
  strict Content Security Policy.

Status: **Phase 2** (see [PLAN.md](PLAN.md)): passkey unlock, media and recording,
search, tags, insights and templates. Security notes: [SECURITY.md](SECURITY.md).

## How it protects your diary

| What                       | How                                                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Master key                 | 256 random bits made on your device at setup; only ever in memory while unlocked; wiped on lock or after 10 idle minutes. |
| Passphrase                 | Argon2id (64 MiB, 3 passes) → key that wraps the master key in `vault.json`.                                              |
| Recovery words             | 24 BIP39 words = another 256-bit key (HKDF-SHA256) that also wraps the master key.                                        |
| Passkeys (optional)        | WebAuthn PRF secret, released only after Face ID / Touch ID / screen lock → HKDF-SHA256 → wraps the master key.           |
| Every entry and attachment | Its own random key; AES-256-GCM in 4 MiB chunks; tampering, reordering or truncation is detected.                         |
| Google Drive               | Sees only random file names, sizes and times. Scope `drive.file`: the app can't see any other file in your Drive.         |
| This device                | IndexedDB holds only encrypted copies plus sync bookkeeping (ids, timestamps). The Google token stays in memory.          |

Crypto is WebCrypto (AES-GCM, HKDF) plus [hash-wasm](https://github.com/Daninet/hash-wasm) for
Argon2id. Nothing home-made. The exact file format is in [FORMAT.md](FORMAT.md).

What it can't protect against: someone who knows your passphrase or has your recovery words; malware
or a malicious browser extension on an unlocked device; and — as with any web app — a compromised
copy of the site itself. Keep `recovery.html` offline as an independent way back in.

## Getting started

- Try it with a fake in-browser Drive: `npm ci && npm run dev:fake` → <http://localhost:5173>.
- Real setup (Google Cloud, Firebase Hosting, GitHub Pages): **[SETUP.md](SETUP.md)**.
- Manual test plan, ending with a full recovery drill: **[TESTPLAN.md](TESTPLAN.md)**.

## Development

```sh
npm ci
npm run dev           # needs VITE_GOOGLE_CLIENT_ID in .env.local (see .env.example)
npm run dev:fake      # no Google needed
npm run lint && npm run format:check && npm test && npm run build
npm run test:py       # recover.py tests (pip install cryptography argon2-cffi)
npm run test:e2e      # Playwright, needs `npm run dev:fake` running and Playwright installed
npm run build:e2e && npm run preview:e2e   # production build (real CSP, service worker) with
                                           # the fake Drive; then APP_URL=http://localhost:4174/ npm run test:e2e
npm run fixture       # regenerate tests/fixtures/sample-vault (then commit it)
npm run build:recovery  # rebuild recovery/recovery.html (CI fails if it's stale)
```

Build flags (environment variables at build time):

- `VITE_GOOGLE_CLIENT_ID` — the web OAuth client ID.
- `VITE_READ_ONLY=true` — hides every create, edit, delete and upload action.

### Layout

```
src/crypto/      VDV1 container, vault.json key wrapping, BIP39
src/model/       entry and index formats
src/drive/       Google sign-in (GIS token client), Drive REST v3, fake Drive
src/storage/     IndexedDB (Dexie): encrypted cache and upload queue
src/sync/        sync engine (conflict copies) and resumable upload queue
src/core/        controller (unlock, auto-lock, scheduling) and unlocked session
src/ui/          React screens
src/recovery/    shared recovery logic and the recovery.html page
recovery/        recovery.html (built, committed), recover.py, README
tests/           Vitest tests and the committed sample vault fixture
e2e/             Playwright smoke tests
```

Deployment: `.github/workflows/deploy.yml` builds once and deploys the same `dist/` to Firebase
Hosting and GitHub Pages.
