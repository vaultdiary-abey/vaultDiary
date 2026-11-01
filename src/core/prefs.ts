// Per-device, non-secret preferences (localStorage, guarded: it can be unavailable).

export type Theme = 'system' | 'light' | 'dark'

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // ignore
  }
}

export const AUTO_LOCK_CHOICES = [1, 5, 10, 15, 30, 60] as const

export function getAutoLockMinutes(): number {
  const n = Number(read('vd.autoLockMinutes'))
  return AUTO_LOCK_CHOICES.includes(n as (typeof AUTO_LOCK_CHOICES)[number]) ? n : 10
}

export function setAutoLockMinutes(minutes: number): void {
  write('vd.autoLockMinutes', String(minutes))
}

export function getTheme(): Theme {
  const t = read('vd.theme')
  return t === 'light' || t === 'dark' ? t : 'system'
}

export function setTheme(theme: Theme): void {
  write('vd.theme', theme)
  applyTheme(theme)
}

export function applyTheme(theme: Theme = getTheme()): void {
  if (theme === 'system') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = theme
}

/** Longest video the app records, so clips don't fill Google Drive. Voice notes: AUDIO_MAX_MINUTES. */
export const MAX_VIDEO_CHOICES = [1, 2, 5, 10, 15, 30] as const
export const AUDIO_MAX_MINUTES = 60

export function getMaxVideoMinutes(): number {
  const n = Number(read('vd.maxVideoMinutes'))
  return MAX_VIDEO_CHOICES.includes(n as (typeof MAX_VIDEO_CHOICES)[number]) ? n : 5
}

export function setMaxVideoMinutes(minutes: number): void {
  write('vd.maxVideoMinutes', String(minutes))
}
