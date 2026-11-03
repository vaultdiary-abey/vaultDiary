// Phase 4 milestones A and B: entry locations, place names, saved places, search and export.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { randomId } from '../src/crypto/bytes'
import { decryptJson, encryptJson, importMasterKey } from '../src/crypto/container'
import { randomBytes } from '../src/crypto/bytes'
import { buildMarkdownExport, withoutLocation } from '../src/core/exporter'
import { nearestCity, parseCities, searchCities } from '../src/location/cities'
import { describePosition, matchPlace } from '../src/location/locate'
import { newEntry, parseEntry, parseIndex, buildIndex, type Entry } from '../src/model/entry'
import {
  cityLabel,
  locationFrontMatter,
  locationLabel,
  parseLocation,
  plainNumber,
  type EntryLocation,
} from '../src/model/location'
import {
  defaultSettings,
  deletePlace,
  livePlaces,
  mergeSettings,
  parseSettings,
  savePlace,
  setAddLocation,
} from '../src/model/settings'
import { matchesFilters, NO_FILTERS, placeCounts, placeOf } from '../src/search/filter'
import { SearchIndex } from '../src/search/searchIndex'
import { entryToMarkdown } from '../src/recovery/export'

const auto: EntryLocation = {
  lat: 1.438012,
  lon: 103.788741,
  accuracy: 35,
  label: 'Woodlands, Singapore',
  city: 'Woodlands',
  region: '',
  country: 'Singapore',
  source: 'auto',
  capturedAt: '2026-11-03T01:15:00.000Z',
}

const typed: EntryLocation = {
  lat: null,
  lon: null,
  accuracy: null,
  label: "Grandma's garden",
  city: '',
  region: '',
  country: '',
  source: 'manual',
  capturedAt: '2026-11-03T01:15:00.000Z',
}

function entryWith(location?: EntryLocation, date = '2026-11-03'): Entry {
  const e = newEntry(date, new Date(`${date}T08:00:00Z`))
  e.title = 'Test'
  if (location) e.location = location
  return e
}

async function roundTrip(e: Entry): Promise<Entry> {
  const mk = await importMasterKey(randomBytes(32))
  const data = await encryptJson(mk, e.id, 'entry', e)
  return parseEntry(await decryptJson(mk, data, { expectedId: e.id, expectedKind: 'entry' }), e.id)
}

describe('entry location format (FORMAT.md revision 4)', () => {
  it('round-trips an entry with a location through encryption', async () => {
    const e = entryWith(auto)
    const back = await roundTrip(e)
    expect(back).toEqual(e)
    expect(parseLocation(back.location)).toEqual(auto)
  })

  it('round-trips an entry with only a typed name', async () => {
    const back = await roundTrip(entryWith(typed))
    const l = parseLocation(back.location)!
    expect(l.lat).toBeNull()
    expect(l.lon).toBeNull()
    expect(locationLabel(l)).toBe("Grandma's garden")
  })

  it('round-trips an entry without a location (no field is added)', async () => {
    const back = await roundTrip(entryWith())
    expect('location' in back).toBe(false)
  })

  it('reads old entries without the field, and keeps the stored location byte for byte', () => {
    const id = randomId()
    const old = parseEntry(
      { id, date: '2025-01-01', title: 'Old', body: '', tags: [], mood: null, attachments: [] },
      id,
    )
    expect(old.location).toBeUndefined()
    const odd = { lat: 1, lon: 2, futureField: 'x' }
    const e = parseEntry({ id, date: '2025-01-01', location: odd }, id)
    expect(e.location).toEqual(odd)
  })

  it('validates locations like recover.py does', () => {
    expect(parseLocation(null)).toBeNull()
    expect(parseLocation({})).toBeNull()
    expect(parseLocation({ label: '   ' })).toBeNull()
    expect(parseLocation({ lat: 91, lon: 0 })).toBeNull()
    expect(parseLocation({ lat: 1, lon: 'x', label: 'A' })).toMatchObject({ lat: null, lon: null })
    expect(parseLocation({ lat: 1, lon: 2 })).toMatchObject({ lat: 1, lon: 2, source: 'manual' })
    expect(parseLocation({ label: ' Home ', source: 'teleport' })).toMatchObject({
      label: 'Home',
      source: 'manual',
    })
    expect(locationLabel(parseLocation({ lat: 1.5, lon: 2 })!)).toBe('1.5000, 2.0000')
  })

  it('labels cities without repeating city-states', () => {
    expect(cityLabel('Woodlands', 'Singapore')).toBe('Woodlands, Singapore')
    expect(cityLabel('Singapore', 'Singapore')).toBe('Singapore')
    expect(cityLabel('', 'Singapore')).toBe('Singapore')
  })

  it('keeps the location in the encrypted index summary', () => {
    const idx = parseIndex(JSON.parse(JSON.stringify(buildIndex([entryWith(auto), entryWith()]))))
    expect(idx.entries.map((e) => e.location)).toContainEqual({
      label: 'Woodlands, Singapore',
      city: 'Woodlands',
      country: 'Singapore',
    })
    expect(idx.entries.filter((e) => e.location)).toHaveLength(1)
  })
})

describe('front matter (Markdown export and recovery)', () => {
  it('writes label, city, country, lat and lon', () => {
    const md = entryToMarkdown(entryWith(auto), () => true)
    expect(md).toContain(
      [
        'tags: []',
        'location:',
        '  label: "Woodlands, Singapore"',
        '  city: "Woodlands"',
        '  country: "Singapore"',
        '  lat: 1.438012',
        '  lon: 103.788741',
        '---',
      ].join('\n'),
    )
    expect(locationFrontMatter(typed)).toContain('  lat: null')
    expect(entryToMarkdown(entryWith(), () => true)).not.toContain('location:')
  })

  const numbers = [
    0,
    1,
    -1,
    103,
    1.438,
    -33.8688,
    0.0078125,
    -0.0078125,
    0.000001,
    -0.0000004,
    0.0000005,
    1e-7,
    179.9999999,
    89.123456789,
    12.5,
    51.50735,
    -0.12776,
    1 / 3,
  ]

  it('writes numbers without exponents or trailing zeros', () => {
    expect(numbers.map(plainNumber)).toEqual([
      '0',
      '1',
      '-1',
      '103',
      '1.438',
      '-33.8688',
      '0.007813',
      '-0.007812',
      '0.000001',
      '0',
      '0.000001',
      '0',
      '180',
      '89.123457',
      '12.5',
      '51.50735',
      '-0.12776',
      '0.333333',
    ])
  })

  it('recover.py formats every number exactly like the app', () => {
    const py = execFileSync(
      'python3',
      [
        '-c',
        'import json,sys; sys.path.insert(0, "recovery"); import recover; ' +
          'print(json.dumps([recover.plain_number(n) for n in json.load(sys.stdin)]))',
      ],
      { input: JSON.stringify(numbers) },
    ).toString()
    expect(JSON.parse(py)).toEqual(numbers.map(plainNumber))
  })

  it('recover.py writes the same front matter as the app, with and without coordinates', () => {
    const cases = [auto, typed, { label: 'Ünïcode "quoted" ✓', lat: 1, lon: 2.5 }, { lat: 5 }]
    const py = execFileSync(
      'python3',
      [
        '-c',
        'import json,sys; sys.path.insert(0, "recovery"); import recover; ' +
          'print(json.dumps([recover.location_front_matter(c) for c in json.load(sys.stdin)]))',
      ],
      { input: JSON.stringify(cases) },
    ).toString()
    expect(JSON.parse(py)).toEqual(cases.map(locationFrontMatter))
  })

  it('the export can leave every location field out', async () => {
    const entries = [entryWith(auto), entryWith(typed)]
    const range = { from: '2026-11-03', to: '2026-11-03' }
    const read = async (zip: Blob) => new TextDecoder().decode(await zip.arrayBuffer())
    const withLoc = await buildMarkdownExport(entries, range, async () => new Blob([]))
    const without = await buildMarkdownExport(entries, range, async () => new Blob([]), undefined, {
      includeLocations: false,
    })
    const a = await read(withLoc.zip)
    const b = await read(without.zip)
    expect(a).toContain('Woodlands')
    expect(a).toContain("Grandma's garden")
    expect(b).not.toMatch(/location:|Woodlands|Grandma|103\.78/)
    expect('location' in withoutLocation(entries[0])).toBe(false)
    expect(entries[0].location).toBeDefined()
  })
})

describe('offline city list', () => {
  const sample = [
    '#VDCITIES 1 4 CC-BY-4.0 GeoNames test',
    'Singapore|France|United States',
    '|Île-de-France|Texas',
    'Singapore||0|0|12894|1038500',
    'Paris||1|1|488566|23522',
    'Woodlands||0|0|14380|1037888',
    'Paris||2|2|336609|-955555',
  ].join('\n')
  const db = parseCities(sample)

  it('finds the nearest city', () => {
    expect(nearestCity(db, 1.4382, 103.7891)?.name).toBe('Woodlands')
    expect(nearestCity(db, 48.85, 2.35)).toMatchObject({ name: 'Paris', country: 'France' })
    expect(nearestCity(db, 33.66, -95.55)).toMatchObject({ region: 'Texas' })
  })

  it('searches by prefix, accent-insensitively, most populous first, with ", country"', () => {
    expect(searchCities(db, 'par').map((c) => c.country)).toEqual(['France', 'United States'])
    expect(searchCities(db, 'paris, uni').map((c) => c.country)).toEqual(['United States'])
    expect(searchCities(db, 'WOOD')[0].name).toBe('Woodlands')
    expect(searchCities(db, 'ile-de')).toEqual([])
    expect(searchCities(db, '')).toEqual([])
  })

  it('the bundled GeoNames list loads and names real places', () => {
    const real = parseCities(readFileSync('src/location/cities.txt', 'utf8'))
    expect(real.count).toBeGreaterThan(100_000)
    expect(nearestCity(real, 1.4382, 103.7891)).toMatchObject({
      name: 'Woodlands',
      country: 'Singapore',
    })
    expect(nearestCity(real, 51.5007, -0.1246)).toMatchObject({ country: 'United Kingdom' })
    expect(searchCities(real, 'zurich')[0]).toMatchObject({
      name: 'Zürich',
      country: 'Switzerland',
    })
  })
})

describe('saved places', () => {
  const home = savePlace(defaultSettings(), { name: ' Home ', lat: 1.438, lon: 103.7887 })

  it('stores places in the settings and merges them by id', () => {
    expect(home.place).toMatchObject({ name: 'Home', radius: 150 })
    const parsed = parseSettings(JSON.parse(JSON.stringify(home.settings)))
    expect(livePlaces(parsed)).toHaveLength(1)
    const renamed = savePlace(
      parsed,
      { id: home.place.id, name: 'Our flat', lat: 1.438, lon: 103.7887, radius: 300 },
      new Date(Date.now() + 1000),
    ).settings
    const deleted = deletePlace(parsed, home.place.id, new Date(Date.now() + 2000))
    expect(livePlaces(mergeSettings(renamed, home.settings))[0]).toMatchObject({
      name: 'Our flat',
      radius: 300,
    })
    expect(livePlaces(mergeSettings(renamed, deleted))).toEqual([])
    expect(livePlaces(mergeSettings(deleted, renamed))).toEqual([])
  })

  it('"Add location" is on by default and syncs by time', () => {
    expect(defaultSettings().addLocation.value).toBe(true)
    expect(parseSettings({ v: 1 }).addLocation.value).toBe(true)
    const off = setAddLocation(defaultSettings(), false)
    expect(mergeSettings(defaultSettings(), off).addLocation.value).toBe(false)
    expect(mergeSettings(off, defaultSettings()).addLocation.value).toBe(false)
  })

  it('matches a position within 150 m only when accurate enough', () => {
    const places = livePlaces(home.settings)
    expect(matchPlace(places, 1.4385, 103.7889, 20)?.name).toBe('Home')
    expect(matchPlace(places, 1.4385, 103.7889, 150)).toBeNull()
    expect(matchPlace(places, 1.4385, 103.7889, null)).toBeNull()
    expect(matchPlace(places, 1.445, 103.7889, 20)).toBeNull()
  })

  it('names a position: saved place, else nearest city, else coordinates', async () => {
    const places = livePlaces(home.settings)
    const city = async () => ({ name: 'Woodlands', region: '', country: 'Singapore' })
    const near = await describePosition(
      { lat: 1.4385, lon: 103.7889, accuracy: 20 },
      places,
      'auto',
      city,
    )
    expect(near).toMatchObject({
      label: 'Home',
      source: 'saved-place',
      placeId: home.place.id,
      city: 'Woodlands',
    })
    const far = await describePosition({ lat: 1.3, lon: 103.8, accuracy: 20 }, places, 'auto', city)
    expect(far).toMatchObject({ label: 'Woodlands, Singapore', source: 'auto' })
    expect(far.placeId).toBeUndefined()
    const offline = await describePosition(
      { lat: 1.123456789, lon: 103.8, accuracy: 12.6 },
      [],
      'auto',
      async () => {
        throw new Error('offline')
      },
    )
    expect(offline).toMatchObject({ label: '1.1235, 103.8000', lat: 1.123457, accuracy: 13 })
  })

  it('deleting a saved place leaves past entries labelled as they were', () => {
    const e = entryWith({ ...auto, label: 'Home', placeId: home.place.id, source: 'saved-place' })
    deletePlace(home.settings, home.place.id)
    expect(locationLabel(parseLocation(e.location)!)).toBe('Home')
  })
})

describe('search and the Places view', () => {
  const a = entryWith(auto, '2026-11-01')
  const b = entryWith({ ...typed, label: 'Home' }, '2026-11-02')
  const c = entryWith({ ...typed, label: 'home' }, '2026-11-03')
  const d = entryWith(undefined, '2026-11-04')
  const items = [a, b, c, d].map((entry) => ({ kind: 'entry' as const, entry }))

  it('search matches the label, city and country', () => {
    const index = new SearchIndex()
    index.update(items)
    expect(index.search('woodlands').map((h) => h.id)).toEqual([a.id])
    expect(index.search('singapore').map((h) => h.id)).toEqual([a.id])
    expect(new Set(index.search('home').map((h) => h.id))).toEqual(new Set([b.id, c.id]))
  })

  it('lists places with counts, the newest first, and filters by place', () => {
    expect(placeCounts(items)).toEqual([
      { key: 'home', label: 'home', count: 2, latest: '2026-11-03', country: '' },
      {
        key: 'woodlands, singapore',
        label: 'Woodlands, Singapore',
        count: 1,
        latest: '2026-11-01',
        country: 'Singapore',
      },
    ])
    const f = { ...NO_FILTERS, place: 'home' }
    expect(items.filter((i) => matchesFilters(i, f)).map((i) => i.entry.id)).toEqual([b.id, c.id])
    expect(placeOf(items[3])).toBe('')
  })
})
