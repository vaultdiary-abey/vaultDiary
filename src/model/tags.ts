// Tags: free text, compared case- and accent-insensitively ("Café" = "cafe"), shown with the
// spelling used most often.

export const MAX_TAG_LENGTH = 40
export const MAX_TAGS = 30

/** Trims, drops a leading '#', collapses spaces and limits length. '' for nothing usable. */
export function normalizeTag(raw: string): string {
  const t = raw
    .normalize('NFC')
    .replace(/[\s\u00a0]+/g, ' ')
    .trim()
    .replace(/^#+/, '')
    .trim()
  return Array.from(t).slice(0, MAX_TAG_LENGTH).join('').trim()
}

/** Comparison key: case- and accent-insensitive. */
export function tagKey(tag: string): string {
  return normalizeTag(tag).normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase()
}

/** Adds a tag unless the entry already has it (by key). */
export function addTag(tags: string[], raw: string): string[] {
  const tag = normalizeTag(raw)
  if (!tag || tags.length >= MAX_TAGS || tags.some((t) => tagKey(t) === tagKey(tag))) return tags
  return [...tags, tag]
}

export function removeTag(tags: string[], tag: string): string[] {
  return tags.filter((t) => tagKey(t) !== tagKey(tag))
}

export function hasTag(tags: string[], tag: string): boolean {
  const k = tagKey(tag)
  return tags.some((t) => tagKey(t) === k)
}

/** Renames `from` to `to` in one entry's tags, merging if `to` is already there. */
export function renameTag(tags: string[], from: string, to: string): string[] {
  const next = normalizeTag(to)
  if (!next || !hasTag(tags, from)) return tags
  const out: string[] = []
  for (const t of tags) {
    const candidate = tagKey(t) === tagKey(from) ? next : t
    if (!out.some((o) => tagKey(o) === tagKey(candidate))) out.push(candidate)
  }
  return out
}

export interface TagCount {
  tag: string
  count: number
}

/** Every tag with the number of entries that have it, most used first. */
export function tagCounts(list: Iterable<{ tags: string[] }>): TagCount[] {
  const byKey = new Map<string, { count: number; spellings: Map<string, number> }>()
  for (const item of list) {
    const seen = new Set<string>()
    for (const t of item.tags) {
      const k = tagKey(t)
      if (!k || seen.has(k)) continue
      seen.add(k)
      const rec = byKey.get(k) ?? { count: 0, spellings: new Map() }
      rec.count++
      rec.spellings.set(t, (rec.spellings.get(t) ?? 0) + 1)
      byKey.set(k, rec)
    }
  }
  return [...byKey.values()]
    .map((r) => ({
      tag: [...r.spellings.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0],
      count: r.count,
    }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
}

/** Autocomplete: known tags starting with (then containing) the typed text, not already used. */
export function suggestTags(
  known: TagCount[],
  typed: string,
  current: string[],
  limit = 6,
): string[] {
  const k = tagKey(typed)
  const free = known.filter((t) => !hasTag(current, t.tag))
  if (!k) return free.slice(0, limit).map((t) => t.tag)
  const starts = free.filter((t) => tagKey(t.tag).startsWith(k))
  const contains = free.filter((t) => !tagKey(t.tag).startsWith(k) && tagKey(t.tag).includes(k))
  return [...starts, ...contains].slice(0, limit).map((t) => t.tag)
}
