# Manual test plan (Phases 1 and 2)

Automated coverage: `npm test` (crypto, format, sync, upload queue, recovery core, cross-check with
`recover.py`), `npm run test:py` (recover.py) and `npm run test:e2e` (real browser against the fake
Drive, plus `recovery.html` offline). This plan covers what only a real Google account and real
devices can show. Use a phone and a laptop. Tick each box.

## A. Setup and sign-in

- [ ] Open the Firebase URL in a fresh browser profile. Welcome screen shows; no requests to any
      host other than the site, `accounts.google.com` and `www.googleapis.com` (DevTools → Network).
- [ ] Sign in with Google. The consent screen asks only for "files you use with this app".
- [ ] A `VaultDiary` folder appears in drive.google.com with `entries/` and `files/` inside.
- [ ] Passphrase shorter than 10 characters is refused; mismatched repeat is refused.
- [ ] 24 words are shown. **Print recovery sheet** prints only the sheet (words, vault id).
- [ ] Typing a wrong word at the confirmation step is refused; the right words create the vault.
- [ ] `vault.json` appears in Drive and contains no readable diary data.

## B. Writing

- [ ] Today view shows today's date. **New entry**, type a title and text: "Saving…" then "Saved".
- [ ] Close the tab mid-sentence, reopen, unlock: the text is there.
- [ ] Add a second and third entry for the same day; all appear on Today in time order.
- [ ] Change an entry's date to yesterday; it moves to yesterday (‹ on the Today page).
- [ ] Markdown preview renders headings, lists, bold, links (links open in a new tab).
- [ ] Choose a mood; it shows on the card.
- [ ] Delete an entry (confirm); it disappears here and from Drive's `entries/` after sync
      (it goes to Drive's trash).
- [ ] Drive file names in `entries/` and `files/` are random ids only.

## C. Attachments

- [ ] Attach a photo, a PDF, a `.zip` and a video over 100 MB. "Encrypting…" then "Uploading N%".
- [ ] Turn on airplane mode during the big upload. It shows "Waiting to upload (offline)". Turn it
      off: it continues from where it stopped (not from 0 %).
- [ ] Close the app during an upload; reopen and unlock: the upload resumes.
- [ ] **Download** each attachment; it opens and is identical to the original.
- [ ] **Remove** an attachment; its `.vdf` goes to Drive's trash after sync.

## D. Timeline and calendar

- [ ] Timeline lists entries newest first, grouped by day; "Show older entries" appears after 50.
- [ ] Calendar marks days with entries (number when more than one); tapping a day opens it;
      ‹ › change months.

## E. Locking and secrets

- [ ] **Lock** wipes the screen back to the unlock form.
- [ ] Wrong passphrase: "Wrong passphrase." and nothing else happens.
- [ ] Set auto-lock to 1 minute, leave the app idle: it locks; unsaved typing was saved first.
- [ ] Unlock with the 24 recovery words (try with capital letters / only the first 4 letters of
      each word). You must choose a new passphrase. The old passphrase no longer works; the new one
      does; the recovery words still work.
- [ ] A wrong or mistyped recovery phrase shows a clear message (checksum / not this vault).
- [ ] Settings → Change passphrase: wrong current passphrase is refused; afterwards the second
      device accepts the new passphrase after it syncs.

## F. Offline and two devices

- [ ] On the phone, unlock, then go offline. Read old entries, write a new one, edit another. The
      badge shows "Offline". Go online: everything syncs ("Synced").
- [ ] Reload while offline: the app still opens and unlocks from the offline copy.
- [ ] Edit the **same** entry on the phone (offline) and on the laptop. Bring the phone online:
      both versions exist, one titled "… (conflict copy)".
- [ ] Wait more than an hour (or revoke access at myaccount.google.com → Security → Third-party
      access): the banner "Google Drive needs you to sign in again" appears; **Continue** fixes it.
- [ ] On a brand-new device, sign in: the timeline appears quickly (from `index.vdi`), then all
      entries download.

## G. Settings, backup, hosting

- [ ] Storage used shows the Drive size and entry/file counts.
- [ ] **Download encrypted backup** produces `VaultDiary-backup-YYYY-MM-DD.zip` with `vault.json`,
      `index.vdi`, `entries/`, `files/` — no readable text inside.
- [ ] Light, dark and system themes all look right on phone and laptop.
- [ ] The app installs as a PWA and opens offline.
- [ ] The GitHub Pages URL works the same and sees the same vault.
- [ ] A build with `READ_ONLY=true` shows no New/Edit/Delete/Attach/Change passphrase controls.
- [ ] `curl -I https://YOUR-FIREBASE-ID.web.app/` shows the `Content-Security-Policy` header.

## P. Passkeys (Phase 2, milestone A)

Use a real device for each row. "Add" = Settings → Passkeys → **Add passkey** → passphrase →
**Create passkey** (prompt 1) → name → **Confirm with passkey** (prompt 2).

- [ ] **iPhone Safari** (iOS 18+): Add, save to Passwords/iCloud Keychain, Face ID twice. Default
      name "iPhone Face ID". Lock → **Unlock with passkey** → Face ID → unlocked, no new
      passphrase asked.
- [ ] **iPhone home-screen app** (same site, installed): it shares the site's passkeys; unlock
      with passkey works. Turn on airplane mode, lock, unlock with passkey: still works.
- [ ] **Mac Safari** (macOS 15+): Add (Touch ID / iCloud Keychain), lock, unlock with passkey.
- [ ] **Mac Chrome** (132+): Add and choose **iCloud Keychain** in Chrome's dialog (not "Chrome
      profile": that one has no PRF and is refused with "can't unlock the diary", nothing saved).
- [ ] **Android Chrome** or **desktop Chrome signed in to Google**: Add, save to Google Password
      Manager. Default name "Google passkey". Unlock with it.
- [ ] **Two passkeys** (one Apple, one Google) on the same site: both listed; each unlocks;
      removing one leaves the other working.
- [ ] **Browser without PRF / without a screen lock** (e.g. Firefox on Linux, or Safari 17): the
      Passkeys card says why in plain words and shows no **Add passkey** button.
- [ ] Cancel the Face ID / Touch ID prompt at unlock: you land on the passphrase form with
      "cancelled or timed out … Unlock with your passphrase instead". The passphrase works.
- [ ] **Other site**: a passkey added on the Firebase address shows as "other site
      (….web.app)" on the GitHub Pages address, and vice versa; the unlock screen there offers
      only the passphrase until you add a passkey on that address too.
- [ ] Add a passkey on the phone while the laptop is offline; change the passphrase on the
      laptop; bring the laptop online. Both devices end up with the passkey **and** the new
      passphrase (vault.json is merged, not overwritten).
- [ ] Change passphrase in Settings: the passkey still unlocks.
- [ ] Recovery-word unlock still forces a new passphrase; the passkey keeps working afterwards.
- [ ] Auto-lock (set 1 minute): locks as before; passkey unlock afterwards works.
- [ ] READ_ONLY build: **Unlock with passkey** works; no Add/Remove buttons.
- [ ] `vault.json` in Drive now has a `"type": "webauthn-prf"` entry per passkey and nothing
      readable.

## U. App updates

- [ ] With the app open (also the home-screen app), deploy a new version. Within an hour, or
      when the app comes back to the foreground, "A new version of Vault Diary is available"
      appears. **Reload** saves the open entry and loads the new version (you unlock again).

## H. Final recovery drill (do this before trusting the app)

1. [ ] Write **10 entries** over several dates, with mixed attachments: at least one photo, one
       PDF, one empty file, one file larger than 4 MiB, one file with a non-English name
       (e.g. `résumé 2026.pdf`), and entries with emoji and Markdown.
2. [ ] Wait until the badge says **Synced** and the upload list is empty.
3. [ ] Download `recovery.html` from Settings. Make an encrypted backup zip too.
4. [ ] **Clear the browser data** for the site (Settings → Privacy → Site data, or DevTools →
       Application → Clear storage). Reopening the site should show the Welcome screen.
5. [ ] In drive.google.com, right-click `VaultDiary` → **Download**. Keep the zip(s).
6. [ ] Turn off Wi-Fi. Open `recovery.html`, choose the Drive zip(s), enter the passphrase →
       **Decrypt** → **Download everything**. Check: 10 `.md` files in `entries/<date>/`, every
       attachment in `files/` opens and matches the original.
7. [ ] Repeat step 6 with the backup zip and the **24 recovery words** instead of the passphrase.
8. [ ] With Python: `pip install cryptography argon2-cffi`, then
       `python3 recovery/recover.py ~/Downloads/VaultDiary-*.zip -o ~/recovered` → enter the
       passphrase. Check the same 10 entries and all attachments. Run again with `--words`.
9. [ ] Sign in to the app again: unlock with your passphrase and see all 10 entries.
10. [ ] Phase 2: do the drill on a vault with at least one passkey. recovery.html and recover.py
        open it with the passphrase and the words exactly as before.
