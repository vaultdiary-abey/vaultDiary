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

## Origins: GitHub Pages and Firebase

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
