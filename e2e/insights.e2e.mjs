// Search, filters, tags (autocomplete, rename), streaks, heatmap and mood stats.
//   APP_URL=http://localhost:4174/ node e2e/insights.e2e.mjs   (production-like build)
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { chromium } = require(
  require.resolve('playwright', {
    paths: [process.cwd(), ...(process.env.NODE_PATH ?? '').split(':')],
  }),
)
const URL = process.env.APP_URL ?? 'http://localhost:5173/'
const SHOTS = 'e2e/screenshots'
mkdirSync(SHOTS, { recursive: true })
const PASS = 'correct horse battery staple'

function assert(cond, msg) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`)
  console.log(`  ✓ ${msg}`)
}

const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
const page = await context.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
page.on('dialog', (d) => (d.type() === 'prompt' ? d.accept('Job') : d.accept()))
await page.goto(URL)

// Setup
await page.getByRole('button', { name: 'Sign in with Google' }).click()
await page.getByRole('button', { name: 'Start' }).click()
await page.getByLabel('Passphrase', { exact: true }).fill(PASS)
await page.getByLabel('Repeat passphrase').fill(PASS)
await page.getByRole('button', { name: 'Continue' }).click()
await page.locator('.word-grid li').first().waitFor()
const words = (await page.locator('.word-grid li').allInnerTexts()).map((t) => t.split(/\s+/).pop())
await page.getByLabel('I have written down').check()
await page.getByRole('button', { name: 'Continue' }).click()
const labels = await page.locator('label[for^="cw"]').allInnerTexts()
for (const [i, label] of labels.entries()) {
  await page.locator(`#cw${i}`).fill(words[Number(label.replace(/\D/g, '')) - 1])
}
await page.getByRole('button', { name: 'Create vault' }).click()
await page.getByRole('heading', { name: 'Today' }).waitFor()

async function write({ title, body, tags, mood, date }) {
  await page.getByRole('link', { name: 'Today' }).click()
  await page.getByRole('link', { name: '+ New entry' }).click()
  await page.getByLabel('Title').fill(title)
  await page.getByLabel('Entry text').fill(body)
  if (date) await page.getByLabel('Date').fill(date)
  for (const t of tags) {
    await page.getByLabel('Add a tag').fill(t)
    await page.getByLabel('Add a tag').press('Enter')
  }
  if (mood)
    await page
      .getByRole('radio')
      .nth(mood - 1)
      .click()
  await page.waitForTimeout(1000)
  await page.getByRole('button', { name: 'Done' }).click()
  await page.getByRole('heading', { name: title }).waitFor()
}

const d = (offset) => {
  const x = new Date()
  x.setDate(x.getDate() + offset)
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`
}

console.log('Tags while writing')
await write({
  title: 'Lake run',
  body: 'Ran around the **lake** with Café stop.',
  tags: ['Sport', 'outdoors'],
  mood: 5,
})
await write({
  title: 'Office day',
  body: 'Budget meeting all afternoon.',
  tags: ['work'],
  mood: 2,
  date: d(-1),
})
// Autocomplete offers a known tag.
await page.getByRole('link', { name: 'Today' }).click()
await page.getByRole('link', { name: '+ New entry' }).click()
await page.getByLabel('Title').fill('Evening walk')
await page.getByLabel('Entry text').fill('Quiet walk by the river')
await page.getByLabel('Add a tag').fill('out')
await page.getByRole('option', { name: '#outdoors' }).click()
assert(
  await page.locator('.tag-editor .chip', { hasText: '#outdoors' }).isVisible(),
  'autocomplete adds a known tag',
)
await page.getByLabel('Date').fill(d(-2))
await page.waitForTimeout(1000)
await page.getByRole('button', { name: 'Done' }).click()
await page.getByRole('heading', { name: 'Evening walk' }).waitFor()
assert(
  await page.locator('.entry-view .tag', { hasText: '#outdoors' }).isVisible(),
  'tags shown on the entry',
)

console.log('Search')
await page.getByRole('link', { name: 'Timeline' }).click()
const search = page.getByLabel('Search entries')
const results = () => page.locator('.entry-card .entry-card-title').allInnerTexts()
await search.fill('cafe')
await page.locator('.entry-card mark').first().waitFor()
assert(
  JSON.stringify(await results()) === '["Lake run"]',
  'accent-insensitive search with highlight',
)
await search.fill('budg')
await page.waitForFunction(
  () => document.querySelector('.entry-card-title')?.textContent === 'Office day',
)
assert(true, 'prefix search')
await search.fill('outdoors')
await page.waitForFunction(() => document.querySelectorAll('.entry-card').length === 2)
assert(true, 'tag text is searchable')
await page.screenshot({ path: `${SHOTS}/c1-search.png`, fullPage: true })

console.log('Filters')
await search.fill('')
await page.getByRole('button', { name: /^Filters/ }).click()
await page.getByLabel('Add a tag filter').selectOption('work')
await page.waitForFunction(() => document.querySelectorAll('.entry-card').length === 1)
assert(JSON.stringify(await results()) === '["Office day"]', 'tag filter')
await page.getByRole('button', { name: 'Clear all filters' }).click()
await page.getByRole('button', { name: /Great/ }).click()
await page.waitForFunction(() => document.querySelectorAll('.entry-card').length === 1)
assert(JSON.stringify(await results()) === '["Lake run"]', 'mood filter')
await page.getByRole('button', { name: 'Clear all filters' }).click()
await page.getByLabel('From').fill(d(-1))
await page.waitForFunction(() => document.querySelectorAll('.entry-card').length === 2)
assert(true, 'date range filter')
await page.screenshot({ path: `${SHOTS}/c2-filters.png`, fullPage: true })
await page.getByRole('button', { name: 'Clear all filters' }).click()

console.log('Insights')
await page.getByRole('link', { name: 'Insights' }).click()
await page.locator('.stat-value').first().waitFor()
const tiles = await page.locator('.stat-value').allInnerTexts()
assert(tiles[0] === '3' && tiles[1] === '3', `streak: 3 days in a row, longest 3 (${tiles})`)
assert((await page.locator('a.heat.heat-1').count()) >= 3, 'heatmap marks the days')
assert(/Average 3\.5 of 5/.test(await page.locator('.insights').innerText()), 'mood average')
await page.screenshot({ path: `${SHOTS}/c3-insights.png`, fullPage: true })
assert(
  await page.locator('.tag-list a', { hasText: '#outdoors' }).isVisible(),
  'tag list with counts',
)
await page
  .locator('.tag-list li', { hasText: '#work' })
  .getByRole('button', { name: 'Rename' })
  .click()
await page.getByText('Renamed in 1 entry.').waitFor()
assert(
  await page.locator('.tag-list a', { hasText: '#Job' }).isVisible(),
  'tag renamed across entries',
)
await page.locator('.tag-list a', { hasText: '#outdoors' }).click()
await page.waitForFunction(() => document.querySelectorAll('.entry-card').length === 2)
assert(true, 'tapping a tag shows its entries')

console.log('Search cache survives lock/unlock')
await page.getByRole('button', { name: 'Lock now' }).click()
const cache = await page.evaluate(
  () =>
    new Promise((resolve) => {
      const r = indexedDB.open('vaultdiary')
      r.onsuccess = () => {
        const q = r.result.transaction('kv').objectStore('kv').get('searchCache')
        q.onsuccess = () => {
          const v = q.result?.value
          resolve(
            v
              ? {
                  magic: String.fromCharCode(...v.slice(0, 4)),
                  plain: new TextDecoder().decode(v).includes('Budget'),
                }
              : null,
          )
        }
      }
    }),
)
assert(
  cache && cache.magic === 'VDV1' && !cache.plain,
  'search cache stored encrypted (VDV1 kind "cache")',
)
await page.getByLabel('Passphrase').fill(PASS)
await page.getByRole('button', { name: 'Unlock', exact: true }).click()
await page.getByRole('link', { name: 'Timeline' }).click()
await page.getByLabel('Search entries').fill('river')
await page.waitForFunction(
  () => document.querySelector('.entry-card-title')?.textContent === 'Evening walk',
)
assert(true, 'search works after unlocking (from the cache)')

assert(errors.length === 0, `no page errors (${errors.join(' | ')})`)
await browser.close()
console.log('\nInsights e2e: all good.')
