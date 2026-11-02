// Writing streaks, the year heatmap and mood statistics. Days are local calendar days
// ("YYYY-MM-DD", the entry's `date`).
import { addDays, parseDate } from '../lib/dates'
import { MOODS, localDate, type Mood } from './entry'

export interface Streaks {
  /** Consecutive days with entries up to today. Today without an entry yet doesn't break it. */
  current: number
  longest: number
  /** Last day of the longest streak. */
  longestEnd: string | null
}

export function streaks(days: Iterable<string>, today: string): Streaks {
  const set = new Set(days)
  let current = 0
  let d = set.has(today) ? today : addDays(today, -1)
  while (set.has(d)) {
    current++
    d = addDays(d, -1)
  }
  let longest = 0
  let longestEnd: string | null = null
  for (const day of [...set].sort()) {
    if (set.has(addDays(day, -1))) continue // not the start of a run
    let n = 0
    let end = day
    while (set.has(addDays(day, n))) {
      end = addDays(day, n)
      n++
    }
    if (n > longest) {
      longest = n
      longestEnd = end
    }
  }
  return { current, longest, longestEnd }
}

export interface HeatCell {
  date: string
  count: number
  /** 0 = none, 1, 2, 3 = three or more. */
  level: 0 | 1 | 2 | 3
}

/** Weeks (columns, Monday first) of a calendar year; days outside the year are null. */
export function yearGrid(year: number, counts: Map<string, number>): (HeatCell | null)[][] {
  const first = new Date(year, 0, 1)
  const offset = (first.getDay() + 6) % 7
  const cells: (HeatCell | null)[] = Array(offset).fill(null)
  for (let d = new Date(first); d.getFullYear() === year; d.setDate(d.getDate() + 1)) {
    const date = localDate(d)
    const count = counts.get(date) ?? 0
    cells.push({ date, count, level: count >= 3 ? 3 : (count as 0 | 1 | 2) })
  }
  while (cells.length % 7) cells.push(null)
  const weeks: (HeatCell | null)[][] = []
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7))
  return weeks
}

export function yearsWithEntries(days: Iterable<string>, thisYear: number): number[] {
  const years = new Set<number>([thisYear])
  for (const d of days) years.add(Number(d.slice(0, 4)))
  return [...years].sort((a, b) => b - a)
}

export interface MoodStats {
  counts: { mood: Mood; emoji: string; label: string; count: number }[]
  rated: number
  unrated: number
  average: number | null
}

export function moodStats(
  items: Iterable<{ date: string; mood: Mood | null }>,
  from: string,
  to: string,
): MoodStats {
  const counts = new Map<Mood, number>()
  let rated = 0
  let unrated = 0
  let sum = 0
  for (const i of items) {
    if (i.date < from || i.date > to) continue
    if (i.mood === null) {
      unrated++
      continue
    }
    counts.set(i.mood, (counts.get(i.mood) ?? 0) + 1)
    rated++
    sum += i.mood
  }
  return {
    counts: MOODS.map((m) => ({
      mood: m.value,
      emoji: m.emoji,
      label: m.label,
      count: counts.get(m.value) ?? 0,
    })),
    rated,
    unrated,
    average: rated ? sum / rated : null,
  }
}

export function dayOfYearLabel(date: string): string {
  return parseDate(date).toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}
