// End-to-end smoke test of the real UI against the dev-only fake Drive.
//   npm run dev:fake            (in another terminal)
//   node e2e/app.e2e.mjs        (URL defaults to http://localhost:5173/)
// Screenshots go to e2e/screenshots/ (git-ignored).
import { mkdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

// Playwright is not a project dependency; use a globally installed one (NODE_PATH) if present.
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
const NEWPASS = 'a brand new passphrase'

function assert(cond, msg) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`)
  console.log(`  ✓ ${msg}`)
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
async function expectCount(selector, n, msg) {
  try {
    await page.waitForFunction(
      ([sel, k]) => document.querySelectorAll(sel).length === k,
      [selector, n],
      { timeout: 10000 },
    )
  } catch {
    throw new Error(`Assertion failed: ${msg} (found ${await page.locator(selector).count()})`)
  }
  console.log(`  ✓ ${msg}`)
}
const shot = (name) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true })

console.log('Setup')
await page.goto(URL)
await page.getByRole('button', { name: 'Sign in with Google' }).click()
await page.getByRole('button', { name: 'Start' }).click()
await page.getByLabel('Passphrase', { exact: true }).fill('short')
assert(await page.getByText('Use at least 10 characters').isVisible(), 'short passphrase rejected')
await page.getByLabel('Passphrase', { exact: true }).fill(PASS)
await page.getByLabel('Repeat passphrase').fill(PASS)
await page.getByRole('button', { name: 'Continue' }).click()
await page.locator('.word-grid li').first().waitFor()
const words = (await page.locator('.word-grid li').allInnerTexts()).map((t) => t.split(/\s+/).pop())
assert(words.length === 24, '24 recovery words shown')
await shot('01-words')
await page.getByLabel('I have written down').check()
await page.getByRole('button', { name: 'Continue' }).click()
const labels = await page.locator('label[for^="cw"]').allInnerTexts()
assert(labels.length === 3, 'asked to confirm 3 words')
for (const [i, label] of labels.entries()) {
  const n = Number(label.replace(/\D/g, ''))
  await page.locator(`#cw${i}`).fill(i === 0 ? 'wrong' : words[n - 1])
}
await page.getByRole('button', { name: 'Create vault' }).click()
assert(await page.getByText("doesn't match").isVisible(), 'wrong confirmation word rejected')
const n0 = Number(labels[0].replace(/\D/g, ''))
await page.locator('#cw0').fill(words[n0 - 1].toUpperCase())
await page.getByRole('button', { name: 'Create vault' }).click()
await page.getByRole('heading', { name: 'Today' }).waitFor()
assert(true, 'vault created, Today view shown')
await shot('02-today-empty')

console.log('Write an entry with an attachment')
await page.getByRole('link', { name: '+ New entry' }).click()
await page.getByLabel('Title').fill('First entry')
await page.getByLabel('Entry text').fill('Hello **world**\n\n- one\n- two')
await page.getByRole('radio').nth(3).click()
await page.getByText('Saved', { exact: false }).first().waitFor()
const attachment = Buffer.alloc(9 * 1024 * 1024 + 7, 7)
await page
  .locator('input[type=file]')
  .setInputFiles({ name: 'big.bin', mimeType: 'application/octet-stream', buffer: attachment })
await page.getByRole('button', { name: 'Open big.bin' }).waitFor()
await page.waitForFunction(
  () =>
    !document.body.innerText.includes('Waiting to upload') &&
    !document.body.innerText.includes('Uploading'),
  null,
  { timeout: 30000 },
)
assert(true, 'attachment encrypted and uploaded')
await shot('03-editor')
await page.getByRole('button', { name: 'Done' }).click()
await page.locator('.markdown strong', { hasText: 'world' }).waitFor()
assert(true, 'markdown rendered in entry view')
await shot('04-entry-view')

const [download] = await Promise.all([
  page.waitForEvent('download'),
  page.getByRole('button', { name: 'Download' }).click(),
])
const got = readFileSync(await download.path())
assert(
  got.length === attachment.length && got.equals(attachment),
  'attachment downloads and decrypts correctly',
)

console.log('Second entry same day, timeline, calendar')
await page.getByRole('link', { name: 'Today' }).click()
await page.getByRole('link', { name: '+ New entry' }).click()
await page.getByLabel('Entry text').fill('Second thought of the day')
await page.waitForTimeout(1200)
await page.getByRole('button', { name: 'Done' }).click()
await page.getByRole('link', { name: 'Today' }).click()
await expectCount('.entry-card', 2, 'two entries on the same day')
await page.getByRole('link', { name: 'Timeline' }).click()
await expectCount('.entry-card', 2, 'timeline lists both')
await shot('05-timeline')
await page.getByRole('link', { name: 'Calendar' }).click()
await expectCount('.cal-day.has-entries', 1, 'calendar marks today')
await shot('06-calendar')

console.log('Lock, unlock, wrong passphrase')
await page.getByRole('button', { name: 'Lock now' }).click()
await page.getByRole('heading', { name: 'Vault Diary is locked' }).waitFor()
await page.getByLabel('Passphrase').fill('not my passphrase')
await page.getByRole('button', { name: 'Unlock' }).click()
await page.getByText('Wrong passphrase.').waitFor()
assert(true, 'wrong passphrase fails cleanly')
await page.getByLabel('Passphrase').fill(PASS)
await page.getByRole('button', { name: 'Unlock' }).click()
await page.getByRole('link', { name: 'Timeline' }).click()
await expectCount('.entry-card', 2, 'entries back after unlock')

console.log('Reload works from the offline cache')
await page.reload()
await page.getByLabel('Passphrase').fill(PASS)
await page.getByRole('button', { name: 'Unlock' }).click()
await page.getByRole('link', { name: 'Timeline' }).click()
await expectCount('.entry-card', 2, 'entries survive reload')

console.log('Offline editing then sync')
await context.setOffline(true)
await page.getByRole('link', { name: 'Today' }).click()
await page.getByText("You're offline").waitFor()
await page.getByRole('link', { name: '+ New entry' }).click()
await page.getByLabel('Entry text').fill('Written offline')
await page.waitForTimeout(1200)
await page.getByRole('button', { name: 'Done' }).click()
await page.locator('.badge', { hasText: 'Offline' }).waitFor()
await page.getByRole('link', { name: 'Today' }).click()
await expectCount('.entry-card', 3, 'offline entry saved locally')
await shot('07-offline')
await context.setOffline(false)
// The Google token lives in memory only, so after the reload the app asks to continue.
await page.getByText('needs you to sign in again').waitFor()
await shot('07b-continue')
await page.getByRole('button', { name: 'Continue' }).click()
await page.locator('.badge', { hasText: 'Synced' }).waitFor({ timeout: 15000 })
assert(true, 'synced after coming back online')

console.log('Recovery words unlock forces a new passphrase')
await page.getByRole('button', { name: 'Lock now' }).click()
await page.getByRole('button', { name: /recovery words/ }).click()
await page.getByLabel('Your 24 recovery words').fill(['abandon', ...words.slice(1)].join(' '))
await page.getByRole('button', { name: 'Unlock' }).click()
await page.locator('.note-error').waitFor()
assert(
  /checksum|belong/.test(await page.locator('.note-error').innerText()),
  'wrong words fail cleanly',
)
await page.getByLabel('Your 24 recovery words').fill(words.join('\n'))
await page.getByRole('button', { name: 'Unlock' }).click()
await page.getByRole('heading', { name: 'Choose a new passphrase' }).waitFor()
await page.getByLabel('New passphrase').fill(NEWPASS)
await page.getByLabel('Repeat it').fill(NEWPASS)
await page.getByRole('button', { name: 'Save and unlock' }).click()
await page.getByRole('heading', { name: 'Today' }).waitFor()
await page.getByRole('button', { name: 'Lock now' }).click()
await page.getByLabel('Passphrase').fill(PASS)
await page.getByRole('button', { name: 'Unlock' }).click()
await page.getByText('Wrong passphrase.').waitFor()
await page.getByLabel('Passphrase').fill(NEWPASS)
await page.getByRole('button', { name: 'Unlock' }).click()
await page.getByRole('heading', { name: 'Today' }).waitFor()
assert(true, 'new passphrase works and old one does not')

console.log('Settings: change passphrase, backup')
await page.getByRole('link', { name: 'Settings' }).click()
await page.getByLabel('Current passphrase').fill(NEWPASS)
await page.getByLabel('New passphrase', { exact: true }).fill(PASS)
await page.getByLabel('Repeat new passphrase').fill(PASS)
await page.getByRole('button', { name: 'Change passphrase' }).click()
await page.getByText('Passphrase changed').waitFor()
assert(true, 'passphrase changed in settings')
await page.getByRole('button', { name: 'Check storage used' }).click()
await page.getByText('Vault in Google Drive').waitFor()
const [backup] = await Promise.all([
  page.waitForEvent('download', { timeout: 30000 }),
  page.getByRole('button', { name: /encrypted backup/ }).click(),
])
const backupPath = `${SHOTS}/backup.zip`
await backup.saveAs(backupPath)
assert(
  readFileSync(backupPath).subarray(0, 2).toString() === 'PK',
  `backup zip saved (${backup.suggestedFilename()})`,
)
await shot('08-settings')

console.log('Dark theme')
await page.getByLabel('Theme').selectOption('dark')
await page.getByRole('link', { name: 'Today' }).click()
await shot('09-today-dark')

assert(errors.length === 0, `no page errors (${errors.join(' | ')})`)
console.log(
  `\nAll good. Backup written to ${backupPath}; passphrase: "${PASS}"; words: ${words.join(' ')}`,
)
await browser.close()
