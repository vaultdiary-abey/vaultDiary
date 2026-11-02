import { useState } from 'react'
import { saveBlob } from '../lib/download'
import { localDate } from '../model/entry'
import { useController } from './controllerContext'

/** Runs the encrypted backup and saves the .zip; shared by Settings and the reminder banner. */
export function useBackup() {
  const c = useController()
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const run = async () => {
    setError(null)
    setProgress({ done: 0, total: 1 })
    try {
      // After the app was reopened, Google needs a new sign-in first (straight from the tap).
      if (!c.auth.hasToken()) await c.signIn()
      const zip = await c.backup((done, total) => setProgress({ done, total }))
      saveBlob(zip, `VaultDiary-backup-${localDate()}.zip`)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setProgress(null)
    }
  }
  return { progress, error, setError, run }
}

/** Last backup time from settings.vds (synced), or null if none was ever made. */
export function useLastBackup(): string | null {
  return useController().session?.settings.lastBackup.value ?? null
}
