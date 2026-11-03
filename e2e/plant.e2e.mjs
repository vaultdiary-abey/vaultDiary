// Phase 4 milestone C: the Timeline plant in the real app.
//   APP_URL=http://localhost:4174/ node e2e/plant.e2e.mjs   (production-like build)
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
const context = await browser.newContext({ viewport: { width: 375, height: 812 } })
const page = await context.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
page.on('dialog', (d) => d.accept())

await page.goto(URL)
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

const sentence = page.getByTestId('plant-sentence')
console.log('Empty timeline')
await page.getByRole('link', { name: 'Timeline' }).click()
await sentence.waitFor()
assert((await sentence.innerText()) === 'Your pothos is waiting for its first entry.', '0 entries')
assert((await page.locator('.vine-pot-row svg').count()) === 1, 'just the pot with a sprout')

async function write(date, title) {
  await page.goto(`${URL}#/new/${date}`)
  await page.getByLabel('Title').fill(title)
  await page.getByLabel('Entry text').fill(`Text of ${title}.`)
  await page.waitForTimeout(1000)
  await page.getByRole('button', { name: 'Done' }).click()
  await page.getByRole('heading', { name: title }).waitFor()
}
await write('2026-04-01', 'Planting day')
await page.getByRole('link', { name: 'Timeline' }).click()
assert((await sentence.innerText()) === 'Your pothos was planted today · 1 entry', '1 entry')
await write('2026-04-01', 'Same day again')
await write('2026-10-31', 'Autumn')
await write('2026-11-01', 'Rainy walk')
await page.getByRole('link', { name: 'Timeline' }).click()
await page.locator('.vine-row svg').first().waitFor()
assert(
  (await sentence.innerText()) === 'Your pothos has been growing for 215 days · 4 entries',
  'many entries, two on one day',
)
assert(
  (await page.locator('.vine-row[data-vine-id]').count()) === 4,
  'every entry has its own node',
)
assert(
  await page
    .locator('.vine-svg')
    .evaluateAll((s) => s.every((x) => x.getAttribute('aria-hidden') === 'true')),
  'all plant SVG is aria-hidden',
)

async function widths() {
  return page.evaluate(() => {
    const cell = document
      .querySelector('.vine-row[data-vine-id] .vine-cell')
      .getBoundingClientRect()
    const card = document.querySelector('.vine-row .entry-card').getBoundingClientRect()
    const page = document.querySelector('.page').getBoundingClientRect()
    return {
      cell: cell.width,
      cellRight: cell.right,
      cardLeft: card.left,
      card: card.width,
      page: page.width,
      cellLeft: cell.left,
    }
  })
}
const phone = await widths()
assert(phone.cell <= 40, `plant column at 375 px is ${phone.cell} px (≤ 40)`)
assert(phone.cellRight <= phone.cardLeft + 0.5, 'the column never overlaps the cards')
assert(
  phone.card >= phone.page - 30,
  `cards keep almost their full width (${phone.card} of ${phone.page})`,
)
await page.screenshot({ path: `${SHOTS}/plant-375.png` })
await page.setViewportSize({ width: 1280, height: 900 })
await page.waitForTimeout(300)
const laptop = await widths()
assert(laptop.cell <= 56, `plant column at 1,280 px is ${laptop.cell} px (≤ 56)`)
assert(Math.abs(laptop.card - laptop.page) < 1, 'on a wide screen cards keep their full width')
await page.screenshot({ path: `${SHOTS}/plant-1280.png` })
await page.setViewportSize({ width: 375, height: 812 })

console.log('Filtered views')
await page.getByRole('searchbox', { name: 'Search entries' }).fill('rainy')
await page.locator('.entry-card', { hasText: 'Rainy walk' }).waitFor()
await page.waitForTimeout(300)
assert(
  (await page.locator('.vine-row[data-vine-id]').count()) === 1,
  'the vine connects only the visible entries',
)
assert(
  (await sentence.innerText()) === 'Your pothos has been growing for 215 days · 4 entries',
  'the sentence still counts all entries',
)
await page.getByRole('searchbox', { name: 'Search entries' }).fill('')

console.log('Printing')
await page.emulateMedia({ media: 'print' })
assert(
  await page
    .locator('.vine-cell')
    .first()
    .evaluate((e) => getComputedStyle(e).display === 'none'),
  'hidden when printing',
)
await page.emulateMedia({ media: 'screen' })

console.log('Setting off')
await page.getByRole('link', { name: 'Settings' }).click()
await page.getByLabel('Timeline plant').uncheck()
await page.getByRole('link', { name: 'Timeline' }).click()
await page.locator('.entry-card').first().waitFor()
assert(!(await page.locator('.vine-list, .plant-sentence').count()), 'no plant and no sentence')
assert(
  (await page.locator('section.timeline-day .entry-list .entry-card').count()) === 4,
  'the old Timeline layout',
)
await page.getByRole('link', { name: 'Settings' }).click()
await page.getByLabel('Timeline plant').check()

assert(errors.length === 0, `no page errors (${errors.join(' | ')})`)
await browser.close()
console.log('Plant e2e passed')
