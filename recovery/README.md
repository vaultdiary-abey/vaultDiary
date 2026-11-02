# Vault Diary recovery tools

Two independent ways to get your diary back **without the app, without Google sign-in and without
the internet**. Both need your passphrase _or_ your 24 recovery words. (Passkeys can't be used
here: they only work inside the app, on the site where they were made.)

First get the encrypted files onto your computer, either:

- **From Google Drive:** open drive.google.com, right-click the `VaultDiary` folder → Download.
  Drive gives you one or more `VaultDiary-….zip` files. You don't need to unzip them.
- **From a backup:** the `VaultDiary-backup-YYYY-MM-DD.zip` made in Settings → Encrypted backup.

What you get back:

```
VaultDiary-recovered/
  entries/2026-10-26/morning-walk-9b1d3c0a.md     one Markdown file per entry, by day
  files/51c0aa12-IMG_0042.jpg                     attachments, with their original names
  files/7d2e90b1-IMG_0100.HEIC                    an iPhone photo (original)
  files/7d2e90b1-IMG_0100-view.jpg                its JPEG viewing copy, if the app made one
```

Each `.md` file starts with the entry's details (date, times, mood) and links to its attachments.

## Option 1: recovery.html (any computer with a browser)

`recovery.html` is one self-contained file. It loads nothing from the internet (its Content
Security Policy forbids network access), so you can keep a copy on a USB stick next to your
printed recovery sheet.

1. Get `recovery.html` from this folder, or from the app's Settings page ("Download recovery tool").
2. Disconnect from the internet if you like, then open the file in Chrome, Edge, Firefox or Safari.
3. Choose the downloaded zip(s), or the unzipped `VaultDiary` folder.
4. Enter your passphrase, or switch to "recovery words" and type the 24 words.
5. Tap **Decrypt**. Download everything as one zip, or individual files.

Damaged or modified files are listed by name; everything else is still recovered.

## Option 2: recover.py (Python 3.9+)

```sh
pip install cryptography argon2-cffi
python3 recover.py ~/Downloads/VaultDiary-20261026T040000Z-001.zip -o ~/VaultDiary-recovered
# or an unzipped folder, or several zips at once:
python3 recover.py ~/Downloads/VaultDiary -o ~/VaultDiary-recovered
# use the recovery words instead of the passphrase:
python3 recover.py backup.zip -o out --words
```

It asks for the passphrase (hidden) or words. For scripts, set `VAULTDIARY_PASSPHRASE` or
`VAULTDIARY_WORDS` instead. Exit status: `0` everything recovered, `1` some files were damaged
(listed), `2` wrong passphrase/words or unusable input.

`recover.py` uses only the `cryptography` and `argon2-cffi` packages plus the standard library.
The BIP39 word list is embedded and checked against its published SHA-256.

## Tests

```sh
python3 -m unittest discover -s recovery -p 'test_*.py' -v
```

The tests decrypt `tests/fixtures/sample-vault`, a vault written by the app's own code, and check
the output is byte-identical to what `recovery.html` produces. They also check that tampered,
reordered and truncated files and wrong secrets fail loudly. The fixture's passphrase and words are
in `tests/fixtures/sample-vault/secrets.json` — test data only.

The file format is documented in [`../FORMAT.md`](../FORMAT.md).
