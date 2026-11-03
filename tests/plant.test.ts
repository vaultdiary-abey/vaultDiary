// Phase 4 milestone C: the Timeline plant is a pure function of the entry list.
import { describe, expect, it } from 'vitest'
import { randomId } from '../src/crypto/bytes'
import { leafShape, potShape, stemPaths } from '../src/plant/draw'
import { formatLength, hash32, planVine, plantSentence, rng, stemWidth } from '../src/plant/plan'

const ids = (n: number, seed = 1) => {
  const r = rng(seed)
  return Array.from({ length: n }, () =>
    Array.from({ length: 4 }, () => ((r() * 2 ** 32) >>> 0).toString(16).padStart(8, '0')).join(''),
  )
}

describe('seeded plant', () => {
  it('the same entries always produce exactly the same plant', () => {
    const list = ids(300)
    const a = planVine(list)
    const b = planVine([...list])
    expect(b).toEqual(a)
    const geo = (p: (typeof a)[number]) =>
      stemPaths({
        width: 40,
        height: 120,
        nodeX: p.x * 40,
        nodeY: 22,
        topX: p.rank === 0 ? null : p.above * 40,
        bottomX: 20,
        sway: p.sway,
      })
    expect(a.map(geo)).toEqual(b.map(geo))
    const leaf = a.find((p) => p.leaf)!
    expect(leafShape(18, leaf.maturity, leaf.leaf!.seed)).toEqual(
      leafShape(18, leaf.maturity, leaf.leaf!.seed),
    )
    expect(hash32('abc')).toBe(hash32('abc'))
  })

  it('different entries grow a different plant', () => {
    expect(planVine(ids(50, 1))).not.toEqual(planVine(ids(50, 2)))
  })

  it('adding a newer entry changes nothing below it except how mature the leaves are', () => {
    const list = ids(120)
    const before = planVine(list.slice(0, 119))
    const after = planVine(list)
    for (let k = 0; k < 118; k++) {
      expect(after[k].leaf).toEqual(before[k].leaf)
      expect(after[k].x).toBe(before[k].x)
      expect(after[k].above).toBe(before[k].above)
      expect(after[k].rank).toBe(before[k].rank + 1)
    }
  })

  it('leaf rules: a little over 1 in 3, never 3 bare nodes or 3 leaves in a row, alternating sides', () => {
    let leaves = 0
    let total = 0
    for (let seed = 1; seed <= 40; seed++) {
      const plan = planVine(ids(250, seed))
      let bare = 0
      let run = 0
      let lastSide = 0
      for (const p of plan) {
        total++
        if (p.leaf) {
          leaves++
          run++
          bare = 0
          expect(p.leaf.side).not.toBe(lastSide)
          lastSide = p.leaf.side
        } else {
          bare++
          run = 0
        }
        expect(bare).toBeLessThan(3)
        expect(run).toBeLessThan(3)
      }
    }
    expect(leaves / total).toBeGreaterThan(0.38)
    expect(leaves / total).toBeLessThan(0.5)
  })

  it('the vine wanders inside its column; the stem tapers from pot to tip', () => {
    const plan = planVine(ids(200))
    for (const p of plan) {
      expect(p.x).toBeGreaterThanOrEqual(0.3)
      expect(p.x).toBeLessThanOrEqual(0.7)
      expect(p.above).toBeGreaterThanOrEqual(0.3)
      expect(p.above).toBeLessThanOrEqual(0.7)
    }
    expect(new Set(plan.map((p) => p.x.toFixed(3))).size).toBeGreaterThan(50)
    expect(stemWidth(0)).toBeLessThan(stemWidth(10))
    expect(stemWidth(10)).toBeLessThan(stemWidth(100))
    expect(stemWidth(100, 56)).toBeGreaterThan(stemWidth(100, 40))
    expect(plan.at(-1)!.rank).toBe(0)
    expect(plan.at(-1)!.maturity).toBe(0)
    expect(plan[0].maturity).toBe(1)
  })

  it('segments meet at the row edges: vertical there, at the same x', () => {
    const top = stemPaths({ width: 40, height: 100, nodeX: 20, nodeY: 30, topX: 18, bottomX: 24 })
    expect(top.lower.startsWith('M24,100')).toBe(true)
    expect(top.upper.endsWith('18,0')).toBe(true)
    const tip = stemPaths({ width: 40, height: 100, nodeX: 20, nodeY: 30, topX: null, bottomX: 24 })
    expect(tip.tip).not.toBeNull()
    expect(potShape(40).height).toBeLessThan(40)
  })
})

describe('header sentence', () => {
  it('0 entries', () => {
    expect(plantSentence([])).toBe('Your pothos is waiting for its first entry.')
  })

  it('1 entry, and several entries on one day', () => {
    expect(plantSentence(['2026-11-03'])).toBe('Your pothos was planted today and has grown 5 cm.')
    expect(plantSentence(['2026-11-03', '2026-11-03', '2026-11-03'])).toBe(
      'Your pothos was planted today and has grown 15 cm.',
    )
  })

  it('many entries: length grown and days from first to latest (counting both)', () => {
    expect(plantSentence(['2026-11-03', '2026-11-02'])).toBe(
      'Your pothos has grown 10 cm in 2 days.',
    )
    const month = Array.from(
      { length: 70 },
      (_, i) => `2026-10-${String(1 + (i % 30)).padStart(2, '0')}`,
    )
    expect(plantSentence(month)).toBe('Your pothos has grown 3.5 m in 30 days.')
    const dates = Array.from({ length: 1234 }, (_, i) =>
      new Date(Date.UTC(2023, 0, 1 + (i % 1500))).toISOString().slice(0, 10),
    )
    dates.push('2027-02-01')
    // 1,235 entries × 5 cm = 61.75 m; 2023-01-01 … 2027-02-01 is 1,493 days counting both ends.
    expect(plantSentence(dates)).toBe('Your pothos has grown 61.8 m in 1,493 days.')
  })

  it('formats lengths in cm under a metre, then metres', () => {
    expect(formatLength(95)).toBe('95 cm')
    expect(formatLength(100)).toBe('1 m')
    expect(formatLength(355)).toBe('3.6 m')
    expect(formatLength(125_000)).toBe('1,250 m')
  })

  it('does not depend on order (filters never change it: the Timeline passes all entries)', () => {
    const d = ['2026-03-01', '2026-01-01', '2026-02-01']
    expect(plantSentence(d)).toBe(plantSentence([...d].reverse()))
  })
})

it('random ids work too', () => {
  expect(planVine([randomId(), randomId()])).toHaveLength(2)
})
