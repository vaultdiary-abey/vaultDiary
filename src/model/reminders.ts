// Pure rules behind the Today-view extras: "On this day", the evening writing nudge and the
// backup reminder. Kept free of the DOM and of time sources so they can be tested.

/** The same day and month in earlier years. Entries from 29 February show on 28 February in
 * years without a 29 February. Dates are yyyy-MM-dd. */
export function isOnThisDay(entryDate: string, today: string): boolean {
  const year = Number(entryDate.slice(0, 4))
  const thisYear = Number(today.slice(0, 4))
  if (!(year < thisYear)) return false
  const md = entryDate.slice(5)
  const todayMd = today.slice(5)
  if (md === todayMd) return true
  return md === '02-29' && todayMd === '02-28' && !isLeapYear(thisYear)
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

export interface DatedItem {
  date: string
}

/** Groups past-year items for today, newest year first. Item order within a year is kept. */
export function onThisDay<T extends DatedItem>(
  items: readonly T[],
  today: string,
): { year: number; yearsAgo: number; items: T[] }[] {
  const thisYear = Number(today.slice(0, 4))
  const byYear = new Map<number, T[]>()
  for (const item of items) {
    if (!isOnThisDay(item.date, today)) continue
    const year = Number(item.date.slice(0, 4))
    const list = byYear.get(year) ?? []
    list.push(item)
    byYear.set(year, list)
  }
  return [...byYear.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([year, list]) => ({ year, yearsAgo: thisYear - year, items: list }))
}

/** "HH:MM" (24 h) → minutes after midnight, or null for "off" / anything invalid. */
export function parseClock(value: string | null | undefined): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value ?? '')
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

/**
 * The writing nudge shows when there is no entry today, the chosen time has passed, and it
 * wasn't dismissed today.
 */
export function shouldNudge(opts: {
  now: Date
  /** "HH:MM", or "off". */
  nudgeTime: string
  hasEntryToday: boolean
  /** yyyy-MM-dd of the day the nudge was dismissed, if any. */
  dismissedOn: string | null
  today: string
}): boolean {
  const at = parseClock(opts.nudgeTime)
  if (at === null || opts.hasEntryToday || opts.dismissedOn === opts.today) return false
  return opts.now.getHours() * 60 + opts.now.getMinutes() >= at
}

export const BACKUP_REMINDER_DAYS = 30

/**
 * True when the last encrypted backup is more than 30 days old. A vault that was never backed
 * up counts from the day it was created, so a new diary isn't nagged on its first day.
 */
export function backupOverdue(opts: {
  lastBackupAt: string | null
  vaultCreatedAt: string | null
  now: Date
}): boolean {
  const since = Date.parse(opts.lastBackupAt ?? opts.vaultCreatedAt ?? '')
  if (Number.isNaN(since)) return false
  return opts.now.getTime() - since > BACKUP_REMINDER_DAYS * 24 * 3600_000
}

/** Whole days since an ISO time (for "Your last backup was 41 days ago"). */
export function daysSince(iso: string, now: Date): number {
  return Math.floor((now.getTime() - Date.parse(iso)) / (24 * 3600_000))
}
