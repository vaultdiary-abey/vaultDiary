// Phase 3 milestone A: "On this day", the writing nudge, the backup reminder and export.
//   APP_URL=http://localhost:4174/ node e2e/extras.e2e.mjs   (production-like build)
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'

const require = createRequire(import.meta.url)
const { chromium } = require(
  require.resolve('playwright', {
    paths: [process.cwd(), ...(process.env.NODE_PATH ?? '').split(':')],
  }),
)
const URL = process.env.APP_URL ?? 'http://localhost:5173/'
const SHOTS = 'e2e/screenshots'
mkdirSync(SHOTS, { recursive: true })
const work = mkdtempSync(join(tmpdir(), 'vd-extras-'))
const PASS = 'correct horse battery staple'

function assert(cond, msg) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`)
  console.log(`  ✓ ${msg}`)
}

/** A small valid PNG (solid colour), so the browser can decode and print it. */
function png(w, h) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (buf) => {
    let c = 0xffffffff
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type), data])
    const c = Buffer.alloc(4)
    c.writeUInt32BE(crc(td))
    return Buffer.concat([len, td, c])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 0x5a)])
  const raw = Buffer.concat(Array.from({ length: h }, () => row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const browser = await chromium.launch()
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  acceptDownloads: true,
})
const page = await context.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
page.on('dialog', (d) => d.accept())
// 9 pm on 2 November 2026: past the default 8 pm nudge time.
await page.clock.setFixedTime(new Date('2026-11-02T21:00:00'))
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

console.log('Writing nudge')
const nudge = page.locator('.banner-gentle', { hasText: 'No entry yet today' })
await nudge.waitFor()
assert(true, 'after 8 pm with no entry today, a gentle banner shows')
assert(await nudge.getByRole('link', { name: 'Write now' }).isVisible(), 'it offers Write now')
await nudge.getByRole('button', { name: 'Not today' }).click()
await nudge.waitFor({ state: 'detached' })
assert(true, 'Not today hides it')
assert(!(await page.locator('.banner-backup').count()), 'no backup reminder on a vault made today')

async function writeEntry(date, title, file) {
  await page.goto(`${URL}#/new/${date}`)
  await page.getByLabel('Title').fill(title)
  await page.getByLabel('Entry text').fill(`Text of ${title}.`)
  if (file) {
    await page.locator('input[type=file][multiple]').setInputFiles(file)
    await page.locator('.attachments li', { hasText: file.name }).waitFor()
  }
  await page.waitForTimeout(1200)
  await page.getByRole('button', { name: 'Done' }).click()
  await page.getByRole('heading', { name: title }).waitFor()
}

console.log('On this day')
await page.getByRole('link', { name: 'Today' }).click()
assert(!(await page.locator('.on-this-day').count()), 'no card when nothing matches')
await writeEntry('2025-11-02', 'A year ago', {
  name: 'pixel.png',
  mimeType: 'image/png',
  buffer: png(64, 48),
})
await writeEntry('2024-11-02', 'Two years ago')
await writeEntry('2025-11-03', 'Not this day')
await page.getByRole('link', { name: 'Today' }).click()
const card = page.locator('.on-this-day')
await card.waitFor()
const cardText = await card.innerText()
assert(cardText.includes('1 year ago') && cardText.includes('A year ago'), 'shows last year')
assert(cardText.includes('2 years ago') && cardText.includes('Two years ago'), 'and 2024')
assert(!cardText.includes('Not this day'), 'not other days')
assert(cardText.indexOf('1 year ago') < cardText.indexOf('2 years ago'), 'most recent year first')
await page.screenshot({ path: `${SHOTS}/p3a1-today.png`, fullPage: true })
await card.getByRole('link', { name: /A year ago/ }).click()
await page.getByRole('heading', { name: 'A year ago' }).waitFor()
assert(true, 'tapping opens the entry')

console.log('Backup reminder')
// 32 days later: the app has been idle, so it locks; open it again.
await page.clock.setFixedTime(new Date('2026-12-04T10:00:00'))
await page.goto(URL)
await page.reload()
await page.getByLabel('Passphrase').fill(PASS)
await page.getByRole('button', { name: 'Unlock' }).click()
await page.getByRole('heading', { name: 'Today' }).waitFor()
const reminder = page.locator('.banner-backup')
await reminder.waitFor()
assert(
  (await reminder.innerText()).includes("haven't made an encrypted backup"),
  'a vault without a backup for over 30 days shows the reminder',
)
await page.screenshot({ path: `${SHOTS}/p3a2-backup-reminder.png`, fullPage: true })
const [backup] = await Promise.all([
  page.waitForEvent('download'),
  reminder.getByRole('button', { name: 'Back up now' }).click(),
])
assert(/^VaultDiary-backup-.*\.zip$/.test(backup.suggestedFilename()), 'Back up now downloads')
await reminder.waitFor({ state: 'detached' })
assert(true, 'and the reminder goes away')
await page.getByRole('link', { name: 'Settings' }).click()
assert(
  (await page.getByTestId('last-backup').innerText()).startsWith('Last encrypted backup:'),
  'Settings shows the date of the last backup',
)
assert(!(await page.locator('.banner-backup').count()), 'no reminder in Settings either')

console.log('Export: Markdown')
const exportCard = page.locator('.card.export')
await exportCard.getByRole('button', { name: 'Everything' }).click()
assert(
  (await page.getByTestId('export-summary').innerText()).startsWith('3 entries, 1 attachment'),
  'summary counts entries and attachments',
)
await exportCard.getByRole('button', { name: 'Export…' }).click()
assert(
  (await exportCard.innerText()).includes('These files will NOT be encrypted'),
  'warns that exported files are not encrypted',
)
await exportCard.getByLabel('Your passphrase').fill('wrong passphrase here')
await exportCard.getByRole('button', { name: 'Confirm and export' }).click()
await exportCard.getByText('Wrong passphrase.').waitFor()
assert(true, 'a wrong passphrase is refused')
await exportCard.getByLabel('Your passphrase').fill(PASS)
const [md] = await Promise.all([
  page.waitForEvent('download'),
  exportCard.getByRole('button', { name: 'Confirm and export' }).click(),
])
const zipPath = join(work, md.suggestedFilename())
await md.saveAs(zipPath)
assert(/^VaultDiary-export-.*\.zip$/.test(md.suggestedFilename()), 'downloads a .zip')
const listing = execFileSync('python3', [
  '-I',
  '-c',
  'import sys,zipfile; print("\\n".join(zipfile.ZipFile(sys.argv[1]).namelist()))',
  zipPath,
])
  .toString()
  .trim()
  .split('\n')
assert(
  listing.some((p) => /\/entries\/2025-11-02\/a-year-ago-[0-9a-f]{8}\.md$/.test(p)) &&
    listing.some((p) => /\/entries\/2024-11-02\/two-years-ago-[0-9a-f]{8}\.md$/.test(p)),
  'entries as Markdown grouped by date',
)
assert(
  listing.some((p) => /\/files\/[0-9a-f]{8}-pixel\.png$/.test(p)),
  'attachments in files/',
)
const mdText = execFileSync('python3', [
  '-I',
  '-c',
  'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print(z.read([n for n in z.namelist() if "a-year-ago" in n][0]).decode())',
  zipPath,
]).toString()
assert(mdText.includes('Text of A year ago.') && mdText.includes('pixel.png'), 'readable text')
const pngOut = execFileSync('python3', [
  '-I',
  '-c',
  'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print(z.read([n for n in z.namelist() if n.endswith("pixel.png")][0]).hex())',
  zipPath,
])
  .toString()
  .trim()
assert(pngOut === png(64, 48).toString('hex'), 'the attachment is the original file')

console.log('Export: PDF (print view)')
await exportCard.getByRole('button', { name: 'Everything' }).click()
await exportCard.getByLabel('PDF (print view)').check()
await exportCard.getByRole('button', { name: 'Export…' }).click()
await exportCard.getByLabel('Your passphrase').fill(PASS)
await exportCard.getByRole('button', { name: 'Confirm and export' }).click()
await page.locator('.print-doc').waitFor()
const printed = page.locator('.print-entry')
assert((await printed.count()) === 3, 'three entries in the print view')
assert(
  (await printed.first().innerText()).includes('Two years ago'),
  'oldest entry first, with its title',
)
const img = page.locator('.print-photo img')
await img.waitFor()
assert(await img.evaluate((el) => el.complete && el.naturalWidth === 64), 'photos are shown inline')
await page.emulateMedia({ media: 'print' })
assert(!(await page.locator('.print-toolbar').isVisible()), 'the toolbar is not printed')
await page.screenshot({ path: `${SHOTS}/p3a3-print.png`, fullPage: true })
await page.emulateMedia({ media: 'screen' })
await page.getByRole('button', { name: '✕ Close' }).click()
await page.getByRole('heading', { name: 'Settings' }).waitFor()
assert(true, 'Close returns to Settings')

console.log('Export needs a fresh confirmation each time')
await exportCard.getByRole('button', { name: 'Export…' }).click()
assert(await exportCard.getByLabel('Your passphrase').isVisible(), 'the passphrase is asked again')

assert(errors.length === 0, `no page errors (${errors.join(' | ')})`)
await browser.close()
console.log('\nExtras e2e: all good.')
