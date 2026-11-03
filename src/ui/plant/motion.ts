// Motion state for the Timeline plant. Kept for the whole visit (not stored anywhere).

export function reducedMotion(): boolean {
  try {
    return matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

/** Entry ids the Timeline has already shown in this visit; null before its first opening. */
let seen: Set<string> | null = null

/** New entries grow in only if they were written recently (not ones arriving from sync). */
export const NEW_WINDOW_MS = 30 * 60_000

export function seenIds(): ReadonlySet<string> | null {
  return seen
}

export function markSeen(ids: readonly string[]): void {
  seen ??= new Set()
  for (const id of ids) seen.add(id)
}

/** Forgets what was shown, so the vine draws in again (the dev preview's "Replay"). */
export function resetVineMemory(): void {
  seen = null
}
