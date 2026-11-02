// The recovery drill, automated: build a vault through the real app using every Phase 2 feature
// (passkey, tags, template, voice note, video, camera photo, thumbnails, files), download the
// encrypted backup, throw the browser away ("clear browser data"), then recover with
// recovery.html (offline, recovery words) and recover.py (passphrase and words).
//   APP_URL=http://localhost:4174/ node e2e/drill.e2e.mjs   (production-like build)
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require(
  require.resolve('playwright', {
    paths: [process.cwd(), ...(process.env.NODE_PATH ?? '').split(':')],
  }),
)
const URL = process.env.APP_URL ?? 'http://localhost:5173/'
const PASS = 'correct horse battery staple'
const work = mkdtempSync(join(tmpdir(), 'vd-drill-'))
mkdirSync('e2e/screenshots', { recursive: true })

function assert(cond, msg) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`)
  console.log(`  ✓ ${msg}`)
}

function walk(dir, base = dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) walk(p, base, out)
    else out.push(p.slice(base.length + 1))
  }
  return out
}

const pdf = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
)
const big = Buffer.alloc(4 * 1024 * 1024 + 123, 9) // more than one 4 MiB chunk

const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
})
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  permissions: ['camera', 'microphone'],
  acceptDownloads: true,
})
const page = await context.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('dialog', (d) => d.accept())
await page.goto(URL)
const cdp = await context.newCDPSession(page)
await cdp.send('WebAuthn.enable')
await cdp.send('WebAuthn.addVirtualAuthenticator', {
  options: {
    protocol: 'ctap2',
    ctap2Version: 'ctap2_1',
    transport: 'internal',
    hasResidentKey: true,
    hasUserVerification: true,
    isUserVerified: true,
    hasPrf: true,
    automaticPresenceSimulation: true,
  },
})

console.log('Build a vault with every Phase 2 feature')
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

// Passkey
await page.getByRole('link', { name: 'Settings' }).click()
await page.getByRole('button', { name: 'Add passkey' }).click()
await page.getByLabel('Your passphrase').fill(PASS)
await page.getByRole('button', { name: 'Continue' }).click()
await page.getByRole('button', { name: 'Create passkey' }).click()
await page.getByRole('button', { name: 'Confirm with passkey' }).click()
await page.locator('.passkey-list li').waitFor()
// Template
await page.getByRole('link', { name: 'Manage templates' }).click()
await page.getByRole('link', { name: 'New template' }).click()
await page.getByLabel('Template name').fill('Evening')
await page.getByLabel('Entry text (Markdown)').fill('## Best part of today\n')
await page.getByRole('button', { name: 'Save template' }).click()
await page.locator('.template-list').waitFor()

// Entry 1: from the template, tagged, with recordings, a photo, a PDF and a >4 MiB file
await page.getByRole('link', { name: 'Today' }).click()
await page.locator('.template-picker').getByRole('link', { name: 'Evening' }).click()
await page.getByLabel('Entry text').waitFor()
await page.getByLabel('Entry text').press('End')
await page.getByLabel('Entry text').pressSequentially('Walked by the river. Café ☕.')
await page.getByLabel('Add a tag').fill('walks')
await page.getByLabel('Add a tag').press('Enter')
await page.getByRole('radio').nth(4).click()
async function record(button, ms) {
  await page.getByRole('button', { name: button }).click()
  await page.getByRole('button', { name: '● Record' }).click()
  await page.waitForTimeout(ms)
  await page.getByRole('button', { name: '■ Stop' }).click()
  await page.getByRole('button', { name: 'Keep' }).click()
  await page.getByRole('dialog').waitFor({ state: 'detached' })
}
await record('🎙 Voice note', 2000)
await record('🎥 Video', 2500)
await page.getByRole('button', { name: '📷 Photo' }).click()
await page.getByRole('button', { name: 'Take photo' }).click()
await page.getByRole('button', { name: 'Keep' }).click()
await page.getByRole('dialog').waitFor({ state: 'detached' })
await page.locator('input[type=file][multiple]').setInputFiles([
  { name: 'ticket.pdf', mimeType: 'application/pdf', buffer: pdf },
  { name: 'big file.bin', mimeType: 'application/octet-stream', buffer: big },
])
await page.getByRole('button', { name: 'Open big file.bin' }).waitFor()
await page.waitForFunction(
  () => document.querySelectorAll('.attachments .thumb-img img').length >= 2,
  null,
  { timeout: 20000 },
)
await page.waitForTimeout(1200)
await page.getByRole('button', { name: 'Done' }).click()
// Entry 2: plain text with the default title
await page.getByRole('link', { name: 'Today' }).click()
await page.getByRole('link', { name: '+ New entry' }).click()
await page.getByLabel('Entry text').fill('A short second note.')
await page.waitForTimeout(1200)
await page.getByRole('button', { name: 'Done' }).click()
await page.getByRole('heading', { name: / · Entry 2$/ }).waitFor()
// Wait until everything is on (the fake) Drive.
await page.getByRole('link', { name: 'Settings' }).click()
await page.locator('.badge', { hasText: 'Synced' }).waitFor({ timeout: 60000 })
await page.waitForFunction(() => !document.querySelector('.uploads'), null, { timeout: 60000 })
assert(
  true,
  'vault built: passkey, template, tags, mood, voice note, video, photo, PDF, 4 MiB+ file',
)

console.log('Encrypted backup, then clear the browser')
const [dl] = await Promise.all([
  page.waitForEvent('download', { timeout: 60000 }),
  page.getByRole('button', { name: /encrypted backup/ }).click(),
])
const zip = join(work, 'backup.zip')
await dl.saveAs(zip)
const listing = execFileSync('unzip', ['-Z1', zip]).toString().trim().split('\n')
assert(
  listing.includes('VaultDiary/settings.vds') && listing.includes('VaultDiary/vault.json'),
  `backup has vault.json, settings.vds and ${listing.filter((p) => p.endsWith('.vdf')).length} .vdf files`,
)
const vault = JSON.parse(execFileSync('unzip', ['-p', zip, 'VaultDiary/vault.json']).toString())
assert(
  vault.wrappers.some((w) => w.type === 'webauthn-prf'),
  'vault.json in the backup has the passkey wrapper',
)
assert(errors.length === 0, `no page errors (${errors.join(' | ')})`)
await context.close() // all local data gone

console.log('recover.py (passphrase, then recovery words)')
for (const [mode, env, args] of [
  ['passphrase', { VAULTDIARY_PASSPHRASE: PASS }, []],
  ['words', { VAULTDIARY_WORDS: words.join(' ') }, ['--words']],
]) {
  const out = join(work, `py-${mode}`)
  execFileSync('python3', ['recovery/recover.py', zip, '-o', out, ...args], {
    env: { ...process.env, ...env },
    stdio: 'pipe',
  }) // exits non-zero on any problem
  const files = walk(out)
  const md = files.filter((f) => f.endsWith('.md'))
  const attachments = files.filter((f) => f.startsWith('files/'))
  assert(md.length === 2, `${mode}: 2 entries`)
  assert(
    attachments.length === 5 &&
      attachments.some((f) => /Voice note .*\.(webm|m4a)$/.test(f)) &&
      attachments.some((f) => /Video .*\.(webm|mp4)$/.test(f)) &&
      attachments.some((f) => /Photo .*\.jpg$/.test(f)) &&
      !attachments.some((f) => f.includes('unreferenced')),
    `${mode}: 5 attachments by name, no thumbnails (${attachments.length})`,
  )
  const bigOut = attachments.find((f) => f.endsWith('big file.bin'))
  assert(readFileSync(join(out, bigOut)).equals(big), `${mode}: the 4 MiB+ file is byte-identical`)
  const text = md.map((f) => readFileSync(join(out, f), 'utf8')).join('\n')
  assert(
    text.includes('tags: ["walks"]') && text.includes('Café ☕') && / · Entry 2/.test(text),
    `${mode}: tags, text and the default title come through`,
  )
}

console.log('recovery.html, offline, with the recovery words')
const ctx2 = await browser.newContext({ acceptDownloads: true, offline: true })
const rp = await ctx2.newPage()
await rp.goto(`file://${resolve('recovery/recovery.html')}`)
await rp.locator('#pick-zip').setInputFiles([zip])
await rp.getByText('vault.json: found').waitFor()
await rp.locator('#mode-words').check()
await rp.locator('#words').fill(words.join(' '))
await rp.getByRole('button', { name: 'Decrypt' }).click()
await rp.locator('#status.ok, #status.error').waitFor({ timeout: 60000 })
const status = await rp.locator('#status').innerText()
assert(status.startsWith('Done. Everything decrypted'), `recovery.html: ${status}`)
assert((await rp.locator('#results li').count()) === 7, 'recovery.html: 2 entries + 5 files')
await rp.screenshot({ path: 'e2e/screenshots/drill-recovery.png', fullPage: true })
await browser.close()
console.log('\nRecovery drill: all good.')
