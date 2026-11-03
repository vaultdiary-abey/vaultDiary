// The Timeline plant (a Silver Satin Pothos, Scindapsus pictus 'Argyraeus'), as pure data.
// Nothing about it is stored: it is worked out from the list of entries every time, seeded by
// each entry's id, so the same entries always grow exactly the same plant.

/** 32-bit FNV-1a hash of a string. */
export function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** Small, fast seeded PRNG (mulberry32) giving numbers in [0, 1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface LeafPlan {
  /** 1 = right of the vine (towards the card), -1 = left. */
  side: 1 | -1
  /** Angle away from straight up, in degrees (before mirroring for the side). */
  tilt: number
  /** Size multiplier around 1. */
  scale: number
  /** Seed for the silver splashes. */
  seed: number
}

export interface NodePlan {
  id: string
  /** Position of the vine at this node across the column, 0 (left) … 1 (right). */
  x: number
  /** Position of the vine at the boundary above this node (towards the newer entry). */
  above: number
  leaf: LeafPlan | null
  /** Gentle sideways sway of the stem below this node, -1 … 1. */
  sway: number
  /** A short aerial-root nub. */
  root: boolean
  /** 0 at the newest entry (the growing tip), 1 more for each older one. */
  rank: number
  /** 0 = brand new … 1 = mature (fuller, larger, more silver). */
  maturity: number
}

/** Range the vine wanders in, as a fraction of the column width. */
export const X_MIN = 0.36
export const X_MAX = 0.66

export const LEAF_CHANCE = 1 / 3
const MAX_BARE = 3
const MAX_LEAVES = 2
/** Leaves reach full size and silver this many nodes below the tip. */
const MATURE_AT = 9

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/**
 * Plans the vine for entries ordered OLDEST FIRST (the pot end). The pass runs from the pot to
 * the tip, so adding a newer entry never changes anything below it except how mature each leaf
 * is. Rules: roughly 1 node in 3 has a leaf, never more than 3 bare nodes in a row, never more
 * than 2 leaves in a row, and leaves alternate sides.
 */
export function planVine(idsOldestFirst: readonly string[]): NodePlan[] {
  const n = idsOldestFirst.length
  const out: NodePlan[] = new Array(n)
  let bare = 0
  let leaves = 0
  let leafCount = 0
  let prevX = 0.45
  for (let k = 0; k < n; k++) {
    const id = idsOldestFirst[k]
    const r = rng(hash32(id))
    const roll = r()
    let leaf = roll < LEAF_CHANCE
    if (bare >= MAX_BARE) leaf = true
    if (leaves >= MAX_LEAVES) leaf = false
    if (leaf) {
      leaves++
      bare = 0
    } else {
      bare++
      leaves = 0
    }
    // A smooth wander: each node pulls a little towards a random spot, never jumping.
    const target = X_MIN + r() * (X_MAX - X_MIN)
    const x = k === 0 ? 0.45 : clamp(prevX * 0.35 + target * 0.65, X_MIN, X_MAX)
    const between = (r() - 0.5) * 0.08
    const rank = n - 1 - k
    const plan: NodePlan = {
      id,
      x,
      // Set below, once the next node's position is known.
      above: between,
      leaf: null,
      sway: 0,
      root: false,
      rank,
      maturity: Math.min(1, rank / MATURE_AT),
    }
    const tilt = 26 + r() * 20
    const scale = 0.9 + r() * 0.2
    const seed = (r() * 4294967296) >>> 0
    const rootRoll = r()
    const swayRoll = r()
    plan.sway = (swayRoll < 0.5 ? -1 : 1) * (0.5 + Math.abs(swayRoll - 0.5))
    if (leaf) {
      plan.leaf = { side: leafCount % 2 === 0 ? 1 : -1, tilt, scale, seed }
      leafCount++
    }
    plan.root = !leaf && rank >= 3 && rootRoll < 0.18
    out[k] = plan
    prevX = x
  }
  // The boundary above each node lies between it and the next, newer node (the tip's is where
  // the growing tip ends). Row segments meet exactly there, so the vine joins seamlessly.
  for (let k = 0; k < n; k++) {
    const next = k + 1 < n ? out[k + 1].x : out[k].x + (out[k].x < 0.45 ? 0.08 : -0.08)
    out[k].above = clamp((out[k].x + next) / 2 + out[k].above, X_MIN, X_MAX)
  }
  return out
}

/**
 * Stem thickness at a given distance (in nodes) from the tip, in px for a 40 px column: thin
 * at the growing tip, thicker towards the pot.
 */
export function stemWidth(rank: number, column = 40): number {
  const s = column / 40
  return (1.15 + 1.85 * (1 - Math.exp(-Math.max(0, rank) / 12))) * s
}

// --- the line above the Timeline

const nf = new Intl.NumberFormat('en-US')

function plural(n: number, one: string, many: string): string {
  return `${nf.format(n)} ${n === 1 ? one : many}`
}

function dayNumber(date: string): number {
  const [y, m, d] = date.split('-').map(Number)
  return Math.round(Date.UTC(y, m - 1, d) / 86_400_000)
}

/**
 * "Your pothos has been growing for 214 days · 132 entries". Days run from the first entry's
 * date to the latest entry's date, counting both. Always uses every entry, even when the
 * Timeline is filtered.
 */
export function plantSentence(dates: readonly string[]): string {
  if (!dates.length) return 'Your pothos is waiting for its first entry.'
  let min = dates[0]
  let max = dates[0]
  for (const d of dates) {
    if (d < min) min = d
    if (d > max) max = d
  }
  const days = dayNumber(max) - dayNumber(min) + 1
  const entries = plural(dates.length, 'entry', 'entries')
  if (days <= 1) return `Your pothos was planted today · ${entries}`
  return `Your pothos has been growing for ${plural(days, 'day', 'days')} · ${entries}`
}
