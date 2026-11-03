// Phase 4 milestones A and B: automatic location, the location editor, saved places, Places
// view, search, export, and what happens when location permission is denied.
//   APP_URL=http://localhost:4174/ node e2e/location.e2e.mjs   (production-like build)
import { mkdirSync, readFileSync } from 'node:fs'
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
// Woodlands, Singapore.
const HERE = { latitude: 1.43821, longitude: 103.78912, accuracy: 20 }

function assert(cond, msg) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`)
  console.log(`  ✓ ${msg}`)
}

const pad = (n) => String(n).padStart(2, '0')
const d = new Date()
const TODAY = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

async function setup(page) {
  await page.goto(URL)
  await page.getByRole('button', { name: 'Sign in with Google' }).click()
  await page.getByRole('button', { name: 'Start' }).click()
  await page.getByLabel('Passphrase', { exact: true }).fill(PASS)
  await page.getByLabel('Repeat passphrase').fill(PASS)
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.locator('.word-grid li').first().waitFor()
  const words = (await page.locator('.word-grid li').allInnerTexts()).map((t) =>
    t.split(/\s+/).pop(),
  )
  await page.getByLabel('I have written down').check()
  await page.getByRole('button', { name: 'Continue' }).click()
  const labels = await page.locator('label[for^="cw"]').allInnerTexts()
  for (const [i, label] of labels.entries()) {
    await page.locator(`#cw${i}`).fill(words[Number(label.replace(/\D/g, '')) - 1])
  }
  await page.getByRole('button', { name: 'Create vault' }).click()
  await page.getByRole('heading', { name: 'Today' }).waitFor()
}

function watch(page) {
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  page.on('dialog', (dlg) => dlg.accept())
  return errors
}

const browser = await chromium.launch()

// ------------------------------------------------------------------ permission granted
console.log('Location allowed')
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  acceptDownloads: true,
  permissions: ['geolocation'],
  geolocation: HERE,
})
const page = await context.newPage()
const errors = watch(page)
await setup(page)

await page.goto(`${URL}#/new`)
await page.getByLabel('Title').waitFor()
const chip = page.getByTestId('location-chip')
await chip.filter({ hasText: 'Woodlands, Singapore' }).waitFor({ timeout: 20000 })
assert(true, 'a new entry for today gets "Woodlands, Singapore" without asking (already allowed)')
await page.getByLabel('Title').fill('Morning walk')
await page.getByLabel('Entry text').fill('Written near the park.')
await page.waitForTimeout(1200)
await page.screenshot({ path: `${SHOTS}/loc-01-editor.png` })
await page.getByRole('button', { name: 'Done' }).click()
await page.getByRole('heading', { name: 'Morning walk' }).waitFor()
assert(
  await chip.filter({ hasText: 'Woodlands, Singapore' }).isVisible(),
  'chip shows under the date',
)

console.log('Location editor')
await chip.click()
const sheet = page.getByRole('dialog', { name: 'Location' })
await sheet.waitFor()
await page.screenshot({ path: `${SHOTS}/loc-02-sheet.png` })
await sheet.getByLabel('Search a city').fill('paris, fra')
await sheet.getByRole('option', { name: /Paris/ }).first().waitFor({ timeout: 20000 })
await sheet.getByRole('option', { name: /Paris/ }).first().click()
await sheet.waitFor({ state: 'detached' })
assert(await chip.filter({ hasText: 'Paris, France' }).isVisible(), 'searching a city sets it')
const dateText = await page.locator('.entry-view > p.muted').first().innerText()

await chip.click()
await sheet.getByLabel('Type a custom name').fill("Mum's balcony")
await sheet.getByLabel('Coordinates (optional)').fill('')
await sheet.getByRole('button', { name: 'Use this name' }).click()
await sheet.waitFor({ state: 'detached' })
assert(
  await chip.filter({ hasText: "Mum's balcony" }).isVisible(),
  'a typed name without coordinates',
)
assert(
  (await page.locator('.entry-view > p.muted').first().innerText()) === dateText,
  "editing the location doesn't change the date",
)

await chip.click()
await sheet.getByRole('button', { name: 'Use current location' }).click()
await sheet.waitFor({ state: 'detached' })
assert(await chip.filter({ hasText: 'Woodlands' }).isVisible(), 'use current location refreshes it')

console.log('Saved places')
await chip.click()
await sheet.getByLabel('Save this place').fill('Home')
await sheet.getByRole('button', { name: 'Save place' }).click()
await sheet.waitFor({ state: 'detached' })
assert(await chip.filter({ hasText: 'Home' }).isVisible(), 'saving the place names this entry')

await page.goto(`${URL}#/new`)
await page.getByLabel('Title').waitFor()
await chip.filter({ hasText: 'Home' }).waitFor({ timeout: 20000 })
assert(true, 'a new entry within 150 m of a saved place gets its name')
await page.getByLabel('Title').fill('Second at home')
await page.waitForTimeout(1200)
await page.getByRole('button', { name: 'Done' }).click()
await page.getByRole('heading', { name: 'Second at home' }).waitFor()

console.log('Past dates and existing entries')
await page.goto(`${URL}#/new/2024-05-01`)
await page.getByLabel('Title').fill('Old memory')
await page.waitForTimeout(2500)
assert(
  await chip.filter({ hasText: 'Add location' }).isVisible(),
  'a new entry for a past date gets no location',
)
await page.getByRole('button', { name: 'Done' }).click()
await page.getByRole('heading', { name: 'Old memory' }).waitFor()
await page.getByRole('link', { name: 'Edit' }).click()
await page.waitForTimeout(2500)
assert(
  await chip.filter({ hasText: 'Add location' }).isVisible(),
  'editing an existing entry adds no location',
)
await page.getByRole('button', { name: 'Done' }).click()

console.log('Places view, search, settings')
await page.getByRole('link', { name: 'Timeline' }).click()
await page.locator('.entry-card', { hasText: 'Second at home' }).waitFor()
await page.screenshot({ path: `${SHOTS}/loc-03-timeline.png` })
assert(
  (await page.locator('.entry-card .loc-chip', { hasText: 'Home' }).count()) >= 2,
  'cards show the place',
)
await page.getByRole('searchbox', { name: 'Search entries' }).fill('singapore')
await page.locator('.entry-card', { hasText: 'Morning walk' }).waitFor()
assert(
  !(await page.locator('.entry-card', { hasText: 'Old memory' }).count()),
  'search matches the country of the location',
)
await page.getByRole('searchbox', { name: 'Search entries' }).fill('')
await page.getByRole('link', { name: '📍 Places' }).click()
await page.getByRole('heading', { name: 'Places' }).waitFor()
const homeRow = page.locator('.place-counts a', { hasText: 'Home' })
assert((await homeRow.innerText()).includes('2 entries'), 'Places lists Home with 2 entries')
await page.screenshot({ path: `${SHOTS}/loc-04-places.png` })
await homeRow.click()
await page.locator('.entry-card', { hasText: 'Second at home' }).waitFor()
assert(
  (await page.locator('.entry-list .entry-card').count()) === 2,
  'tapping it shows those entries',
)

await page.getByRole('link', { name: 'Settings' }).click()
const places = page.locator('.place-list')
await places.getByText('Home', { exact: true }).waitFor()
assert(true, 'Settings → Places lists the saved place')
await places.getByRole('button', { name: 'Rename' }).click()
await places.getByLabel('Place name').fill('Our flat')
await places.getByRole('button', { name: 'Save' }).click()
await places.getByText('Our flat').waitFor()
await places.getByLabel('Radius for Our flat').selectOption('250')
assert(true, 'rename and radius change')
await places.getByRole('button', { name: 'Delete' }).click()
await page.getByText('No saved places yet').waitFor()
await page.getByRole('link', { name: 'Timeline' }).click()
await page.locator('.entry-card', { hasText: 'Second at home' }).waitFor()
assert(
  (await page.locator('.entry-card .loc-chip', { hasText: 'Home' }).count()) >= 2,
  'deleting a saved place keeps past entries’ labels',
)

console.log('Export')
await page.getByRole('link', { name: 'Settings' }).click()
const exportCard = page.locator('.card.export')
await exportCard.getByRole('button', { name: 'Everything' }).click()
assert(
  await exportCard.getByLabel('Include locations').isChecked(),
  '"Include locations" is on by default',
)
async function exportZip(include) {
  const box = exportCard.getByLabel('Include locations')
  if ((await box.isChecked()) !== include) await box.click()
  await exportCard.getByRole('button', { name: 'Export…' }).click()
  await exportCard.getByLabel('Your passphrase').fill(PASS)
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    exportCard.getByRole('button', { name: 'Confirm and export' }).click(),
  ])
  return readFileSync(await download.path()).toString('latin1')
}
const withLoc = await exportZip(true)
assert(
  /location:\n {2}label: "Home"/.test(withLoc),
  'the Markdown export has the location in front matter',
)
const withoutLoc = await exportZip(false)
assert(
  !/location:|Woodlands|Home"/.test(withoutLoc),
  'with the box off, every location field is gone',
)

await exportCard.getByRole('button', { name: 'Everything' }).click()
await exportCard.getByLabel('PDF (print view)').check()
await exportCard.getByLabel('Include locations').check()
await exportCard.getByRole('button', { name: 'Export…' }).click()
await exportCard.getByLabel('Your passphrase').fill(PASS)
await exportCard.getByRole('button', { name: 'Confirm and export' }).click()
await page.locator('.print-doc').waitFor()
assert(
  (await page.locator('.print-place', { hasText: 'Home' }).count()) >= 1,
  'the PDF shows the label under the date',
)
await page.getByRole('button', { name: '✕ Close' }).click()

assert(
  await page
    .locator('.card', { hasText: 'GeoNames' })
    .getByRole('link', { name: 'CC BY 4.0' })
    .isVisible(),
  'About credits GeoNames (CC BY)',
)
assert(errors.length === 0, `no page errors (${errors.join(' | ')})`)
await context.close()

// ------------------------------------------------------------------ permission denied
console.log('Location denied')
const denied = await browser.newContext({ viewport: { width: 390, height: 844 } })
const page2 = await denied.newPage()
const errors2 = watch(page2)
await setup(page2)
await page2.goto(`${URL}#/new`)
const ask = page2.locator('.loc-ask')
await ask.waitFor()
assert(
  (await ask.innerText()).includes('stored only inside your encrypted entry'),
  'the first time, one plain sentence explains why',
)
await page2.screenshot({ path: `${SHOTS}/loc-05-ask.png` })
await page2.getByLabel('Title').fill('Typing while it asks')
await ask.getByRole('button', { name: 'Add my location' }).click()
await page2.waitForTimeout(1500)
assert(
  await page2.getByTestId('location-chip').filter({ hasText: 'Add location' }).isVisible(),
  'denied: the location stays empty',
)
assert(
  (await page2.getByLabel('Title').inputValue()) === 'Typing while it asks',
  'writing was never blocked',
)
await page2.getByRole('button', { name: 'Done' }).click()
await page2.getByRole('heading', { name: 'Typing while it asks' }).waitFor()
await page2.goto(`${URL}#/new`)
await page2.getByLabel('Title').waitFor()
await page2.waitForTimeout(800)
assert(!(await page2.locator('.loc-ask').count()), "after a denial it doesn't ask again")
await page2.getByRole('link', { name: 'Settings' }).click()
const off = page2.getByTestId('location-off')
await off.waitFor()
assert((await off.innerText()).includes('Location off'), 'Settings shows "Location off"')
assert(
  (await off.innerText()).includes('Privacy & Security'),
  '…with how to turn it on on an iPhone',
)
await page2.screenshot({ path: `${SHOTS}/loc-06-off.png`, fullPage: true })
assert(errors2.length === 0, `no page errors (${errors2.join(' | ')})`)

await browser.close()
console.log('Location e2e passed')
