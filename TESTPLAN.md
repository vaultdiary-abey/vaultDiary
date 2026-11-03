# Manual test plan (Phases 1, 2 and 3)

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

## M. Media and recording (Phase 2, milestone B)

- [ ] **Viewers.** Open a photo (JPEG), an iPhone **HEIC** photo, a PDF of several pages, an
      audio file and a video from an entry. Each opens full screen; ✕ Close returns. HEIC: shows
      in Safari; on Chrome/Windows it says it can't show it and offers **Download**.
- [ ] A file over 200 MB says how big it is and offers **Download instead** / **Open anyway**.
- [ ] A `.zip` or other file offers only **Download**.
- [ ] **Voice note** (iPhone and laptop): 🎙 Voice note → allow the microphone → ● Record → the
      timer and size count up → ■ Stop → play it back → **Keep**. It appears in the entry, uploads,
      and plays in the viewer on the other device too.
- [ ] **Video**: 🎥 Video → ⟲ Flip switches front/back camera → record ~10 s → **Re-take** →
      record again → **Keep**. Only the kept clip is attached. iPhone: file ends in `.mp4`;
      Chrome/Android: `.webm`. Each plays on the other device.
- [ ] **Max length**: Settings → Longest video to record → 1 minute. Record a video: it stops by
      itself at 1:00 and says so.
- [ ] **Photo**: 📷 Photo → Take photo → Keep. "Attach files" still works for any file (and the
      camera roll on iPhone).
- [ ] **Crash safety**: start a video, record ~10 s, then swipe the app away (iPhone) / close the
      tab (laptop). Reopen and unlock: "An unfinished video … wasn't saved" → **Recover**. It is
      attached to that entry (or a new "Recovered recording" entry) and plays (up to the last
      second or so). **Discard** removes it instead.
- [ ] Lock (🔒) while recording: recording stops; after unlocking, it is offered for recovery.
- [ ] Recording doesn't trigger auto-lock (set auto-lock to 1 minute, record for 2 minutes).
- [ ] **Thumbnails**: new photos and videos show a small preview in the entry and on the
      timeline; PDFs, audio and other files show an icon. On the second device the previews
      appear after sync, also when offline afterwards.
- [ ] **Older attachments**: photos/videos attached before this update get previews by
      themselves within a few minutes of unlocking (watch the timeline). No "(conflict copy)"
      entries appear even if phone and laptop are both open.
- [ ] Remove an attachment that has a thumbnail: after sync both its `.vdf` and the thumbnail's
      go to Drive's trash.
- [ ] **Firebase only**: `curl -I https://YOUR-FIREBASE-ID.web.app/` shows
      `Permissions-Policy: camera=(self), microphone=(self), …` and `media-src 'self' blob:` in
      the CSP.

## S. Search, tags, mood, streaks (Phase 2, milestone C)

- [ ] **Tags**: in an entry, type a tag and press Enter (or a comma); it becomes a chip. Typing
      the start of a known tag suggests it; tap the suggestion. ✕ removes a tag. Tags appear on
      the timeline cards and the entry; tapping one lists all entries with it.
- [ ] **Search** (Timeline tab): search a word from a body, a title, a tag and an attachment's
      file name. Accents and capitals don't matter (`cafe` finds "Café"); the start of a word is
      enough. Matching words are highlighted. Works offline (airplane mode).
- [ ] **Filters**: date range, a tag, several moods, "Has attachments", Photos / Videos. The
      count and results update; "Clear all filters" resets. Open a result and go back: the search
      is still there.
- [ ] **Insights**: "days in a row" counts today (or yesterday, if you haven't written today
      yet) backwards; the longest streak is right. The heatmap marks the right days (darker =
      more entries); tapping a day opens it; the year menu switches years. Mood bars and the
      average match your entries.
- [ ] **Rename a tag** in Insights → Tags: every entry with it changes (also on the other device
      after sync). Renaming to an existing tag merges them.
- [ ] Lock and unlock a diary with many entries: the first search after unlocking is instant.
- [ ] On a new device while entries are still downloading, search finds them by title and summary
      and says so; renaming a tag asks you to wait until everything has downloaded.

## D. Templates, prompts, default title (Phase 2, milestone D)

- [ ] **Default title**: new entry, leave the title empty (it shows e.g. "2 Nov 2026 · Entry 1"
      greyed out), write some text → it is saved with that title. A second entry the same day is
      "Entry 2". Typing your own title still works. Changing the date uses that day's number.
- [ ] **Prompt**: Today shows a prompt; **Another** changes it; tomorrow shows a different one.
      **Write about this** starts an entry quoting the prompt. **Hide prompts** hides it; Settings →
      Templates and prompts turns it back on.
- [ ] **Templates**: Settings → Manage templates → New template (name, optional title, text, tags)
      → Save. On Today, "Start from a template" lists it; tapping it starts an entry with that text
      and tags. Edit and delete a template.
- [ ] **Two devices**: make a template on the phone, another on the laptop, both offline; bring both
      online: both devices list both templates. Delete one on the phone: it disappears on the
      laptop after sync. The prompt switch syncs too.
- [ ] `settings.vds` in Drive is unreadable (encrypted). recovery.html and recover.py (new copies)
      recover everything with no problems; an old Phase 1 copy reports `settings.vds` as one
      problem and recovers everything else.

## X. On this day, nudge, backup reminder, export (Phase 3, milestone A)

- [ ] **On this day**: write an entry dated exactly one year ago today (Today → ‹ … or + New entry
      and change the date) and one two years ago. Today shows an "On this day" card with both,
      newest year first; tapping one opens it. With no such entries the card is not shown.
- [ ] **Nudge**: Settings → This device → "Remind me to write" is on at 20:00. Set it to a time a
      few minutes ago. With no entry today, Today shows "No entry yet today" (green). **Not
      today** hides it until tomorrow. Write an entry: it doesn't come back. Turn the setting off:
      it never shows. No notification permission is ever asked.
- [ ] **Backup reminder**: on a vault created more than 30 days ago that has never been backed
      up (or whose last backup is older than 30 days), Today and Settings show "Back up now".
      Tap it on the iPhone: the backup .zip downloads (Files → Downloads) and the banner goes
      away. Settings → Backup shows "Last encrypted backup: <today>". On the laptop, after a sync,
      the reminder is gone there too.
- [ ] After reopening the installed iPhone app (Google sign-in expired), **Back up now** asks
      for Google sign-in first, then downloads.
- [ ] **Export, Markdown**: Settings → Export → This month → Markdown → **Export…**. A warning
      says the files will NOT be encrypted. A wrong passphrase is refused. With the right one
      (or **Confirm with passkey** → Face ID) a `VaultDiary-export-….zip` downloads. Open it:
      `entries/<date>/<title>-<id>.md` files you can read, attachments in `files/` open.
- [ ] **Export, PDF**: same with **PDF (print view)**. A clean page shows the entries (oldest
      first) with dates, titles, text and photos; voice notes and videos are listed by name.
      **Print / Save as PDF** → on iPhone: Share sheet / Print → pinch out the preview → Save to
      Files; on laptop Chrome: Destination "Save as PDF". The PDF has no app buttons in it.
      **Close** returns to Settings.
- [ ] Each export asks for the passphrase / passkey again. Locking while the print view is open
      closes it.

## V. Streaming playback (Phase 3, milestone B)

Use a long video (several minutes; ideally one over 1 GB from the laptop) attached to an entry
and fully uploaded (Settings → Sync shows nothing waiting).

- [ ] **Diagnostics**: Settings → "Test video streaming on this device". Locked or unlocked,
      pick a video from the device → "Streaming works"; **Middle** and **Last 5 s** report
      "ok". Unlocked, pick one of the diary's videos from the list → the same. Do this in
      iPhone Safari, the installed iPhone app and laptop Chrome; screenshot the Report.
- [ ] **Player**: open the video attachment. It starts within a few seconds, with no "decrypts
      all of it into memory" warning even above 200 MB. Drag to the middle: it plays within a
      few seconds. Drag to the last seconds: it plays to the end.
- [ ] Audio: a long voice note streams the same way.
- [ ] **Sign-in expiry**: leave the player paused for over an hour (or until the badge says "Not
      connected"), then seek to a part not played yet: "Google sign-in has expired. Playback is
      paused." → **Continue** → it plays on from there.
- [ ] **Close / lock**: close the player; it stops. Play again and let the diary auto-lock (or
      press Lock): playback stops and the unlock screen shows.
- [ ] **Offline**: with airplane mode on, a video not played before can't stream and shows an
      error; a video still waiting to upload plays (from the local encrypted copy).
- [ ] **Fallback**: in a private window opened for the first time (no service worker yet), a
      video still plays (decrypted whole, with the size warning above 200 MB).
- [ ] DevTools (laptop) → Network: Drive requests for the video have a `Range` header and
      return 206; no request downloads the whole `.vdf`.

## W. HEIC viewing copies and unplayable videos (Phase 3, milestone C)

- [ ] **iPhone**: add a photo from Photos (iPhone photos are HEIC unless Settings → Camera →
      Formats is "Most Compatible"). Wait until it has uploaded.
- [ ] **Laptop Chrome**: open that entry. The photo shows (it's the JPEG viewing copy; the viewer
      says so). **Download** saves the original `.HEIC` (same size as on the iPhone). The
      timeline thumbnail shows too.
- [ ] **iPhone**: the same photo opens as the original (no "viewing copy" note).
- [ ] **Older photos**: on the laptop, Settings → "Photos from iPhone (HEIC)" says this browser
      can't make viewing copies. On the iPhone, the same card says "N HEIC photos without a
      viewing copy" → **Make viewing copies for older photos** → progress, then "Every HEIC
      photo has a viewing copy". Try **Stop** halfway and start again: it continues. Afterwards
      the laptop shows those photos too.
- [ ] A HEIC photo without a viewing copy on the laptop shows its thumbnail (if any), a plain
      message and **Download**.
- [ ] **Video**: on a Windows/Linux laptop (or Firefox), open a video recorded on the iPhone
      (HEVC unless "Most Compatible"). It says in plain words that this browser can't play HEVC
      and offers **Download**. On the iPhone and on a Mac it plays.
- [ ] **Export / recovery**: Settings → Export → Markdown includes `IMG_…-view.jpg` next to
      `IMG_….HEIC`. The PDF export on the laptop prints the photo. A backup recovered with
      recovery.html and with recover.py contains both files; the entry's `.md` links "Viewing
      copy (JPEG)".

## L. Location (Phase 4, milestones A and B)

- [ ] **iPhone Safari**, first new entry for today: one sentence explains why; **Add my
      location** → the iOS prompt → **Allow**. Keep typing while it works: the chip under the
      date changes from "Finding location…" to e.g. "📍 Woodlands, Singapore" (first time: a few
      seconds while the place list loads).
- [ ] **Installed app (Home Screen)**: the same, then a second entry: no explanation again.
- [ ] **Past date**: Calendar → an earlier day → New entry: the chip says "Add location"; nothing
      is captured. Editing an older entry never adds a location.
- [ ] **Tap the chip**: Use current location / Search a city ("paris, fr") / Type a custom name
      (with and without coordinates) / Remove location. The entry's date never changes.
- [ ] **Saved places**: on an entry with coordinates, "Save this place" → "Home". The next new
      entry at home is labelled "Home". Settings → Places: rename, change the distance, delete
      (old entries keep "Home").
- [ ] **Deny**: on a second device or after resetting Safari's website settings, choose **Don't
      Allow**. The entry stays without a location and the app doesn't ask again. Settings →
      Location shows "Location off" with the iPhone steps; after allowing it in iOS, **Try
      again**.
- [ ] **Search / Places**: search "Singapore" finds located entries. Timeline → 📍 Places lists
      places with counts, newest first; tapping one shows its entries.
- [ ] **Export**: Markdown front matter has `location:` (label, city, country, lat, lon); with
      "Include locations" unticked there is none. The PDF shows the label under the date.
- [ ] **Recovery**: re-download recovery.html and recover.py; both write the same `location:`
      lines for a recovered entry.

## T. Timeline plant (Phase 4, milestone C)

- [ ] **iPhone**: Timeline shows one muted line ("Your pothos has been growing for N days · M
      entries") and a slim vine on the left with a pot below the oldest entry (tap "Show older
      entries" until the end). Cards are only slightly narrower; nothing covers text.
- [ ] Write a new entry for today, go back to the Timeline: its node, stem and (maybe) leaf grow
      in once. With iOS Settings → Accessibility → Motion → Reduce Motion on: no animation.
- [ ] Search or filter (also 📍 Places): the vine joins only the shown entries; the line above
      still counts all entries.
- [ ] Light/dark, every colour, dotted background on and off: the plant looks the same.
- [ ] Settings → This device → untick "Timeline plant": the Timeline looks exactly as before.
- [ ] Print the Timeline page (Share → Print): no plant.
- [ ] Laptop at full width: the plant sits in the margin; cards keep their width.
- [ ] Scroll a long Timeline fast (Show older entries several times): smooth.

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
10. [ ] Phase 2: do the drill on a vault with at least one passkey, a recorded voice note, a
        recorded video and photos with thumbnails. recovery.html and recover.py open it with the
        passphrase and the words; recordings come out with their names (`Video ….webm/.mp4`,
        `Voice note ….m4a/.webm`) and play; no thumbnail files appear in the output.
11. [ ] Phase 3: make the drill's backup zip after at least one earlier backup (so `settings.vds`
        records it). Both recovery tools still recover everything with no problems.
