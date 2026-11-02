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
  const root = document.documentElement
  if (theme === 'system') delete root.dataset.theme
  else root.dataset.theme = theme
  const accent = getAccent()
  if (accent === 'ink') delete root.dataset.accent
  else root.dataset.accent = accent
  if (getDots()) delete root.dataset.dots
  else root.dataset.dots = 'off'
}

/** Accent colour of the minimal theme. */
export const ACCENTS = [
  { id: 'ink', label: 'Ink' },
  { id: 'sage', label: 'Sage' },
  { id: 'clay', label: 'Clay' },
  { id: 'graphite', label: 'Graphite' },
] as const
export type Accent = (typeof ACCENTS)[number]['id']

export function getAccent(): Accent {
  const a = read('vd.accent')
  return ACCENTS.some((x) => x.id === a) ? (a as Accent) : 'ink'
}

export function setAccent(accent: Accent): void {
  write('vd.accent', accent)
  applyTheme()
}

/** The dotted "paper" background (on unless turned off). */
export function getDots(): boolean {
  return read('vd.dots') !== 'off'
}

export function setDots(on: boolean): void {
  write('vd.dots', on ? 'on' : 'off')
  applyTheme()
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

/** Evening writing nudge: "HH:MM" (24 h) after which the Today view nudges, or "off". */
export const DEFAULT_NUDGE_TIME = '20:00'

export function getNudgeTime(): string {
  const v = read('vd.nudgeTime')
  return v === 'off' || (v && /^([01]\d|2[0-3]):[0-5]\d$/.test(v)) ? v : DEFAULT_NUDGE_TIME
}

export function setNudgeTime(value: string): void {
  write('vd.nudgeTime', value)
}

/** The day (yyyy-MM-dd) the nudge was last dismissed, so "Not today" lasts until tomorrow. */
export function getNudgeDismissedOn(): string | null {
  return read('vd.nudgeDismissedOn')
}

export function setNudgeDismissedOn(day: string): void {
  write('vd.nudgeDismissedOn', day)
}
