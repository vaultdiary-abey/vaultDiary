// The Timeline plant: a pothos vine that climbs from a pot below the oldest entry up to the
// newest one, with a node beside every entry card. Purely decorative (aria-hidden, hidden when
// printing) and computed from the entry list each time; nothing is stored.
//
// Each entry row draws its own small SVG segment, sized by one shared ResizeObserver. Segments
// meet at fixed points on the row edges with the same direction, so the vine is seamless, and
// rows far from the screen draw nothing (one shared IntersectionObserver), which keeps long
// timelines smooth.
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  leafShape,
  potShape,
  potStem,
  rolledLeaf,
  rootNub,
  stemPaths,
  twigPath,
  type RowGeometry,
} from '../../plant/draw'
import { planVine, stemWidth, type NodePlan } from '../../plant/plan'
import { markSeen, NEW_WINDOW_MS, reducedMotion, seenIds } from './motion'

// ------------------------------------------------------------------ shared observers

type Listener = (entry: ResizeObserverEntry | IntersectionObserverEntry) => void
const resizeListeners = new Map<Element, Listener>()
const nearListeners = new Map<Element, Listener>()
let resizeObserver: ResizeObserver | null = null
let nearObserver: IntersectionObserver | null = null

function observeSize(el: Element, fn: Listener): () => void {
  resizeObserver ??= new ResizeObserver((entries) => {
    for (const e of entries) resizeListeners.get(e.target)?.(e)
  })
  resizeListeners.set(el, fn)
  resizeObserver.observe(el)
  return () => {
    resizeListeners.delete(el)
    resizeObserver?.unobserve(el)
  }
}

function observeNear(el: Element, fn: Listener): () => void {
  if (typeof IntersectionObserver === 'undefined') {
    fn({ isIntersecting: true } as IntersectionObserverEntry)
    return () => {}
  }
  nearObserver ??= new IntersectionObserver(
    (entries) => {
      for (const e of entries) nearListeners.get(e.target)?.(e)
    },
    { rootMargin: '900px 0px' },
  )
  nearListeners.set(el, fn)
  nearObserver.observe(el)
  return () => {
    nearListeners.delete(el)
    nearObserver?.unobserve(el)
  }
}

// ------------------------------------------------------------------ motion

function useMotion(items: readonly VineItem[], enabled: boolean) {
  const [motion] = useState(() => {
    if (!enabled || reducedMotion()) return { reveal: false, fresh: new Set<string>() }
    const seen = seenIds()
    if (seen === null) return { reveal: true, fresh: new Set<string>() }
    const now = Date.now()
    const fresh = new Set(
      items
        .filter((i) => !seen.has(i.id) && now - Date.parse(i.createdAt) < NEW_WINDOW_MS)
        .map((i) => i.id),
    )
    return { reveal: false, fresh }
  })
  useEffect(() => markSeen(items.map((i) => i.id)), [items])
  return motion
}

// ------------------------------------------------------------------ pieces

const mix = (rank: number) =>
  `color-mix(in srgb, var(--pothos-stem-old) ${Math.round(Math.min(1, rank / 30) * 55)}%, var(--pothos-stem-young))`

const leafFill = (maturity: number) =>
  `color-mix(in srgb, var(--pothos-leaf) ${Math.round(maturity * 100)}%, var(--pothos-leaf-young))`

function Defs({ uid }: { uid: string }) {
  return (
    <defs>
      <linearGradient id={`${uid}-shade`} x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stopColor="#000" stopOpacity="0.22" />
        <stop offset="0.55" stopColor="#000" stopOpacity="0" />
        <stop offset="1" stopColor="#fff" stopOpacity="0.04" />
      </linearGradient>
    </defs>
  )
}

function Leaf({
  uid,
  x,
  y,
  plan,
  rank,
  maturity,
  column,
  young,
}: {
  uid: string
  x: number
  y: number
  plan: NonNullable<NodePlan['leaf']>
  rank: number
  maturity: number
  column: number
  young: boolean
}) {
  const s = column / 40
  const tilt = plan.side < 0 ? plan.tilt * 0.62 : plan.tilt + 10
  const rad = (tilt * Math.PI) / 180
  const dx = Math.sin(rad) * plan.side
  const dy = -Math.cos(rad)
  const petiole = (young ? 2 : 3.2) * s
  const bx = x + dx * petiole
  const by = y + dy * petiole
  const length = (young ? 9.5 : 13.5 + 8 * maturity) * plan.scale * s
  const shape = leafShape(length, young ? 0.05 : maturity, plan.seed, young ? 0.35 : 1)
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI
  const clip = `${uid}-clip`
  return (
    <g className="vine-leaf">
      <path
        d={`M${x},${y}L${bx},${by}`}
        stroke={mix(rank)}
        strokeWidth={0.9 * s}
        strokeLinecap="round"
        fill="none"
      />
      <g transform={`translate(${bx},${by}) rotate(${angle}) scale(1,${plan.side})`}>
        <g className="vine-leaf-body">
          <clipPath id={clip}>
            <path d={shape.blade} />
          </clipPath>
          <path d={shape.blade} fill={young ? 'var(--pothos-leaf-young)' : leafFill(maturity)} />
          <path d={shape.blade} fill={`url(#${uid}-shade)`} />
          <g clipPath={`url(#${clip})`} fill="var(--pothos-silver)">
            {shape.spots.map((p, i) => (
              <ellipse
                key={i}
                cx={p.cx}
                cy={p.cy}
                rx={p.rx}
                ry={p.ry}
                opacity={p.o * (young ? 0.6 : 1)}
                transform={`rotate(${p.rot} ${p.cx} ${p.cy})`}
              />
            ))}
            <path
              d={shape.blade}
              fill="none"
              stroke="var(--pothos-silver)"
              strokeWidth={length * 0.075}
              opacity={young ? 0.15 : 0.18 + 0.32 * maturity}
            />
          </g>
          <path
            d={shape.vein}
            fill="none"
            stroke="var(--pothos-vein)"
            strokeWidth={0.45 * s}
            strokeLinecap="round"
          />
        </g>
      </g>
    </g>
  )
}

export interface VineItem {
  id: string
  createdAt: string
  content: ReactNode
}

interface Size {
  w: number
  h: number
  nodeY: number
}

function VineRow({
  item,
  node,
  belowX,
  isOldest,
  grow,
}: {
  item: VineItem
  node: NodePlan
  /** Vine position at the bottom edge (fraction of the column), from the older neighbour. */
  belowX: number
  isOldest: boolean
  grow: boolean
}) {
  const rowRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<Size | null>(null)
  const [near, setNear] = useState(false)
  const uid = 'v' + useId().replace(/[^a-zA-Z0-9]/g, '')

  useLayoutEffect(() => {
    const row = rowRef.current
    const content = contentRef.current
    if (!row || !content) return
    const measure = () => {
      const cell = row.firstElementChild as HTMLElement
      const card = content.querySelector<HTMLElement>('.entry-card')
      // offsetTop ignores the cards' entrance animation (a transform), unlike
      // getBoundingClientRect. Rows and cards share one offsetParent (nothing is positioned).
      const cardTop = card ? card.offsetTop - row.offsetTop : 0
      const nodeY = cardTop + Math.min(22, card ? card.offsetHeight / 2 : 22)
      const next = { w: cell.clientWidth, h: row.clientHeight, nodeY }
      setSize((s) => (s && s.w === next.w && s.h === next.h && s.nodeY === next.nodeY ? s : next))
    }
    measure()
    const stopSize = observeSize(row, measure)
    // Once a segment has been near the screen it stays drawn: nothing is redrawn on scroll.
    let stopNear = () => {}
    stopNear = observeNear(row, (e) => {
      if (!(e as IntersectionObserverEntry).isIntersecting) return
      setNear(true)
      stopNear()
    })
    return () => {
      stopSize()
      stopNear()
    }
  }, [])

  const svg = useMemo(() => {
    if (!size || !near || size.w <= 0) return null
    const W = size.w
    const g: RowGeometry = {
      width: W,
      height: size.h,
      nodeX: node.x * W,
      nodeY: size.nodeY,
      topX: node.rank === 0 ? null : node.above * W,
      bottomX: isOldest ? node.x * W : belowX * W,
      sway: node.sway,
    }
    const stem = stemPaths(g)
    const s = W / 40
    const lowerW = stemWidth(node.rank + 0.5, W)
    const upperW = stemWidth(node.rank - 0.5, W)
    const color = mix(node.rank)
    const young = node.rank === 0
    return (
      <svg className="vine-svg" width={W} height={1} aria-hidden="true" focusable="false">
        <Defs uid={uid} />
        <path
          className="vine-stem"
          d={stem.lower}
          stroke={color}
          strokeWidth={lowerW}
          strokeLinecap="round"
          fill="none"
          pathLength={1}
        />
        <g className={grow ? 'vine-grow' : undefined}>
          <path
            className="vine-stem"
            d={stem.upper}
            stroke={color}
            strokeWidth={upperW}
            strokeLinecap="round"
            fill="none"
            pathLength={1}
          />
          <path
            className="vine-twig"
            d={twigPath(g, W)}
            stroke={color}
            strokeWidth={1.25}
            strokeLinecap="round"
            fill="none"
            pathLength={1}
          />
          {node.root && (
            <path
              className="vine-root"
              d={rootNub(g.nodeX, g.nodeY + lowerW * 0.4, node.x < 0.45 ? -1 : 1, 3.4 * s)}
              stroke="var(--pothos-root)"
              strokeWidth={0.9 * s}
              strokeLinecap="round"
              fill="none"
            />
          )}
          <ellipse
            className="vine-node"
            cx={g.nodeX}
            cy={g.nodeY}
            rx={Math.max(lowerW, upperW) * 0.72}
            ry={Math.max(lowerW, upperW) * 0.9}
            fill={color}
          />
          {node.leaf && (
            <Leaf
              uid={uid}
              x={g.nodeX}
              y={g.nodeY}
              plan={node.leaf}
              rank={node.rank}
              maturity={node.maturity}
              column={W}
              young={young}
            />
          )}
          {stem.tip && !node.leaf && (
            <path
              className="vine-bud"
              d={rolledLeaf(7 * s)}
              transform={`translate(${stem.tip.x},${stem.tip.y + 1}) rotate(${-90 + stem.tip.angle})`}
              fill="var(--pothos-leaf-young)"
            />
          )}
        </g>
      </svg>
    )
  }, [size, near, node, belowX, isOldest, grow, uid])

  return (
    <div ref={rowRef} className="vine-row" data-vine-id={item.id}>
      <div className="vine-cell">{svg}</div>
      <div ref={contentRef} className="vine-content">
        {item.content}
      </div>
    </div>
  )
}

/** The pot below the oldest entry, with the vine going into the soil (or a sprout). */
export function PotRow({ topX, children }: { topX: number | null; children?: ReactNode }) {
  const cellRef = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(0)
  useLayoutEffect(() => {
    const el = cellRef.current
    if (!el) return
    const measure = () => setW(el.clientWidth)
    measure()
    return observeSize(el, measure)
  }, [])
  const pot = w ? potShape(w, topX === null ? w * 0.42 : 16) : null
  const s = w / 40
  return (
    <div className="vine-row vine-pot-row">
      <div ref={cellRef} className="vine-cell">
        {pot && (
          <svg
            className="vine-svg"
            width={w}
            height={pot.height}
            viewBox={`0 0 ${w} ${pot.height}`}
            aria-hidden="true"
            focusable="false"
          >
            {topX !== null ? (
              <path
                className="vine-stem"
                d={potStem(topX * w, pot.soilX, pot.soilY)}
                stroke={mix(40)}
                strokeWidth={stemWidth(60, w)}
                strokeLinecap="round"
                fill="none"
                pathLength={1}
              />
            ) : (
              <g className="vine-sprout">
                <path
                  d={`M${pot.soilX},${pot.soilY}q${0.6 * s},${-5 * s} ${-0.4 * s},${-10 * s}`}
                  stroke="var(--pothos-stem-young)"
                  strokeWidth={1.1 * s}
                  strokeLinecap="round"
                  fill="none"
                />
                <path
                  d={rolledLeaf(6 * s)}
                  transform={`translate(${pot.soilX - 0.3 * s},${pot.soilY - 9 * s}) rotate(-130) scale(1,1.8)`}
                  fill="var(--pothos-leaf-young)"
                />
                <path
                  d={rolledLeaf(5 * s)}
                  transform={`translate(${pot.soilX - 0.2 * s},${pot.soilY - 8 * s}) rotate(-45) scale(1,1.6)`}
                  fill="var(--pothos-leaf-young)"
                />
              </g>
            )}
            <ellipse {...pot.shadow} fill="var(--pothos-pot-shadow)" />
            <path d={pot.body} fill="var(--pothos-pot)" />
            <path d={pot.body} fill="url(#vine-pot-shade)" />
            <path d={pot.rim} fill="var(--pothos-pot-rim)" />
            <path d={pot.soil} fill="var(--pothos-soil)" />
            <defs>
              <linearGradient id="vine-pot-shade" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0" stopColor="#000" stopOpacity="0.1" />
                <stop offset="0.45" stopColor="#fff" stopOpacity="0.06" />
                <stop offset="1" stopColor="#000" stopOpacity="0.14" />
              </linearGradient>
            </defs>
          </svg>
        )}
      </div>
      <div className="vine-content">{children}</div>
    </div>
  )
}

/**
 * Entries (newest first, as shown) with the vine beside them. `allIdsOldestFirst` is every
 * entry in the current view, shown or not yet ("Show older"), so the plant doesn't change as
 * more of the list is shown. The pot appears once the oldest entry of the view is shown.
 */
export function VineList({
  items,
  allIdsOldestFirst,
  animate = true,
}: {
  items: VineItem[]
  allIdsOldestFirst: readonly string[]
  animate?: boolean
}) {
  const plan = useMemo(() => planVine(allIdsOldestFirst), [allIdsOldestFirst])
  const index = useMemo(() => new Map(plan.map((p, k) => [p.id, k])), [plan])
  const motion = useMotion(items, animate)
  const oldest = plan[0]?.id
  const showsOldest = items.some((i) => i.id === oldest)
  return (
    <div className={`vine-list${motion.reveal ? ' vine-reveal' : ''}`}>
      {items.map((item) => {
        const k = index.get(item.id)
        if (k === undefined) return null
        const node = plan[k]
        return (
          <VineRow
            key={item.id}
            item={item}
            node={node}
            belowX={k > 0 ? plan[k - 1].above : node.x}
            isOldest={k === 0}
            grow={motion.fresh.has(item.id)}
          />
        )
      })}
      {(showsOldest || items.length === 0) && <PotRow topX={plan.length ? plan[0].x : null} />}
    </div>
  )
}
