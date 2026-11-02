// Text helpers for search: Markdown to plain text, term normalisation, result snippets.

/** Markdown body as plain text (no truncation), for indexing and snippets. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```\w*/g, ' '))
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[#>*_`~|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Case- and accent-insensitive form of a word ("Café" → "cafe"). */
export function normalizeTerm(term: string): string {
  return term.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase()
}

/** Words of a text, as the index sees them. */
export function tokenize(text: string): string[] {
  return text.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
}

export interface Snippet {
  before: string
  parts: { text: string; match: boolean }[]
  after: string
}

/**
 * A short piece of `text` around the first word matching one of `terms` (already
 * normalised), with the matches marked. Null if nothing matches.
 */
export function snippet(text: string, terms: string[], length = 160): Snippet | null {
  if (!terms.length || !text) return null
  const wanted = new Set(terms)
  const re = /[\p{L}\p{N}]+/gu
  const hits: [number, number][] = []
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const w = normalizeTerm(m[0])
    if (wanted.has(w) || terms.some((t) => w.startsWith(t)))
      hits.push([m.index, m.index + m[0].length])
  }
  if (!hits.length) return null
  const start = Math.max(0, hits[0][0] - Math.floor(length / 3))
  const end = Math.min(text.length, start + length)
  const parts: { text: string; match: boolean }[] = []
  let pos = start
  for (const [a, b] of hits) {
    if (a < start || b > end) continue
    if (a > pos) parts.push({ text: text.slice(pos, a), match: false })
    parts.push({ text: text.slice(a, b), match: true })
    pos = b
  }
  if (pos < end) parts.push({ text: text.slice(pos, end), match: false })
  return { before: start > 0 ? '…' : '', parts, after: end < text.length ? '…' : '' }
}
