// Builds the offline city list used to name places (src/location/cities.txt) from GeoNames:
//
//   node scripts/build-cities.mjs <cities1000.txt> <admin1CodesASCII.txt | admin1.json>
//
// Sources: https://download.geonames.org/export/dump/ (cities1000.zip, admin1CodesASCII.txt).
// GeoNames data is licensed CC BY 4.0 (https://www.geonames.org/), credited in Settings → About.
//
// Output (UTF-8, one record per line, most populous first so search can rank by line order):
//   line 1:  "#VDCITIES 1 <count> CC-BY-4.0 GeoNames <date>"
//   line 2:  country names, "|"-separated (index = position), from ISO codes via Intl
//   line 3:  region (admin1) names, "|"-separated
//   then:    name|asciiName|regionIndex|countryIndex|lat×10⁴|lon×10⁴
//            asciiName is empty when it adds nothing to the accent-folded name.
import { readFileSync, writeFileSync } from 'node:fs'

const [citiesPath, adminPath, outPath = 'src/location/cities.txt'] = process.argv.slice(2)
if (!citiesPath || !adminPath) {
  console.error('usage: node scripts/build-cities.mjs <cities1000.txt> <admin1 file> [out]')
  process.exit(2)
}

const admin = new Map()
const adminText = readFileSync(adminPath, 'utf8')
if (adminPath.endsWith('.json')) {
  for (const a of JSON.parse(adminText)) admin.set(a.code, a.name)
} else {
  for (const line of adminText.split('\n')) {
    const [code, name] = line.split('\t')
    if (code && name) admin.set(code, name)
  }
}

const countryName = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'code' })
/** Shorter everyday names where Intl's are formal or ambiguous. */
const COUNTRY_OVERRIDES = {
  CD: 'DR Congo',
  CG: 'Republic of the Congo',
  HK: 'Hong Kong',
  MO: 'Macao',
  MM: 'Myanmar',
}
const fold = (s) => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
const clean = (s) => s.replace(/[|\n\r\t]/g, ' ').trim()

const rows = []
for (const line of readFileSync(citiesPath, 'utf8').split('\n')) {
  const f = line.split('\t')
  if (f.length < 15) continue
  const [, name, ascii, , lat, lon, , , cc, , a1] = f
  const pop = Number(f[14]) || 0
  if (!name || !cc) continue
  rows.push({ name: clean(name), ascii: clean(ascii), cc, a1, lat: +lat, lon: +lon, pop })
}
rows.sort((a, b) => b.pop - a.pop || a.name.localeCompare(b.name) || a.lat - b.lat)

const countries = [],
  countryIdx = new Map()
const regions = [''],
  regionIdx = new Map([['', 0]])
const idx = (list, map, key, label) => {
  if (!map.has(key)) {
    map.set(key, list.length)
    list.push(label)
  }
  return map.get(key)
}
const out = []
for (const r of rows) {
  const c = idx(
    countries,
    countryIdx,
    r.cc,
    clean(COUNTRY_OVERRIDES[r.cc] ?? countryName.of(r.cc) ?? r.cc),
  )
  const regionName = admin.get(`${r.cc}.${r.a1}`) ?? ''
  const g = regionName ? idx(regions, regionIdx, clean(regionName), clean(regionName)) : 0
  const ascii = r.ascii && fold(r.ascii) !== fold(r.name) ? r.ascii : ''
  out.push(`${r.name}|${ascii}|${g}|${c}|${Math.round(r.lat * 1e4)}|${Math.round(r.lon * 1e4)}`)
}
const date = new Date().toISOString().slice(0, 10)
writeFileSync(
  outPath,
  [
    `#VDCITIES 1 ${out.length} CC-BY-4.0 GeoNames ${date}`,
    countries.join('|'),
    regions.join('|'),
    ...out,
  ].join('\n') + '\n',
)
console.log(
  `${out.length} cities, ${countries.length} countries, ${regions.length} regions → ${outPath}`,
)
