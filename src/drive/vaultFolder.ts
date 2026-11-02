// Finds or creates VaultDiary/ with entries/ and files/ inside it.
import type { DriveClient, DriveFile } from './types'

export const ROOT_NAME = 'VaultDiary'
export const APP_PROPERTY: [string, string] = ['vaultdiary', 'root']
export const VAULT_FILE = 'vault.json'
export const INDEX_FILE = 'index.vdi'
export const SETTINGS_FILE = 'settings.vds'

export interface VaultLocation {
  rootId: string
  entriesId: string
  filesId: string
}

export interface FoundVault {
  location: VaultLocation
  vaultFile: DriveFile | null
  indexFile: DriveFile | null
}

function newest(files: DriveFile[]): DriveFile | null {
  return [...files].sort((a, b) => (a.modifiedTime < b.modifiedTime ? 1 : -1))[0] ?? null
}

async function subfolder(drive: DriveClient, rootId: string, name: string, children: DriveFile[]) {
  const existing = children.find((f) => f.name === name && f.mimeType.endsWith('.folder'))
  return existing ?? (await drive.createFolder(name, rootId))
}

async function describe(drive: DriveClient, rootId: string): Promise<FoundVault> {
  const children = await drive.list(rootId)
  const entries = await subfolder(drive, rootId, 'entries', children)
  const files = await subfolder(drive, rootId, 'files', children)
  return {
    location: { rootId, entriesId: entries.id, filesId: files.id },
    vaultFile: newest(children.filter((f) => f.name === VAULT_FILE)),
    indexFile: newest(children.filter((f) => f.name === INDEX_FILE)),
  }
}

/**
 * Looks for the app's folder. With the drive.file scope Drive only shows folders this app
 * created, so a folder made by hand (or by a different OAuth client) is invisible here.
 */
export async function findVaultFolder(drive: DriveClient): Promise<FoundVault | null> {
  let candidates = await drive.findFolders({ appProperty: APP_PROPERTY })
  if (!candidates.length) candidates = await drive.findFolders({ name: ROOT_NAME })
  if (!candidates.length) return null
  // Prefer a folder that already holds a vault.json; oldest first (list is in creation order).
  for (const folder of candidates) {
    const found = await describe(drive, folder.id)
    if (found.vaultFile) return found
  }
  return describe(drive, candidates[0].id)
}

export async function createVaultFolder(drive: DriveClient): Promise<FoundVault> {
  const root = await drive.createFolder(ROOT_NAME, null, {
    [APP_PROPERTY[0]]: APP_PROPERTY[1],
  })
  return describe(drive, root.id)
}
