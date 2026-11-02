// `npm run dev:fake`: a fake Drive persisted in its own IndexedDB database, so the whole app can
// be exercised (including reloads and "offline") without a Google account. Dev builds only.
import Dexie from 'dexie'
import { FakeDrive, type FakeFile } from './fake'
import { AuthError, OfflineError } from './types'

interface Auth {
  hasToken(): boolean
}

export async function createDevFakeDrive(auth: Auth): Promise<FakeDrive> {
  const db = new Dexie('vaultdiary-fake-drive')
  db.version(1).stores({ files: 'id' })
  const table = db.table<FakeFile, string>('files')
  const drive = new FakeDrive()
  for (const f of await table.toArray()) drive.files.set(f.id, f)
  let timer: ReturnType<typeof setTimeout> | null = null
  // Saved at most 200 ms after the first unsaved change (a debounce could be postponed for
  // ever by a steady stream of changes, and a reload would then lose them).
  drive.onChange = () => {
    timer ??= setTimeout(() => {
      timer = null
      void table.bulkPut([...drive.files.values()])
    }, 200)
  }
  // Mirror the fake auth state and the browser's offline toggle (DevTools → Network → Offline).
  const check = (drive as unknown as { check: () => void }).check.bind(drive)
  ;(drive as unknown as { check: () => void }).check = () => {
    if (!navigator.onLine) throw new OfflineError()
    if (!auth.hasToken()) throw new AuthError()
    check()
  }
  // Expose for manual testing from the console, e.g. `__fakeDrive.authExpired = true`.
  ;(window as unknown as { __fakeDrive: FakeDrive }).__fakeDrive = drive
  return drive
}
