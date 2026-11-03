// Geometry for the Timeline plant: SVG path data for stem segments, twigs, pothos leaves with
// their silver splashes, aerial-root nubs and the pot. Pure functions of numbers, so the same
// inputs always draw the same picture.
import { rng } from './plan'

const f = (n: number) => (Math.round(n * 100) / 100).toString()

interface Knot {
  /** Vertical position (down is positive). */
  y: number
  x: number
  /** dx/dy: 0 means the stem runs straight up and down here. */
  m: number
}

/** A smooth curve x(y) through knots ordered by y, as cubic Béziers, drawn BOTTOM to TOP. */
function upward(knots: Knot[]): string {
  const k = [...knots].sort((a, b) => a.y - b.y)
  let d = `M${f(k[k.length - 1].x)},${f(k[k.length - 1].y)}`
  for (let i = k.length - 1; i > 0; i--) {
    const a = k[i] // lower
    const b = k[i - 1] // upper
    const h = a.y - b.y
    d += `C${f(a.x - (a.m * h) / 3)},${f(a.y - h / 3)} ${f(b.x + (b.m * h) / 3)},${f(b.y + h / 3)} ${f(b.x)},${f(b.y)}`
  }
  return d
}

export interface RowGeometry {
  /** Column width and row height in px. */
  width: number
  height: number
  /** The node: vine position (px) and height in the row (px). */
  nodeX: number
  nodeY: number
  /** Vine position at the top edge (towards the newer entry); null at the growing tip. */
  topX: number | null
  /** Vine position at the bottom edge (towards the older entry / the pot). */
  bottomX: number
  /** Seeded sideways sway below the node, -1 … 1 (tall rows bend gently, never straight). */
  sway?: number
}

export interface StemPaths {
  /** From the bottom edge up to the node (older, a little thicker). */
  lower: string
  /** From the node up to the top edge, or to the growing tip. */
  upper: string
  /** Where the growing tip ends (only at the newest entry). */
  tip: { x: number; y: number; angle: number } | null
}

/**
 * The stem through one row. Every segment is vertical at the row edges, so a segment always
 * meets its neighbour at the same point with the same direction: the vine looks continuous.
 */
export function stemPaths(g: RowGeometry): StemPaths {
  const top = g.topX
  const slope =
    top === null ? 0 : Math.max(-1, Math.min(1, (g.bottomX - top) / Math.max(40, g.height))) * 0.9
  const node: Knot = { y: g.nodeY, x: g.nodeX, m: slope }
  const span = g.height - g.nodeY
  const bend = (g.sway ?? 0) * Math.min(g.width * 0.13, span * 0.05)
  const lower =
    span > 70 && bend
      ? upward([
          node,
          {
            y: g.nodeY + span * 0.55,
            x: Math.min(g.width * 0.75, Math.max(g.width * 0.2, (g.nodeX + g.bottomX) / 2 + bend)),
            m: ((g.bottomX - g.nodeX) / span) * 0.5,
          },
          { y: g.height, x: g.bottomX, m: 0 },
        ])
      : upward([node, { y: g.height, x: g.bottomX, m: 0 }])
  if (top !== null) {
    return { lower, upper: upward([{ y: 0, x: top, m: 0 }, node]), tip: null }
  }
  // The growing tip: a short, slightly leaning end above the newest node.
  const rise = Math.min(g.nodeY - 2, Math.max(12, g.width * 0.42))
  const lean = g.nodeX < g.width * 0.45 ? 1 : -1
  const tip = { x: g.nodeX + lean * g.width * 0.07, y: g.nodeY - rise }
  const upper = upward([
    { y: tip.y, x: tip.x, m: -lean * 0.35 },
    { ...node, m: 0 },
  ])
  return { lower, upper, tip: { ...tip, angle: lean * 12 } }
}

/** The thin stem from the node to the card's left edge. */
export function twigPath(g: RowGeometry, cardX: number): string {
  const x0 = g.nodeX
  const y0 = g.nodeY
  const x1 = cardX + 2
  const y1 = y0 - 2.5
  const dx = x1 - x0
  return `M${f(x0)},${f(y0)}C${f(x0 + dx * 0.4)},${f(y0 + 2)} ${f(x0 + dx * 0.7)},${f(y1 + 0.5)} ${f(x1)},${f(y1)}`
}

// --- leaves

export interface LeafShape {
  /** Blade outline in leaf coordinates: base (petiole end) at 0,0, tip at L,0. */
  blade: string
  /** Faint centre vein. */
  vein: string
  /** Silver splashes and speckles: centre, radii, rotation (deg), opacity. */
  spots: { cx: number; cy: number; rx: number; ry: number; rot: number; o: number }[]
  length: number
  halfWidth: number
}

/**
 * A Scindapsus pictus leaf: heart-shaped (cordate) with a shallow notch at the base, slightly
 * asymmetric, about 1.3 times as long as wide, with a short pointed tip. `open` < 1 draws a leaf
 * that is still unfurling (one half rolled in).
 */
export function leafShape(length: number, maturity: number, seed: number, open = 1): LeafShape {
  const L = length
  const w = L / 1.3 / 2
  const a = w // upper half (the larger lobe)
  const b = w * 0.9 * open // lower half
  const blade =
    `M${f(0.07 * L)},0` +
    `C${f(-0.06 * L)},${f(-0.5 * a)} ${f(0.06 * L)},${f(-1.04 * a)} ${f(0.36 * L)},${f(-a)}` +
    `C${f(0.62 * L)},${f(-0.97 * a)} ${f(0.8 * L)},${f(-0.52 * a)} ${f(0.91 * L)},${f(-0.17 * a)}` +
    `Q${f(0.96 * L)},${f(-0.05 * a)} ${f(1.02 * L)},${f(0.02 * w)}` +
    `Q${f(0.95 * L)},${f(0.07 * b)} ${f(0.9 * L)},${f(0.18 * b)}` +
    `C${f(0.8 * L)},${f(0.5 * b)} ${f(0.62 * L)},${f(0.97 * b)} ${f(0.36 * L)},${f(b)}` +
    `C${f(0.08 * L)},${f(1.03 * b)} ${f(-0.05 * L)},${f(0.52 * b)} ${f(0.07 * L)},0Z`
  const vein = `M${f(0.08 * L)},0Q${f(0.5 * L)},${f(-0.07 * w)} ${f(0.93 * L)},${f(-0.01 * w)}`

  // Silver: a few soft speckles on a young leaf; many irregular splashes on a mature one,
  // denser towards the edges.
  const r = rng(seed)
  const count = Math.round(3 + 24 * Math.pow(maturity, 1.15))
  const spots: LeafShape['spots'] = []
  for (let i = 0; i < count; i++) {
    const t = 0.1 + r() * 0.82
    const side = r() < 0.55 ? -1 : 1
    const half = side < 0 ? a : b
    const profile = Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.18 + 0.04)), 0.8)
    const edge = 1 - Math.pow(r(), 1.1 + 2.2 * maturity)
    const v = side * (0.18 + 0.72 * edge) * profile * half
    const size = L * (0.022 + r() * 0.045) * (0.7 + 0.5 * maturity)
    const long = r() < 0.45 ? 1.6 + r() * 1.2 : 1
    spots.push({
      cx: t * L,
      cy: v,
      rx: size * long,
      ry: size,
      rot: (r() - 0.5) * 70,
      o: 0.45 + r() * 0.45,
    })
  }
  return { blade, vein, spots, length: L, halfWidth: w }
}

/** A new leaf still rolled into a narrow spike, at the growing tip. */
export function rolledLeaf(length: number): string {
  const L = length
  const w = L * 0.13
  return `M0,0C${f(L * 0.2)},${f(-w)} ${f(L * 0.65)},${f(-w * 0.9)} ${f(L)},0C${f(L * 0.65)},${f(w * 0.6)} ${f(L * 0.2)},${f(w * 0.8)} 0,0Z`
}

/** A short aerial-root nub pointing down and outwards from a node. */
export function rootNub(x: number, y: number, side: 1 | -1, size: number): string {
  return `M${f(x)},${f(y)}q${f(side * size * 0.5)},${f(size * 0.35)} ${f(side * size * 0.75)},${f(size * 0.95)}`
}

// --- pot

export interface PotShape {
  rim: string
  body: string
  soil: string
  shadow: { cx: number; cy: number; rx: number; ry: number }
  /** Where the vine goes into the soil. */
  soilX: number
  soilY: number
  height: number
}

/** A plain, minimal pot that fits a column of the given width. */
export function potShape(width: number, top = 6): PotShape {
  const cx = width / 2
  const rimW = width * 0.74
  const rimH = Math.max(4, width * 0.12)
  const bodyTop = width * 0.64
  const bodyBottom = width * 0.46
  const bodyH = width * 0.48
  const soilY = top + rimH * 0.35
  const y0 = top
  const y1 = y0 + rimH
  const y2 = y1 + bodyH
  const rr = Math.min(2, rimH / 3)
  const rim =
    `M${f(cx - rimW / 2 + rr)},${f(y0)}H${f(cx + rimW / 2 - rr)}` +
    `Q${f(cx + rimW / 2)},${f(y0)} ${f(cx + rimW / 2)},${f(y0 + rr)}` +
    `V${f(y1)}H${f(cx - rimW / 2)}V${f(y0 + rr)}` +
    `Q${f(cx - rimW / 2)},${f(y0)} ${f(cx - rimW / 2 + rr)},${f(y0)}Z`
  const body =
    `M${f(cx - bodyTop / 2)},${f(y1)}H${f(cx + bodyTop / 2)}` +
    `L${f(cx + bodyBottom / 2)},${f(y2 - 1.5)}Q${f(cx + bodyBottom / 2 - 0.3)},${f(y2)} ${f(cx + bodyBottom / 2 - 1.8)},${f(y2)}` +
    `H${f(cx - bodyBottom / 2 + 1.8)}Q${f(cx - bodyBottom / 2 + 0.3)},${f(y2)} ${f(cx - bodyBottom / 2)},${f(y2 - 1.5)}Z`
  const soil = `M${f(cx - rimW / 2 + 1.5)},${f(y0 + 0.8)}Q${f(cx)},${f(y0 - rimH * 0.35)} ${f(cx + rimW / 2 - 1.5)},${f(y0 + 0.8)}Z`
  return {
    rim,
    body,
    soil,
    shadow: { cx, cy: y2 + 1.2, rx: bodyBottom * 0.62, ry: 1.6 },
    soilX: cx,
    soilY,
    height: y2 + 4,
  }
}

/** The vine from the last row's bottom edge down into the soil. */
export function potStem(topX: number, soilX: number, soilY: number): string {
  return upward([
    { y: 0, x: topX, m: 0 },
    { y: soilY, x: soilX, m: 0 },
  ])
}
