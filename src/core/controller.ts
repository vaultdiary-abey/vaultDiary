// App orchestration: sign-in, vault discovery, setup, unlock/lock, auto-lock, sync scheduling.
// React reads state from here (see useController); nothing in here touches the DOM except the
// idle/online listeners and file downloads.
import { importMasterKey } from '../crypto/container'
import { WrongSecretError } from '../crypto/errors'
import {
  changePassphrase,
  createVault,
  parseVault,
  rewrapPassphrase,
  unlockWithPassphrase,
  unwrapWithPassphrase,
  unwrapWithRecoveryWords,
  type NewVault,
  type PassphraseWrapper,
  type VaultFile,
} from '../crypto/vault'
import type { VaultOp } from '../crypto/vaultMerge'
import {
  isPasskeyWrapper,
  makePasskeyWrapper,
  passkeysForHost,
  unwrapWithPasskey,
  wrapperForCredential,
} from '../crypto/passkey'
import { equalBytes, fromBase64Url, isId, randomBytes, wipe } from '../crypto/bytes'
import {
  createPasskey,
  evaluatePrf,
  signalRemovedPasskey,
  webauthnErrorMessage,
  type CreatedPasskey,
} from './webauthn'
import { FakeAuth, GoogleAuth } from '../drive/auth'
import { HttpDrive } from '../drive/http'
import { AuthError, OfflineError, type About, type DriveClient } from '../drive/types'
import {
  createVaultFolder,
  findVaultFolder,
  VAULT_FILE,
  type VaultLocation,
} from '../drive/vaultFolder'
import { ZipWriter } from '../lib/zip'
import { blobSource, openContainer } from '../crypto/container'
import { blobType } from '../media/kind'
import { StreamHost, type OpenStream } from '../stream/host'
import { PlainReader } from '../stream/plainReader'
import { driveSource } from '../stream/sources'
import { setLastBackup } from '../model/settings'
import {
  buildMarkdownExport,
  entriesInRange,
  exportFolderName,
  type DateRange,
  type MarkdownExportResult,
} from './exporter'
import { LARGE_FILE } from '../media/kind'
import { RecordingStore, type RecordingMeta } from '../media/recordingStore'
import { ThumbnailJob } from '../media/thumbJob'
import { ViewCopyJob } from '../media/viewCopyJob'
import { loadSearchCache, saveSearchCache } from '../search/searchCache'
import { SearchIndex } from '../search/searchIndex'
import { renameTag as renameTagIn, hasTag } from '../model/tags'
import { makeThumbnail, thumbnailable } from '../media/thumbnail'
import { canDecodeHeic, isHeic, makeViewCopy } from '../media/heic'
import { newEntry, type Attachment, type Entry } from '../model/entry'
import { KV, VaultDB } from '../storage/db'
import { SyncEngine } from '../sync/sync'
import { UploadQueue } from '../sync/uploads'
import { recordVaultOps } from '../sync/vaultOps'
import { CLIENT_ID, FAKE_DRIVE, READ_ONLY } from './config'
import { Emitter } from './emitter'
import { getAutoLockMinutes } from './prefs'
import { VaultSession } from './session'

export type Phase =
  | 'boot'
  | 'unconfigured'
  | 'signedOut'
  | 'finding'
  | 'setup'
  | 'locked'
  | 'resetPassphrase'
  | 'unlocked'

interface AuthLike {
  ready: boolean
  preload(): Promise<void>
  hasToken(): boolean
  getToken(): string | null
  markExpired(): void
  signIn(firstTime?: boolean): Promise<void>
  signOut(): void
}

export interface StorageReport {
  driveBytes: number
  entryCount: number
  fileCount: number
  quotaUsage: number | null
  quotaLimit: number | null
  localBytes: number | null
}

/** Where an "Add passkey" flow is. The raw MK is held only between steps 1 and 3. */
export type PasskeySetupStep = { step: 'create' } | { step: 'confirm'; created: CreatedPasskey }

const PASSKEY_SETUP_TIMEOUT = 5 * 60_000
const SYNC_INTERVAL = 3 * 60_000
const LOCAL_CHANGE_DELAY = 2000

export class Controller extends Emitter {
  readonly readOnly = READ_ONLY
  readonly db = new VaultDB()
  readonly auth: AuthLike
  readonly drive: DriveClient
  phase: Phase = 'boot'
  error: string | null = null
  busy = false
  online = typeof navigator === 'undefined' ? true : navigator.onLine
  account: About | null = null
  vault: VaultFile | null = null
  location: VaultLocation | null = null
  session: VaultSession | null = null
  sync: SyncEngine | null = null
  readonly uploads: UploadQueue
  readonly recordings: RecordingStore
  /** Recordings left over from a crash, a closed tab or a lock, offered for recovery. */
  pendingRecordings: RecordingMeta[] = []
  thumbJob: ThumbnailJob | null = null
  /** Settings → "Make viewing copies for older photos" (HEIC). */
  viewCopyJob: ViewCopyJob | null = null
  /** Decrypted thumbnails, in memory only (object URLs), dropped on lock. */
  private thumbUrls = new Map<string, Promise<string | null>>()
  private thumbSlots = 3
  private thumbWaiters: (() => void)[] = []
  private editing = new Map<string, number>()
  /** Full-text index of the unlocked diary; in memory only, dropped on lock. */
  private searchIndex: SearchIndex | null = null
  private searchLoading: Promise<SearchIndex> | null = null
  private searchTimer: ReturnType<typeof setTimeout> | null = null
  private searchSaveTimer: ReturnType<typeof setTimeout> | null = null
  /** Set while the setup screens show the recovery words. */
  pendingSetup: NewVault | null = null
  /** A newer version of the app has been downloaded and is waiting. */
  updateAvailable = false
  private updater: (() => Promise<void>) | null = null
  private pendingRawMk: Uint8Array | null = null
  /** "Add passkey" flow: raw MK after re-entering the passphrase, wiped on finish/cancel/lock. */
  passkeySetup: PasskeySetupStep | null = null
  private passkeyRawMk: Uint8Array | null = null
  private passkeyTimer: ReturnType<typeof setTimeout> | null = null
  private lastActivity = Date.now()
  private syncTimer: ReturnType<typeof setInterval> | null = null
  private changeTimer: ReturnType<typeof setTimeout> | null = null
  private flushers = new Set<() => Promise<void>>()
  /** Until when a plaintext export is allowed (set by confirmForExport, cleared on lock). */
  private exportGrantUntil = 0
  /** This device had completed a sync before this visit (so its settings.vds copy is real). */
  private syncedBefore = false
  /** Streaming playback: answers the service worker with decrypted bytes (Phase 3 B). */
  readonly streams = new StreamHost()
  /** A stream is waiting for Google sign-in (the player pauses and offers Continue). */
  streamNeedsSignIn = false
  private signInWaiters: { resolve: () => void; reject: (e: Error) => void }[] = []
  /** The date range shown in the print view (PDF export), or null. */
  printRange: DateRange | null = null
  private unsubscribers: (() => void)[] = []

  constructor() {
    super()
    const changed = () => {
      this.emit()
      this.resolveSignInWaiters()
    }
    if ((import.meta.env.DEV || import.meta.env.MODE === 'e2e') && FAKE_DRIVE) {
      this.auth = new FakeAuth(changed)
      this.drive = null as unknown as DriveClient // replaced in init() by the dev fake
    } else {
      this.auth = new GoogleAuth(CLIENT_ID, () => this.onAuthChange())
      this.drive = new HttpDrive(
        () => this.auth.getToken(),
        () => this.auth.markExpired(),
      )
    }
    this.uploads = new UploadQueue(
      this.db,
      () => (this.auth.hasToken() && this.drive ? this.drive : null),
      () => this.location,
    )
    this.uploads.subscribe(changed)
    this.recordings = new RecordingStore(this.db)
  }

  private set(patch: Partial<Pick<Controller, 'phase' | 'error' | 'busy'>>) {
    Object.assign(this, patch)
    this.emit()
  }

  // ---------------------------------------------------------------- startup

  async init(): Promise<void> {
    if ((import.meta.env.DEV || import.meta.env.MODE === 'e2e') && FAKE_DRIVE) {
      const { createDevFakeDrive } = await import('../drive/devFake')
      ;(this as { drive: DriveClient }).drive = await createDevFakeDrive(this.auth)
    }
    window.addEventListener('online', () => this.setOnline(true))
    window.addEventListener('offline', () => this.setOnline(false))
    for (const ev of ['pointerdown', 'keydown', 'touchstart', 'wheel', 'input']) {
      window.addEventListener(ev, () => this.touch(), { passive: true, capture: true })
    }
    document.addEventListener('visibilitychange', () => {
      this.checkIdle()
      // Back in the foreground (iOS may have suspended requests in the background): carry on.
      if (document.visibilityState === 'visible' && this.online) this.kickAll()
    })
    setInterval(() => this.checkIdle(), 15_000)

    if (!CLIENT_ID && !FAKE_DRIVE) {
      this.set({ phase: 'unconfigured' })
      return
    }
    if (this.online) {
      void this.auth.preload().then(
        () => this.emit(),
        () => this.emit(),
      )
    }

    const json = await this.db.getKv<string>(KV.vaultJson)
    this.location = (await this.db.getKv<VaultLocation>(KV.location)) ?? null
    this.account = (await this.db.getKv<About>(KV.account)) ?? null
    if (json) {
      this.vault = parseVault(json)
      this.set({ phase: 'locked' })
      void this.uploads.kick()
    } else {
      this.set({ phase: 'signedOut' })
    }
    try {
      await navigator.storage?.persist?.()
    } catch {
      // best effort: asks the browser not to evict our offline cache
    }
  }

  private setOnline(online: boolean) {
    this.online = online
    this.emit()
    if (online) {
      void this.auth.preload().then(
        () => this.emit(),
        () => {},
      )
      this.kickAll()
    }
  }

  private onAuthChange() {
    this.emit()
    if (this.auth.hasToken()) this.kickAll()
    this.resolveSignInWaiters()
  }

  /** Streams waiting for Google sign-in continue once there is a token again. */
  private resolveSignInWaiters() {
    if (!this.auth.hasToken() || !this.signInWaiters.length) return
    const waiters = this.signInWaiters
    this.signInWaiters = []
    this.streamNeedsSignIn = false
    for (const w of waiters) w.resolve()
    this.emit()
  }

  private kickAll() {
    void this.uploads.kick()
    void this.sync?.sync()
  }

  // ---------------------------------------------------------------- Google

  /** Must be called from a tap/click handler (opens Google's popup). */
  async signIn(): Promise<void> {
    this.set({ error: null })
    try {
      await this.auth.signIn(this.phase === 'signedOut')
      await this.checkAccount()
      if (this.phase === 'signedOut') await this.findVault()
      this.kickAll()
    } catch (e) {
      this.set({ error: (e as Error).message })
    }
  }

  private async checkAccount() {
    try {
      const about = await this.drive.about()
      const known = await this.db.getKv<About>(KV.account)
      if (known?.email && about.email && known.email !== about.email) {
        this.auth.signOut()
        throw new Error(
          `This device's vault belongs to ${known.email}, but you signed in as ${about.email}. ` +
            'Sign in with the right account, or remove the vault from this device in Settings.',
        )
      }
      this.account = about
      await this.db.setKv(KV.account, about)
      this.emit()
    } catch (e) {
      if (e instanceof OfflineError) return
      throw e
    }
  }

  private async findVault() {
    this.set({ phase: 'finding', busy: true })
    try {
      const found = await findVaultFolder(this.drive)
      if (found) {
        this.location = found.location
        await this.db.setKv(KV.location, found.location)
      }
      if (found?.vaultFile) {
        const text = await (await this.drive.download(found.vaultFile.id)).text()
        this.vault = parseVault(text)
        await this.db.setKv(KV.vaultJson, text)
        await this.db.setKv(KV.vaultDriveId, found.vaultFile.id)
        await this.db.setKv(KV.vaultMd5, found.vaultFile.md5)
        this.set({ phase: 'locked', busy: false })
      } else {
        this.set({ phase: 'setup', busy: false })
      }
    } catch (e) {
      this.set({ phase: 'signedOut', busy: false, error: (e as Error).message })
    }
  }

  // ---------------------------------------------------------------- setup

  async beginSetup(passphrase: string): Promise<string[]> {
    this.set({ busy: true, error: null })
    try {
      this.pendingSetup = await createVault(passphrase)
      return this.pendingSetup.recoveryWords
    } finally {
      this.set({ busy: false })
    }
  }

  cancelSetup() {
    this.pendingSetup = null
    this.emit()
  }

  /** Called once the user has confirmed the recovery words. Writes vault.json to Drive. */
  async finishSetup(): Promise<void> {
    const pending = this.pendingSetup
    if (!pending) return
    this.set({ busy: true, error: null })
    try {
      if (!this.location) {
        const created = await createVaultFolder(this.drive)
        this.location = created.location
        await this.db.setKv(KV.location, created.location)
      }
      const text = JSON.stringify(pending.vault, null, 2)
      const file = await this.drive.createFile(
        this.location.rootId,
        VAULT_FILE,
        new Blob([text], { type: 'application/json' }),
      )
      await this.db.setKv(KV.vaultJson, text)
      await this.db.setKv(KV.vaultDriveId, file.id)
      await this.db.setKv(KV.vaultMd5, file.md5)
      this.vault = pending.vault
      this.pendingSetup = null
      await this.openSession(pending.mk)
    } catch (e) {
      this.set({
        error:
          e instanceof OfflineError || e instanceof AuthError
            ? 'Could not save to Google Drive. Check your connection, then try again.'
            : (e as Error).message,
      })
    } finally {
      this.set({ busy: false })
    }
  }

  // ---------------------------------------------------------------- unlock / lock

  async unlock(passphrase: string): Promise<boolean> {
    if (!this.vault) return false
    this.set({ busy: true, error: null })
    try {
      const mk = await unlockWithPassphrase(this.vault, passphrase)
      await this.openSession(mk)
      return true
    } catch (e) {
      this.set({ error: (e as Error).message })
      return false
    } finally {
      this.set({ busy: false })
    }
  }

  async unlockWithWords(words: string): Promise<boolean> {
    if (!this.vault) return false
    this.set({ busy: true, error: null })
    try {
      const raw = await unwrapWithRecoveryWords(this.vault, words)
      if (this.readOnly) {
        // Can't save a new passphrase in a read-only build; just open the vault.
        try {
          await this.openSession(await importMasterKey(raw))
        } finally {
          wipe(raw)
        }
      } else {
        this.pendingRawMk = raw
        this.set({ phase: 'resetPassphrase' })
      }
      return true
    } catch (e) {
      this.set({ error: (e as Error).message })
      return false
    } finally {
      this.set({ busy: false })
    }
  }

  /** Passkey slots usable at this address (a passkey only works on the site it was made for). */
  passkeysHere() {
    return passkeysForHost(this.vault, location.hostname)
  }

  /**
   * Must be called straight from a tap (Safari requires a user gesture for WebAuthn). Any
   * failure leaves the passphrase as the way in, with a clear message.
   */
  async unlockWithPasskey(): Promise<boolean> {
    if (!this.vault || !this.passkeysHere().length) return false
    this.set({ busy: true, error: null })
    let raw: Uint8Array | null = null
    try {
      raw = await this.passkeyUnwrap()
      await this.openSession(await importMasterKey(raw))
      return true
    } catch (e) {
      this.set({ error: (e as Error).message })
      return false
    } finally {
      wipe(raw)
      this.set({ busy: false })
    }
  }

  /**
   * Asks a passkey (Face ID, Touch ID, …) for its PRF secret and unwraps the raw master key
   * with it. Must run straight from a tap. The caller wipes the result. Errors carry a message
   * that points to the passphrase.
   */
  private async passkeyUnwrap(): Promise<Uint8Array> {
    const vault = this.vault
    const slots = this.passkeysHere()
    if (!vault || !slots.length) throw new Error('No passkey is set up on this device.')
    let result
    try {
      result = await evaluatePrf(
        location.hostname,
        slots.map((w) => ({
          credentialId: fromBase64Url(w.credentialId),
          prfSalt: fromBase64Url(w.prfSalt),
        })),
      )
    } catch (e) {
      throw new Error(`${webauthnErrorMessage(e)} Use your passphrase instead.`, { cause: e })
    }
    const wrapper = wrapperForCredential(vault, result.credentialId)
    if (!wrapper) {
      throw new Error('That passkey is not set up for this diary. Use your passphrase.')
    }
    if (!result.prfOutput) {
      throw new Error(
        "This passkey didn't return its unlock secret (this can happen when it is used from " +
          'another device via a QR code). Use your passphrase, or a passkey on this device.',
      )
    }
    try {
      return await unwrapWithPasskey(vault, wrapper, result.prfOutput)
    } catch (e) {
      if (e instanceof WrongSecretError) {
        throw new Error('This passkey could not unlock the diary. Use your passphrase.', {
          cause: e,
        })
      }
      throw e
    } finally {
      wipe(result.prfOutput)
    }
  }

  // ---------------------------------------------------------------- passkey management

  /** Step 1: re-enter the passphrase (the raw MK is needed to wrap it for the passkey). */
  async beginAddPasskey(passphrase: string): Promise<void> {
    if (!this.vault || !this.session || this.readOnly) throw new Error('Unlock first.')
    this.cancelAddPasskey()
    let raw: Uint8Array
    try {
      raw = await unwrapWithPassphrase(this.vault, passphrase)
    } catch (e) {
      if (e instanceof WrongSecretError) {
        throw new Error('Your passphrase is wrong.', { cause: e })
      }
      throw e
    }
    this.passkeyRawMk = raw
    this.passkeySetup = { step: 'create' }
    this.passkeyTimer = setTimeout(() => this.cancelAddPasskey(), PASSKEY_SETUP_TIMEOUT)
    this.emit()
  }

  /** Step 2 (from a tap): the password manager creates the passkey. Saves nothing yet. */
  async createPasskeyCredential(): Promise<void> {
    if (!this.passkeySetup || !this.passkeyRawMk) throw new Error('Start again.')
    let created: CreatedPasskey
    try {
      created = await createPasskey({
        rpId: location.hostname,
        userName: this.account?.email ?? 'Vault Diary',
        excludeCredentialIds: this.passkeysHere().map((w) => fromBase64Url(w.credentialId)),
      })
    } catch (e) {
      throw new Error(webauthnErrorMessage(e), { cause: e })
    }
    if (!created.prfEnabled) {
      this.cancelAddPasskey()
      throw new Error(
        "This passkey provider can't unlock the diary (it doesn't support the PRF feature), so " +
          'nothing was saved. You can delete the new passkey from your password manager. ' +
          'Try Apple Passwords / iCloud Keychain or Google Password Manager.',
      )
    }
    this.passkeySetup = { step: 'confirm', created }
    this.emit()
  }

  /**
   * Step 3 (from a tap): uses the new passkey with a fresh random prfSalt, wraps MK with the
   * PRF output, checks the wrapper opens, and only then saves it.
   */
  async finishAddPasskey(label: string): Promise<void> {
    const setup = this.passkeySetup
    const raw = this.passkeyRawMk
    const vault = this.vault
    if (!setup || setup.step !== 'confirm' || !raw || !vault) throw new Error('Start again.')
    const prfSalt = randomBytes(32)
    let result
    try {
      result = await evaluatePrf(
        location.hostname,
        [{ credentialId: setup.created.credentialId, prfSalt }],
        'eval',
      )
    } catch (e) {
      throw new Error(`${webauthnErrorMessage(e)} Nothing was saved; try again.`, { cause: e })
    }
    const { prfOutput } = result
    try {
      if (!equalBytes(result.credentialId, setup.created.credentialId)) {
        throw new Error('A different passkey was used. Nothing was saved; try again.')
      }
      if (!prfOutput) {
        throw new Error(
          "This passkey didn't return its unlock secret, so it can't unlock the diary. " +
            'Nothing was saved.',
        )
      }
      const wrapper = await makePasskeyWrapper(vault.vaultId, raw, {
        label: label.trim() || setup.created.defaultLabel,
        provider: setup.created.provider,
        rpId: location.hostname,
        credentialId: setup.created.credentialId,
        prfSalt,
        prfOutput,
      })
      // Test-unwrap before saving: a wrapper that doesn't open must never be stored.
      const check = await unwrapWithPasskey(vault, wrapper, prfOutput).catch(() => null)
      const ok = !!check && equalBytes(check, raw)
      wipe(check)
      if (!ok || !isPasskeyWrapper(wrapper)) {
        throw new Error('The new passkey failed its test unlock. Nothing was saved.')
      }
      await this.saveVaultOps([{ op: 'addWrapper', wrapper }])
      this.cancelAddPasskey()
      void this.sync?.sync()
    } finally {
      wipe(prfOutput)
    }
  }

  cancelAddPasskey(): void {
    if (this.passkeyTimer) clearTimeout(this.passkeyTimer)
    this.passkeyTimer = null
    wipe(this.passkeyRawMk)
    this.passkeyRawMk = null
    if (this.passkeySetup) {
      this.passkeySetup = null
      this.emit()
    }
  }

  async removePasskey(id: string): Promise<void> {
    if (this.readOnly) return
    const wrapper = (this.vault?.wrappers ?? []).filter(isPasskeyWrapper).find((w) => w.id === id)
    await this.saveVaultOps([{ op: 'removeWrapper', id }])
    if (wrapper && wrapper.rpId === location.hostname) {
      void signalRemovedPasskey(wrapper.rpId, wrapper.credentialId)
    }
    void this.sync?.sync()
  }

  /** After a recovery-word unlock: the user must choose a new passphrase. */
  async setNewPassphrase(passphrase: string): Promise<void> {
    const raw = this.pendingRawMk
    if (!raw || !this.vault) return
    this.set({ busy: true, error: null })
    try {
      await this.savePassphrase(await rewrapPassphrase(this.vault, raw, passphrase))
      const mk = await importMasterKey(raw)
      wipe(raw)
      this.pendingRawMk = null
      await this.openSession(mk)
    } catch (e) {
      this.set({ error: (e as Error).message })
    } finally {
      this.set({ busy: false })
    }
  }

  async changePassphrase(current: string, next: string): Promise<void> {
    if (!this.vault) throw new Error('No vault.')
    try {
      await this.savePassphrase(await changePassphrase(this.vault, current, next))
    } catch (e) {
      if (e instanceof WrongSecretError)
        throw new Error('Your current passphrase is wrong.', { cause: e })
      throw e
    }
    void this.sync?.sync()
  }

  /** Records local vault.json changes; the next sync merges them onto Drive's copy. */
  private async saveVaultOps(ops: VaultOp[]) {
    this.vault = await recordVaultOps(this.db, ops)
    this.emit()
  }

  private async savePassphrase(updated: VaultFile) {
    const wrapper = updated.wrappers.find((w) => w.type === 'passphrase') as PassphraseWrapper
    await this.saveVaultOps([{ op: 'setPassphrase', wrapper }])
  }

  private async openSession(mk: CryptoKey) {
    const session = await VaultSession.open(this.db, mk)
    session.onLocalChange = () => this.scheduleSync()
    const sync = new SyncEngine({
      db: this.db,
      session,
      getDrive: () => (this.auth.hasToken() ? this.drive : null),
      getLocation: () => this.location,
      readOnly: this.readOnly,
      onVaultChanged: (json) => {
        this.vault = parseVault(json)
        this.emit()
      },
    })
    const thumbJob = new ThumbnailJob({
      db: this.db,
      session: () => this.session,
      fetchEncrypted: (fileId) => this.encryptedFile(fileId).catch(() => null),
      listDriveFiles: async () => {
        if (!this.auth.hasToken() || !this.location || !this.online) return null
        return new Set((await this.drive.list(this.location.filesId)).map((f) => f.name))
      },
      make: makeThumbnail,
      isEditing: (id) => this.editing.has(id),
    })
    const viewCopyJob = new ViewCopyJob({
      db: this.db,
      session: () => this.session,
      canDecode: canDecodeHeic,
      fetchEncrypted: (fileId) => this.encryptedFile(fileId).catch(() => null),
      make: makeViewCopy,
      isEditing: (id) => this.editing.has(id),
      queuedUploads: () => this.db.uploads.count(),
    })
    let lastSynced: number | null = null
    this.unsubscribers = [
      session.subscribe(() => {
        this.emit()
        this.scheduleSearchUpdate()
      }),
      sync.subscribe(() => {
        this.emit()
        // After each completed sync, make any missing thumbnails (in the background).
        const st = sync.status
        if (st.state === 'idle' && st.lastSyncedAt !== lastSynced && !this.readOnly) {
          lastSynced = st.lastSyncedAt
          void thumbJob.kick()
        }
      }),
      thumbJob.subscribe(() => this.emit()),
      viewCopyJob.subscribe(() => this.emit()),
    ]
    this.thumbJob = thumbJob
    this.viewCopyJob = viewCopyJob
    this.session = session
    this.sync = sync
    this.lastActivity = Date.now()
    this.syncTimer = setInterval(() => {
      if (document.visibilityState === 'visible') void sync.sync()
    }, SYNC_INTERVAL)
    this.pendingRecordings = await this.recordings.list().catch(() => [])
    this.syncedBefore = (await this.db.getKv<number>(KV.lastSyncedAt)) != null
    this.set({ phase: 'unlocked', error: null })
    await sync.refreshPending()
    void sync.sync()
    void this.uploads.kick()
    // Get search ready in the background so the first search is instant.
    setTimeout(() => void this.ensureSearch().catch(() => {}), 1500)
  }

  /** Editors register a flush so typing isn't lost when the vault locks. */
  registerFlush(flush: () => Promise<void>): () => void {
    this.flushers.add(flush)
    return () => this.flushers.delete(flush)
  }

  async lock(): Promise<void> {
    this.cancelAddPasskey()
    if (this.pendingRawMk) {
      wipe(this.pendingRawMk)
      this.pendingRawMk = null
    }
    if (this.session) {
      for (const flush of [...this.flushers]) {
        try {
          await flush()
        } catch {
          // keep locking
        }
      }
    }
    for (const u of this.unsubscribers) u()
    this.unsubscribers = []
    this.thumbJob?.stop()
    this.thumbJob = null
    this.viewCopyJob?.stop()
    this.viewCopyJob = null
    this.dropThumbnails()
    this.exportGrantUntil = 0
    this.printRange = null
    this.streams.closeAll()
    this.failSignInWaiters(new Error('The vault is locked.'))
    await this.dropSearch()
    if (this.syncTimer) clearInterval(this.syncTimer)
    if (this.changeTimer) clearTimeout(this.changeTimer)
    this.session?.lock()
    this.session = null
    this.sync = null
    if (this.phase === 'unlocked' || this.phase === 'resetPassphrase') {
      this.set({ phase: 'locked', error: null })
    }
  }

  private touch() {
    this.lastActivity = Date.now()
  }

  /** Counts as activity for auto-lock (e.g. while recording, when nobody touches the screen). */
  noteActivity() {
    this.touch()
  }

  private checkIdle() {
    if (this.phase !== 'unlocked' && this.phase !== 'resetPassphrase') return
    if (Date.now() - this.lastActivity >= getAutoLockMinutes() * 60_000) void this.lock()
  }

  private scheduleSync() {
    if (this.changeTimer) clearTimeout(this.changeTimer)
    this.changeTimer = setTimeout(() => this.kickAll(), LOCAL_CHANGE_DELAY)
    this.emit()
  }

  /** "Sync now": also retries uploads waiting in backoff immediately. */
  syncNow() {
    void this.uploads.retryNow()
    void this.sync?.sync()
  }

  // ---------------------------------------------------------------- attachments, backup

  /** An attachment's encrypted container: from the upload queue if still here, else Drive. */
  async encryptedFile(
    fileId: string,
    onProgress?: (done: number, total: number) => void,
  ): Promise<Blob> {
    const queued = await this.db.uploads.get(fileId)
    if (queued) return queued.blob
    if (!this.auth.hasToken() || !this.location) {
      throw new Error('Connect to Google Drive to download this attachment.')
    }
    const [file] = await this.drive.findByName(this.location.filesId, `${fileId}.vdf`)
    if (!file) throw new Error('This attachment has not reached Google Drive yet.')
    return this.drive.download(file.id, onProgress)
  }

  async attachmentBlob(
    attachment: Attachment,
    onProgress?: (done: number, total: number) => void,
  ): Promise<Blob> {
    const session = this.session
    if (!session) throw new Error('The vault is locked.')
    return session.decryptAttachment(
      attachment,
      await this.encryptedFile(attachment.fileId, onProgress),
    )
  }

  /** A HEIC photo's decrypted JPEG viewing copy (FORMAT.md revision 3). */
  async viewCopyBlob(attachment: Attachment): Promise<Blob> {
    const session = this.session
    const id = attachment.viewCopyFileId
    if (!session) throw new Error('The vault is locked.')
    if (!isId(id)) throw new Error('This photo has no viewing copy.')
    return session.decryptThumbnail(id, await this.encryptedFile(id))
  }

  // ---------------------------------------------------------------- streaming playback

  /** Set when a player's requests never reached the service worker: don't try again. */
  private streamingFailed = false

  /** Can this page stream right now (a service worker controls it and answers)? */
  streamingAvailable(): Promise<boolean> {
    if (this.streamingFailed) return Promise.resolve(false)
    return this.streams.available()
  }

  /**
   * The browser bypassed the service worker for media (the request never reached the page).
   * Until the app is reloaded, players use full decryption instead.
   */
  markStreamingUnavailable() {
    this.streamingFailed = true
  }

  private waitForSignIn(): Promise<void> {
    if (this.auth.hasToken()) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      this.signInWaiters.push({ resolve, reject })
      if (!this.streamNeedsSignIn) {
        this.streamNeedsSignIn = true
        this.emit()
      }
    })
  }

  private failSignInWaiters(e: Error) {
    const waiters = this.signInWaiters
    this.signInWaiters = []
    this.streamNeedsSignIn = false
    for (const w of waiters) w.reject(e)
  }

  /**
   * Opens an attachment for streaming playback and returns a same-origin URL for <video> or
   * <audio>. Reads the local encrypted copy if this device still has one, otherwise Google
   * Drive with Range requests; only the chunks the player asks for are downloaded and
   * decrypted. Throws if the header can't be read (the viewer then falls back).
   */
  async openStream(attachment: Attachment): Promise<OpenStream & { reader: PlainReader }> {
    const session = this.session
    if (!session) throw new Error('The vault is locked.')
    const queued = await this.db.uploads.get(attachment.fileId)
    let source
    if (queued) source = blobSource(queued.blob)
    else {
      if (!this.location) throw new Error('Connect to Google Drive to play this attachment.')
      if (!this.auth.hasToken()) await this.waitForSignIn()
      const [file] = await this.drive.findByName(this.location.filesId, `${attachment.fileId}.vdf`)
      if (!file) throw new Error('This attachment has not reached Google Drive yet.')
      source = driveSource(() => this.drive, file.id, file.size, {
        waitForSignIn: () => {
          // Drive said the token is no longer valid, even if it hadn't timed out yet.
          this.auth.markExpired()
          return this.waitForSignIn()
        },
      })
    }
    const opened = await openContainer(session.key, source, {
      expectedId: attachment.fileId,
      expectedKind: 'file',
    })
    if (this.session !== session) throw new Error('The vault is locked.')
    const reader = new PlainReader(opened)
    const stream = await this.streams.open(
      reader,
      blobType(attachment.mime, attachment.name),
      attachment.name,
    )
    return { ...stream, reader }
  }

  // ---------------------------------------------------------------- thumbnails

  /** Entries open in an editor; the thumbnail job leaves them alone. */
  registerEditing(entryId: string): () => void {
    this.editing.set(entryId, (this.editing.get(entryId) ?? 0) + 1)
    return () => {
      const n = (this.editing.get(entryId) ?? 1) - 1
      if (n > 0) this.editing.set(entryId, n)
      else this.editing.delete(entryId)
    }
  }

  /**
   * Object URL of a decrypted thumbnail, or null when it can't be had right now. Decrypted
   * thumbnails live in memory only; the encrypted .vdf is cached in IndexedDB.
   */
  thumbnailUrl(thumbFileId: string): Promise<string | null> {
    let p = this.thumbUrls.get(thumbFileId)
    if (!p) {
      p = this.loadThumbnail(thumbFileId)
      this.thumbUrls.set(thumbFileId, p)
      // Failures (e.g. offline) are retried next time instead of being remembered.
      void p.then((url) => url ?? this.thumbUrls.delete(thumbFileId))
    }
    return p
  }

  private async loadThumbnail(id: string): Promise<string | null> {
    const session = this.session
    if (!session) return null
    while (this.thumbSlots === 0) await new Promise<void>((r) => this.thumbWaiters.push(r))
    this.thumbSlots--
    try {
      let encrypted: Blob | null = null
      const cached = await this.db.thumbs.get(id)
      if (cached) encrypted = new Blob([cached.data])
      else {
        encrypted = await this.encryptedFile(id).catch(() => null)
        if (encrypted) {
          await this.db.thumbs.put({
            fileId: id,
            data: new Uint8Array(await encrypted.arrayBuffer()),
          })
        }
      }
      if (!encrypted || session.locked) return null
      const jpeg = await session.decryptThumbnail(id, encrypted)
      return session.locked ? null : URL.createObjectURL(jpeg)
    } catch {
      return null
    } finally {
      this.thumbSlots++
      this.thumbWaiters.shift()?.()
    }
  }

  private dropThumbnails() {
    for (const p of this.thumbUrls.values()) void p.then((url) => url && URL.revokeObjectURL(url))
    this.thumbUrls.clear()
  }

  /** Makes, encrypts and queues a thumbnail for a photo or video just attached. */
  private async thumbnailFor(file: Blob, attachment: Attachment): Promise<Attachment> {
    const kind = thumbnailable(attachment.mime, attachment.name)
    const session = this.session
    if (!kind || !session || file.size > LARGE_FILE) return attachment
    try {
      const jpeg = await makeThumbnail(file, kind)
      if (!jpeg) return attachment
      return { ...attachment, thumbFileId: await session.addThumbnail(jpeg) }
    } catch {
      return attachment // the background job tries again later
    }
  }

  async backup(onProgress: (done: number, total: number) => void): Promise<Blob> {
    if (!this.location || !this.auth.hasToken()) {
      throw new Error('Connect to Google Drive to make a backup.')
    }
    await this.sync?.sync()
    const loc = this.location
    const groups: [string, string][] = [
      ['', loc.rootId],
      ['entries/', loc.entriesId],
      ['files/', loc.filesId],
    ]
    const items: { path: string; id: string }[] = []
    for (const [prefix, folder] of groups) {
      for (const f of await this.drive.list(folder)) {
        if (f.mimeType.endsWith('.folder')) continue
        items.push({ path: `VaultDiary/${prefix}${f.name}`, id: f.id })
      }
    }
    const zip = new ZipWriter()
    let done = 0
    for (const item of items) {
      onProgress(done, items.length)
      await zip.add(item.path, await this.drive.download(item.id))
      done++
    }
    onProgress(done, items.length)
    const blob = zip.finish()
    await this.noteBackupMade()
    return blob
  }

  /** Remembers (encrypted, in settings.vds, synced) that a backup was just made. */
  private async noteBackupMade() {
    const session = this.session
    if (!session || session.locked) return
    try {
      await session.saveSettings(setLastBackup(session.settings))
    } catch {
      // only affects the reminder
    }
  }

  // ---------------------------------------------------------------- plaintext export

  /** How long a confirmation allows exports (the user picks a range and taps Export). */
  static readonly EXPORT_GRANT_MS = 5 * 60_000

  /**
   * Exported files are not encrypted, so exporting asks again for the passphrase or a passkey.
   * Either way the master key is unwrapped (and wiped at once): only the right secret passes.
   */
  async confirmForExport(secret: { passphrase: string } | { passkey: true }): Promise<void> {
    if (!this.vault || !this.session) throw new Error('The vault is locked.')
    let raw: Uint8Array | null = null
    try {
      if ('passphrase' in secret) {
        try {
          raw = await unwrapWithPassphrase(this.vault, secret.passphrase)
        } catch (e) {
          if (e instanceof WrongSecretError) throw new Error('Wrong passphrase.', { cause: e })
          throw e
        }
      } else {
        raw = await this.passkeyUnwrap()
      }
      this.exportGrantUntil = Date.now() + Controller.EXPORT_GRANT_MS
      this.emit()
    } finally {
      wipe(raw)
    }
  }

  /**
   * Whether synced settings (e.g. the date of a backup made on another device) can be trusted:
   * this device has synced before, or has synced on this visit.
   */
  get settingsSettled(): boolean {
    return this.syncedBefore || this.sync?.status.lastSyncedAt != null
  }

  get exportAllowed(): boolean {
    return !!this.session && Date.now() < this.exportGrantUntil
  }

  private requireExportGrant() {
    if (!this.exportAllowed) {
      throw new Error('Confirm with your passphrase or passkey before exporting.')
    }
  }

  /** Entries in a range (oldest first) and how many are still downloading. */
  exportEntries(range: DateRange) {
    return entriesInRange(this.session?.list() ?? [], range)
  }

  async exportMarkdown(
    range: DateRange,
    onProgress?: (done: number, total: number) => void,
  ): Promise<MarkdownExportResult & { name: string }> {
    this.requireExportGrant()
    const { entries, pending } = this.exportEntries(range)
    if (pending) {
      throw new Error(
        `${pending} entries in this range are still downloading. Export once they're all here.`,
      )
    }
    if (!entries.length) throw new Error('There are no entries in this date range.')
    const result = await buildMarkdownExport(
      entries,
      range,
      (a) => this.attachmentBlob(a),
      onProgress,
    )
    this.exportGrantUntil = 0
    this.emit()
    return { ...result, name: `${exportFolderName(range)}.zip` }
  }

  /** Opens the print view for "Save as PDF". */
  openPrintView(range: DateRange) {
    this.requireExportGrant()
    const { pending } = this.exportEntries(range)
    if (pending) {
      throw new Error(
        `${pending} entries in this range are still downloading. Export once they're all here.`,
      )
    }
    this.exportGrantUntil = 0
    this.printRange = range
    this.emit()
  }

  closePrintView() {
    this.printRange = null
    this.emit()
  }

  async storageReport(): Promise<StorageReport> {
    const report: StorageReport = {
      driveBytes: 0,
      entryCount: 0,
      fileCount: 0,
      quotaUsage: null,
      quotaLimit: null,
      localBytes: null,
    }
    try {
      report.localBytes = (await navigator.storage?.estimate?.())?.usage ?? null
    } catch {
      // unavailable
    }
    if (this.location && this.auth.hasToken()) {
      const loc = this.location
      const [root, entries, files, about] = await Promise.all([
        this.drive.list(loc.rootId),
        this.drive.list(loc.entriesId),
        this.drive.list(loc.filesId),
        this.drive.about(),
      ])
      for (const f of [...root, ...entries, ...files]) report.driveBytes += f.size
      report.entryCount = entries.length
      report.fileCount = files.length
      report.quotaUsage = about.usage
      report.quotaLimit = about.limit
    }
    return report
  }

  /** Removes the vault's offline copy from this browser (Drive is untouched). */
  async forgetDevice(): Promise<void> {
    await this.lock()
    this.uploads.stop()
    await this.db.wipeAll()
    this.auth.signOut()
    this.vault = null
    this.location = null
    this.account = null
    this.set({ phase: 'signedOut', error: null })
  }

  // ---------------------------------------------------------------- search and tags

  /** The search index, loaded from the encrypted local cache or built, then kept current. */
  ensureSearch(): Promise<SearchIndex> {
    const session = this.session
    if (!session) return Promise.reject(new Error('The vault is locked.'))
    if (this.searchIndex) return Promise.resolve(this.searchIndex)
    this.searchLoading ??= (async () => {
      const index = (await loadSearchCache(this.db, session.key)) ?? new SearchIndex()
      if (this.session !== session) throw new Error('The vault is locked.')
      const changed = index.update(session.list())
      this.searchIndex = index
      if (changed) this.scheduleSearchSave()
      this.emit()
      return index
    })().finally(() => {
      this.searchLoading = null
    })
    return this.searchLoading
  }

  /** Synchronous search once the index is ready (null until then). */
  get searchReady(): SearchIndex | null {
    return this.searchIndex
  }

  private scheduleSearchUpdate() {
    if (!this.searchIndex) return
    if (this.searchTimer) clearTimeout(this.searchTimer)
    this.searchTimer = setTimeout(() => {
      const session = this.session
      if (!session || !this.searchIndex) return
      if (this.searchIndex.update(session.list())) {
        this.scheduleSearchSave()
        this.emit()
      }
    }, 300)
  }

  private scheduleSearchSave() {
    if (this.searchSaveTimer) clearTimeout(this.searchSaveTimer)
    this.searchSaveTimer = setTimeout(() => {
      const session = this.session
      const index = this.searchIndex
      if (session && index && !session.locked) {
        void saveSearchCache(this.db, session.key, index).catch(() => {})
      }
    }, 3000)
  }

  /** On lock: saves a pending cache update (the key is still there), then drops the index. */
  private async dropSearch() {
    if (this.searchTimer) clearTimeout(this.searchTimer)
    const session = this.session
    const index = this.searchIndex
    if (this.searchSaveTimer) {
      clearTimeout(this.searchSaveTimer)
      this.searchSaveTimer = null
      if (session && index && !session.locked) {
        // Bring it up to date first: the last edits may still be waiting for the update timer.
        index.update(session.list())
        await saveSearchCache(this.db, session.key, index).catch(() => {})
      }
    }
    this.searchIndex = null
  }

  /**
   * Renames a tag in every entry that has it. Entries still downloading can't be changed, so
   * this waits until all entries are on this device. Returns how many entries changed.
   */
  async renameTag(from: string, to: string): Promise<number> {
    const session = this.session
    if (!session || this.readOnly) throw new Error('The vault is locked.')
    if (session.summaries.size > 0) {
      throw new Error(
        `${session.summaries.size} entries are still downloading. Rename once they're all here.`,
      )
    }
    let n = 0
    for (const e of [...session.entries.values()]) {
      if (!hasTag(e.tags, from)) continue
      const tags = renameTagIn(e.tags, from, to)
      await session.save({ ...e, tags, updatedAt: new Date().toISOString() })
      n++
    }
    return n
  }

  // ---------------------------------------------------------------- unfinished recordings

  /**
   * Adds a left-over recording to the entry it was made for (or a new entry on that day if the
   * entry was never saved), then deletes it from the recording store. Returns the entry id.
   */
  async recoverRecording(id: string): Promise<string> {
    const session = this.session
    if (!session) throw new Error('The vault is locked.')
    const meta = await this.recordings.get(id)
    if (!meta) throw new Error('This recording is no longer on this device.')
    const blob = await this.recordings.assemble(session.key, id)
    if (blob.size === 0) throw new Error('Nothing was saved of this recording.')
    const { recordingName } = await import('../media/recorder')
    const file = new File([blob], recordingName(meta.kind, meta.mime, new Date(meta.startedAt)), {
      type: meta.mime,
    })
    const attachment = await this.attachFile(file)
    const existing = session.entries.get(meta.entryId)
    const entry: Entry = existing
      ? { ...existing, attachments: [...existing.attachments, attachment] }
      : {
          ...newEntry(meta.entryDate),
          title: 'Recovered recording',
          attachments: [attachment],
        }
    await session.save({ ...entry, updatedAt: new Date().toISOString() })
    await this.discardRecording(id)
    return entry.id
  }

  async discardRecording(id: string): Promise<void> {
    await this.recordings.discard(id)
    this.pendingRecordings = this.pendingRecordings.filter((r) => r.id !== id)
    this.emit()
  }

  /** Encrypts a file into the upload queue and returns its attachment record. */
  async attachFile(
    file: File,
    onProgress?: (done: number, total: number) => void,
  ): Promise<Attachment> {
    const session = this.session
    if (!session) throw new Error('The vault is locked.')
    const attachment = await session.addAttachment(file, onProgress)
    return this.viewCopyFor(file, await this.thumbnailFor(file, attachment))
  }

  /**
   * For a HEIC photo on a browser that can decode it (e.g. iPhone Safari): also a JPEG viewing
   * copy (quality 0.9, longest side ≤ 4096 px), encrypted and queued like any file, so other
   * browsers can show the photo. The original is always kept.
   */
  private async viewCopyFor(file: Blob, attachment: Attachment): Promise<Attachment> {
    const session = this.session
    if (!session || !isHeic(attachment.mime, attachment.name) || file.size > LARGE_FILE) {
      return attachment
    }
    try {
      if (!(await canDecodeHeic())) return attachment
      const jpeg = await makeViewCopy(file)
      if (!jpeg) return attachment
      return { ...attachment, viewCopyFileId: await session.addViewCopy(jpeg) }
    } catch {
      return attachment // Settings → "Make viewing copies for older photos" can do it later
    }
  }

  // ---------------------------------------------------------------- app updates

  setUpdater(updater: () => Promise<void>) {
    this.updater = updater
  }

  setUpdateAvailable() {
    this.updateAvailable = true
    this.emit()
  }

  /** Saves open editors, then activates the new version (the page reloads and locks). */
  async applyUpdate(): Promise<void> {
    for (const flush of [...this.flushers]) {
      try {
        await flush()
      } catch {
        // keep going: the editor also saved on every change
      }
    }
    await (this.updater ?? (async () => location.reload()))()
  }

  clearError() {
    this.set({ error: null })
  }
}
