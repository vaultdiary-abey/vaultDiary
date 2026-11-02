// Phase 3 milestone C: HEIC viewing copies and "can't play this video" in plain words.
//   APP_URL=http://localhost:4174/ node e2e/heic.e2e.mjs   (production-like build)
//
// Headless Chromium can't decode HEIC, like Chrome on most computers. To also exercise the
// iPhone side (a browser that can), a test-only stub (localStorage "e2eHeic" = "on") makes
// createImageBitmap decode the HEIC test photo from its JPEG twin. The app has no such hook.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require(
  require.resolve('playwright', {
    paths: [process.cwd(), ...(process.env.NODE_PATH ?? '').split(':')],
  }),
)
const URL = process.env.APP_URL ?? 'http://localhost:4174/'
const SHOTS = 'e2e/screenshots'
mkdirSync(SHOTS, { recursive: true })
const work = mkdtempSync(join(tmpdir(), 'vd-heic-'))
const PASS = 'correct horse battery staple'
const HEIC = readFileSync('tests/fixtures/assets/IMG_0100.HEIC')
const TWIN = readFileSync('tests/fixtures/assets/IMG_0100-view.jpg')

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

/** A minimal .mov whose video track is HEVC (hvc1), like an iPhone recording. */
function hevcMov() {
  const box = (type, body) => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(8 + body.length)
    head.write(type, 4, 'ascii')
    return Buffer.concat([head, body])
  }
  const stsd = box(
    'stsd',
    Buffer.concat([Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]), box('hvc1', Buffer.alloc(78))]),
  )
  const moov = box('moov', box('trak', box('mdia', box('minf', box('stbl', stsd)))))
  return Buffer.concat([
    box('ftyp', Buffer.from('qt  \0\0\0\0qt  ')),
    box('mdat', Buffer.alloc(20000, 1)),
    moov,
  ])
}

const browser = await chromium.launch()
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  acceptDownloads: true,
})
await context.addInitScript((twinB64) => {
  if (localStorage.getItem('e2eHeic') !== 'on') return
  const original = window.createImageBitmap.bind(window)
  const twin = Uint8Array.from(atob(twinB64), (c) => c.charCodeAt(0))
  window.createImageBitmap = (source, ...rest) => {
    if (source instanceof Blob && /heic|heif/i.test(source.type)) {
      // The 467-byte probe image is 16×16; anything else is the test photo.
      if (source.size < 1000) return original(new ImageData(16, 16), ...rest)
      return original(new Blob([twin], { type: 'image/jpeg' }), ...rest)
    }
    return original(source, ...rest)
  }
}, TWIN.toString('base64'))
const page = await context.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('dialog', (d) => d.accept())

async function heicMode(on) {
  // Let sync finish and the fake Drive (kept in this browser's IndexedDB) save, as a reload
  // starts it again from what it saved.
  await page.locator('.badge', { hasText: 'Synced' }).waitFor({ timeout: 60000 })
  await page.waitForTimeout(1000)
  await page.evaluate((v) => localStorage.setItem('e2eHeic', v), on ? 'on' : 'off')
  await page.reload()
  await page.getByLabel('Passphrase').fill(PASS)
  await page.getByRole('button', { name: 'Unlock' }).click()
  await page.getByRole('button', { name: 'Lock now' }).waitFor()
}

async function waitUploads() {
  const count = () =>
    page.evaluate(
      () =>
        new Promise((resolve) => {
          const r = indexedDB.open('vaultdiary')
          r.onsuccess = () => {
            const q = r.result.transaction('uploads').objectStore('uploads').count()
            q.onsuccess = () => {
              r.result.close()
              resolve(q.result)
            }
          }
        }),
    )
  for (let i = 0; (await count()) > 0; i++) {
    if (i > 120) throw new Error('uploads did not finish')
    await page.waitForTimeout(500)
  }
}

async function newEntry(title, files) {
  await page.goto(`${URL}#/new`)
  await page.getByLabel('Title').fill(title)
  await page.locator('input[type=file][multiple]').setInputFiles(files)
  for (const f of files) await page.locator('.attachments li', { hasText: f.name }).waitFor()
  await page.waitForTimeout(1500)
  await page.getByRole('button', { name: 'Done' }).click()
  await page.getByRole('heading', { name: title }).waitFor()
}

console.log('Set up (a browser that cannot decode HEIC, like Chrome)')
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

await newEntry('Old HEIC photo', [{ name: 'IMG_0100.HEIC', mimeType: 'image/heic', buffer: HEIC }])
await page.getByRole('button', { name: 'Open IMG_0100.HEIC' }).click()
const viewer = page.getByRole('dialog', { name: 'IMG_0100.HEIC' })
await viewer.getByText(/can't show HEIC photos, and this one has no viewing copy yet/).waitFor()
assert(true, 'no viewing copy: a plain message')
assert(await viewer.getByRole('button', { name: 'Download' }).first().isVisible(), 'and Download')
const [orig] = await Promise.all([
  page.waitForEvent('download'),
  viewer.locator('.viewer-message').getByRole('button', { name: 'Download' }).click(),
])
const origPath = join(work, 'orig.heic')
await orig.saveAs(origPath)
assert(readFileSync(origPath).equals(HEIC), 'Download gives the original HEIC')
await viewer.getByRole('button', { name: 'Close' }).click()
await page.getByRole('link', { name: 'Settings' }).click()
assert(
  /can't read HEIC photos/.test(await page.getByTestId('viewcopy-status').innerText()),
  'Settings explains that this browser can’t make viewing copies',
)
await waitUploads()

console.log('On a browser that can decode HEIC (simulated iPhone)')
await heicMode(true)
await page.getByRole('link', { name: 'Settings' }).click()
await page.getByTestId('viewcopy-status').getByText('1 HEIC photo without a viewing copy').waitFor()
await page.getByRole('button', { name: 'Make viewing copies for older photos' }).click()
await page
  .getByTestId('viewcopy-status')
  .getByText(/Made 1 viewing copy/)
  .waitFor()
assert(true, '"Make viewing copies for older photos" makes one for the old photo')
await page.screenshot({ path: `${SHOTS}/c1-viewcopies.png`, fullPage: true })
await newEntry('New HEIC photo', [{ name: 'IMG_0200.HEIC', mimeType: 'image/heic', buffer: HEIC }])
await page.getByRole('link', { name: 'Settings' }).click()
await page
  .getByTestId('viewcopy-status')
  .getByText('Every HEIC photo has a viewing copy.')
  .waitFor()
assert(true, 'a HEIC photo added here gets its viewing copy straight away')
await waitUploads()

console.log('Back on a browser that cannot decode HEIC')
await heicMode(false)
await page.goto(`${URL}#/timeline`)
await page.locator('.entry-card', { hasText: 'Old HEIC photo' }).click()
await page.getByRole('button', { name: 'Open IMG_0100.HEIC' }).click()
// Reopened app: Google needs a new sign-in before the viewing copy can come from Drive.
await viewer.getByText(/the viewing copy couldn't be loaded/).waitFor()
assert(true, 'without a Google sign-in, it says why and offers Try again')
await viewer.getByRole('button', { name: 'Try again' }).click()
const copy = viewer.locator('img[data-viewcopy=yes]')
await copy.waitFor()
await page.waitForFunction(() => document.querySelector('img[data-viewcopy=yes]')?.complete)
assert(
  (await copy.evaluate((i) => i.naturalWidth)) === 320,
  'the viewer shows the JPEG viewing copy',
)
assert(await viewer.getByText(/Viewing copy \(JPEG\)/).isVisible(), 'and says it is a viewing copy')
await page.screenshot({ path: `${SHOTS}/c2-viewer-copy.png`, fullPage: true })
const [orig2] = await Promise.all([
  page.waitForEvent('download'),
  viewer.locator('.viewer-bar').getByRole('button', { name: 'Download' }).click(),
])
await orig2.saveAs(origPath)
assert(readFileSync(origPath).equals(HEIC), 'Download still gives the original HEIC')
await viewer.getByRole('button', { name: 'Close' }).click()

console.log('A video this browser cannot play (HEVC)')
await newEntry('iPhone video', [
  { name: 'IMG_0300.MOV', mimeType: 'video/quicktime', buffer: hevcMov() },
])
await page.getByRole('button', { name: 'Open IMG_0300.MOV' }).click()
const vviewer = page.getByRole('dialog', { name: 'IMG_0300.MOV' })
await vviewer.getByText(/recorded in HEVC \(H\.265\)/).waitFor()
assert(true, 'HEVC: says so in plain words')
assert(
  await vviewer.locator('.viewer-message').getByRole('button', { name: 'Download' }).isVisible(),
  'and offers Download',
)
await page.screenshot({ path: `${SHOTS}/c3-hevc.png`, fullPage: true })
await vviewer.getByRole('button', { name: 'Close' }).click()
await waitUploads()

console.log('Exports and recovery include the viewing copies')
await page.getByRole('link', { name: 'Settings' }).click()
const exportCard = page.locator('.card.export')
await exportCard.getByRole('button', { name: 'Everything' }).click()
await exportCard.getByRole('button', { name: 'Export…' }).click()
await exportCard.getByLabel('Your passphrase').fill(PASS)
const [md] = await Promise.all([
  page.waitForEvent('download'),
  exportCard.getByRole('button', { name: 'Confirm and export' }).click(),
])
const mdZip = join(work, 'export.zip')
await md.saveAs(mdZip)
const mdList = execFileSync('unzip', ['-Z1', mdZip]).toString()
assert(
  /files\/[0-9a-f]{8}-IMG_0100-view\.jpg/.test(mdList) &&
    /files\/[0-9a-f]{8}-IMG_0100\.HEIC/.test(mdList),
  'Markdown export: original and IMG_0100-view.jpg',
)

await exportCard.getByRole('button', { name: 'Everything' }).click()
await exportCard.getByLabel('PDF (print view)').check()
await exportCard.getByRole('button', { name: 'Export…' }).click()
await exportCard.getByLabel('Your passphrase').fill(PASS)
await exportCard.getByRole('button', { name: 'Confirm and export' }).click()
await page.locator('.print-doc').waitFor()
await page.waitForFunction(() =>
  [...document.querySelectorAll('.print-photo img')].every((i) => i.complete),
)
const widths = await page
  .locator('.print-photo img')
  .evaluateAll((l) => l.map((i) => i.naturalWidth))
assert(
  widths.length === 2 && widths.every((w) => w === 320),
  `PDF print view uses the viewing copies (${widths})`,
)
await page.getByRole('button', { name: '✕ Close' }).click()

const [bk] = await Promise.all([
  page.waitForEvent('download', { timeout: 60000 }),
  page.getByRole('button', { name: /encrypted backup/ }).click(),
])
const backup = join(work, 'backup.zip')
await bk.saveAs(backup)
const out = join(work, 'py')
execFileSync('python3', ['recovery/recover.py', backup, '-o', out], {
  env: { ...process.env, VAULTDIARY_PASSPHRASE: PASS },
  stdio: 'pipe',
})
const recovered = walk(out)
const views = recovered.filter((f) => /-view\.jpg$/.test(f))
assert(
  views.length === 2 &&
    recovered.filter((f) => /\.HEIC$/.test(f)).length === 2 &&
    !recovered.some((f) => f.includes('unreferenced')),
  `recover.py: both originals and both viewing copies (${views.join(', ')})`,
)
assert(
  readFileSync(
    join(
      out,
      recovered.find((f) => f.endsWith('IMG_0100.HEIC')),
    ),
  ).equals(HEIC),
  'recover.py: the original HEIC is byte-identical',
)
const text = recovered
  .filter((f) => f.endsWith('.md'))
  .map((f) => readFileSync(join(out, f), 'utf8'))
  .join('\n')
assert(text.includes('[Viewing copy (JPEG)]'), 'the Markdown links the viewing copy')

assert(errors.length === 0, `no page errors (${errors.join(' | ')})`)
await browser.close()
console.log('\nHEIC e2e: all good.')
