# Setting up Vault Diary (step by step)

This guide assumes no prior experience with Google Cloud or Firebase. It takes about 30–45
minutes. You will:

1. Create a Google Cloud project and turn on the Google Drive API.
2. Set up the OAuth consent screen (what people see when they sign in).
3. Create a web OAuth client ID and list the addresses the app runs from.
4. Set up Firebase Hosting (main site) and GitHub Pages (backup site).
5. Let GitHub Actions build once and deploy to both.

Throughout, replace:

| Placeholder        | Example            | Where it comes from                                        |
| ------------------ | ------------------ | ---------------------------------------------------------- |
| `YOUR-FIREBASE-ID` | `vault-diary-4821` | Firebase project ID (step 5)                               |
| `YOUR-GITHUB-NAME` | `vaultdiary-abey`  | the GitHub organisation (or user) that owns the repository |
| `YOUR-REPO`        | `vaultDiary`       | this repository's name                                     |

Your three app addresses will be:

- `http://localhost:5173` — your computer, while developing
- `https://YOUR-FIREBASE-ID.web.app` — main site (Firebase also serves `…firebaseapp.com`)
- `https://YOUR-GITHUB-NAME.github.io/YOUR-REPO/` — backup site (GitHub Pages), today
  `https://vaultdiary-abey.github.io/vaultDiary/`

The app never hard-codes any of these addresses. It works out where it is running from the
browser (`location.hostname` / `location.origin`), so the same build works on every host.

> **Important:** use **one** Google Cloud project and **one** OAuth client ID for all three
> addresses. Vault Diary uses the `drive.file` permission, which only lets an app see files _that
> same app_ created. A second client ID would be a different app and would not find your vault.

---

## 0. What you need

- A Google account (the diary is stored in its Drive).
- A GitHub account with this repository.
- On your computer: [Node.js 22](https://nodejs.org/) and Git. Python 3.9+ only if you want to run
  `recover.py`.

Try the app without any Google setup first:

```sh
npm ci
npm run dev:fake      # uses a fake, in-browser "Drive"; open http://localhost:5173
```

---

## 1. Create a Google Cloud project

1. Go to <https://console.cloud.google.com/> and sign in.
2. Click the project picker at the top (it may say "Select a project") → **New project**.
3. Name it e.g. `vault-diary`. Leave "Location" as is. Click **Create**.
4. Make sure the new project is selected in the picker before continuing.

## 2. Enable the Google Drive API

1. In the left menu: **APIs & Services → Library**.
2. Search for **Google Drive API**, open it, click **Enable**.

## 3. OAuth consent screen

Google has renamed this area a few times; it is now called **Google Auth Platform**.

1. Left menu: **APIs & Services → OAuth consent screen** (or search "Google Auth Platform").
   If asked, click **Get started**.
2. **App information:** App name `Vault Diary`, user support email = your email. **Next.**
3. **Audience:** choose **External**. **Next.**
4. **Contact information:** your email. **Next**, accept the policy, **Create**.
5. Open **Data access** (or "Scopes") → **Add or remove scopes** → find
   `https://www.googleapis.com/auth/drive.file` ("See, edit, create and delete only the specific
   Google Drive files you use with this app") → tick it → **Update** → **Save**.
   Do **not** add any other scope.
6. Open **Audience** → **Test users** → **Add users** → add your own Gmail address (and anyone
   else who will use it) → **Save**.

While the app is in **Testing**, only the test users can sign in. That is fine for personal use.
Because `drive.file` is a non-sensitive scope you can also press **Publish app** later without a
Google review, so anyone with the link could create their own (separate) vault.

## 4. Create the web OAuth client ID

1. Left menu: **APIs & Services → Credentials** (or **Google Auth Platform → Clients**).
2. **Create credentials → OAuth client ID** (or **Create client**).
3. Application type: **Web application**. Name: `Vault Diary web`.
4. Under **Authorised JavaScript origins**, click **Add URI** for each of these (no trailing slash,
   no path):
   - `http://localhost:5173`
   - `http://localhost:4173` (for `npm run preview`)
   - `https://YOUR-FIREBASE-ID.web.app`
   - `https://YOUR-FIREBASE-ID.firebaseapp.com`
   - `https://YOUR-GITHUB-NAME.github.io` (origins never include the `/YOUR-REPO/` path), today
     `https://vaultdiary-abey.github.io`
5. Leave **Authorised redirect URIs** empty. Click **Create**.
6. Copy the **Client ID** (looks like `1234…-abc….apps.googleusercontent.com`). It is not a
   secret; it ends up in the public website. You don't need the client secret at all.

You can come back and add origins later (e.g. after you know your Firebase ID). Changes can take
up to 5 minutes to work.

### Run it locally with real Google sign-in

```sh
cp .env.example .env.local
# edit .env.local and paste your client ID into VITE_GOOGLE_CLIENT_ID
npm run dev
```

Open **http://localhost:5173** (use `localhost`, not `127.0.0.1`, which is a different origin).

## 5. Firebase Hosting (main site)

Firebase is used only to host the static files. No Firestore, no Firebase Auth, no Analytics.

1. Go to <https://console.firebase.google.com/> → **Create a project** (or "Add project").
2. In the name box, choose **your existing Google Cloud project** (`vault-diary`) from the list so
   both live in the same project. Continue.
3. When asked about **Google Analytics, turn it off.** (The app has no trackers.) Create.
4. In the Firebase console: **Build → Hosting → Get started**. You can click through the CLI
   instructions; the repository already contains `firebase.json`.
5. Note the **project ID** (Project settings → General). Your site is
   `https://YOUR-FIREBASE-ID.web.app`. Add it (and `…firebaseapp.com`) to the OAuth client's
   origins (step 4) if you haven't yet.
6. Edit `.firebaserc` in this repository and replace `your-firebase-project-id` with your ID.

### A service account so GitHub can deploy

1. Open <https://console.cloud.google.com/iam-admin/serviceaccounts> (same project).
2. **Create service account** → name `github-deploy` → **Create and continue**.
3. Add these roles: **Firebase Hosting Admin**, **API Keys Viewer**, **Cloud Run Viewer** →
   **Continue → Done**.
4. Click the new account → **Keys → Add key → Create new key → JSON**. A file downloads.
5. In GitHub: your repository → **Settings → Secrets and variables → Actions → Secrets → New
   repository secret**. Name `FIREBASE_SERVICE_ACCOUNT`, value: the whole content of the JSON file.
6. **Delete the downloaded JSON file** from your computer. Never commit it.

(Alternatively, `npx firebase-tools init hosting:github` creates the account and the secret for
you; if it also writes workflow files, delete them — `.github/workflows/deploy.yml` already does
the job.)

### Deploying by hand (optional)

```sh
npx firebase-tools login
VITE_GOOGLE_CLIENT_ID=… npm run build
npx firebase-tools deploy --only hosting --project YOUR-FIREBASE-ID
```

## 6. GitHub Pages (backup site)

1. Repository → **Settings → Pages**.
2. **Build and deployment → Source: GitHub Actions.**
3. The site will be `https://YOUR-GITHUB-NAME.github.io/YOUR-REPO/`. Make sure
   `https://YOUR-GITHUB-NAME.github.io` is in the OAuth origins.

The same build works on both hosts because it uses relative paths and `#/` page addresses.

## 7. Repository variables

Repository → **Settings → Secrets and variables → Actions → Variables → New repository variable**:

| Name                  | Value                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------- |
| `GOOGLE_CLIENT_ID`    | the client ID from step 4                                                                   |
| `FIREBASE_PROJECT_ID` | `YOUR-FIREBASE-ID`                                                                          |
| `READ_ONLY`           | `false` (set `true` to deploy a read-only build: no create, edit, delete or upload buttons) |

## 8. Deploy

Push to the `main` branch (or **Actions → Build and deploy → Run workflow**). The workflow:

1. installs, lints, checks formatting, runs the JavaScript and Python tests;
2. builds **once** (`dist/`, including `recovery.html`);
3. deploys that same `dist/` to Firebase Hosting **and** GitHub Pages.

Pull requests run the checks and the build but don't deploy.

## 8a. Moving the repository to another account or organisation

The repository moved from a personal account to the `vaultdiary-abey` organisation, so the
GitHub Pages address changed to `https://vaultdiary-abey.github.io/vaultDiary/`. GitHub does
**not** redirect the old `…github.io` address of a transferred repository. Do this once after a
move:

1. **OAuth origins** (step 4): add `https://vaultdiary-abey.github.io`. Remove the old
   `https://<old-name>.github.io` origin once nobody uses the old address any more.
2. **Pages** (step 6): in the organisation's copy of the repository, Settings → Pages → Source:
   **GitHub Actions**. Organisation owners may first need to allow Pages under the
   organisation's Settings → Pages / Member privileges.
3. **Variables and secret** (steps 5 and 7): repository variables and secrets move with the
   repository, but check that `GOOGLE_CLIENT_ID`, `FIREBASE_PROJECT_ID`, `READ_ONLY` and
   `FIREBASE_SERVICE_ACCOUNT` are still listed. If the organisation restricts Actions, allow
   them under Settings → Actions → General.
4. **Deploy**: re-run **Actions → Build and deploy** so the new Pages address has the current
   build. Nothing in the code needs to change: the build is host-independent.
5. **Each device**: the new address is a different _origin_ to the browser. Its offline copy,
   installed home-screen app and passkeys are separate from the old address. Open the new
   address, sign in with the same Google account (same OAuth client, so the same vault is
   found), unlock with your passphrase, and re-install it to the home screen. Then remove the
   old home-screen icon. Your diary in Google Drive is not affected.

## 9. First use

1. Open `https://YOUR-FIREBASE-ID.web.app` on your phone or laptop → **Sign in with Google** →
   allow access to "files you use with this app".
2. The app creates a `VaultDiary` folder in your Drive (you can see it in drive.google.com).
3. Choose a passphrase. Write down the 24 recovery words (or **Print recovery sheet**), then type
   three of them to confirm.
4. Install it: on Android/Chrome use **Install app**; on iPhone, Safari → Share → **Add to Home
   Screen**; on desktop Chrome/Edge, the install icon in the address bar.
5. Download `recovery.html` from **Settings → Backup and recovery** and keep it with your recovery
   sheet.

On a second device, just sign in with the same Google account on the same site and unlock with your
passphrase.

## Troubleshooting

| Problem                                                    | Fix                                                                                                |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `Error 400: origin_mismatch` / "redirect_uri_mismatch"     | The address in the browser isn't in **Authorised JavaScript origins** exactly. Add it, wait 5 min. |
| "Access blocked: app has not completed verification" / 403 | Add your Gmail as a **Test user** (step 3.6), or publish the app.                                  |
| The Google window doesn't open                             | Allow pop-ups for the site.                                                                        |
| "Google Drive needs you to sign in again"                  | Normal: Google sign-ins last about an hour and are never stored. Tap **Continue**.                 |
| A new, empty vault appears instead of mine                 | You are using a different OAuth client ID / Cloud project, or a different Google account.          |
| The app says "no OAuth client ID"                          | `VITE_GOOGLE_CLIENT_ID` wasn't set at build time (repository variable `GOOGLE_CLIENT_ID`).         |
